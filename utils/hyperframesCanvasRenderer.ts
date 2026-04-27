/**
 * hyperframesCanvasRenderer.ts
 *
 * Canvas-side equivalent of every composition in public/hyperframes/.
 * Each renderer replicates its composition's GSAP animation as pure math
 * so the export pipeline can draw Hyperframes captions without an iframe.
 *
 * Convention: all "size" variables in compositions are authored at 1920×1080.
 * We scale everything by Math.min(outputWidth/1920, outputHeight/1080) to match
 * the viewport's iframe scaling (same as HyperframesCaptionOverlay.computeScale).
 */

import type { HyperframesConfig } from '../types';

// ── Easing functions ────────────────────────────────────────────────────────

function clamp01(t: number) { return Math.max(0, Math.min(1, t)); }
function backOut(t: number, overshoot = 2): number {
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
}
function power3Out(t: number): number { return 1 - Math.pow(1 - t, 3); }
function power2In(t: number): number { return t * t; }
function power2Out(t: number): number { return 1 - (1 - t) * (1 - t); }
function power1Out(t: number): number { return 1 - (1 - t); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function deg(d: number): number { return d * Math.PI / 180; }

// ── Variable helpers ────────────────────────────────────────────────────────

function v(vars: Record<string, string | number | boolean>, key: string, fallback: string | number | boolean): string | number | boolean {
  return key in vars ? vars[key] : fallback;
}
function vStr(vars: Record<string, string | number | boolean>, key: string, fallback: string): string {
  return String(v(vars, key, fallback));
}
function vNum(vars: Record<string, string | number | boolean>, key: string, fallback: number): number {
  const val = Number(v(vars, key, fallback));
  return isNaN(val) ? fallback : val;
}
function vBool(vars: Record<string, string | number | boolean>, key: string, fallback: boolean): boolean {
  const raw = v(vars, key, fallback);
  if (typeof raw === 'boolean') return raw;
  return String(raw).toLowerCase() !== 'false' && String(raw) !== '0' && String(raw) !== '';
}

// ── Font / style helpers ────────────────────────────────────────────────────

/** Build a CSS font string. Auto-wraps multi-word single-family names in quotes.
 *  Passes fallback lists (comma-separated) through unchanged. */
function buildFont(weight: string | number, sizePx: number, family: string): string {
  // Comma = already a font stack, use as-is.
  // Multi-word name without quotes = wrap in quotes (e.g. "Courier Prime" → "Courier Prime").
  const needsQuotes = !family.includes(',') && /\s/.test(family) && !family.startsWith('"');
  const quotedFamily = needsQuotes ? `"${family}"` : family;
  return `${weight} ${sizePx}px ${quotedFamily}, sans-serif`;
}

function transformText(text: string, transform: string): string {
  switch (transform) {
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'capitalize': return text.replace(/\b\w/g, c => c.toUpperCase());
    default: return text;
  }
}

// ── Composition coordinate helpers ─────────────────────────────────────────
// The viewport renders compositions as a 1920×1080 iframe scaled by
// Math.min(containerW/1920, containerH/1080) and centered in the container.
// The canvas renderer must replicate the same scale and centering so that
// text position / size matches the viewport 1:1 for any aspect ratio.

const COMP_W = 1920;
const COMP_H = 1080;

/**
 * Returns:
 *  sc         — uniform scale that fits 1920×1080 into (outputWidth × outputHeight)
 *  compBottom — canvas Y coordinate of the composition's bottom edge (after centering)
 */
function compositionScale(outputWidth: number, outputHeight: number): { sc: number; compBottom: number } {
  const sc = Math.min(outputWidth / COMP_W, outputHeight / COMP_H);
  const compBottom = outputHeight / 2 + (COMP_H * sc) / 2;
  return { sc, compBottom };
}

// ── Text layout helper ──────────────────────────────────────────────────────

interface WordMeasure { word: string; width: number; x: number; }

function measureWords(ctx: CanvasRenderingContext2D, words: string[], gap: number): WordMeasure[] {
  let x = 0;
  return words.map(word => {
    const width = ctx.measureText(word).width;
    const m = { word, width, x: x + width / 2 };
    x += width + gap;
    return m;
  });
}

function centreLayout(measures: WordMeasure[], centreX: number): WordMeasure[] {
  if (!measures.length) return measures;
  const totalWidth = measures[measures.length - 1].x + measures[measures.length - 1].width / 2;
  const offset = centreX - totalWidth / 2;
  return measures.map(m => ({ ...m, x: m.x + offset }));
}

function words(text: string): string[] { return text.split(/\s+/).filter(Boolean); }

function wrapLines(text: string, maxChars = 40): string[] {
  const ws = words(text);
  const lines: string[] = [];
  let cur = '';
  for (const w of ws) {
    if (cur.length + w.length + 1 > maxChars && cur) { lines.push(cur.trim()); cur = w + ' '; }
    else cur += w + ' ';
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

// ── Karaoke: which word is active right now? ────────────────────────────────

export interface WordTiming { text: string; start: number; end: number }

/** Given a list of word timings (in media time) and the current media time, return active word index. -1 if none. */
function activeWordIndex(timings: WordTiming[] | undefined, mediaTime: number): number {
  if (!timings || !timings.length) return -1;
  for (let i = 0; i < timings.length; i++) {
    if (mediaTime >= timings[i].start && mediaTime <= timings[i].end) return i;
  }
  // Between words → pick the most recent past word
  let lastPast = -1;
  for (let i = 0; i < timings.length; i++) {
    if (timings[i].end < mediaTime) lastPast = i;
    else break;
  }
  return lastPast;
}

/** Fallback: spread the subtitle event evenly if no per-word timings exist */
function syntheticWordTimings(wordList: string[], startTime: number, endTime: number): WordTiming[] {
  const dur = endTime - startTime;
  const per = dur / Math.max(1, wordList.length);
  return wordList.map((w, i) => ({
    text: w,
    start: startTime + i * per,
    end:   startTime + (i + 1) * per,
  }));
}

// ── Apply text style (stroke + shadow) ──────────────────────────────────────

function applyTextStyle(ctx: CanvasRenderingContext2D, opts: {
  color: string; strokeColor?: string; strokeWidth?: number;
  shadowColor?: string; shadowBlur?: number;
}) {
  ctx.fillStyle = opts.color;
  if (opts.shadowColor && opts.shadowBlur) {
    ctx.shadowColor = opts.shadowColor;
    ctx.shadowBlur = opts.shadowBlur;
  } else {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
  if (opts.strokeColor && opts.strokeWidth && opts.strokeWidth > 0) {
    ctx.strokeStyle = opts.strokeColor;
    ctx.lineWidth = opts.strokeWidth;
    ctx.lineJoin = 'round';
  }
}

function drawTextWithStroke(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, hasStroke: boolean) {
  if (hasStroke) ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

// ── Main entry point ────────────────────────────────────────────────────────

export interface HFCanvasParams {
  ctx: CanvasRenderingContext2D;
  text: string;
  config: HyperframesConfig;
  timeOffset: number;           // seconds since subtitle event start (for animation)
  mediaTime: number;            // absolute media time (for word timing lookup)
  subtitleStart: number;        // subtitle startTime in media time
  subtitleEnd: number;          // subtitle endTime in media time
  wordTimings?: WordTiming[];   // per-word timings (AssemblyAI)
  outputWidth: number;
  outputHeight: number;
}

export function drawHyperframesCaption(params: HFCanvasParams): void {
  const id = params.config.compositionSrc.split('/').pop()?.replace('.html', '') ?? '';

  // Defensive: ensure canvas is in a clean state before drawing
  // (previous operations may leave compositing/alpha in unexpected states)
  params.ctx.globalAlpha = 1;
  params.ctx.globalCompositeOperation = 'source-over';
  params.ctx.shadowColor = 'transparent';
  params.ctx.shadowBlur = 0;
  params.ctx.filter = 'none';
  params.ctx.resetTransform();

  switch (id) {
    case 'bounce-caption':     return drawBounce(params);
    case 'slide-up-caption':   return drawSlideUp(params);
    case 'pop-word-caption':   return drawPop(params);
    case 'neon-caption':       return drawNeon(params);
    case 'typewriter-caption': return drawTypewriter(params);
    case 'karaoke-caption':    return drawKaraoke(params);
    case 'wave-caption':       return drawWave(params);
    case 'glitch-caption':     return drawGlitch(params);
    default:
      drawFallback(params);
  }
}

// ── Shared karaoke / word highlight application ─────────────────────────────

interface HighlightOpts {
  activeIdx: number;
  activeWordProgress: number;            // 0..1 within active word's time range
  color: string;                          // highlight text color
  scale: number;                          // multiplier (1 = no scale)
  glowColor: string;
  glowBlur: number;
  strokeColor: string;
  strokeWidth: number;
  bgColor: string;                        // background highlight bar
  bgPadX: number;                         // bg padding px
  bgPadY: number;
  enabled: boolean;
}

function hlOptsFromVars(
  variables: Record<string, string | number | boolean>,
  defaults: {
    color?: string; scale?: number; glow?: string; glowBlur?: number;
    strokeColor?: string; strokeWidth?: number; bg?: string;
  } = {},
  scale: number
): Omit<HighlightOpts, 'activeIdx' | 'activeWordProgress'> {
  return {
    enabled:     vBool(variables, 'highlight-enabled', true),
    color:       vStr(variables,  'highlight-color',        defaults.color       ?? '#FFD700'),
    scale:       vNum(variables,  'highlight-scale',        defaults.scale       ?? 1.15),
    glowColor:   vStr(variables,  'highlight-glow',         defaults.glow        ?? 'transparent'),
    glowBlur:    vNum(variables,  'highlight-glow-blur',    defaults.glowBlur    ?? 0) * scale,
    strokeColor: vStr(variables,  'highlight-stroke-color', defaults.strokeColor ?? 'transparent'),
    strokeWidth: vNum(variables,  'highlight-stroke-width', defaults.strokeWidth ?? 0) * scale,
    bgColor:     vStr(variables,  'highlight-bg-color',     defaults.bg          ?? 'transparent'),
    bgPadX:      vNum(variables,  'highlight-bg-padx', 14) * scale,
    bgPadY:      vNum(variables,  'highlight-bg-pady',  6) * scale,
  };
}

// ── 1. Bounce Caption ───────────────────────────────────────────────────────

function drawBounce(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, mediaTime, subtitleStart, subtitleEnd, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       80)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const shadowC = vStr(variables,  'shadow-color', '#000000');
  const shadowB = vNum(variables,  'shadow-blur',  8) * sc;
  const strokeC = vStr(variables,  'stroke-color', '#000000');
  const strokeW = vNum(variables,  'stroke-width', 3) * sc;
  const bottom  = Math.max(0, vNum(variables, 'bottom',    80)) * sc;
  const dur     = Math.max(0.01, vNum(variables, 'duration', 0.5));
  const stagger = Math.max(0,    vNum(variables, 'stagger',  0.06));
  const font    = vStr(variables,  'font-family', 'Impact, "Arial Black"');
  const weight  = vStr(variables,  'weight',      '900');
  const letterSp= vNum(variables,  'letter-spacing', 0) * sc;
  const tt      = vStr(variables,  'text-transform', 'none');
  const hl      = hlOptsFromVars(variables, { color: '#FFD700', scale: 1.2 }, sc);

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`; // modern browsers
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(text, tt);
  const ws = words(displayText);
  const gap = 8 * sc + letterSp;
  const raw = measureWords(ctx, ws, gap);
  const centred = centreLayout(raw, outputWidth / 2);
  const baseY = compBottom - bottom;

  const activeIdx = hl.enabled ? activeWordIndex(
    p.wordTimings ?? syntheticWordTimings(ws, subtitleStart, subtitleEnd),
    mediaTime
  ) : -1;

  ws.forEach((word, i) => {
    const startT = i * stagger;
    const prog   = clamp01((timeOffset - startT) / dur);
    const eased  = backOut(prog, 2);
    const ty      = lerp(-60 * sc, 0, eased);
    // Opacity mirrors applyHighlight: past words = 0.6, active/upcoming = 1.0
    // No fade-in from zero — the scale+translate animation is the entrance effect
    const isActive = i === activeIdx;
    const isPast   = i < activeIdx;
    const opacity  = isPast ? 0.6 : 1.0;
    const animScale = lerp(0.4, 1, eased);
    const rotation  = lerp(-15, 0, eased);
    const finalScale = animScale * (isActive ? hl.scale : 1);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(centred[i].x, baseY + ty);
    ctx.rotate(deg(rotation));
    ctx.scale(finalScale, finalScale);

    // Highlight background for active word
    if (isActive && hl.bgColor !== 'transparent') {
      ctx.save();
      ctx.fillStyle = hl.bgColor;
      ctx.fillRect(-centred[i].width / 2 - hl.bgPadX, -size + hl.bgPadY, centred[i].width + hl.bgPadX * 2, size + hl.bgPadY);
      ctx.restore();
    }

    applyTextStyle(ctx, {
      color: isActive ? hl.color : color,
      shadowColor: isActive && hl.glowColor !== 'transparent' ? hl.glowColor : shadowC,
      shadowBlur: isActive && hl.glowBlur > 0 ? hl.glowBlur : shadowB,
      strokeColor: isActive && hl.strokeColor !== 'transparent' ? hl.strokeColor : strokeC,
      strokeWidth: isActive && hl.strokeWidth > 0 ? hl.strokeWidth : strokeW,
    });
    drawTextWithStroke(ctx, word, 0, 0, (isActive ? hl.strokeWidth : strokeW) > 0);
    ctx.restore();
  });
  ctx.restore();
}

// ── 2. Slide Up Caption ─────────────────────────────────────────────────────

function drawSlideUp(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, mediaTime, subtitleStart, subtitleEnd, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       72)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const shadowC = vStr(variables,  'shadow-color', 'rgba(0,0,0,0.8)');
  const shadowB = vNum(variables,  'shadow-blur',  10) * sc;
  const bgColor = vStr(variables,  'bg-color',     'transparent');
  const dur     = Math.max(0.01, vNum(variables, 'duration', 0.55));
  const stagger = Math.max(0,    vNum(variables, 'stagger',  0.1));
  const bottom  = Math.max(0,    vNum(variables, 'bottom',   80)) * sc;
  const font    = vStr(variables,  'font-family', 'Arial');
  const weight  = vStr(variables,  'weight',      '700');
  const letterSp= vNum(variables,  'letter-spacing', 0) * sc;
  const tt      = vStr(variables,  'text-transform', 'none');
  const hl      = hlOptsFromVars(variables, { color: '#FFD700', scale: 1.1 }, sc);

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(text, tt);
  const allWords = words(displayText);
  const lineHeight = size * 1.15;
  const lines = wrapLines(displayText, 40);
  const totalH = lines.length * lineHeight;
  const baseY = compBottom - bottom - totalH + lineHeight;

  const activeIdx = hl.enabled ? activeWordIndex(
    p.wordTimings ?? syntheticWordTimings(allWords, subtitleStart, subtitleEnd),
    mediaTime
  ) : -1;

  // Figure out which word belongs to which line
  const wordLineMap: Array<{ line: number; indexInLine: number }> = [];
  {
    let w = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineWords = words(lines[li]);
      for (let k = 0; k < lineWords.length; k++) {
        wordLineMap[w++] = { line: li, indexInLine: k };
      }
    }
  }

  // Determine which line the active word lives on (mirrors applyHighlight in slide-up HTML)
  const activeLine = activeIdx >= 0 ? (wordLineMap[activeIdx]?.line ?? -1) : -1;

  lines.forEach((line, i) => {
    const startT = i * stagger;
    const prog   = clamp01((timeOffset - startT) / dur);
    const eased  = power3Out(prog);
    const ty      = lerp(lineHeight, 0, eased);
    // Opacity mirrors applyHighlight: past lines = 0.6, active/upcoming = 1.0
    // The clip + translate animation handles the line-reveal; no need for opacity fade
    const isActiveLine = i === activeLine;
    const isPastLine   = activeLine >= 0 && i < activeLine;
    const opacity = isPastLine ? 0.6 : 1.0;
    const lineY = baseY + i * lineHeight;
    const textW = ctx.measureText(line).width;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.beginPath();
    ctx.rect(outputWidth / 2 - textW / 2 - 20, lineY - size, textW + 40, lineHeight + 4);
    ctx.clip();
    ctx.translate(0, ty);

    // Background stripe for whole line
    if (bgColor !== 'transparent') {
      ctx.fillStyle = bgColor;
      ctx.fillRect(outputWidth / 2 - textW / 2 - 10, lineY - size + 4, textW + 20, size + 4);
    }

    // Draw whole line normally
    applyTextStyle(ctx, { color, shadowColor: shadowC, shadowBlur: shadowB });
    ctx.fillText(line, outputWidth / 2, lineY);

    // Draw active word highlighted on top (if the active word lives on this line)
    if (isActiveLine && activeIdx >= 0) {
      const lineWords = words(line);
      const gap = ctx.measureText(' ').width;
      const wm = measureWords(ctx, lineWords, gap);
      const centred = centreLayout(wm, outputWidth / 2);
      const hi = wordLineMap[activeIdx].indexInLine;
      const m = centred[hi];
      if (m) {
        ctx.save();
        if (hl.bgColor !== 'transparent') {
          ctx.fillStyle = hl.bgColor;
          ctx.fillRect(m.x - m.width / 2 - hl.bgPadX, lineY - size + hl.bgPadY, m.width + hl.bgPadX * 2, size + hl.bgPadY);
        }
        ctx.translate(m.x, lineY);
        ctx.scale(hl.scale, hl.scale);
        applyTextStyle(ctx, {
          color: hl.color,
          shadowColor: hl.glowColor !== 'transparent' ? hl.glowColor : shadowC,
          shadowBlur: hl.glowBlur > 0 ? hl.glowBlur : shadowB,
          strokeColor: hl.strokeColor,
          strokeWidth: hl.strokeWidth,
        });
        drawTextWithStroke(ctx, lineWords[hi], 0, 0, hl.strokeWidth > 0);
        ctx.restore();
      }
    }

    ctx.restore();
  });
  ctx.restore();
}

// ── 3. Pop Word Caption ─────────────────────────────────────────────────────

function drawPop(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, mediaTime, subtitleStart, subtitleEnd, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       76)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const accent  = vStr(variables,  'accent-color', '#FFD700');
  const accentEvery = Math.max(0, Math.floor(vNum(variables, 'accent-every', 3)));
  const strokeC = vStr(variables,  'stroke-color', '#000000');
  const strokeW = vNum(variables,  'stroke-width', 2) * sc;
  const shadowC = vStr(variables,  'shadow-color', 'transparent');
  const shadowB = vNum(variables,  'shadow-blur',  0) * sc;
  const dur     = Math.max(0.01, vNum(variables, 'duration', 0.35));
  const stagger = Math.max(0,    vNum(variables, 'stagger',  0.07));
  const bottom  = Math.max(0,    vNum(variables, 'bottom',   80)) * sc;
  const font    = vStr(variables,  'font-family', '"Arial Black"');
  const weight  = vStr(variables,  'weight',      '900');
  const letterSp= vNum(variables,  'letter-spacing', 0) * sc;
  const tt      = vStr(variables,  'text-transform', 'none');
  const hl      = hlOptsFromVars(variables, { color: accent, scale: 1.25, glow: accent, glowBlur: 12 }, sc);

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(text, tt);
  const ws = words(displayText);
  const gap = 6 * sc + letterSp;
  const raw = measureWords(ctx, ws, gap);
  const centred = centreLayout(raw, outputWidth / 2);
  const baseY = compBottom - bottom;

  const activeIdx = hl.enabled ? activeWordIndex(
    p.wordTimings ?? syntheticWordTimings(ws, subtitleStart, subtitleEnd),
    mediaTime
  ) : -1;

  ws.forEach((word, i) => {
    const startT = i * stagger;
    const prog   = clamp01((timeOffset - startT) / dur);
    const eased  = backOut(prog, 3);
    const scaleA = lerp(0, 1, eased);
    // Opacity mirrors applyHighlight: past = 0.6, active/upcoming = 1.0
    // scale 0→1 animation is the entrance effect (no opacity fade needed)
    const isAccent = accentEvery > 0 && (i % accentEvery === accentEvery - 1);
    const baseColor = isAccent ? accent : color;
    const isActive = i === activeIdx;
    const isPast   = i < activeIdx;
    const opacity  = isPast ? 0.6 : 1.0;
    const finalScale = scaleA * (isActive ? hl.scale : 1);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(centred[i].x, baseY);
    ctx.scale(finalScale, finalScale);

    if (isActive && hl.bgColor !== 'transparent') {
      ctx.save();
      ctx.fillStyle = hl.bgColor;
      ctx.fillRect(-centred[i].width / 2 - hl.bgPadX, -size + hl.bgPadY, centred[i].width + hl.bgPadX * 2, size + hl.bgPadY);
      ctx.restore();
    }

    applyTextStyle(ctx, {
      color: isActive ? hl.color : baseColor,
      shadowColor: isActive && hl.glowColor !== 'transparent' ? hl.glowColor : shadowC,
      shadowBlur: isActive && hl.glowBlur > 0 ? hl.glowBlur : shadowB,
      strokeColor: isActive && hl.strokeColor !== 'transparent' ? hl.strokeColor : strokeC,
      strokeWidth: isActive && hl.strokeWidth > 0 ? hl.strokeWidth : strokeW,
    });
    drawTextWithStroke(ctx, word, 0, 0, (isActive ? hl.strokeWidth : strokeW) > 0);
    ctx.restore();
  });
  ctx.restore();
}

// ── 4. Neon Caption ─────────────────────────────────────────────────────────

function drawNeon(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size      = Math.max(8, vNum(variables, 'size',    80)) * sc;
  const color     = vStr(variables, 'color',      '#ffffff');
  const glow      = vStr(variables, 'glow',       '#ffffff');
  const glowOuter = vStr(variables, 'glow-outer', '#ff00ff');
  const glowInner = vNum(variables, 'glow-inner-blur',  10) * sc;
  const glowMid   = vNum(variables, 'glow-mid-blur',    42) * sc;
  const glowFar   = vNum(variables, 'glow-far-blur',    82) * sc;
  const dur       = Math.max(0.01, vNum(variables, 'duration', 0.6));
  const bottom    = Math.max(0,    vNum(variables, 'bottom',   80)) * sc;
  const font      = vStr(variables,  'font-family', 'Arial');
  const weight    = vStr(variables,  'weight',      '900');
  const letterSp  = vNum(variables,  'letter-spacing', 2) * sc;
  const tt        = vStr(variables,  'text-transform', 'none');
  const flicker   = vBool(variables, 'flicker', true);

  // Opacity: neon appears immediately (flicker is the animation, not fade-from-zero)
  // Previously used t=0→1 which made text invisible at subtitle start; now stays at 1.0
  // with optional flicker dip after initial reveal.
  const t = clamp01(timeOffset / dur);
  let opacity: number;
  if (!flicker) {
    opacity = 1.0; // always fully visible; no fade-in
  } else if (t < 0.1) opacity = power2In(t / 0.1); // fast 100ms reveal
  else if (t < 0.2) opacity = lerp(1, 0.4, (t - 0.1) / 0.1);
  else if (t < 0.3) opacity = lerp(0.4, 1, (t - 0.2) / 0.1);
  else if (t < 0.4) opacity = lerp(1, 0.7, (t - 0.3) / 0.1);
  else              opacity = lerp(0.7, 1, power1Out((t - 0.4) / 0.6));

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = opacity;

  const displayText = transformText(text, tt);
  const y = compBottom - bottom;

  // Far outer glow
  ctx.fillStyle = color;
  ctx.shadowColor = glowOuter;
  ctx.shadowBlur = glowFar;
  ctx.fillText(displayText, outputWidth / 2, y);
  // Mid outer glow
  ctx.shadowBlur = glowMid;
  ctx.fillText(displayText, outputWidth / 2, y);
  // Inner glow
  ctx.shadowColor = glow;
  ctx.shadowBlur = glowInner;
  ctx.fillText(displayText, outputWidth / 2, y);

  ctx.restore();
}

// ── 5. Typewriter Caption ───────────────────────────────────────────────────

function drawTypewriter(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       70)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const shadowC = vStr(variables,  'shadow-color', 'rgba(0,0,0,0.9)');
  const shadowB = vNum(variables,  'shadow-blur',  8) * sc;
  const bgColor = vStr(variables,  'bg-color',     'transparent');
  const dur     = Math.max(0.01, vNum(variables, 'duration', 1.5));
  const cursor  = vBool(variables, 'cursor',       true);
  const bottom  = Math.max(0,    vNum(variables, 'bottom',   80)) * sc;
  const font    = vStr(variables,  'font-family', '"Courier New", monospace');
  const weight  = vStr(variables,  'weight',      '700');
  const letterSp= vNum(variables,  'letter-spacing', 0) * sc;
  const tt      = vStr(variables,  'text-transform', 'none');

  const progress = clamp01(timeOffset / dur);
  const displayText = transformText(text, tt);
  const charCount = Math.floor(progress * displayText.length);
  const visible = displayText.slice(0, charCount);

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const y = compBottom - bottom;
  const textW = ctx.measureText(visible).width;

  if (bgColor !== 'transparent' && visible.length > 0) {
    ctx.fillStyle = bgColor;
    const padH = 24 * sc, padV = 10 * sc;
    ctx.fillRect(outputWidth / 2 - textW / 2 - padH, y - size - padV, textW + padH * 2, size + padV * 2);
  }

  applyTextStyle(ctx, { color, shadowColor: shadowC, shadowBlur: shadowB });
  ctx.fillText(visible, outputWidth / 2, y);

  if (cursor) {
    const blink = Math.floor(timeOffset * 2) % 2 === 0;
    if (blink) {
      ctx.fillStyle = color;
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      const cursorX = outputWidth / 2 + textW / 2 + 4 * sc;
      ctx.fillRect(cursorX, y - size * 0.85, 3 * sc, size * 0.9);
    }
  }
  ctx.restore();
}

// ── 6. Karaoke Caption (NEW — per-word progressive reveal) ─────────────────

function drawKaraoke(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, mediaTime, subtitleStart, subtitleEnd, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       80)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const activeColor = vStr(variables, 'active-color', '#FFD700');
  const pastColor   = vStr(variables, 'past-color',   '#ffffff');
  const shadowC = vStr(variables,  'shadow-color', 'rgba(0,0,0,0.8)');
  const shadowB = vNum(variables,  'shadow-blur',  10) * sc;
  const strokeC = vStr(variables,  'stroke-color', '#000000');
  const strokeW = vNum(variables,  'stroke-width', 3) * sc;
  const activeScale = vNum(variables, 'active-scale', 1.2);
  const activeGlow  = vStr(variables, 'active-glow',  activeColor);
  const activeGlowBlur = vNum(variables, 'active-glow-blur', 18) * sc;
  const activeBg    = vStr(variables, 'active-bg-color', 'transparent');
  const bottom  = Math.max(0, vNum(variables, 'bottom',    80)) * sc;
  const font    = vStr(variables,  'font-family', 'Impact');
  const weight  = vStr(variables,  'weight',      '900');
  const letterSp= vNum(variables,  'letter-spacing', 0) * sc;
  const tt      = vStr(variables,  'text-transform', 'uppercase');

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(text, tt);
  const ws = words(displayText);
  const gap = 10 * sc + letterSp;
  const raw = measureWords(ctx, ws, gap);
  const centred = centreLayout(raw, outputWidth / 2);
  const baseY = compBottom - bottom;

  const timings = p.wordTimings ?? syntheticWordTimings(ws, subtitleStart, subtitleEnd);
  const activeIdx = activeWordIndex(timings, mediaTime);

  ws.forEach((word, i) => {
    const isActive = i === activeIdx;
    const isPast = i < activeIdx;
    let wordColor: string;
    if (isActive) wordColor = activeColor;
    else if (isPast) wordColor = pastColor;
    else wordColor = color;

    const scale = isActive ? activeScale : 1;

    ctx.save();
    // Opacity mirrors applyHighlight: past = 0.6, active/upcoming = 1.0 (no fade-in from 0)
    ctx.globalAlpha = isPast ? 0.6 : 1.0;
    ctx.translate(centred[i].x, baseY);
    ctx.scale(scale, scale);

    if (isActive && activeBg !== 'transparent') {
      const padX = 14 * sc, padY = 8 * sc;
      ctx.save();
      ctx.fillStyle = activeBg;
      ctx.fillRect(-centred[i].width / 2 - padX, -size + padY, centred[i].width + padX * 2, size + padY);
      ctx.restore();
    }

    applyTextStyle(ctx, {
      color: wordColor,
      shadowColor: isActive ? activeGlow : shadowC,
      shadowBlur:  isActive ? activeGlowBlur : shadowB,
      strokeColor: strokeC,
      strokeWidth: strokeW,
    });
    drawTextWithStroke(ctx, word, 0, 0, strokeW > 0);
    ctx.restore();
  });
  ctx.restore();
}

// ── 7. Wave Caption (NEW — sine-wave bob per word) ──────────────────────────

function drawWave(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, mediaTime, subtitleStart, subtitleEnd, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       72)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const shadowC = vStr(variables,  'shadow-color', 'rgba(0,0,0,0.8)');
  const shadowB = vNum(variables,  'shadow-blur',  8) * sc;
  const amp     = vNum(variables,  'wave-amplitude', 15) * sc;
  const speed   = vNum(variables,  'wave-speed',     2);
  const phaseGap= vNum(variables,  'wave-phase-gap', 0.5);
  const bottom  = Math.max(0, vNum(variables, 'bottom',  80)) * sc;
  const font    = vStr(variables,  'font-family', 'Arial');
  const weight  = vStr(variables,  'weight',      '700');
  const letterSp= vNum(variables,  'letter-spacing', 0) * sc;
  const tt      = vStr(variables,  'text-transform', 'none');
  const hl      = hlOptsFromVars(variables, { color: '#00ffff', scale: 1.2, glow: '#00ffff', glowBlur: 14 }, sc);

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(text, tt);
  const ws = words(displayText);
  const gap = 8 * sc + letterSp;
  const raw = measureWords(ctx, ws, gap);
  const centred = centreLayout(raw, outputWidth / 2);
  const baseY = compBottom - bottom;

  const activeIdx = hl.enabled ? activeWordIndex(
    p.wordTimings ?? syntheticWordTimings(ws, subtitleStart, subtitleEnd),
    mediaTime
  ) : -1;

  ws.forEach((word, i) => {
    const phase = timeOffset * speed * Math.PI * 2 + i * phaseGap;
    const bob = Math.sin(phase) * amp;
    const isActive = i === activeIdx;
    const isPast   = i < activeIdx;
    const scale = isActive ? hl.scale : 1;

    ctx.save();
    // Opacity mirrors applyHighlight: past = 0.6, active/upcoming = 1.0
    ctx.globalAlpha = isPast ? 0.6 : 1.0;
    ctx.translate(centred[i].x, baseY + bob);
    ctx.scale(scale, scale);

    applyTextStyle(ctx, {
      color: isActive ? hl.color : color,
      shadowColor: isActive && hl.glowColor !== 'transparent' ? hl.glowColor : shadowC,
      shadowBlur: isActive && hl.glowBlur > 0 ? hl.glowBlur : shadowB,
      strokeColor: isActive && hl.strokeColor !== 'transparent' ? hl.strokeColor : undefined,
      strokeWidth: isActive ? hl.strokeWidth : 0,
    });
    drawTextWithStroke(ctx, word, 0, 0, isActive && hl.strokeWidth > 0);
    ctx.restore();
  });
  ctx.restore();
}

// ── 8. Glitch Caption (NEW — RGB split + jitter) ────────────────────────────

function drawGlitch(p: HFCanvasParams) {
  const { ctx, text, config: { variables }, timeOffset, outputWidth, outputHeight } = p;
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  const size    = Math.max(8, vNum(variables, 'size',       84)) * sc;
  const color   = vStr(variables,  'color',        '#ffffff');
  const redColor  = vStr(variables, 'red-channel',  '#ff0044');
  const blueColor = vStr(variables, 'blue-channel', '#00ddff');
  const split   = vNum(variables,  'split-amount', 6) * sc;
  const jitter  = vNum(variables,  'jitter-amount', 3) * sc;
  const freq    = vNum(variables,  'jitter-freq',  8);
  const bottom  = Math.max(0, vNum(variables, 'bottom',   80)) * sc;
  const font    = vStr(variables,  'font-family', 'Impact');
  const weight  = vStr(variables,  'weight',      '900');
  const letterSp= vNum(variables,  'letter-spacing', 2) * sc;
  const tt      = vStr(variables,  'text-transform', 'uppercase');
  const shadowC = vStr(variables,  'shadow-color', 'transparent');
  const shadowB = vNum(variables,  'shadow-blur',  0) * sc;

  ctx.save();
  ctx.font = buildFont(weight, size, font);
  (ctx as any).letterSpacing = `${letterSp}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const displayText = transformText(text, tt);
  const y = compBottom - bottom;
  const x = outputWidth / 2;

  // Random jitter based on time (deterministic pseudo-random)
  const jx = Math.sin(timeOffset * freq * 7.13) * jitter;
  const jy = Math.cos(timeOffset * freq * 5.71) * jitter;

  ctx.globalAlpha = 1.0; // glitch is always fully visible; the jitter IS the animation

  // Red channel offset left
  ctx.fillStyle = redColor;
  ctx.globalCompositeOperation = 'screen';
  ctx.fillText(displayText, x - split + jx, y + jy);

  // Blue channel offset right
  ctx.fillStyle = blueColor;
  ctx.fillText(displayText, x + split - jx, y - jy);

  // Main white layer on top
  ctx.globalCompositeOperation = 'source-over';
  applyTextStyle(ctx, { color, shadowColor: shadowC, shadowBlur: shadowB });
  ctx.fillText(displayText, x, y);

  ctx.restore();
}

// ── Fallback ────────────────────────────────────────────────────────────────

function drawFallback({ ctx, text, outputWidth, outputHeight }: HFCanvasParams) {
  const { sc, compBottom } = compositionScale(outputWidth, outputHeight);
  ctx.save();
  ctx.font = `bold ${72 * sc}px sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 8;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, outputWidth / 2, compBottom - 80 * sc);
  ctx.restore();
}
