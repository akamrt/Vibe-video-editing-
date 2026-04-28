/**
 * GraphicLayerOverlay
 *
 * Renders one or more GraphicLayers as SVG overlays in 1920x1080 author space,
 * scaled to fit the viewport. Each layer's DSL.graphics array is iterated and
 * each node's tracks evaluated per-frame.
 *
 * Selection: click a layer to select it. Selected layer gets a dashed bounding
 * outline. Drag (TODO) to reposition translateX/Y. Backspace/Delete deletes.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphicLayer, GraphicNode, HyperframesDSL } from '../types';
import {
  DSL_COMP_W, DSL_COMP_H,
  evaluateTracks,
  DEFAULT_TRACK_VALUES,
  mixHexColors,
} from '../utils/hyperframesDSL';

interface Props {
  layers: GraphicLayer[];
  /** Current media playhead time (seconds) — same time space as layer.startTime/endTime */
  mediaTime: number;
  isPlaying: boolean;
  containerWidth: number;
  containerHeight: number;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
}

function computeScale(w: number, h: number) {
  return Math.min(w / DSL_COMP_W, h / DSL_COMP_H);
}

export default function GraphicLayerOverlay({
  layers, mediaTime, isPlaying,
  containerWidth, containerHeight,
  selectedId, onSelect,
}: Props) {
  // 60fps tick during playback so loops/animations stay smooth
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const baselineRef = useRef({ time: mediaTime, wallclock: performance.now(), playing: isPlaying });

  useEffect(() => {
    baselineRef.current = { time: mediaTime, wallclock: performance.now(), playing: isPlaying };
    if (!isPlaying) {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      setTick(t => t + 1);
      return;
    }
    if (rafRef.current != null) return;
    const loop = () => { rafRef.current = requestAnimationFrame(loop); setTick(t => t + 1); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; } };
  }, [mediaTime, isPlaying]);

  const effectiveTime = useMemo(() => {
    const b = baselineRef.current;
    return b.playing ? b.time + (performance.now() - b.wallclock) / 1000 : mediaTime;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, mediaTime]);

  const scale = computeScale(containerWidth, containerHeight);

  // Active layers — within their time window AND visible
  const activeLayers = useMemo(() => {
    return layers
      .filter(l => l.visible !== false && effectiveTime >= l.startTime && effectiveTime <= l.endTime)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  }, [layers, effectiveTime]);

  if (!activeLayers.length) return null;

  return (
    <svg
      width={containerWidth}
      height={containerHeight}
      viewBox={`0 0 ${DSL_COMP_W} ${DSL_COMP_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{
        position: 'absolute', inset: 0,
        width: containerWidth, height: containerHeight,
        pointerEvents: 'auto',
        overflow: 'visible',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onSelect?.(null);
      }}
    >
      {activeLayers.map(layer => (
        <LayerGroup
          key={layer.id}
          layer={layer}
          mediaTime={effectiveTime}
          selected={layer.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </svg>
  );
}

// ── Layer group ─────────────────────────────────────────────────────────────

function LayerGroup({
  layer, mediaTime, selected, onSelect,
}: {
  layer: GraphicLayer;
  mediaTime: number;
  selected: boolean;
  onSelect?: (id: string | null) => void;
}) {
  const layerTime = mediaTime - layer.startTime;
  const layerLength = layer.endTime - layer.startTime;

  // Fade in/out
  const fadeIn  = layer.fadeInDuration  ?? 0;
  const fadeOut = layer.fadeOutDuration ?? 0;
  let layerOpacity = 1;
  if (fadeIn > 0 && layerTime < fadeIn) layerOpacity = layerTime / fadeIn;
  if (fadeOut > 0 && layerTime > layerLength - fadeOut) layerOpacity = Math.max(0, (layerLength - layerTime) / fadeOut);

  const tx = layer.translateX ?? 0;
  const ty = layer.translateY ?? 0;
  const lscale = layer.scale ?? 1;
  const lrot   = layer.rotation ?? 0;

  const transform = `translate(${tx}, ${ty}) scale(${lscale}) rotate(${lrot})`;

  const dsl = layer.dsl;
  const graphics = dsl.graphics ?? [];

  // Compute selection bounding box (loose — pad by 30 author px)
  const bbox = useMemo(() => computeBBox(graphics), [graphics]);

  return (
    <g
      transform={transform}
      opacity={layerOpacity}
      onMouseDown={(e) => {
        e.stopPropagation();
        onSelect?.(layer.id);
      }}
      style={{ cursor: 'pointer' }}
    >
      {graphics.map((node, i) => (
        <GraphicNodeView
          key={node.id ?? i}
          node={node}
          dsl={dsl}
          layerTime={layerTime}
          mediaTime={mediaTime}
          unitIndex={i}
        />
      ))}
      {/* Selection outline */}
      {selected && bbox && (
        <rect
          x={bbox.x - 30} y={bbox.y - 30}
          width={bbox.w + 60} height={bbox.h + 60}
          fill="none" stroke="#6c63ff" strokeWidth={3}
          strokeDasharray="12 8"
          style={{ pointerEvents: 'none' }}
        />
      )}
    </g>
  );
}

// ── Single node ─────────────────────────────────────────────────────────────

function GraphicNodeView({
  node, dsl, layerTime, mediaTime, unitIndex,
}: {
  node: GraphicNode;
  dsl: HyperframesDSL;
  layerTime: number;
  mediaTime: number;
  unitIndex: number;
}) {
  const appearAt = node.appearAt ?? 0;
  const disappearAt = node.disappearAt ?? Infinity;
  if (layerTime < appearAt || layerTime > disappearAt) return null;

  const animDuration = node.animDuration ?? dsl.duration ?? 0.5;
  const nodeTime = layerTime - appearAt;
  const tracks = node.tracks ?? [];
  const v = tracks.length
    ? evaluateTracks(tracks, animDuration, nodeTime, mediaTime, unitIndex)
    : DEFAULT_TRACK_VALUES;

  // Determine origin point (in author space)
  const origin = computeNodeOrigin(node);
  const ox = origin.x;
  const oy = origin.y;

  // Compose transform — translate(origin) rotate scale skew translate(-origin)
  // All transform tracks are in author-space px / degrees.
  const tx = (node as any).translateX ?? 0;
  // Tracks add to baseline; node x/y is the base position
  const trans = `translate(${v.translateX}, ${v.translateY})`;
  const rot   = `rotate(${v.rotate}, ${ox}, ${oy})`;
  const scl   = `translate(${ox}, ${oy}) scale(${v.scaleX}, ${v.scaleY}) translate(${-ox}, ${-oy})`;
  const skew  = (v.skewX || v.skewY) ? `skewX(${v.skewX}) skewY(${v.skewY})` : '';

  const groupTransform = `${trans} ${rot} ${scl} ${skew}`.trim();

  const opacity = (node.opacity ?? 1) * v.opacity;
  const filter = v.blur > 0 ? `blur(${v.blur}px)` : undefined;

  // Color mix (applies to fills via track)
  const colorMixedFill = v.colorMix !== undefined && v.colorPair
    ? mixHexColors(v.colorPair[0], v.colorPair[1], v.colorMix) || undefined
    : undefined;

  return (
    <g transform={groupTransform} opacity={opacity} style={{ filter }}>
      {renderNodeShape(node, colorMixedFill)}
    </g>
  );
}

function renderNodeShape(node: GraphicNode, fillOverride?: string): React.ReactNode {
  const fill = fillOverride ?? (node as any).fill;
  switch (node.kind) {
    case 'rect': return (
      <rect
        x={node.x} y={node.y}
        width={node.width} height={node.height}
        rx={node.cornerRadius ?? 0}
        ry={node.cornerRadius ?? 0}
        fill={fill ?? 'transparent'}
        stroke={node.stroke ?? 'none'}
        strokeWidth={node.strokeWidth ?? 0}
      />
    );
    case 'circle': return (
      <circle
        cx={node.x} cy={node.y}
        r={node.radius}
        fill={fill ?? 'transparent'}
        stroke={node.stroke ?? 'none'}
        strokeWidth={node.strokeWidth ?? 0}
      />
    );
    case 'line': {
      // drawProgress 0..1 reveals from start
      const p = node.drawProgress ?? 1;
      const tx = node.x + (node.x2 - node.x) * p;
      const ty = node.y + (node.y2 - node.y) * p;
      return (
        <line
          x1={node.x} y1={node.y} x2={tx} y2={ty}
          stroke={node.stroke}
          strokeWidth={node.strokeWidth}
          strokeLinecap={node.lineCap ?? 'round'}
        />
      );
    }
    case 'path': return (
      <path
        d={translatePathD(node.d, node.x, node.y)}
        fill={fill ?? 'none'}
        stroke={node.stroke ?? 'none'}
        strokeWidth={node.strokeWidth ?? 0}
      />
    );
    case 'image': return (
      <image
        href={node.src}
        x={node.x} y={node.y}
        width={node.width} height={node.height}
        preserveAspectRatio="xMidYMid meet"
      />
    );
    case 'text': {
      const transformText = (t: string) => {
        switch (node.textTransform) {
          case 'uppercase': return t.toUpperCase();
          case 'lowercase': return t.toLowerCase();
          case 'capitalize': return t.replace(/\b\w/g, c => c.toUpperCase());
          default: return t;
        }
      };
      const filters: string[] = [];
      if (node.shadow) filters.push(`drop-shadow(${node.shadow.offsetX ?? 0}px ${node.shadow.offsetY ?? 2}px ${node.shadow.blur}px ${node.shadow.color})`);
      if (node.glow)   filters.push(`drop-shadow(0 0 ${node.glow.blur}px ${node.glow.color})`);
      const filter = filters.length ? filters.join(' ') : undefined;
      const anchor = node.align === 'left' ? 'start' : node.align === 'right' ? 'end' : 'middle';
      return (
        <text
          x={node.x} y={node.y}
          fill={fill ?? '#ffffff'}
          stroke={node.stroke?.color ?? 'none'}
          strokeWidth={node.stroke?.width ?? 0}
          paintOrder="stroke"
          fontFamily={node.fontFamily ?? 'Inter'}
          fontWeight={String(node.fontWeight ?? '700')}
          fontSize={node.fontSize ?? 64}
          letterSpacing={node.letterSpacing ?? 0}
          textAnchor={anchor as any}
          dominantBaseline="alphabetic"
          style={{ filter }}
        >{transformText(node.text)}</text>
      );
    }
  }
}

// ── Node origin (for transform) ────────────────────────────────────────────

function computeNodeOrigin(node: GraphicNode): { x: number; y: number } {
  const o = node.origin ?? { x: 0.5, y: 0.5 };
  switch (node.kind) {
    case 'rect':   return { x: node.x + node.width * o.x, y: node.y + node.height * o.y };
    case 'circle': return { x: node.x, y: node.y };
    case 'line':   return { x: (node.x + node.x2) / 2, y: (node.y + node.y2) / 2 };
    case 'image':  return { x: node.x + node.width * o.x, y: node.y + node.height * o.y };
    case 'text':   return { x: node.x, y: node.y };
    case 'path':   return { x: node.x, y: node.y };
  }
}

// ── Path translate helper ──────────────────────────────────────────────────
// SVG paths are absolute or relative coordinate sequences. To honor the
// node's x/y offset we wrap the path in a local translate via a parent <g>.
// But to keep node opacity/transform composable we take a quick shortcut:
// simply prepend a "translate" by inserting a "transform" into the parent g
// at render time. Simpler: just leave coords absolute and add x,y to first
// "M" if path is relative-only. For v1, we ignore (require absolute paths).

function translatePathD(d: string, dx: number, dy: number): string {
  // Quick optimization: if x and y are zero, return as-is.
  if (dx === 0 && dy === 0) return d;
  // Wrap with a leading move offset — but this changes path semantics.
  // Safer: callers should pass absolute path d and use node x/y as transform.
  return d; // path nodes ignore x/y in author space for v1; AI will use transform tracks
}

// ── Bounding box ───────────────────────────────────────────────────────────

function computeBBox(nodes: GraphicNode[]): { x: number; y: number; w: number; h: number } | null {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = nodeBounds(n);
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  if (!isFinite(minX) || !isFinite(maxX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function nodeBounds(n: GraphicNode): { x: number; y: number; w: number; h: number } {
  switch (n.kind) {
    case 'rect':   return { x: n.x, y: n.y, w: n.width, h: n.height };
    case 'circle': return { x: n.x - n.radius, y: n.y - n.radius, w: n.radius * 2, h: n.radius * 2 };
    case 'line':   return {
      x: Math.min(n.x, n.x2), y: Math.min(n.y, n.y2),
      w: Math.abs(n.x2 - n.x), h: Math.abs(n.y2 - n.y),
    };
    case 'image':  return { x: n.x, y: n.y, w: n.width, h: n.height };
    case 'text':   return { x: n.x - 200, y: n.y - 80, w: 400, h: 100 }; // rough
    case 'path':   return { x: n.x, y: n.y, w: 100, h: 100 }; // rough
  }
}
