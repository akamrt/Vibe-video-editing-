/**
 * HyperframesDSLOverlay
 *
 * Renders a HyperframesDSL config as a transparent caption overlay using
 * pure DOM/CSS — no iframe, no eval, no GSAP. The same DSL is consumed by
 * `drawDSLCaption` in hyperframesCanvasRenderer.ts so preview matches export.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { HyperframesDSL } from '../../types';
import {
  DSL_COMP_W, DSL_COMP_H,
  evaluateTracks,
  splitText,
  staggerOffset,
  transformText,
  mixHexColors,
  activeWordIndex,
  syntheticWordTimings,
  type WordTiming,
} from '../../utils/hyperframesDSL';

interface Props {
  dsl: HyperframesDSL;
  text: string;
  sourceTime: number;
  eventStartTime: number;
  eventEndTime?: number;
  wordTimings?: WordTiming[];
  isPlaying: boolean;
  containerWidth: number;
  containerHeight: number;
  onMouseDown?: (e: React.MouseEvent) => void;
  divRef?: React.RefObject<HTMLDivElement>;
  style?: React.CSSProperties;
}

function computeScale(w: number, h: number) {
  return Math.min(w / DSL_COMP_W, h / DSL_COMP_H);
}

export default function HyperframesDSLOverlay({
  dsl,
  text,
  sourceTime,
  eventStartTime,
  eventEndTime,
  wordTimings,
  isPlaying,
  containerWidth,
  containerHeight,
  onMouseDown,
  divRef,
  style,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Drives re-render at ~60fps during playback so transforms update smoothly
  // (parent's React updates are too coarse — same trick as HyperframesCaptionOverlay)
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const baselineRef = useRef({ time: sourceTime, wallclock: performance.now(), playing: isPlaying });

  useEffect(() => {
    baselineRef.current = { time: sourceTime, wallclock: performance.now(), playing: isPlaying };
    if (!isPlaying) {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setTick(t => t + 1);
      return;
    }
    if (rafRef.current != null) return;
    const loop = () => { rafRef.current = requestAnimationFrame(loop); setTick(t => t + 1); };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [sourceTime, isPlaying]);

  // Effective playhead — extrapolate from baseline during playback
  const effectiveSource = useMemo(() => {
    const b = baselineRef.current;
    if (!b.playing) return sourceTime;
    return b.time + (performance.now() - b.wallclock) / 1000;
    // tick is intentionally a dependency to force re-eval each rAF
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, sourceTime]);

  const scale = computeScale(containerWidth, containerHeight);
  const offset = Math.max(0, effectiveSource - eventStartTime);

  const { units, lines, wordsPerLine } = useMemo(
    () => splitText(text || '', dsl.split, 40),
    [text, dsl.split],
  );

  const totalUnits = units.length;
  const stagger   = dsl.stagger ?? 0;
  const duration  = dsl.duration;
  const staggerFn = dsl.staggerFn ?? 'linear';

  // Karaoke
  const ws = useMemo(() => (text || '').split(/\s+/).filter(Boolean), [text]);
  const timings = wordTimings && wordTimings.length
    ? wordTimings
    : syntheticWordTimings(ws, eventStartTime, eventEndTime ?? eventStartTime + 10);
  const activeWord = activeWordIndex(timings, effectiveSource);

  // ── Position container ────────────────────────────────────────────────────
  // We render in 1920x1080 author space then transform-scale to fit container.
  const baseX = DSL_COMP_W / 2;
  const baseY = DSL_COMP_H - dsl.layout.bottom;
  const align = dsl.layout.align ?? 'center';

  // Per-line render: assemble units into lines for positioning
  const lineUnits = useMemo(() => {
    if (dsl.split === 'element' || dsl.split === 'line') {
      // each unit IS a line
      return units.map((u, i) => ({ line: u.text, units: [u], lineIndex: i }));
    }
    // word/letter — group by lineIndex
    const map = new Map<number, typeof units>();
    units.forEach(u => {
      if (!map.has(u.lineIndex)) map.set(u.lineIndex, []);
      map.get(u.lineIndex)!.push(u);
    });
    return Array.from(map.entries()).map(([lineIndex, us]) => ({
      line: lines[lineIndex] ?? '',
      units: us,
      lineIndex,
    }));
  }, [units, lines, dsl.split]);

  const fontSize = dsl.style.fontSize ?? 80;
  const lineHeight = (dsl.layout.lineHeight ?? 1.15) * fontSize;
  const totalLines = lineUnits.length;

  const fontFamily = dsl.style.fontFamily ?? 'Inter';
  const fontWeight = dsl.style.fontWeight ?? '700';
  const baseColor  = dsl.style.color ?? '#ffffff';
  const tt = dsl.style.textTransform ?? 'none';

  // ── Effects → CSS shadows / strokes ───────────────────────────────────────
  const baseTextShadow = useMemo(() => {
    const parts: string[] = [];
    if (dsl.effects?.shadow) {
      const s = dsl.effects.shadow;
      parts.push(`${s.offsetX ?? 0}px ${s.offsetY ?? 2}px ${s.blur}px ${s.color}`);
    }
    if (dsl.effects?.glow) {
      const g = dsl.effects.glow;
      parts.push(`0 0 ${g.blur}px ${g.color}`);
    }
    return parts.join(', ');
  }, [dsl.effects?.shadow, dsl.effects?.glow]);

  const strokeStyles: React.CSSProperties = useMemo(() => {
    if (!dsl.effects?.stroke || dsl.effects.stroke.width <= 0) return {};
    const w = dsl.effects.stroke.width;
    const c = dsl.effects.stroke.color;
    return {
      WebkitTextStroke: `${w}px ${c}`,
      paintOrder: 'stroke fill',
    };
  }, [dsl.effects?.stroke]);

  // RGB split jitter — needs current time
  const rgbSplitTransforms = useMemo(() => {
    if (!dsl.effects?.rgbSplit) return null;
    const r = dsl.effects.rgbSplit;
    const jitter = r.jitter ?? 0;
    const freq = r.jitterFreq ?? 8;
    const t = effectiveSource;
    const jx = jitter > 0 ? (Math.sin(t * freq * 6.28) * jitter) : 0;
    const jy = jitter > 0 ? (Math.cos(t * freq * 7.13) * jitter) : 0;
    return {
      red:  { x: r.redOffset[0]  + jx, y: r.redOffset[1]  + jy },
      blue: { x: r.blueOffset[0] - jx, y: r.blueOffset[1] - jy },
    };
  }, [dsl.effects?.rgbSplit, effectiveSource]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={(el) => {
        wrapperRef.current = el;
        if (divRef) (divRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }}
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute', inset: 0,
        width: containerWidth, height: containerHeight,
        pointerEvents: 'auto', cursor: 'grab',
        overflow: 'hidden', background: 'transparent',
        ...style,
      }}
    >
      {/* Author-space stage scaled to container */}
      <div
        style={{
          position: 'absolute',
          width: DSL_COMP_W, height: DSL_COMP_H,
          left: '50%', top: '50%',
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center center',
          pointerEvents: 'none',
        }}
      >
        {/* Caption block */}
        <div
          style={{
            position: 'absolute',
            left: 0, right: 0,
            bottom: dsl.layout.bottom,
            display: 'flex',
            flexDirection: 'column',
            alignItems: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
            textAlign: align,
            gap: 0,
            paddingLeft: align === 'left' ? 60 : 0,
            paddingRight: align === 'right' ? 60 : 0,
          }}
        >
          {lineUnits.map(({ units: lineUs, lineIndex }) => (
            <div
              key={lineIndex}
              style={{
                display: 'flex',
                flexDirection: 'row',
                gap: 0,
                justifyContent: align === 'left' ? 'flex-start' : align === 'right' ? 'flex-end' : 'center',
                lineHeight: `${lineHeight}px`,
                whiteSpace: 'nowrap',
              }}
            >
              {lineUs.map((u, idx) => {
                const isLastUnitOnLine = idx === lineUs.length - 1;
                const t0 = staggerOffset(u.globalIndex, totalUnits, stagger, staggerFn);
                const unitTime = offset - t0;
                const v = evaluateTracks(dsl.tracks, duration, unitTime, effectiveSource, u.globalIndex);

                // Karaoke check (only for word/letter splits)
                const wordIdxForUnit = dsl.split === 'word' ? u.globalIndex : -1;
                const isActiveWord = dsl.karaoke?.enabled && wordIdxForUnit === activeWord;
                const isPastWord   = dsl.karaoke?.enabled && wordIdxForUnit >= 0 && wordIdxForUnit < activeWord;

                let color = baseColor;
                if (v.colorMix !== undefined && v.colorPair) {
                  color = mixHexColors(v.colorPair[0], v.colorPair[1], v.colorMix) || color;
                }
                if (isActiveWord && dsl.karaoke?.color) color = dsl.karaoke.color;

                const opacity = v.opacity * (isPastWord ? (dsl.karaoke?.pastOpacity ?? 1) : 1);
                const karaokeScale = isActiveWord && dsl.karaoke?.scale ? dsl.karaoke.scale : 1;

                const transform = [
                  `translate(${v.translateX}px, ${v.translateY}px)`,
                  `scale(${v.scaleX * karaokeScale}, ${v.scaleY * karaokeScale})`,
                  `rotate(${v.rotate}deg)`,
                  v.skewX ? `skewX(${v.skewX}deg)` : '',
                  v.skewY ? `skewY(${v.skewY}deg)` : '',
                ].filter(Boolean).join(' ');

                const filter = v.blur > 0 ? `blur(${v.blur}px)` : undefined;

                // Karaoke glow + bg
                const activeShadow = isActiveWord && dsl.karaoke?.glow
                  ? `0 0 ${dsl.karaoke.glow.blur}px ${dsl.karaoke.glow.color}` + (baseTextShadow ? `, ${baseTextShadow}` : '')
                  : baseTextShadow;

                const activeBg = isActiveWord && dsl.karaoke?.background?.color !== 'transparent' && dsl.karaoke?.background
                  ? {
                      backgroundColor: dsl.karaoke.background.color,
                      padding: `${dsl.karaoke.background.padY}px ${dsl.karaoke.background.padX}px`,
                      borderRadius: 6,
                    }
                  : {};

                const charText = transformText(u.text, tt);

                // Letter splits join visually with no extra space
                const padRight = dsl.split === 'word' && !isLastUnitOnLine ? '0.3em' : 0;

                const baseUnitStyle: React.CSSProperties = {
                  display: 'inline-block',
                  fontFamily, fontWeight, fontSize, color,
                  letterSpacing: dsl.style.letterSpacing ?? 0,
                  opacity,
                  transform,
                  transformOrigin: 'center center',
                  filter,
                  textShadow: activeShadow || undefined,
                  willChange: 'transform, opacity',
                  paddingRight: padRight,
                  ...strokeStyles,
                  ...activeBg,
                };

                // RGB split: render two color-channel ghosts behind the main char
                if (rgbSplitTransforms) {
                  return (
                    <span key={u.globalIndex} style={{ position: 'relative', display: 'inline-block', paddingRight: padRight }}>
                      <span style={{
                        ...baseUnitStyle,
                        position: 'absolute', inset: 0, paddingRight: 0,
                        color: '#ff0044',
                        transform: `${transform} translate(${rgbSplitTransforms.red.x}px, ${rgbSplitTransforms.red.y}px)`,
                        mixBlendMode: 'screen',
                      }}>{charText}</span>
                      <span style={{
                        ...baseUnitStyle,
                        position: 'absolute', inset: 0, paddingRight: 0,
                        color: '#00ddff',
                        transform: `${transform} translate(${rgbSplitTransforms.blue.x}px, ${rgbSplitTransforms.blue.y}px)`,
                        mixBlendMode: 'screen',
                      }}>{charText}</span>
                      <span style={{ ...baseUnitStyle, paddingRight: 0, position: 'relative' }}>{charText}</span>
                    </span>
                  );
                }

                return (
                  <span key={u.globalIndex} style={baseUnitStyle}>{charText}</span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
