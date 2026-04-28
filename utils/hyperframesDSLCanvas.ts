/**
 * hyperframesDSLCanvas.ts
 *
 * Canvas-side renderer for the Hyperframes DSL. Mirrors HyperframesDSLOverlay
 * exactly so preview matches export.
 *
 * Authoring space: 1920x1080. We compute layout in author space, then scale
 * to output dimensions using `compositionScale` (same as the per-composition
 * canvas drawers in hyperframesCanvasRenderer.ts).
 */

import type { HyperframesConfig } from '../types';
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
} from './hyperframesDSL';

interface DSLCanvasParams {
  ctx: CanvasRenderingContext2D;
  text: string;
  config: HyperframesConfig;
  timeOffset: number;
  mediaTime: number;
  subtitleStart: number;
  subtitleEnd: number;
  wordTimings?: WordTiming[];
  outputWidth: number;
  outputHeight: number;
}

function compositionScale(outW: number, outH: number) {
  const sc = Math.min(outW / DSL_COMP_W, outH / DSL_COMP_H);
  return {
    sc,
    offsetX: outW / 2 - (DSL_COMP_W * sc) / 2,
    offsetY: outH / 2 - (DSL_COMP_H * sc) / 2,
  };
}

function buildFont(weight: string | number, sizePx: number, family: string): string {
  const needsQuotes = !family.includes(',') && /\s/.test(family) && !family.startsWith('"');
  const quotedFamily = needsQuotes ? `"${family}"` : family;
  return `${weight} ${sizePx}px ${quotedFamily}, sans-serif`;
}

interface UnitMeasure {
  text: string;
  width: number;
  /** Author-space x of unit center (within its line, before line centering) */
  cx: number;
  globalIndex: number;
  localIndex: number;
  lineIndex: number;
}

interface LineLayout {
  units: UnitMeasure[];
  totalWidth: number;
  /** Author-space y baseline */
  baselineY: number;
  /** Author-space x of line center */
  centerX: number;
}

export function drawDSLCaption(p: DSLCanvasParams): void {
  const dsl = p.config.dsl;
  if (!dsl) return;

  const { ctx } = p;
  const { sc, offsetX, offsetY } = compositionScale(p.outputWidth, p.outputHeight);

  const fontSize   = dsl.style.fontSize ?? 80;
  const fontFamily = dsl.style.fontFamily ?? 'Inter';
  const fontWeight = String(dsl.style.fontWeight ?? '700');
  const baseColor  = dsl.style.color ?? '#ffffff';
  const tt         = dsl.style.textTransform ?? 'none';
  const letterSp   = dsl.style.letterSpacing ?? 0;
  const lineHeight = (dsl.layout.lineHeight ?? 1.15) * fontSize;
  const maxChars   = 40;
  const align      = dsl.layout.align ?? 'center';

  ctx.save();
  ctx.font = buildFont(fontWeight, fontSize, fontFamily);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(p.text, tt);
  const { units, lines } = splitText(displayText, dsl.split, maxChars);

  // ── Layout pass: measure widths and position units in author space ────────
  const wordGap = ctx.measureText(' ').width;
  const lineLayouts: LineLayout[] = [];
  const lineToUnits = new Map<number, typeof units>();
  units.forEach(u => {
    if (!lineToUnits.has(u.lineIndex)) lineToUnits.set(u.lineIndex, []);
    lineToUnits.get(u.lineIndex)!.push(u);
  });

  // Determine total lines for vertical positioning
  const totalLines = Math.max(lineToUnits.size, lines.length || 1);
  const totalHeight = (totalLines - 1) * lineHeight;
  const bottomEdgeY = DSL_COMP_H - dsl.layout.bottom;

  for (let i = 0; i < totalLines; i++) {
    const lineUs = lineToUnits.get(i) ?? [];
    let cursor = 0;
    const measured: UnitMeasure[] = lineUs.map((u, idx) => {
      const w = ctx.measureText(u.text).width;
      const cx = cursor + w / 2;
      cursor += w;
      // Spacing between units
      if (dsl.split === 'word' && idx < lineUs.length - 1) cursor += wordGap;
      // letters: no extra gap (joined inside a word)
      // For 'letter' mode, we still want word spacing — but our split puts letters from
      // different words sequentially. Insert gap when next unit's localIndex resets to 0.
      if (dsl.split === 'letter' && idx < lineUs.length - 1) {
        const next = lineUs[idx + 1];
        if (next.localIndex === 0) cursor += wordGap;
      }
      return { text: u.text, width: w, cx, globalIndex: u.globalIndex, localIndex: u.localIndex, lineIndex: u.lineIndex };
    });
    const totalWidth = cursor;
    // Vertical: top line first, then descend
    const topBaseline = bottomEdgeY - totalHeight + (totalLines - 1 - i) * 0; // we layout top→down; index 0 is top line
    // Actually we want lines stacked from top to bottom of the block:
    // line 0 baseline = bottomEdgeY - (totalLines - 1) * lineHeight
    // line N baseline = bottomEdgeY
    const baselineY = bottomEdgeY - (totalLines - 1 - i) * lineHeight;
    const centerX = align === 'left'
      ? (60 + totalWidth / 2)
      : align === 'right' ? (DSL_COMP_W - 60 - totalWidth / 2)
      : DSL_COMP_W / 2;
    lineLayouts.push({ units: measured, totalWidth, baselineY, centerX });
  }

  // ── Karaoke active word ───────────────────────────────────────────────────
  const ws = displayText.split(/\s+/).filter(Boolean);
  const timings = p.wordTimings && p.wordTimings.length
    ? p.wordTimings
    : syntheticWordTimings(ws, p.subtitleStart, p.subtitleEnd);
  const activeIdx = dsl.karaoke?.enabled ? activeWordIndex(timings, p.mediaTime) : -1;

  // ── RGB split (jitter is time-based) ──────────────────────────────────────
  let rgbRed: { x: number; y: number } | null = null;
  let rgbBlue: { x: number; y: number } | null = null;
  if (dsl.effects?.rgbSplit) {
    const r = dsl.effects.rgbSplit;
    const jitter = r.jitter ?? 0;
    const freq   = r.jitterFreq ?? 8;
    const t = p.mediaTime;
    const jx = jitter > 0 ? Math.sin(t * freq * 6.28) * jitter : 0;
    const jy = jitter > 0 ? Math.cos(t * freq * 7.13) * jitter : 0;
    rgbRed  = { x: r.redOffset[0]  + jx, y: r.redOffset[1]  + jy };
    rgbBlue = { x: r.blueOffset[0] - jx, y: r.blueOffset[1] - jy };
  }

  // ── Apply scale + offset transform ────────────────────────────────────────
  ctx.translate(offsetX, offsetY);
  ctx.scale(sc, sc);

  const totalUnits = units.length;
  const stagger    = dsl.stagger ?? 0;
  const staggerFn  = dsl.staggerFn ?? 'linear';
  const duration   = dsl.duration;

  // ── Per-unit draw ─────────────────────────────────────────────────────────
  for (const line of lineLayouts) {
    const lineLeft = line.centerX - line.totalWidth / 2;
    for (const u of line.units) {
      const t0 = staggerOffset(u.globalIndex, totalUnits, stagger, staggerFn);
      const unitTime = p.timeOffset - t0;
      const v = evaluateTracks(dsl.tracks, duration, unitTime, p.mediaTime, u.globalIndex);

      // Word index for karaoke (word splits: globalIndex == word; letter splits: derive)
      const wordIdxForUnit = dsl.split === 'word' ? u.globalIndex : -1;
      const isActive = dsl.karaoke?.enabled && wordIdxForUnit === activeIdx;
      const isPast   = dsl.karaoke?.enabled && wordIdxForUnit >= 0 && wordIdxForUnit < activeIdx;

      let color = baseColor;
      if (v.colorMix !== undefined && v.colorPair) {
        color = mixHexColors(v.colorPair[0], v.colorPair[1], v.colorMix) || color;
      }
      if (isActive && dsl.karaoke?.color) color = dsl.karaoke.color;

      const opacity = v.opacity * (isPast ? (dsl.karaoke?.pastOpacity ?? 1) : 1);
      const karaokeScale = isActive && dsl.karaoke?.scale ? dsl.karaoke.scale : 1;

      const cx = lineLeft + u.cx + v.translateX;
      const cy = line.baselineY + v.translateY;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
      ctx.translate(cx, cy);
      ctx.rotate((v.rotate * Math.PI) / 180);
      ctx.scale(v.scaleX * karaokeScale, v.scaleY * karaokeScale);

      // Karaoke background bar
      if (isActive && dsl.karaoke?.background && dsl.karaoke.background.color !== 'transparent') {
        const bg = dsl.karaoke.background;
        ctx.fillStyle = bg.color;
        const w = u.width + bg.padX * 2;
        const h = fontSize + bg.padY * 2;
        const radius = 6;
        const x = -w / 2;
        const y = -fontSize * 0.78 - bg.padY;
        roundRect(ctx, x, y, w, h, radius);
        ctx.fill();
      }

      // Setup font for child draws
      ctx.font = buildFont(fontWeight, fontSize, fontFamily);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      // Filter (blur)
      if (v.blur > 0) ctx.filter = `blur(${v.blur}px)`;

      // RGB split ghosts behind main
      if (rgbRed && rgbBlue) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = '#ff0044';
        ctx.fillText(u.text, rgbRed.x, rgbRed.y);
        ctx.fillStyle = '#00ddff';
        ctx.fillText(u.text, rgbBlue.x, rgbBlue.y);
        ctx.restore();
      }

      // Glow / shadow / stroke / fill
      const shadow = dsl.effects?.shadow;
      const glow   = isActive && dsl.karaoke?.glow ? dsl.karaoke.glow : dsl.effects?.glow;
      const stroke = isActive && dsl.karaoke?.stroke ? dsl.karaoke.stroke : dsl.effects?.stroke;

      if (glow) {
        ctx.save();
        ctx.shadowColor = glow.color;
        ctx.shadowBlur = glow.blur;
        ctx.fillStyle = color;
        ctx.fillText(u.text, 0, 0);
        ctx.restore();
      } else if (shadow) {
        ctx.shadowColor = shadow.color;
        ctx.shadowBlur = shadow.blur;
        ctx.shadowOffsetX = shadow.offsetX ?? 0;
        ctx.shadowOffsetY = shadow.offsetY ?? 2;
      }

      if (stroke && stroke.width > 0) {
        ctx.lineWidth = stroke.width;
        ctx.strokeStyle = stroke.color;
        ctx.lineJoin = 'round';
        ctx.strokeText(u.text, 0, 0);
      }

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.fillText(u.text, 0, 0);

      ctx.restore();
    }
  }

  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}
