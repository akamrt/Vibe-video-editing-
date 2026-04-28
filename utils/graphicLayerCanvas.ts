/**
 * graphicLayerCanvas.ts
 *
 * Canvas-side renderer for GraphicLayer overlays. Mirrors GraphicLayerOverlay
 * exactly so preview matches export.
 *
 * Authoring space: 1920x1080. Output is scaled to fit the export canvas.
 *
 * Image nodes: a small async preloader cache keeps decoded HTMLImageElements
 * keyed by src so per-frame draws are synchronous.
 */

import type { GraphicLayer, GraphicNode, HyperframesDSL } from '../types';
import {
  DSL_COMP_W, DSL_COMP_H,
  evaluateTracks,
  DEFAULT_TRACK_VALUES,
  mixHexColors,
} from './hyperframesDSL';

// ── Image cache ─────────────────────────────────────────────────────────────

const imgCache = new Map<string, HTMLImageElement>();

export async function preloadGraphicImages(layers: GraphicLayer[]): Promise<void> {
  const srcs = new Set<string>();
  for (const l of layers) {
    for (const n of l.dsl.graphics ?? []) {
      if (n.kind === 'image' && n.src && !imgCache.has(n.src)) srcs.add(n.src);
    }
  }
  await Promise.all(Array.from(srcs).map(loadImg));
}

function loadImg(src: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imgCache.set(src, img); resolve(); };
    img.onerror = () => { resolve(); };  // silently skip broken images
    img.src = src;
  });
}

// ── Main entry: draw all active layers at the given media time ──────────────

export interface GraphicLayerCanvasParams {
  ctx: CanvasRenderingContext2D;
  layers: GraphicLayer[];
  mediaTime: number;
  outputWidth: number;
  outputHeight: number;
}

export function drawGraphicLayers(params: GraphicLayerCanvasParams): void {
  const { ctx, layers, mediaTime, outputWidth, outputHeight } = params;
  if (!layers.length) return;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.filter = 'none';
  ctx.resetTransform();

  const sc = Math.min(outputWidth / DSL_COMP_W, outputHeight / DSL_COMP_H);
  const offsetX = outputWidth / 2 - (DSL_COMP_W * sc) / 2;
  const offsetY = outputHeight / 2 - (DSL_COMP_H * sc) / 2;

  // Apply scale + offset transform once
  ctx.translate(offsetX, offsetY);
  ctx.scale(sc, sc);

  // z-order
  const sorted = [...layers].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
  for (const layer of sorted) {
    if (layer.visible === false) continue;
    if (mediaTime < layer.startTime || mediaTime > layer.endTime) continue;
    drawLayer(ctx, layer, mediaTime);
  }

  ctx.restore();
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: GraphicLayer, mediaTime: number) {
  const layerTime = mediaTime - layer.startTime;
  const layerLength = layer.endTime - layer.startTime;

  let layerOpacity = 1;
  const fadeIn  = layer.fadeInDuration ?? 0;
  const fadeOut = layer.fadeOutDuration ?? 0;
  if (fadeIn > 0 && layerTime < fadeIn) layerOpacity = layerTime / fadeIn;
  if (fadeOut > 0 && layerTime > layerLength - fadeOut) layerOpacity = Math.max(0, (layerLength - layerTime) / fadeOut);

  const tx = layer.translateX ?? 0;
  const ty = layer.translateY ?? 0;
  const lscale = layer.scale ?? 1;
  const lrot   = layer.rotation ?? 0;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, layerOpacity));
  ctx.translate(tx, ty);
  if (lrot) ctx.rotate((lrot * Math.PI) / 180);
  if (lscale !== 1) ctx.scale(lscale, lscale);

  const dsl = layer.dsl;
  const nodes = dsl.graphics ?? [];
  nodes.forEach((node, i) => drawNode(ctx, node, dsl, layerTime, mediaTime, i));

  ctx.restore();
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: GraphicNode,
  dsl: HyperframesDSL,
  layerTime: number,
  mediaTime: number,
  unitIndex: number,
) {
  const appearAt = node.appearAt ?? 0;
  const disappearAt = node.disappearAt ?? Infinity;
  if (layerTime < appearAt || layerTime > disappearAt) return;

  const animDuration = node.animDuration ?? dsl.duration ?? 0.5;
  const nodeTime = layerTime - appearAt;
  const tracks = node.tracks ?? [];
  const v = tracks.length
    ? evaluateTracks(tracks, animDuration, nodeTime, mediaTime, unitIndex)
    : DEFAULT_TRACK_VALUES;

  const origin = nodeOrigin(node);
  const opacity = (node.opacity ?? 1) * v.opacity;
  const colorMixedFill = v.colorMix !== undefined && v.colorPair
    ? mixHexColors(v.colorPair[0], v.colorPair[1], v.colorMix) || undefined
    : undefined;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  if (v.blur > 0) ctx.filter = `blur(${v.blur}px)`;

  // Apply node transform: translate origin → rotate → scale → translate back
  ctx.translate(v.translateX, v.translateY);
  ctx.translate(origin.x, origin.y);
  if (v.rotate) ctx.rotate((v.rotate * Math.PI) / 180);
  if (v.scaleX !== 1 || v.scaleY !== 1) ctx.scale(v.scaleX, v.scaleY);
  // Skew via setTransform combination is non-trivial; v1 ignores skew on canvas
  ctx.translate(-origin.x, -origin.y);

  switch (node.kind) {
    case 'rect':   drawRect(ctx, node, colorMixedFill); break;
    case 'circle': drawCircle(ctx, node, colorMixedFill); break;
    case 'line':   drawLine(ctx, node); break;
    case 'image':  drawImage(ctx, node); break;
    case 'text':   drawText(ctx, node, colorMixedFill); break;
    case 'path':   drawPath(ctx, node, colorMixedFill); break;
  }

  ctx.restore();
}

function drawRect(ctx: CanvasRenderingContext2D, n: Extract<GraphicNode, { kind: 'rect' }>, fill?: string) {
  const r = n.cornerRadius ?? 0;
  if (r > 0) {
    roundRect(ctx, n.x, n.y, n.width, n.height, Math.min(r, n.width / 2, n.height / 2));
  } else {
    ctx.beginPath();
    ctx.rect(n.x, n.y, n.width, n.height);
  }
  if (fill ?? n.fill) {
    ctx.fillStyle = (fill ?? n.fill)!;
    ctx.fill();
  }
  if (n.stroke && (n.strokeWidth ?? 0) > 0) {
    ctx.strokeStyle = n.stroke;
    ctx.lineWidth = n.strokeWidth!;
    ctx.stroke();
  }
}

function drawCircle(ctx: CanvasRenderingContext2D, n: Extract<GraphicNode, { kind: 'circle' }>, fill?: string) {
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
  if (fill ?? n.fill) {
    ctx.fillStyle = (fill ?? n.fill)!;
    ctx.fill();
  }
  if (n.stroke && (n.strokeWidth ?? 0) > 0) {
    ctx.strokeStyle = n.stroke;
    ctx.lineWidth = n.strokeWidth!;
    ctx.stroke();
  }
}

function drawLine(ctx: CanvasRenderingContext2D, n: Extract<GraphicNode, { kind: 'line' }>) {
  const p = n.drawProgress ?? 1;
  const tx = n.x + (n.x2 - n.x) * p;
  const ty = n.y + (n.y2 - n.y) * p;
  ctx.beginPath();
  ctx.moveTo(n.x, n.y);
  ctx.lineTo(tx, ty);
  ctx.strokeStyle = n.stroke;
  ctx.lineWidth = n.strokeWidth;
  ctx.lineCap = (n.lineCap ?? 'round') as CanvasLineCap;
  ctx.stroke();
}

function drawImage(ctx: CanvasRenderingContext2D, n: Extract<GraphicNode, { kind: 'image' }>) {
  const img = imgCache.get(n.src);
  if (!img || !img.complete || img.naturalWidth === 0) return;
  try {
    ctx.drawImage(img, n.x, n.y, n.width, n.height);
  } catch (e) {
    // Tainted canvas (cross-origin) — fail silently
  }
}

function drawText(ctx: CanvasRenderingContext2D, n: Extract<GraphicNode, { kind: 'text' }>, fill?: string) {
  const family = n.fontFamily ?? 'Inter';
  const weight = String(n.fontWeight ?? '700');
  const size   = n.fontSize ?? 64;
  const needsQuotes = !family.includes(',') && /\s/.test(family) && !family.startsWith('"');
  const fam = needsQuotes ? `"${family}"` : family;
  ctx.font = `${weight} ${size}px ${fam}, sans-serif`;
  (ctx as any).letterSpacing = `${n.letterSpacing ?? 0}px`;
  ctx.textAlign = (n.align ?? 'center') as CanvasTextAlign;
  ctx.textBaseline = 'alphabetic';

  const display = transformText(n.text, n.textTransform);
  const color = fill ?? n.color ?? '#ffffff';

  // Glow first (drawn as shadow)
  if (n.glow) {
    ctx.save();
    ctx.shadowColor = n.glow.color;
    ctx.shadowBlur = n.glow.blur;
    ctx.fillStyle = color;
    ctx.fillText(display, n.x, n.y);
    ctx.restore();
  } else if (n.shadow) {
    ctx.shadowColor = n.shadow.color;
    ctx.shadowBlur = n.shadow.blur;
    ctx.shadowOffsetX = n.shadow.offsetX ?? 0;
    ctx.shadowOffsetY = n.shadow.offsetY ?? 2;
  }

  if (n.stroke && n.stroke.width > 0) {
    ctx.lineWidth = n.stroke.width;
    ctx.strokeStyle = n.stroke.color;
    ctx.lineJoin = 'round';
    ctx.strokeText(display, n.x, n.y);
  }

  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.fillText(display, n.x, n.y);
}

function drawPath(ctx: CanvasRenderingContext2D, n: Extract<GraphicNode, { kind: 'path' }>, fill?: string) {
  // Use Path2D to parse SVG path data. Then offset by node.x/y.
  let p: Path2D;
  try { p = new Path2D(n.d); }
  catch { return; }
  ctx.save();
  ctx.translate(n.x, n.y);
  if (fill ?? n.fill) {
    ctx.fillStyle = (fill ?? n.fill)!;
    ctx.fill(p);
  }
  if (n.stroke && (n.strokeWidth ?? 0) > 0) {
    ctx.strokeStyle = n.stroke;
    ctx.lineWidth = n.strokeWidth!;
    ctx.stroke(p);
  }
  ctx.restore();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nodeOrigin(n: GraphicNode): { x: number; y: number } {
  const o = n.origin ?? { x: 0.5, y: 0.5 };
  switch (n.kind) {
    case 'rect':   return { x: n.x + n.width * o.x, y: n.y + n.height * o.y };
    case 'circle': return { x: n.x, y: n.y };
    case 'line':   return { x: (n.x + n.x2) / 2, y: (n.y + n.y2) / 2 };
    case 'image':  return { x: n.x + n.width * o.x, y: n.y + n.height * o.y };
    case 'text':   return { x: n.x, y: n.y };
    case 'path':   return { x: n.x, y: n.y };
  }
}

function transformText(text: string, t?: string): string {
  switch (t) {
    case 'uppercase':  return text.toUpperCase();
    case 'lowercase':  return text.toLowerCase();
    case 'capitalize': return text.replace(/\b\w/g, c => c.toUpperCase());
    default:           return text;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
