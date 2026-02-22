import React, { useMemo } from 'react';
import { interpolate, Easing, spring } from 'remotion';
import type { TextAnimation, AnimationEffect, EasingType, KeywordEmphasis } from '../../types';

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

const AnimatedText: React.FC<AnimatedTextProps> = ({ text, animation, style, frame, fps, wordEmphases, keywordAnimation, onWordClick }) => {
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
    if (animation.scope === 'word' || !emphasisMap) return [];
    let offset = 0;
    return elements.map(el => {
      const curr = offset;
      offset += el.split(/\s+/).filter(w => w.length > 0).length;
      return curr;
    });
  }, [elements, animation.scope, emphasisMap]);

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

                return (
                  <span
                    key={ti}
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
                      color: kwEntry ? (kwEntry.color || '#FFD700') : undefined,
                      ...(!kwEntry ? textFillProps : {}), // Dont apply global gradient to keyword emphasized words if they have their own color
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

        // At word scope, staggerIndex IS the word index — direct emphasisMap lookup
        const isKeywordDirect = animation.scope === 'word' && isKw;

        // For non-word scopes without dual-stack, still color keywords per-word
        const renderContent = () => {
          if (animation.scope === 'word' || !emphasisMap) return el;
          const tokens = el.split(/(\s+)/);
          let localWordIdx = 0;
          const baseOffset = wordOffsets[rawIndex] ?? 0;
          return tokens.map((token, ti) => {
            if (/^\s+$/.test(token)) return <span key={ti}>{token}</span>;
            const globalIdx = baseOffset + localWordIdx;
            localWordIdx++;
            const kwEntry = emphasisMap.get(globalIdx);
            return (
              <span
                key={ti}
                style={{
                  ...(kwEntry ? { color: kwEntry.color || '#FFD700' } : textFillProps)
                }}
                onClick={onWordClick ? (e) => { e.stopPropagation(); onWordClick(globalIdx, token); } : undefined}
                className={onWordClick ? 'cursor-pointer' : undefined}
              >
                {token}
              </span>
            );
          });
        };

        return (
          <span
            key={rawIndex}
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
              color: isKeywordDirect
                ? (emphasisMap!.get(staggerIndex)!.color || '#FFD700')
                : containerStyle.color || undefined,
              ...(!isKeywordDirect && (animation.scope === 'word' || !emphasisMap) ? textFillProps : {}),
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
