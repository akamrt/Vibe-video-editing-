import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { AnalysisEvent, SubtitleStyle, SubtitleTemplate, TextAnimation } from '../../types';
import { getInterpolatedTransform } from '../../utils/interpolation';
import { resolveGradientStops, buildGradientCSS } from '../../utils/gradientUtils';
import AnimatedText from './AnimatedText';

interface SubtitleEntry {
  event: AnalysisEvent;
  sourceStartFrame: number;
  sourceEndFrame: number;
}

interface GlobalSubtitleOverlayProps {
  events: AnalysisEvent[];
  subtitleStyle: SubtitleStyle;
  template: SubtitleTemplate | null;
  activeKeywordAnimation?: TextAnimation | null;
  /** Maps source-video time to timeline frames. Each entry: { sourceOffset, timelineStartFrame, durationFrames } */
  segments: Array<{
    sourceOffset: number; // startTime in source video
    timelineStartFrame: number;
    durationFrames: number;
  }>;
}

const GlobalSubtitleOverlay: React.FC<GlobalSubtitleOverlayProps> = ({
  events,
  subtitleStyle,
  template,
  activeKeywordAnimation,
  segments,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Find which segment is active at the current frame
  let sourceTime: number | null = null;
  for (const seg of segments) {
    const segEnd = seg.timelineStartFrame + seg.durationFrames;
    if (frame >= seg.timelineStartFrame && frame < segEnd) {
      const localFrame = frame - seg.timelineStartFrame;
      sourceTime = seg.sourceOffset + localFrame / fps;
      break;
    }
  }

  if (sourceTime === null) return null;

  // Find the active dialogue event at this source time
  const activeEvent = events.find(
    e => e.type === 'dialogue' && sourceTime! >= e.startTime && sourceTime! <= e.endTime
  );

  if (!activeEvent) return null;

  const style = activeEvent.styleOverride || subtitleStyle;
  // Per-event template override takes priority over global template
  const effectiveTemplate = activeEvent.templateOverride || template;
  // Default animation if none provided: quick fade up
  const defaultAnim: any = {
    id: 'sub_default',
    duration: 0.2,
    scope: 'word',
    stagger: 0.05,
    effects: [{ id: 'e1', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 1, easing: 'linear' }]
  };
  const animation = effectiveTemplate?.animation || defaultAnim;

  // Resolve keyword animation cascade: event > template > global > null
  const kwAnim = activeEvent.keywordAnimation || effectiveTemplate?.keywordAnimation || activeKeywordAnimation || null;

  // Calculate local frame within this subtitle event
  const eventStartFrame = Math.round(activeEvent.startTime * fps);
  const localFrame = Math.round(sourceTime * fps) - eventStartFrame;

  // Use template style if present, but user overrides take priority
  // Strip fontSize so the subtitle style's fontSize remains the "root" value
  const { fontSize: _tfs, ...tplStyleNoSize } = effectiveTemplate?.style || {};
  // FIX: Merge template style FIRST, then user style on top
  const { main: cssStyle, blendLayers } = subtitleStyleToCSS(style);
  const mergedStyle = effectiveTemplate ? { ...tplStyleNoSize, ...cssStyle } : cssStyle;

  // Calculate keyframe transforms
  let keyframeTransform = '';
  if (activeEvent.keyframes && activeEvent.keyframes.length > 0) {
    const subTime = sourceTime - activeEvent.startTime;
    const kfTransform = getInterpolatedTransform(activeEvent.keyframes, subTime);

    const kfParts: string[] = [];
    if (kfTransform.translateX !== 0 || kfTransform.translateY !== 0) {
      // Use percentages as base if no container size known, but consistent with App.tsx
      kfParts.push(`translate(${kfTransform.translateX}%, ${kfTransform.translateY}%)`);
    }
    if (kfTransform.scale !== 1) kfParts.push(`scale(${kfTransform.scale})`);
    if (kfTransform.rotation !== 0) kfParts.push(`rotate(${kfTransform.rotation}deg)`);
    keyframeTransform = kfParts.join(' ');
  }

  const evtTx = activeEvent.translateX || 0;
  const evtTy = activeEvent.translateY || 0;
  const evtTransform = (evtTx !== 0 || evtTy !== 0) ? `translate(${evtTx}%, ${evtTy}%)` : undefined;

  const finalTransform = [evtTransform, keyframeTransform].filter(Boolean).join(' ') || undefined;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: `${style.bottomOffset ?? 10}%`,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 5%',
        pointerEvents: 'none',
        transform: finalTransform,
        isolation: 'isolate' as any,
      }}
    >
      {blendLayers.length > 0 ? (
        <div style={{ display: 'grid' }}>
          {blendLayers.map((layerStyle, i) => (
            <AnimatedText
              key={`blend-${i}`}
              text={activeEvent.details}
              animation={animation}
              style={layerStyle}
              frame={localFrame}
              fps={fps}
              wordEmphases={activeEvent.wordEmphases}
              keywordAnimation={kwAnim || undefined}
            />
          ))}
          <AnimatedText
            text={activeEvent.details}
            animation={animation}
            style={{ ...mergedStyle, gridArea: '1 / 1 / 2 / 2' }}
            frame={localFrame}
            fps={fps}
            wordEmphases={activeEvent.wordEmphases}
            keywordAnimation={kwAnim || undefined}
          />
        </div>
      ) : (
        <AnimatedText
          text={activeEvent.details}
          animation={animation}
          style={mergedStyle}
          frame={localFrame}
          fps={fps}
          wordEmphases={activeEvent.wordEmphases}
          keywordAnimation={kwAnim || undefined}
        />
      )}
    </div>
  );
};

/** Convert the app's SubtitleStyle to CSS properties + blend mode layers */
function subtitleStyleToCSS(s: SubtitleStyle): { main: React.CSSProperties; blendLayers: React.CSSProperties[] } {
  const bgOpacity = s.backgroundOpacity ?? 0.8;
  const bgColor = s.backgroundColor || '#000000';
  const bgR = parseInt(bgColor.slice(1, 3), 16);
  const bgG = parseInt(bgColor.slice(3, 5), 16);
  const bgB = parseInt(bgColor.slice(5, 7), 16);

  // Build individual effect strings
  const textDropShadow = (s.textShadowBlur && s.textShadowBlur > 0 || s.textShadowOffsetX || s.textShadowOffsetY)
    ? `${s.textShadowOffsetX || 0}px ${s.textShadowOffsetY || 0}px ${s.textShadowBlur || 0}px ${s.textShadowColor || '#000000'}`
    : null;
  const textGlow = (s.glowBlur && s.glowBlur > 0)
    ? `0 0 ${s.glowBlur}px ${s.glowColor || '#00ff00'}, 0 0 ${s.glowBlur * 1.5}px ${s.glowColor || '#00ff00'}`
    : null;
  const backdropDropShadow = (s.backdropShadowBlur && s.backdropShadowBlur > 0 || s.backdropShadowOffsetX || s.backdropShadowOffsetY)
    ? `${s.backdropShadowOffsetX || 0}px ${s.backdropShadowOffsetY || 0}px ${s.backdropShadowBlur || 0}px ${s.backdropShadowColor || '#000000'}`
    : null;
  const backdropGlow = (s.backdropGlowBlur && s.backdropGlowBlur > 0)
    ? `0 0 ${s.backdropGlowBlur}px ${s.backdropGlowColor || '#00ff00'}, 0 0 ${s.backdropGlowBlur * 1.5}px ${s.backdropGlowColor || '#00ff00'}`
    : null;
  const innerGlowShadow = (s.innerGlowBlur && s.innerGlowBlur > 0)
    ? `inset 0 0 ${s.innerGlowBlur}px ${s.innerGlowColor || '#ffffff'}`
    : null;

  // Split effects by blend mode
  const mainTextShadows: string[] = [];
  const mainBoxShadows: string[] = [];
  const layers: Array<{ type: 'text-shadow' | 'box-shadow'; value: string; blendMode: string }> = [];

  if (textDropShadow) {
    if (s.shadowBlendMode && s.shadowBlendMode !== 'normal') {
      layers.push({ type: 'text-shadow', value: textDropShadow, blendMode: s.shadowBlendMode });
    } else mainTextShadows.push(textDropShadow);
  }
  if (textGlow) {
    if (s.glowBlendMode && s.glowBlendMode !== 'normal') {
      layers.push({ type: 'text-shadow', value: textGlow, blendMode: s.glowBlendMode });
    } else mainTextShadows.push(textGlow);
  }
  if (backdropDropShadow) {
    if (s.backdropShadowBlendMode && s.backdropShadowBlendMode !== 'normal') {
      layers.push({ type: 'box-shadow', value: backdropDropShadow, blendMode: s.backdropShadowBlendMode });
    } else mainBoxShadows.push(backdropDropShadow);
  }
  if (backdropGlow) {
    if (s.backdropGlowBlendMode && s.backdropGlowBlendMode !== 'normal') {
      layers.push({ type: 'box-shadow', value: backdropGlow, blendMode: s.backdropGlowBlendMode });
    } else mainBoxShadows.push(backdropGlow);
  }
  if (innerGlowShadow) {
    if (s.innerGlowBlendMode && s.innerGlowBlendMode !== 'normal') {
      layers.push({ type: 'box-shadow', value: innerGlowShadow, blendMode: s.innerGlowBlendMode });
    } else mainBoxShadows.push(innerGlowShadow);
  }

  // Gradient Text Support (multi-stop)
  let backgroundGradient: string | undefined = undefined;
  if (s.gradientType && s.gradientType !== 'none') {
    const stops = resolveGradientStops(s);
    if (stops) {
      backgroundGradient = buildGradientCSS(s.gradientType as 'linear' | 'radial', stops, s.gradientAngle);
    }
  }

  const main: React.CSSProperties = {
    fontFamily: s.fontFamily || 'Arial',
    fontSize: s.fontSize || 16,
    fontWeight: s.bold ? 'bold' : 'normal',
    fontStyle: s.italic ? 'italic' : 'normal',
    color: s.color || '#ffffff',
    textAlign: s.textAlign || 'center',
    padding: '6px 12px',
    borderRadius: s.boxBorderRadius ?? 8,
    border: s.boxBorderWidth ? `${s.boxBorderWidth}px solid ${s.boxBorderColor}` : 'none',
    backgroundColor: s.backgroundType !== 'none'
      ? `rgba(${bgR},${bgG},${bgB},${bgOpacity})`
      : 'transparent',
    textShadow: mainTextShadows.length > 0 ? mainTextShadows.join(', ') : undefined,
    boxShadow: mainBoxShadows.length > 0 ? mainBoxShadows.join(', ') : undefined,
    WebkitTextStrokeWidth: s.outlineWidth && s.backgroundType === 'outline' ? `${s.outlineWidth}px` : undefined,
    WebkitTextStrokeColor: s.outlineColor && s.backgroundType === 'outline' ? s.outlineColor : undefined,
    mixBlendMode: s.backdropBlendMode && s.backdropBlendMode !== 'normal'
      ? s.backdropBlendMode as any
      : undefined,
    ...((backgroundGradient ? { '--text-gradient': backgroundGradient } : {}) as any),
  };

  // Build blend-mode layer styles
  const blendLayers: React.CSSProperties[] = layers.map((layer) => ({
    ...main,
    textShadow: layer.type === 'text-shadow' ? layer.value : 'none',
    boxShadow: layer.type === 'box-shadow' ? layer.value : 'none',
    color: 'transparent',
    WebkitTextFillColor: 'transparent',
    WebkitTextStrokeWidth: '0px',
    backgroundImage: 'none',
    '--text-gradient': undefined,
    mixBlendMode: layer.blendMode as any,
    gridArea: '1 / 1 / 2 / 2',
    pointerEvents: 'none' as const,
  } as any));

  return { main, blendLayers };
}

export default GlobalSubtitleOverlay;
