/**
 * GraphicLayerOverlay
 *
 * Renders GraphicLayers as SVG overlays in 1920x1080 author space, scaled to
 * fit the viewport.
 *
 * Selection: click a layer to select it. Drag the body to move (translateX/Y).
 * Drag corner handles to scale. Drag the top rotation handle to rotate.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphicLayer, GraphicNode, HyperframesDSL } from '../types';
import { getInterpolatedTransform } from '../utils/interpolation';
import {
  DSL_COMP_W, DSL_COMP_H,
  evaluateTracks,
  DEFAULT_TRACK_VALUES,
  mixHexColors,
} from '../utils/hyperframesDSL';

interface Props {
  layers: GraphicLayer[];
  mediaTime: number;
  isPlaying: boolean;
  containerWidth: number;
  containerHeight: number;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onUpdateLayer?: (id: string, patch: Partial<GraphicLayer>) => void;
}

function computeViewScale(w: number, h: number) {
  return Math.min(w / DSL_COMP_W, h / DSL_COMP_H);
}

export default function GraphicLayerOverlay({
  layers, mediaTime, isPlaying,
  containerWidth, containerHeight,
  selectedId, onSelect, onUpdateLayer,
}: Props) {
  const [tick, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const baselineRef = useRef({ time: mediaTime, wallclock: performance.now(), playing: isPlaying });
  const svgRef = useRef<SVGSVGElement>(null);

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

  const viewScale = computeViewScale(containerWidth, containerHeight);
  // Letterbox offsets (SVG "meet" puts content centered)
  const offsetX = (containerWidth  - DSL_COMP_W * viewScale) / 2;
  const offsetY = (containerHeight - DSL_COMP_H * viewScale) / 2;

  const activeLayers = useMemo(() => {
    return layers
      .filter(l => l.visible !== false && effectiveTime >= l.startTime && effectiveTime <= l.endTime)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  }, [layers, effectiveTime]);

  // Convert a screen-space point to SVG/author-space
  const screenToSVG = useCallback((sx: number, sy: number) => ({
    x: (sx - offsetX) / viewScale,
    y: (sy - offsetY) / viewScale,
  }), [offsetX, offsetY, viewScale]);

  if (!activeLayers.length) return null;

  return (
    <svg
      ref={svgRef}
      width={containerWidth}
      height={containerHeight}
      viewBox={`0 0 ${DSL_COMP_W} ${DSL_COMP_H}`}
      preserveAspectRatio="xMidYMid meet"
      style={{
        position: 'absolute', inset: 0,
        width: containerWidth, height: containerHeight,
        pointerEvents: 'auto',
        overflow: 'visible',
        zIndex: 9000,
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
          onUpdateLayer={onUpdateLayer}
          screenToSVG={screenToSVG}
        />
      ))}
    </svg>
  );
}

// ── Layer group ─────────────────────────────────────────────────────────────

type DragState =
  | { type: 'move'; startSVGX: number; startSVGY: number; startTx: number; startTy: number }
  | { type: 'scale'; pivotSVGX: number; pivotSVGY: number; startScale: number; startDist: number }
  | { type: 'rotate'; pivotSVGX: number; pivotSVGY: number; startRotation: number; startAngle: number };

function LayerGroup({
  layer, mediaTime, selected, onSelect, onUpdateLayer, screenToSVG,
}: {
  layer: GraphicLayer;
  mediaTime: number;
  selected: boolean;
  onSelect?: (id: string | null) => void;
  onUpdateLayer?: (id: string, patch: Partial<GraphicLayer>) => void;
  screenToSVG: (sx: number, sy: number) => { x: number; y: number };
}) {
  const layerTime = mediaTime - layer.startTime;
  const layerLength = layer.endTime - layer.startTime;
  const dragRef = useRef<DragState | null>(null);
  const groupRef = useRef<SVGGElement>(null);

  const fadeIn  = layer.fadeInDuration  ?? 0;
  const fadeOut = layer.fadeOutDuration ?? 0;
  const baseOpacity = layer.opacity ?? 1;
  let layerOpacity = baseOpacity;
  if (fadeIn > 0 && layerTime < fadeIn) layerOpacity = baseOpacity * (layerTime / fadeIn);
  if (fadeOut > 0 && layerTime > layerLength - fadeOut) layerOpacity = baseOpacity * Math.max(0, (layerLength - layerTime) / fadeOut);

  // Keyframes override static values when present (same system as video clips)
  const kf = layer.keyframes?.length
    ? getInterpolatedTransform(layer.keyframes, layerTime)
    : null;
  const tx     = kf ? kf.translateX : (layer.translateX ?? 0);
  const ty     = kf ? kf.translateY : (layer.translateY ?? 0);
  const lscale = kf ? kf.scale      : (layer.scale ?? 1);
  const lrot   = kf ? kf.rotation   : (layer.rotation ?? 0);

  const dsl      = layer.dsl;
  const graphics = dsl.graphics ?? [];

  const bbox = useMemo(() => computeBBox(graphics), [graphics]);

  // Pivot = bbox center in author/SVG space (accounting for translate but not scale/rotate)
  const pivotX = bbox ? tx + bbox.x + bbox.w / 2 : tx + DSL_COMP_W / 2;
  const pivotY = bbox ? ty + bbox.y + bbox.h / 2 : ty + DSL_COMP_H / 2;

  // Transform: rotate+scale around bbox center
  const cx = bbox ? bbox.x + bbox.w / 2 : DSL_COMP_W / 2;
  const cy = bbox ? bbox.y + bbox.h / 2 : DSL_COMP_H / 2;
  const transform = `translate(${tx},${ty}) translate(${cx},${cy}) rotate(${lrot}) scale(${lscale}) translate(${-cx},${-cy})`;

  // ── Pointer handlers ───────────────────────────────────────────────────────

  const onBodyPointerDown = (e: React.PointerEvent<SVGGElement>) => {
    e.stopPropagation();
    onSelect?.(layer.id);
    if (!onUpdateLayer || !selected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const svgPos = screenToSVG(e.clientX, e.clientY);
    dragRef.current = { type: 'move', startSVGX: svgPos.x, startSVGY: svgPos.y, startTx: tx, startTy: ty };
  };

  const startScaleDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const svgPos = screenToSVG(e.clientX, e.clientY);
    const dx = svgPos.x - pivotX;
    const dy = svgPos.y - pivotY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    dragRef.current = { type: 'scale', pivotSVGX: pivotX, pivotSVGY: pivotY, startScale: lscale, startDist: dist };
  };

  const startRotateDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const svgPos = screenToSVG(e.clientX, e.clientY);
    const angle = Math.atan2(svgPos.y - pivotY, svgPos.x - pivotX) * (180 / Math.PI);
    dragRef.current = { type: 'rotate', pivotSVGX: pivotX, pivotSVGY: pivotY, startRotation: lrot, startAngle: angle };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !onUpdateLayer) return;
    const svgPos = screenToSVG(e.clientX, e.clientY);

    if (d.type === 'move') {
      onUpdateLayer(layer.id, {
        translateX: d.startTx + (svgPos.x - d.startSVGX),
        translateY: d.startTy + (svgPos.y - d.startSVGY),
      });
    } else if (d.type === 'scale') {
      const dx = svgPos.x - d.pivotSVGX;
      const dy = svgPos.y - d.pivotSVGY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const newScale = Math.max(0.05, d.startScale * (dist / d.startDist));
      onUpdateLayer(layer.id, { scale: parseFloat(newScale.toFixed(3)) });
    } else if (d.type === 'rotate') {
      const dx = svgPos.x - d.pivotSVGX;
      const dy = svgPos.y - d.pivotSVGY;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      let newRot = d.startRotation + (angle - d.startAngle);
      // Snap to 15° increments when within 5° of a multiple
      if (e.shiftKey) newRot = Math.round(newRot / 15) * 15;
      onUpdateLayer(layer.id, { rotation: parseFloat(newRot.toFixed(1)) });
    }
  };

  const onPointerUp = () => { dragRef.current = null; };

  // ── Selection handles ──────────────────────────────────────────────────────
  // Rendered in unscaled SVG space at the bbox corners and top-center.
  // We un-apply the layer transform so handles sit at the visual edges.

  const HANDLE_R = 10;  // handle radius in author px
  const ROT_OFFSET = 40; // how far above bbox the rotation handle sits

  const selectionHandles = selected && bbox && onUpdateLayer ? (() => {
    // The bbox corners in content space, after scale+rotate around (cx,cy), then translated by (tx,ty)
    // For rendering the selection outline, we render it INSIDE the group (already transformed),
    // so bbox coords are in local content space. Handles appear at scaled/rotated corners.
    const pad = 20;
    const bx = bbox.x - pad, by = bbox.y - pad;
    const bw = bbox.w + pad * 2, bh = bbox.h + pad * 2;
    const bcx = bbox.x + bbox.w / 2, bcy = bbox.y + bbox.h / 2;
    // Handle radius adjusted for current scale so they appear constant-size on screen
    const hr = HANDLE_R / lscale;
    const strokeW = 2 / lscale;

    return (
      <g style={{ pointerEvents: 'all' }}>
        {/* Selection box */}
        <rect
          x={bx} y={by} width={bw} height={bh}
          fill="rgba(108,99,255,0.05)" stroke="#6c63ff" strokeWidth={strokeW * 1.5}
          strokeDasharray={`${8/lscale} ${5/lscale}`}
          style={{ pointerEvents: 'none' }}
        />
        {/* Corner scale handles */}
        {([
          [bx,    by],
          [bx+bw, by],
          [bx,    by+bh],
          [bx+bw, by+bh],
        ] as [number,number][]).map(([hx, hy], i) => (
          <circle
            key={i}
            cx={hx} cy={hy} r={hr}
            fill="#6c63ff" stroke="white" strokeWidth={strokeW}
            style={{ cursor: 'nwse-resize' }}
            onPointerDown={startScaleDrag}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
        {/* Rotation handle — above top-center */}
        <line
          x1={bcx} y1={by}
          x2={bcx} y2={by - ROT_OFFSET / lscale}
          stroke="#a78bfa" strokeWidth={strokeW}
          style={{ pointerEvents: 'none' }}
        />
        <circle
          cx={bcx} cy={by - ROT_OFFSET / lscale} r={hr}
          fill="#a78bfa" stroke="white" strokeWidth={strokeW}
          style={{ cursor: 'crosshair' }}
          onPointerDown={startRotateDrag}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </g>
    );
  })() : null;

  return (
    <g
      ref={groupRef}
      transform={transform}
      opacity={layerOpacity}
      onPointerDown={onBodyPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ cursor: selected ? 'move' : 'pointer' }}
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
      {selectionHandles}
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
  const appearAt    = node.appearAt    ?? 0;
  const disappearAt = node.disappearAt ?? Infinity;
  if (layerTime < appearAt || layerTime > disappearAt) return null;

  const animDuration = node.animDuration ?? dsl.duration ?? 0.5;
  const nodeTime     = layerTime - appearAt;
  const tracks       = node.tracks ?? [];
  const v = tracks.length
    ? evaluateTracks(tracks, animDuration, nodeTime, mediaTime, unitIndex)
    : DEFAULT_TRACK_VALUES;

  const origin = computeNodeOrigin(node);
  const ox = origin.x, oy = origin.y;

  const trans = `translate(${v.translateX}, ${v.translateY})`;
  const rot   = `rotate(${v.rotate}, ${ox}, ${oy})`;
  const scl   = `translate(${ox}, ${oy}) scale(${v.scaleX}, ${v.scaleY}) translate(${-ox}, ${-oy})`;
  const skew  = (v.skewX || v.skewY) ? `skewX(${v.skewX}) skewY(${v.skewY})` : '';

  const groupTransform = `${trans} ${rot} ${scl} ${skew}`.trim();
  const opacity = (node.opacity ?? 1) * v.opacity;
  const filter  = v.blur > 0 ? `blur(${v.blur}px)` : undefined;

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
      const p  = node.drawProgress ?? 1;
      const lx = node.x + (node.x2 - node.x) * p;
      const ly = node.y + (node.y2 - node.y) * p;
      return (
        <line
          x1={node.x} y1={node.y} x2={lx} y2={ly}
          stroke={node.stroke}
          strokeWidth={node.strokeWidth}
          strokeLinecap={node.lineCap ?? 'round'}
        />
      );
    }
    case 'path': return (
      <path
        d={node.d}
        fill={fill ?? 'none'}
        stroke={node.stroke ?? 'none'}
        strokeWidth={node.strokeWidth ?? 0}
        transform={node.x || node.y ? `translate(${node.x},${node.y})` : undefined}
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
          case 'uppercase':  return t.toUpperCase();
          case 'lowercase':  return t.toLowerCase();
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
          fill={fill ?? node.color ?? '#ffffff'}
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

// ── Node origin ─────────────────────────────────────────────────────────────

function computeNodeOrigin(node: GraphicNode): { x: number; y: number } {
  const o = node.origin ?? { x: 0.5, y: 0.5 };
  switch (node.kind) {
    case 'rect':   return { x: node.x + node.width * o.x,  y: node.y + node.height * o.y };
    case 'circle': return { x: node.x, y: node.y };
    case 'line':   return { x: (node.x + node.x2) / 2,     y: (node.y + node.y2) / 2 };
    case 'image':  return { x: node.x + node.width * o.x,  y: node.y + node.height * o.y };
    case 'text':   return { x: node.x, y: node.y };
    case 'path':   return { x: node.x, y: node.y };
  }
}

// ── Bounding box ────────────────────────────────────────────────────────────

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
    case 'rect':   return { x: n.x,            y: n.y,            w: n.width,         h: n.height };
    case 'circle': return { x: n.x - n.radius, y: n.y - n.radius, w: n.radius * 2,    h: n.radius * 2 };
    case 'line':   return { x: Math.min(n.x, n.x2), y: Math.min(n.y, n.y2), w: Math.abs(n.x2 - n.x), h: Math.abs(n.y2 - n.y) };
    case 'image':  return { x: n.x,            y: n.y,            w: n.width,         h: n.height };
    case 'text':   return { x: n.x - 300,      y: n.y - 80,       w: 600,             h: 100 };
    case 'path':   return { x: n.x,            y: n.y,            w: 200,             h: 200 };
  }
}
