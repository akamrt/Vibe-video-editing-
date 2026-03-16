import React, { useMemo, useRef, useEffect, useState } from 'react';
import { interpolate, Easing, spring } from 'remotion';
import type { TextAnimation, AnimationEffect, EasingType, KeywordEmphasis, SubtitleStyle } from '../../types';
import { getActiveWordInfo, type WordTiming } from '../../utils/wordHighlightUtils';

interface WordRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert a hex color + 0-1 opacity to a CSS rgba() string */
function hexToRgba(hex: string, opacity: number): string {
  const clean = (hex.startsWith('#') ? hex.slice(1) : hex).replace(/[^0-9a-fA-F]/g, '');
  const len = clean.length;
  let r = 0, g = 0, b = 0;
  if (len === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (len >= 6) {
    r = parseInt(clean.slice(0, 2), 16) || 0;
    g = parseInt(clean.slice(2, 4), 16) || 0;
    b = parseInt(clean.slice(4, 6), 16) || 0;
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, opacity))})`;
}

interface AnimatedTextProps {
  text: string;
  animation: TextAnimation;
  style: React.CSSProperties;
  /** The current frame RELATIVE to the start of the animation (0 = start) */
  frame: number;
  /** Frames per second — passed in so this component works both inside and outside Remotion */
  fps: number;
  wordEmphases?: KeywordEmphasis[];
  /** Separate animation for keyword-emphasized words. Only active when scope === 'word'. */
  keywordAnimation?: TextAnimation;
  /** Click handler for individual words (wordIndex, word text). Only used in viewport, not Remotion export. */
  onWordClick?: (wordIndex: number, word: string) => void;
  // ── Word highlight box (karaoke) ──
  /** Pass the subtitle style to enable/read wordHighlight* settings. */
  wordHighlightStyle?: SubtitleStyle;
  /** Current source video time in seconds. Required for highlight to work. */
  sourceTime?: number;
  eventStartTime?: number;
  eventEndTime?: number;
  wordTimings?: WordTiming[];
}

const mapEasing = (easing: EasingType): ((t: number) => number) | null => {
  switch (easing) {
    case 'linear': return Easing.linear;
    case 'easeIn': return Easing.in(Easing.cubic);
    case 'easeOut': return Easing.out(Easing.cubic);
    case 'easeInOut': return Easing.inOut(Easing.cubic);
    case 'bounce': return Easing.bounce;
    case 'elastic': return Easing.elastic(1);
    case 'spring': return null; // Uses remotion spring() instead
    default: return Easing.linear;
  }
};

function computeEffectValue(effect: AnimationEffect, elmLocalFrame: number, totalDurationSec: number, fps: number): number {
  const effectStartFrame = totalDurationSec * effect.startAt * fps;
  const effectEndFrame = totalDurationSec * effect.endAt * fps;
  const effectDurationFrames = effectEndFrame - effectStartFrame;
  const effectFrame = elmLocalFrame - effectStartFrame;

  if (effect.easing === 'spring' || effect.easing === 'elastic') {
    const damping = effect.bounciness != null ? Math.max(1, 20 - effect.bounciness) : 10;
    const stiffness = effect.stiffness ?? 100;

    if (effect.easing === 'spring') {
      const spr = spring({
        frame: Math.max(0, effectFrame),
        fps,
        config: { damping, stiffness },
      });
      return interpolate(spr, [0, 1], [effect.from, effect.to]);
    }

    // elastic easing
    const easingFn = Easing.elastic(effect.bounciness != null ? effect.bounciness / 10 : 1);
    const t = interpolate(
      effectFrame,
      [0, Math.max(1, effectDurationFrames)],
      [0, 1],
      { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    return interpolate(easingFn(t), [0, 1], [effect.from, effect.to]);
  }

  // Standard easing
  const easingFn = mapEasing(effect.easing) || Easing.linear;
  const t = interpolate(
    effectFrame,
    [0, Math.max(1, effectDurationFrames)],
    [0, 1],
    { easing: easingFn, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  return interpolate(t, [0, 1], [effect.from, effect.to]);
}

const AnimatedText: React.FC<AnimatedTextProps> = ({
  text, animation, style, frame, fps, wordEmphases, keywordAnimation, onWordClick,
  wordHighlightStyle, sourceTime, eventStartTime, eventEndTime, wordTimings,
}) => {
  // Split text based on scope
  const elements = useMemo(() => {
    if (animation.scope === 'character') return text.split('');
    if (animation.scope === 'word') return text.split(/(\s+)/); // Preserve spaces as separators
    if (animation.scope === 'line') return text.split('\n');
    return [text]; // 'element' scope — whole block
  }, [text, animation.scope]);

  // Count only non-whitespace elements for stagger indexing
  const animatableIndices = useMemo(() => {
    if (animation.scope !== 'word') return elements.map((_, i) => i);
    let idx = 0;
    return elements.map((el) => {
      if (/^\s+$/.test(el)) return -1; // whitespace token, don't animate
      return idx++;
    });
  }, [elements, animation.scope]);

  // Build keyword emphasis lookup map
  const emphasisMap = useMemo(() => {
    if (!wordEmphases || wordEmphases.length === 0) return null;
    const map = new Map<number, KeywordEmphasis>();
    for (const kw of wordEmphases) {
      if (kw.enabled) map.set(kw.wordIndex, kw);
    }
    return map.size > 0 ? map : null;
  }, [wordEmphases]);

  // For non-word scopes (line/element), compute the cumulative word offset per element
  // so we can map words inside each element back to global word indices
  const wordOffsets = useMemo(() => {
    if (animation.scope === 'word') return [];
    if (!emphasisMap && !onWordClick) return [];
    let offset = 0;
    return elements.map(el => {
      const curr = offset;
      offset += el.split(/\s+/).filter(w => w.length > 0).length;
      return curr;
    });
  }, [elements, animation.scope, emphasisMap, onWordClick]);

  // ── Word highlight box ──
  const wordHighlightEnabled = !!wordHighlightStyle?.wordHighlightEnabled && sourceTime != null;

  const containerRef = useRef<HTMLDivElement>(null);
  const [wordRects, setWordRects] = useState<Map<number, WordRect>>(new Map());

  // Measure word span positions after DOM settles (browser only, not Remotion SSR)
  useEffect(() => {
    if (!wordHighlightEnabled) return;
    const container = containerRef.current;
    if (!container) return;
    const spans = container.querySelectorAll<HTMLSpanElement>('[data-word-idx]');
    if (spans.length === 0) return;
    const newRects = new Map<number, WordRect>();
    spans.forEach(span => {
      const idx = parseInt(span.dataset.wordIdx!, 10);
      if (!isNaN(idx)) {
        newRects.set(idx, {
          left: span.offsetLeft,
          top: span.offsetTop,
          width: span.offsetWidth,
          height: span.offsetHeight,
        });
      }
    });
    setWordRects(newRects);
  }, [wordHighlightEnabled, text, animation.scope]);

  const activeWordInfo = useMemo(() => {
    if (!wordHighlightEnabled) return null;
    return getActiveWordInfo(
      wordTimings,
      eventStartTime ?? 0,
      eventEndTime ?? 0,
      text,
      sourceTime!,
    );
  }, [wordHighlightEnabled, wordTimings, eventStartTime, eventEndTime, text, sourceTime]);

  const activeWordIndex = activeWordInfo?.activeIndex ?? -1;

  // Build highlight box position + style
  const highlightBoxStyle = useMemo((): React.CSSProperties | null => {
    if (!wordHighlightEnabled || !wordHighlightStyle || activeWordIndex < 0) return null;
    const rect = wordRects.get(activeWordIndex);
    if (!rect || rect.width === 0) return null;

    const hlColor = wordHighlightStyle.wordHighlightColor ?? '#FFD700';
    const hlOpacity = wordHighlightStyle.wordHighlightOpacity ?? 0.85;
    const paddingH = wordHighlightStyle.wordHighlightPaddingH ?? 4;
    const paddingV = wordHighlightStyle.wordHighlightPaddingV ?? 2;
    const hlRadius = wordHighlightStyle.wordHighlightBorderRadius ?? 4;
    const hlBlendMode = wordHighlightStyle.wordHighlightBlendMode ?? 'normal';
    const transitionMs = wordHighlightStyle.wordHighlightTransitionMs ?? 150;
    const hlScale = wordHighlightStyle.wordHighlightScale ?? 1.0;
    const shadowColor = wordHighlightStyle.wordHighlightShadowColor;
    const shadowBlur = wordHighlightStyle.wordHighlightShadowBlur ?? 0;
    const shadowX = wordHighlightStyle.wordHighlightShadowOffsetX ?? 0;
    const shadowY = wordHighlightStyle.wordHighlightShadowOffsetY ?? 0;
    const glowColor = wordHighlightStyle.wordHighlightGlowColor;
    const glowBlur = wordHighlightStyle.wordHighlightGlowBlur ?? 0;

    const baseW = rect.width + 2 * paddingH;
    const baseH = rect.height + 2 * paddingV;
    const scaledW = baseW * hlScale;
    const scaledH = baseH * hlScale;
    const left = rect.left - paddingH - (scaledW - baseW) / 2;
    const top = rect.top - paddingV - (scaledH - baseH) / 2;

    const shadows: string[] = [];
    if (shadowColor && (shadowBlur > 0 || shadowX !== 0 || shadowY !== 0)) {
      shadows.push(`${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowColor}`);
    }
    if (glowColor && glowBlur > 0) {
      shadows.push(`0 0 ${glowBlur}px ${glowColor}`);
      shadows.push(`0 0 ${glowBlur * 1.5}px ${glowColor}`);
    }

    return {
      position: 'absolute',
      left,
      top,
      width: scaledW,
      height: scaledH,
      backgroundColor: hexToRgba(hlColor, hlOpacity),
      borderRadius: hlRadius,
      mixBlendMode: hlBlendMode as React.CSSProperties['mixBlendMode'],
      boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
      transition: `left ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1), `
        + `top ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1), `
        + `width ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1), `
        + `height ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1)`,
      pointerEvents: 'none',
      zIndex: 0,
    };
  }, [wordHighlightEnabled, wordHighlightStyle, activeWordIndex, wordRects]);

  const idleOpacity = wordHighlightEnabled ? (wordHighlightStyle?.wordHighlightIdleOpacity ?? 1.0) : 1.0;
  const activeColor = wordHighlightEnabled ? (wordHighlightStyle?.wordHighlightActiveColor || null) : null;
  const applyHighlightStyling = wordHighlightEnabled && (idleOpacity < 1 || activeColor);

  // Separate container styles (font, color, background) from transform styles
  const { padding, ...allContainerStyle } = style;

  const textGradient = (allContainerStyle as any)['--text-gradient'] as string | undefined;

  // Strip --text-gradient from container style so it doesn't pollute the div DOM
  const { '--text-gradient': _removedGradient, ...containerStyle } = allContainerStyle as any;

  const textFillProps = textGradient ? {
    backgroundImage: textGradient,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    color: 'transparent' // Fallback
  } : {};

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: animation.scope === 'line' ? 'column' : 'row',
        flexWrap: animation.scope === 'word' || animation.scope === 'character' ? 'wrap' : 'nowrap',
        justifyContent:
          style.textAlign === 'left' ? 'flex-start' :
            style.textAlign === 'right' ? 'flex-end' : 'center',
        alignItems: animation.scope === 'line' ? 'stretch' : 'center',
        position: 'relative', // Fix for WebKit bug where child background-clip: text hides parent background
        zIndex: 0, // Force stacking context
        transform: 'translateZ(0)', // Force hardware acceleration layer to protect background
        ...containerStyle,
        padding, // Apply padding to the container, NOT per-element
      }}
    >
      {/* Highlight box — rendered first so it's visually behind the text */}
      {highlightBoxStyle && <div style={highlightBoxStyle} />}

      {elements.map((el, rawIndex) => {
        const staggerIndex = animatableIndices[rawIndex];

        // Whitespace tokens: just render a space, no animation
        if (animation.scope === 'word' && staggerIndex === -1) {
          return <span key={rawIndex} style={{ whiteSpace: 'pre' }}>{el}</span>;
        }

        // Dual-stack mode: non-word scope + keywordAnimation + keywords present
        // → each word inside the element gets its own animation transforms
        const dualStack = animation.scope !== 'word' && !!keywordAnimation && !!emphasisMap;

        if (dualStack) {
          // Render each word with its own animation stack
          const tokens = el.split(/(\s+)/);
          let localWordIdx = 0;
          const baseOffset = wordOffsets[rawIndex] ?? 0;

          return (
            <span key={rawIndex} style={{ display: 'inline-block', whiteSpace: 'pre' }}>
              {tokens.map((token, ti) => {
                if (/^\s+$/.test(token)) return <span key={ti}>{token}</span>;
                const globalIdx = baseOffset + localWordIdx;
                localWordIdx++;
                const kwEntry = emphasisMap.get(globalIdx);
                // Pick animation stack: keyword words use keywordAnimation, others use main
                const wordAnim = kwEntry ? keywordAnimation : animation;
                const wordDelay = globalIdx * (wordAnim.stagger ?? 0) * fps;
                const wordFrame = frame - wordDelay;

                let wOp = 1, wSc = 1, wTx = 0, wTy = 0, wRot = 0, wBlur = 0, wLs = 0;
                for (const effect of wordAnim.effects) {
                  const val = computeEffectValue(effect, wordFrame, wordAnim.duration, fps);
                  switch (effect.type) {
                    case 'opacity': wOp *= val; break;
                    case 'scale': wSc *= val; break;
                    case 'translateX': wTx += val; break;
                    case 'translateY': wTy += val; break;
                    case 'rotate': wRot += val; break;
                    case 'blur': wBlur = Math.max(0, wBlur + val); break;
                    case 'letterSpacing': wLs += val; break;
                  }
                }
                wOp = Math.max(0, Math.min(1, wOp));

                // Apply idle/active highlight styling
                const isActiveWord = applyHighlightStyling && globalIdx === activeWordIndex;
                if (applyHighlightStyling && !isActiveWord && idleOpacity < 1) {
                  wOp *= idleOpacity;
                }

                return (
                  <span
                    key={ti}
                    data-word-idx={globalIdx}
                    style={{
                      display: 'inline-block',
                      opacity: wOp,
                      transform: `translate(${wTx}px, ${wTy}px) scale(${wSc}) rotate(${wRot}deg)`,
                      filter: wBlur > 0 ? `blur(${wBlur}px)` : undefined,
                      letterSpacing: wLs !== 0 ? `${wLs}px` : undefined,
                      whiteSpace: 'pre',
                      willChange: 'transform, opacity, filter',
                    }}
                    onClick={onWordClick ? (e) => { e.stopPropagation(); onWordClick(globalIdx, token); } : undefined}
                    className={onWordClick ? 'cursor-pointer' : undefined}
                  >
                    <span style={{
                      display: 'inline-block',
                      color: isActiveWord && activeColor
                        ? activeColor
                        : kwEntry ? (kwEntry.color || '#FFD700') : undefined,
                      ...(!kwEntry && !(isActiveWord && activeColor) ? textFillProps : {}),
                    }}>
                      {token}
                    </span>
                  </span>
                );
              })}
            </span>
          );
        }

        // ── Standard single-stack animation (word scope, or non-word without keywordAnimation) ──
        const isKw = emphasisMap?.has(staggerIndex);
        const useKwAnim = keywordAnimation && animation.scope === 'word' && isKw;
        const effectiveAnim = useKwAnim ? keywordAnimation : animation;

        // Calculate delay for this element
        const delaySec = staggerIndex * (effectiveAnim.stagger ?? 0);
        const delayFrames = delaySec * fps;
        const elmLocalFrame = frame - delayFrames;

        // Compute each effect
        let opacity = 1;
        let scaleVal = 1;
        let translateX = 0;
        let translateY = 0;
        let rotate = 0;
        let blur = 0;
        let letterSpacing = 0;

        for (const effect of effectiveAnim.effects) {
          // Word-target filtering: skip effects that don't apply to this word
          if (effect.wordTarget && emphasisMap && effectiveAnim.scope === 'word') {
            const isKeyword = emphasisMap.has(staggerIndex);
            if (effect.wordTarget.mode === 'keywords' && !isKeyword) continue;
            if (effect.wordTarget.mode === 'non-keywords' && isKeyword) continue;
            if (effect.wordTarget.mode === 'indices' &&
              !effect.wordTarget.indices.includes(staggerIndex)) continue;
          }
          const val = computeEffectValue(effect, elmLocalFrame, effectiveAnim.duration, fps);

          switch (effect.type) {
            case 'opacity': opacity *= val; break;
            case 'scale': scaleVal *= val; break;
            case 'translateX': translateX += val; break;
            case 'translateY': translateY += val; break;
            case 'rotate': rotate += val; break;
            case 'blur': blur = Math.max(0, blur + val); break;
            case 'letterSpacing': letterSpacing += val; break;
          }
        }

        opacity = Math.max(0, Math.min(1, opacity));

        // Apply idle/active highlight styling for word scope
        const isActiveWord = applyHighlightStyling && animation.scope === 'word' && staggerIndex === activeWordIndex;
        if (applyHighlightStyling && animation.scope === 'word' && !isActiveWord && idleOpacity < 1) {
          opacity *= idleOpacity;
        }

        // At word scope, staggerIndex IS the word index — direct emphasisMap lookup
        const isKeywordDirect = animation.scope === 'word' && isKw;

        // For non-word scopes without dual-stack, still color keywords per-word
        const renderContent = () => {
          // Word scope: outer span handles clicks directly
          if (animation.scope === 'word') return el;
          // No interactivity needed and no keywords to highlight
          if (!emphasisMap && !onWordClick && !applyHighlightStyling) return el;
          const tokens = el.split(/(\s+)/);
          let localWordIdx = 0;
          const baseOffset = wordOffsets[rawIndex] ?? 0;
          return tokens.map((token, ti) => {
            if (/^\s+$/.test(token)) return <span key={ti}>{token}</span>;
            const globalIdx = baseOffset + localWordIdx;
            localWordIdx++;
            const kwEntry = emphasisMap?.get(globalIdx);
            const isActiveToken = applyHighlightStyling && globalIdx === activeWordIndex;
            return (
              <span
                key={ti}
                data-word-idx={globalIdx}
                style={{
                  opacity: applyHighlightStyling && !isActiveToken && idleOpacity < 1 ? idleOpacity : undefined,
                  ...(isActiveToken && activeColor
                    ? { color: activeColor }
                    : kwEntry ? { color: kwEntry.color || '#FFD700' } : textFillProps)
                }}
                onClick={onWordClick ? (e) => { e.stopPropagation(); onWordClick(globalIdx, token); } : undefined}
                className={onWordClick ? 'cursor-pointer' : undefined}
              >
                {token}
              </span>
            );
          });
        };

        // Word index attribute for highlight measurement
        const wordIdxAttr = animation.scope === 'word' ? { 'data-word-idx': staggerIndex } : {};

        return (
          <span
            key={rawIndex}
            {...wordIdxAttr}
            onClick={onWordClick && animation.scope === 'word' ? (e) => {
              e.stopPropagation();
              onWordClick(staggerIndex, el);
            } : undefined}
            style={{
              display: 'inline-block',
              opacity,
              transform: `translate(${translateX}px, ${translateY}px) scale(${scaleVal}) rotate(${rotate}deg)`,
              filter: blur > 0 ? `blur(${blur}px)` : undefined,
              letterSpacing: letterSpacing !== 0 ? `${letterSpacing}px` : undefined,
              whiteSpace: 'pre',
              willChange: 'transform, opacity, filter',
              cursor: onWordClick && animation.scope === 'word' ? 'pointer' : undefined,
              textDecoration: onWordClick && isKeywordDirect ? 'underline' : undefined,
              textDecorationColor: onWordClick && isKeywordDirect ? 'rgba(255,215,0,0.4)' : undefined,
            }}
          >
            <span style={{
              display: 'inline-block',
              color: isActiveWord && activeColor
                ? activeColor
                : isKeywordDirect
                  ? (emphasisMap!.get(staggerIndex)!.color || '#FFD700')
                  : containerStyle.color || undefined,
              ...(!isKeywordDirect && !(isActiveWord && activeColor) && (animation.scope === 'word' || !emphasisMap) ? textFillProps : {}),
            }}>
              {renderContent()}
            </span>
          </span>
        );
      })}
    </div>
  );
};

export default AnimatedText;
