import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import type { TextAnimation, TitleLayer, TitleStyle } from '../../types';
import { resolveGradientStops, buildGradientCSS } from '../../utils/gradientUtils';
import AnimatedText from './AnimatedText';

interface AnimatedTitleProps {
  titleLayer: TitleLayer;
  titleStyle: TitleStyle;
  animation: TextAnimation;
}

const AnimatedTitle: React.FC<AnimatedTitleProps> = ({ titleLayer, titleStyle, animation }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = Math.round(titleLayer.startTime * fps);
  const endFrame = Math.round(titleLayer.endTime * fps);
  const durationFrames = endFrame - startFrame;
  const localFrame = frame - startFrame;

  if (localFrame < 0 || localFrame > durationFrames) return null;

  // Base background style
  const bgOpacity = titleStyle.backgroundOpacity ?? 0.9;
  const bgColor = titleStyle.backgroundColor || '#6366f1';
  const bgR = parseInt(bgColor.slice(1, 3), 16);
  const bgG = parseInt(bgColor.slice(3, 5), 16);
  const bgB = parseInt(bgColor.slice(5, 7), 16);

  // Build individual effect strings
  const s = titleStyle;
  const textDropShadow = (s.textShadowBlur && s.textShadowBlur > 0 || s.textShadowOffsetX || s.textShadowOffsetY)
    ? `${s.textShadowOffsetX || 0}px ${s.textShadowOffsetY || 0}px ${s.textShadowBlur || 0}px ${s.textShadowColor || '#000000'}`
    : null;
  const textGlow = (s.glowBlur && s.glowBlur > 0)
    ? `0 0 ${s.glowBlur}px ${s.glowColor || '#00ff00'}, 0 0 ${s.glowBlur * 1.5}px ${s.glowColor || '#00ff00'}`
    : null;
  const backdropDropShadow = (s.backdropShadowBlur && s.backdropShadowBlur > 0 || s.backdropShadowOffsetX || s.backdropShadowOffsetY)
    ? `${s.backdropShadowOffsetX || 0}px ${s.backdropShadowOffsetY || 0}px ${s.backdropShadowBlur || 0}px ${s.backdropShadowColor || '#000000'}`
    : null;
  const backdropGlowStr = (s.backdropGlowBlur && s.backdropGlowBlur > 0)
    ? `0 0 ${s.backdropGlowBlur}px ${s.backdropGlowColor || '#00ff00'}, 0 0 ${s.backdropGlowBlur * 1.5}px ${s.backdropGlowColor || '#00ff00'}`
    : null;
  const innerGlowShadow = (s.innerGlowBlur && s.innerGlowBlur > 0)
    ? `inset 0 0 ${s.innerGlowBlur}px ${s.innerGlowColor || '#ffffff'}`
    : null;

  // Split effects by blend mode
  const mainTextShadows: string[] = [];
  const mainBoxShadows: string[] = [];
  const effectLayers: Array<{ type: 'text-shadow' | 'box-shadow'; value: string; blendMode: string }> = [];

  if (textDropShadow) {
    if (s.shadowBlendMode && s.shadowBlendMode !== 'normal') {
      effectLayers.push({ type: 'text-shadow', value: textDropShadow, blendMode: s.shadowBlendMode });
    } else mainTextShadows.push(textDropShadow);
  }
  if (textGlow) {
    if (s.glowBlendMode && s.glowBlendMode !== 'normal') {
      effectLayers.push({ type: 'text-shadow', value: textGlow, blendMode: s.glowBlendMode });
    } else mainTextShadows.push(textGlow);
  }
  if (backdropDropShadow) {
    if (s.backdropShadowBlendMode && s.backdropShadowBlendMode !== 'normal') {
      effectLayers.push({ type: 'box-shadow', value: backdropDropShadow, blendMode: s.backdropShadowBlendMode });
    } else mainBoxShadows.push(backdropDropShadow);
  }
  if (backdropGlowStr) {
    if (s.backdropGlowBlendMode && s.backdropGlowBlendMode !== 'normal') {
      effectLayers.push({ type: 'box-shadow', value: backdropGlowStr, blendMode: s.backdropGlowBlendMode });
    } else mainBoxShadows.push(backdropGlowStr);
  }
  if (innerGlowShadow) {
    if (s.innerGlowBlendMode && s.innerGlowBlendMode !== 'normal') {
      effectLayers.push({ type: 'box-shadow', value: innerGlowShadow, blendMode: s.innerGlowBlendMode });
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

  const cssStyle: React.CSSProperties = {
    fontFamily: s.fontFamily || 'Arial',
    fontSize: s.fontSize || 20,
    fontWeight: s.bold ? 'bold' : 'normal',
    fontStyle: s.italic ? 'italic' : 'normal',
    color: s.color || '#ffffff',
    textAlign: s.textAlign || 'center',
    padding: '8px 16px',
    borderRadius: s.boxBorderRadius ?? 12,
    border: s.boxBorderWidth ? `${s.boxBorderWidth}px solid ${s.boxBorderColor}` : 'none',
    backgroundColor: s.backgroundType !== 'none'
      ? `rgba(${bgR},${bgG},${bgB},${bgOpacity})`
      : 'transparent',
    textShadow: mainTextShadows.length > 0 ? mainTextShadows.join(', ') : undefined,
    boxShadow: mainBoxShadows.length > 0 ? mainBoxShadows.join(', ') : undefined,
    WebkitTextStrokeWidth: s.outlineWidth && s.backgroundType === 'outline' ? `${s.outlineWidth}px` : undefined,
    WebkitTextStrokeColor: s.outlineColor && s.backgroundType === 'outline' ? s.outlineColor : undefined,
    mixBlendMode: s.backdropBlendMode && s.backdropBlendMode !== 'normal' ? s.backdropBlendMode as any : undefined,
    ...((backgroundGradient ? { '--text-gradient': backgroundGradient } : {}) as any),
  };

  // Build blend-mode layer styles
  const blendLayers: React.CSSProperties[] = effectLayers.map((layer) => ({
    ...cssStyle,
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

  return (
    <div
      style={{
        position: 'absolute',
        top: `${s.topOffset ?? 15}%`,
        left: 0,
        right: 0,
        pointerEvents: 'none',
        padding: '0 5%',
        isolation: 'isolate' as any,
      }}
    >
      {blendLayers.length > 0 ? (
        <div style={{ display: 'grid' }}>
          {blendLayers.map((layerStyle, i) => (
            <AnimatedText
              key={`blend-title-${i}`}
              text={titleLayer.text}
              animation={animation}
              style={layerStyle}
              frame={localFrame}
              fps={fps}
            />
          ))}
          <AnimatedText
            text={titleLayer.text}
            animation={animation}
            style={{ ...cssStyle, gridArea: '1 / 1 / 2 / 2' }}
            frame={localFrame}
            fps={fps}
          />
        </div>
      ) : (
        <AnimatedText
          text={titleLayer.text}
          animation={animation}
          style={cssStyle}
          frame={localFrame}
          fps={fps}
        />
      )}
    </div>
  );
};

export default AnimatedTitle;
