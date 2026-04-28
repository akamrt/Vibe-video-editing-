/**
 * hyperframesDSL.ts
 *
 * Pure-math runtime for the Hyperframes DSL. Both the DOM preview and the
 * canvas exporter import from here so what you see is what you export.
 *
 * Authoring space: 1920x1080. Callers pass a `scale` to convert author-space
 * px into output-space px.
 */

import type { HyperframesDSL, HyperframesEasing, HyperframesTrack, HyperframesTrackProp, GraphicNode } from '../types';

export const DSL_COMP_W = 1920;
export const DSL_COMP_H = 1080;

// ── Easing ──────────────────────────────────────────────────────────────────

export const EASINGS: Record<HyperframesEasing, (t: number) => number> = {
  linear:      (t) => t,
  easeIn:      (t) => t * t,
  easeOut:     (t) => 1 - (1 - t) * (1 - t),
  easeInOut:   (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  power2In:    (t) => t * t,
  power2Out:   (t) => 1 - (1 - t) * (1 - t),
  power2InOut: (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,
  power3In:    (t) => t * t * t,
  power3Out:   (t) => 1 - Math.pow(1 - t, 3),
  power3InOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outBack:     (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inBack:      (t) => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
  outElastic:  (t) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  outBounce:   (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) { const u = t - 1.5 / d1; return n1 * u * u + 0.75; }
    if (t < 2.5 / d1) { const u = t - 2.25 / d1; return n1 * u * u + 0.9375; }
    const u = t - 2.625 / d1; return n1 * u * u + 0.984375;
  },
};

export function applyEasing(t: number, easing?: HyperframesEasing): number {
  const fn = easing ? EASINGS[easing] : EASINGS.easeOut;
  return fn ? fn(clamp01(t)) : clamp01(t);
}

// ── Math utilities ──────────────────────────────────────────────────────────

export function clamp01(t: number): number { return Math.max(0, Math.min(1, t)); }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Deterministic pseudo-random in [-1, 1] for a given seed + time bucket */
export function seededNoise(seed: number, t: number): number {
  // Fast cheap hash — good enough for visual jitter
  const x = Math.sin(seed * 12.9898 + t * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

// ── Stagger ─────────────────────────────────────────────────────────────────

export function staggerOffset(
  unitIndex: number,
  unitCount: number,
  stagger: number,
  fn: 'linear' | 'wave' | 'random' | 'fromCenter' | 'reverse' = 'linear',
  seed = 1,
): number {
  if (stagger <= 0) return 0;
  switch (fn) {
    case 'linear':     return unitIndex * stagger;
    case 'reverse':    return (unitCount - 1 - unitIndex) * stagger;
    case 'fromCenter': {
      const centre = (unitCount - 1) / 2;
      return Math.abs(unitIndex - centre) * stagger;
    }
    case 'wave': {
      // Triangle wave: 0, s, 2s, s, 0, s, 2s, ...
      const period = 4;
      const phase = unitIndex % period;
      const norm = phase < period / 2 ? phase / (period / 2) : 2 - phase / (period / 2);
      return norm * unitCount * stagger * 0.5;
    }
    case 'random': {
      const r = (seededNoise(seed + unitIndex, 1) + 1) / 2; // 0..1
      return r * unitCount * stagger * 0.5;
    }
  }
}

// ── Track evaluation ────────────────────────────────────────────────────────

export interface TrackValues {
  opacity: number;
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  skewX: number;
  skewY: number;
  blur: number;
  /** Mix factor 0..1 between colors[0] and colors[1] (only set if a colorMix track exists) */
  colorMix?: number;
  colorPair?: [string, string];
}

export const DEFAULT_TRACK_VALUES: TrackValues = {
  opacity: 1, translateX: 0, translateY: 0,
  scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, blur: 0,
};

/**
 * Evaluate all tracks for one unit at a given absolute time.
 *
 * @param tracks       The DSL tracks
 * @param duration     Per-unit animation duration (seconds)
 * @param unitTime     Time elapsed since this unit's animation started (seconds)
 *                     (i.e. globalTime - staggerOffset)
 * @param absTime      Absolute time (seconds since composition start) — used for loops
 */
export function evaluateTracks(
  tracks: HyperframesTrack[],
  duration: number,
  unitTime: number,
  absTime: number,
  unitIndex: number,
): TrackValues {
  const v: TrackValues = { ...DEFAULT_TRACK_VALUES };
  const progress = duration > 0 ? clamp01(unitTime / duration) : 1;

  for (const track of tracks) {
    const value = evaluateTrack(track, progress, absTime, unitIndex);
    if (value === null) continue;
    applyTrackToValues(v, track, value);
  }
  return v;
}

function evaluateTrack(track: HyperframesTrack, progress: number, absTime: number, unitIndex: number): number | null {
  // Loop mode
  if (track.loop) {
    const period = Math.max(0.001, track.period ?? 1);
    const amp    = track.amplitude ?? 1;
    const phase  = (track.phasePerUnit ?? 0) * unitIndex;
    const t = (absTime / period + phase) % 1;
    const seed = track.seed ?? 1;
    let osc: number;
    switch (track.loop) {
      case 'sine':     osc = Math.sin(t * Math.PI * 2); break;
      case 'cosine':   osc = Math.cos(t * Math.PI * 2); break;
      case 'sawtooth': osc = t * 2 - 1; break;
      case 'triangle': osc = t < 0.5 ? t * 4 - 1 : 3 - t * 4; break;
      case 'random':   osc = seededNoise(seed, Math.floor(absTime / period)); break;
      default:         osc = 0;
    }
    return osc * amp;
  }

  // Tween mode
  const at = track.at ?? [0, 1];
  const [start, end] = at;
  const span = Math.max(0.0001, end - start);
  const localT = clamp01((progress - start) / span);
  const eased = applyEasing(localT, track.easing);
  const from = track.from ?? 0;
  const to   = track.to   ?? 0;
  return lerp(from, to, eased);
}

function applyTrackToValues(v: TrackValues, track: HyperframesTrack, value: number): void {
  switch (track.prop) {
    case 'opacity':    v.opacity    = track.loop ? clamp01(v.opacity + value) : value; break;
    case 'translateX': v.translateX += value; break;
    case 'translateY': v.translateY += value; break;
    case 'scale':      v.scaleX *= value; v.scaleY *= value; break;
    case 'scaleX':     v.scaleX *= value; break;
    case 'scaleY':     v.scaleY *= value; break;
    case 'rotate':     v.rotate += value; break;
    case 'skewX':      v.skewX += value; break;
    case 'skewY':      v.skewY += value; break;
    case 'blur':       v.blur = Math.max(0, v.blur + value); break;
    case 'colorMix':
      v.colorMix = clamp01(value);
      if (track.colors && track.colors.length === 2) v.colorPair = track.colors;
      break;
  }
}

// ── Color mixing ────────────────────────────────────────────────────────────

export function mixHexColors(a: string, b: string, t: number): string {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca || !cb) return a;
  const r = Math.round(lerp(ca[0], cb[0], t));
  const g = Math.round(lerp(ca[1], cb[1], t));
  const bl = Math.round(lerp(ca[2], cb[2], t));
  return `#${[r, g, bl].map(n => n.toString(16).padStart(2, '0')).join('')}`;
}

function parseHexColor(s: string): [number, number, number] | null {
  if (!s.startsWith('#')) return null;
  let hex = s.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6) return null;
  const n = parseInt(hex, 16);
  if (isNaN(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ── Text splitting ──────────────────────────────────────────────────────────

export interface TextUnit {
  text: string;
  /** Index across the full text (for word index in karaoke) */
  globalIndex: number;
  /** Index within its line (for letter mode) */
  localIndex: number;
  /** Line index this unit belongs to */
  lineIndex: number;
}

export function splitText(
  text: string,
  mode: 'element' | 'line' | 'word' | 'letter',
  maxCharsPerLine = 40,
): { units: TextUnit[]; lines: string[]; wordsPerLine: number[] } {
  const lines = wrapLines(text, maxCharsPerLine);
  const wordsPerLine = lines.map(l => l.split(/\s+/).filter(Boolean).length);
  const units: TextUnit[] = [];
  let wordIdx = 0;

  switch (mode) {
    case 'element':
      units.push({ text, globalIndex: 0, localIndex: 0, lineIndex: 0 });
      break;
    case 'line':
      lines.forEach((l, i) => units.push({ text: l, globalIndex: i, localIndex: 0, lineIndex: i }));
      break;
    case 'word':
      lines.forEach((l, lineIndex) => {
        const ws = l.split(/\s+/).filter(Boolean);
        ws.forEach((w, j) => {
          units.push({ text: w, globalIndex: wordIdx++, localIndex: j, lineIndex });
        });
      });
      break;
    case 'letter':
      lines.forEach((l, lineIndex) => {
        const ws = l.split(/\s+/).filter(Boolean);
        ws.forEach((w) => {
          for (let j = 0; j < w.length; j++) {
            units.push({ text: w[j], globalIndex: wordIdx, localIndex: j, lineIndex });
          }
          wordIdx++;
        });
      });
      break;
  }

  return { units, lines, wordsPerLine };
}

export function wrapLines(text: string, maxChars = 40): string[] {
  const ws = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of ws) {
    if (cur.length + w.length + 1 > maxChars && cur) { lines.push(cur.trim()); cur = w + ' '; }
    else cur += w + ' ';
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [''];
}

export function transformText(text: string, transform: string | undefined): string {
  switch (transform) {
    case 'uppercase':  return text.toUpperCase();
    case 'lowercase':  return text.toLowerCase();
    case 'capitalize': return text.replace(/\b\w/g, c => c.toUpperCase());
    default:           return text;
  }
}

// ── Validation / sanitization ───────────────────────────────────────────────

const VALID_PROPS = new Set<HyperframesTrackProp>([
  'opacity', 'translateX', 'translateY', 'scale', 'scaleX', 'scaleY',
  'rotate', 'skewX', 'skewY', 'blur', 'colorMix',
]);

const VALID_EASINGS = new Set<HyperframesEasing>(Object.keys(EASINGS) as HyperframesEasing[]);

const VALID_LOOPS = new Set(['sine', 'cosine', 'sawtooth', 'triangle', 'random']);

export interface ValidationResult {
  ok: boolean;
  dsl?: HyperframesDSL;
  errors: string[];
}

/** Validate and clean a DSL object. Drops invalid tracks/fields rather than failing. */
export function validateDSL(input: any): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['DSL must be an object'] };
  }

  const split = ['element', 'line', 'word', 'letter'].includes(input.split) ? input.split : 'word';
  const duration = typeof input.duration === 'number' && input.duration > 0 ? Math.min(10, input.duration) : 0.5;
  const stagger  = typeof input.stagger === 'number' ? Math.max(0, Math.min(2, input.stagger)) : 0;

  const layout = input.layout && typeof input.layout === 'object' ? input.layout : {};
  const cleanLayout = {
    bottom: clampNum(layout.bottom, 0, DSL_COMP_H, 80),
    maxWidth: layout.maxWidth ? clampNum(layout.maxWidth, 100, DSL_COMP_W, 1600) : undefined,
    lineHeight: layout.lineHeight ? clampNum(layout.lineHeight, 0.8, 3, 1.15) : 1.15,
    align: ['center', 'left', 'right'].includes(layout.align) ? layout.align : 'center',
  };

  const style = input.style && typeof input.style === 'object' ? input.style : {};
  const cleanStyle = {
    fontFamily:    typeof style.fontFamily === 'string' ? String(style.fontFamily).slice(0, 100) : 'Inter',
    fontWeight:    style.fontWeight !== undefined ? String(style.fontWeight).slice(0, 10) : '700',
    fontSize:      typeof style.fontSize === 'number' ? clampNum(style.fontSize, 10, 400, 80) : 80,
    color:         typeof style.color === 'string' ? style.color.slice(0, 100) : '#ffffff',
    letterSpacing: typeof style.letterSpacing === 'number' ? clampNum(style.letterSpacing, -10, 50, 0) : 0,
    textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'].includes(style.textTransform) ? style.textTransform : 'none',
  };

  const tracks: HyperframesTrack[] = [];
  if (Array.isArray(input.tracks)) {
    for (const t of input.tracks) {
      const cleaned = validateTrack(t, errors);
      if (cleaned) tracks.push(cleaned);
    }
  }

  const effects = input.effects && typeof input.effects === 'object' ? cleanEffects(input.effects) : undefined;
  const karaoke = input.karaoke && typeof input.karaoke === 'object' ? cleanKaraoke(input.karaoke) : undefined;
  const graphics = Array.isArray(input.graphics) ? cleanGraphics(input.graphics, errors) : undefined;

  const dsl: HyperframesDSL = {
    name: typeof input.name === 'string' ? input.name.slice(0, 80) : undefined,
    version: 1,
    split,
    layout: cleanLayout,
    style: cleanStyle,
    duration,
    stagger,
    staggerFn: ['linear', 'wave', 'random', 'fromCenter', 'reverse'].includes(input.staggerFn) ? input.staggerFn : 'linear',
    tracks,
    effects,
    karaoke,
    graphics,
  };

  return { ok: tracks.length > 0 || !!effects || !!karaoke || (graphics?.length ?? 0) > 0, dsl, errors };
}

const VALID_GRAPHIC_KINDS = new Set(['rect', 'circle', 'line', 'path', 'image', 'text']);
const MAX_GRAPHICS = 64;

function cleanGraphics(arr: any[], errors: string[]): GraphicNode[] {
  const out: GraphicNode[] = [];
  for (let i = 0; i < arr.length && out.length < MAX_GRAPHICS; i++) {
    const n = cleanGraphic(arr[i], errors, i);
    if (n) out.push(n);
  }
  return out;
}

function cleanGraphic(g: any, errors: string[], idx: number): GraphicNode | null {
  if (!g || typeof g !== 'object' || !VALID_GRAPHIC_KINDS.has(g.kind)) {
    errors.push(`Graphic #${idx + 1}: unknown kind "${g?.kind}"`);
    return null;
  }
  const base = {
    id: typeof g.id === 'string' ? g.id.slice(0, 40) : undefined,
    x: clampNum(g.x, -DSL_COMP_W, DSL_COMP_W * 2, 0),
    y: clampNum(g.y, -DSL_COMP_H, DSL_COMP_H * 2, 0),
    tracks: Array.isArray(g.tracks) ? g.tracks.map((t: any) => validateTrack(t, errors)).filter(Boolean) as HyperframesTrack[] : undefined,
    animDuration: typeof g.animDuration === 'number' ? clampNum(g.animDuration, 0.05, 60, 0.6) : undefined,
    appearAt: typeof g.appearAt === 'number' ? clampNum(g.appearAt, 0, 600, 0) : 0,
    disappearAt: typeof g.disappearAt === 'number' ? clampNum(g.disappearAt, 0, 6000, 6000) : undefined,
    origin: g.origin && typeof g.origin === 'object'
      ? { x: clampNum(g.origin.x, 0, 1, 0.5), y: clampNum(g.origin.y, 0, 1, 0.5) }
      : undefined,
    opacity: typeof g.opacity === 'number' ? clampNum(g.opacity, 0, 1, 1) : undefined,
  };

  switch (g.kind) {
    case 'rect': return {
      ...base, kind: 'rect',
      width: clampNum(g.width, 0, DSL_COMP_W * 2, 100),
      height: clampNum(g.height, 0, DSL_COMP_H * 2, 100),
      fill: typeof g.fill === 'string' ? g.fill.slice(0, 100) : undefined,
      stroke: typeof g.stroke === 'string' ? g.stroke.slice(0, 100) : undefined,
      strokeWidth: typeof g.strokeWidth === 'number' ? clampNum(g.strokeWidth, 0, 50, 0) : undefined,
      cornerRadius: typeof g.cornerRadius === 'number' ? clampNum(g.cornerRadius, 0, 500, 0) : undefined,
    };
    case 'circle': return {
      ...base, kind: 'circle',
      radius: clampNum(g.radius, 0, DSL_COMP_W, 50),
      fill: typeof g.fill === 'string' ? g.fill.slice(0, 100) : undefined,
      stroke: typeof g.stroke === 'string' ? g.stroke.slice(0, 100) : undefined,
      strokeWidth: typeof g.strokeWidth === 'number' ? clampNum(g.strokeWidth, 0, 50, 0) : undefined,
    };
    case 'line': return {
      ...base, kind: 'line',
      x2: clampNum(g.x2, -DSL_COMP_W, DSL_COMP_W * 2, 0),
      y2: clampNum(g.y2, -DSL_COMP_H, DSL_COMP_H * 2, 0),
      stroke: typeof g.stroke === 'string' ? g.stroke.slice(0, 100) : '#ffffff',
      strokeWidth: clampNum(g.strokeWidth, 0, 50, 4),
      lineCap: ['butt', 'round', 'square'].includes(g.lineCap) ? g.lineCap : 'round',
      drawProgress: typeof g.drawProgress === 'number' ? clampNum(g.drawProgress, 0, 1, 1) : 1,
    };
    case 'path': {
      const d = typeof g.d === 'string' ? g.d.slice(0, 4000) : '';
      if (!d) return null;
      // Reject anything with embedded HTML/script chars
      if (/[<>]/.test(d)) return null;
      return {
        ...base, kind: 'path', d,
        fill: typeof g.fill === 'string' ? g.fill.slice(0, 100) : undefined,
        stroke: typeof g.stroke === 'string' ? g.stroke.slice(0, 100) : undefined,
        strokeWidth: typeof g.strokeWidth === 'number' ? clampNum(g.strokeWidth, 0, 50, 0) : undefined,
      };
    }
    case 'image': {
      const src = typeof g.src === 'string' ? g.src.slice(0, 200_000) : '';
      // Allow only http(s) and data:image/* URIs (no javascript: etc.)
      if (!/^(https?:|data:image\/(png|jpeg|gif|webp|svg\+xml);)/i.test(src)) return null;
      return {
        ...base, kind: 'image', src,
        width: clampNum(g.width, 1, DSL_COMP_W * 2, 100),
        height: clampNum(g.height, 1, DSL_COMP_H * 2, 100),
      };
    }
    case 'text': return {
      ...base, kind: 'text',
      text: typeof g.text === 'string' ? g.text.slice(0, 200) : '',
      fontFamily: typeof g.fontFamily === 'string' ? g.fontFamily.slice(0, 100) : 'Inter',
      fontWeight: g.fontWeight !== undefined ? String(g.fontWeight).slice(0, 10) : '700',
      fontSize: typeof g.fontSize === 'number' ? clampNum(g.fontSize, 8, 400, 64) : 64,
      color: typeof g.color === 'string' ? g.color.slice(0, 100) : '#ffffff',
      align: ['left', 'center', 'right'].includes(g.align) ? g.align : 'center',
      letterSpacing: typeof g.letterSpacing === 'number' ? clampNum(g.letterSpacing, -10, 50, 0) : 0,
      textTransform: ['none', 'uppercase', 'lowercase', 'capitalize'].includes(g.textTransform) ? g.textTransform : 'none',
      stroke: g.stroke && typeof g.stroke === 'object' && typeof g.stroke.color === 'string'
        ? { color: g.stroke.color, width: clampNum(g.stroke.width, 0, 30, 0) } : undefined,
      shadow: g.shadow && typeof g.shadow === 'object' && typeof g.shadow.color === 'string'
        ? { color: g.shadow.color, blur: clampNum(g.shadow.blur, 0, 100, 4),
            offsetX: typeof g.shadow.offsetX === 'number' ? clampNum(g.shadow.offsetX, -50, 50, 0) : 0,
            offsetY: typeof g.shadow.offsetY === 'number' ? clampNum(g.shadow.offsetY, -50, 50, 0) : 2 }
        : undefined,
      glow: g.glow && typeof g.glow === 'object' && typeof g.glow.color === 'string'
        ? { color: g.glow.color, blur: clampNum(g.glow.blur, 0, 100, 0) } : undefined,
    };
  }
  return null;
}

function validateTrack(t: any, errors: string[]): HyperframesTrack | null {
  if (!t || typeof t !== 'object' || !VALID_PROPS.has(t.prop)) {
    errors.push(`Invalid track prop: ${t?.prop}`);
    return null;
  }
  const out: HyperframesTrack = { prop: t.prop };
  if (t.loop && VALID_LOOPS.has(t.loop)) {
    out.loop = t.loop;
    out.amplitude = typeof t.amplitude === 'number' ? clampNum(t.amplitude, -1000, 1000, 1) : 1;
    out.period    = typeof t.period === 'number' ? clampNum(t.period, 0.05, 60, 1) : 1;
    out.phasePerUnit = typeof t.phasePerUnit === 'number' ? clampNum(t.phasePerUnit, 0, 1, 0) : 0;
    out.seed      = typeof t.seed === 'number' ? t.seed : 1;
  } else {
    out.from = typeof t.from === 'number' ? t.from : 0;
    out.to   = typeof t.to   === 'number' ? t.to   : 0;
    if (Array.isArray(t.at) && t.at.length === 2 && t.at.every((n: any) => typeof n === 'number')) {
      out.at = [clamp01(t.at[0]), clamp01(t.at[1])];
    }
    out.easing = VALID_EASINGS.has(t.easing) ? t.easing : 'easeOut';
  }
  if (t.prop === 'colorMix' && Array.isArray(t.colors) && t.colors.length === 2) {
    out.colors = [String(t.colors[0]), String(t.colors[1])];
  }
  return out;
}

function cleanEffects(e: any): HyperframesDSL['effects'] {
  const out: NonNullable<HyperframesDSL['effects']> = {};
  if (e.shadow && typeof e.shadow === 'object' && typeof e.shadow.color === 'string') {
    out.shadow = {
      color: e.shadow.color,
      blur: clampNum(e.shadow.blur, 0, 100, 8),
      offsetX: typeof e.shadow.offsetX === 'number' ? clampNum(e.shadow.offsetX, -100, 100, 0) : 0,
      offsetY: typeof e.shadow.offsetY === 'number' ? clampNum(e.shadow.offsetY, -100, 100, 0) : 0,
    };
  }
  if (e.stroke && typeof e.stroke === 'object' && typeof e.stroke.color === 'string') {
    out.stroke = {
      color: e.stroke.color,
      width: clampNum(e.stroke.width, 0, 30, 0),
    };
  }
  if (e.glow && typeof e.glow === 'object' && typeof e.glow.color === 'string') {
    out.glow = {
      color: e.glow.color,
      blur: clampNum(e.glow.blur, 0, 200, 0),
    };
  }
  if (e.rgbSplit && typeof e.rgbSplit === 'object'
      && Array.isArray(e.rgbSplit.redOffset) && Array.isArray(e.rgbSplit.blueOffset)) {
    out.rgbSplit = {
      redOffset:  [clampNum(e.rgbSplit.redOffset[0],  -50, 50, 0), clampNum(e.rgbSplit.redOffset[1],  -50, 50, 0)],
      blueOffset: [clampNum(e.rgbSplit.blueOffset[0], -50, 50, 0), clampNum(e.rgbSplit.blueOffset[1], -50, 50, 0)],
      jitter:     typeof e.rgbSplit.jitter === 'number' ? clampNum(e.rgbSplit.jitter, 0, 30, 0) : 0,
      jitterFreq: typeof e.rgbSplit.jitterFreq === 'number' ? clampNum(e.rgbSplit.jitterFreq, 0, 60, 8) : 8,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanKaraoke(k: any): HyperframesDSL['karaoke'] {
  if (!k.enabled) return undefined;
  const out: NonNullable<HyperframesDSL['karaoke']> = {
    enabled: true,
    color:       typeof k.color === 'string' ? k.color : '#FFD700',
    scale:       typeof k.scale === 'number' ? clampNum(k.scale, 0.5, 3, 1.15) : 1.15,
    pastOpacity: typeof k.pastOpacity === 'number' ? clampNum(k.pastOpacity, 0, 1, 1) : 1,
  };
  if (k.glow && typeof k.glow === 'object' && typeof k.glow.color === 'string') {
    out.glow = { color: k.glow.color, blur: clampNum(k.glow.blur, 0, 100, 12) };
  }
  if (k.background && typeof k.background === 'object' && typeof k.background.color === 'string') {
    out.background = {
      color: k.background.color,
      padX:  clampNum(k.background.padX,  0, 80, 14),
      padY:  clampNum(k.background.padY,  0, 40, 6),
    };
  }
  if (k.stroke && typeof k.stroke === 'object' && typeof k.stroke.color === 'string') {
    out.stroke = { color: k.stroke.color, width: clampNum(k.stroke.width, 0, 30, 0) };
  }
  return out;
}

function clampNum(n: any, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  if (!isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// ── Active word index ───────────────────────────────────────────────────────

export interface WordTiming { text: string; start: number; end: number; }

export function activeWordIndex(timings: WordTiming[] | undefined, mediaTime: number): number {
  if (!timings || !timings.length) return -1;
  for (let i = 0; i < timings.length; i++) {
    if (mediaTime >= timings[i].start && mediaTime <= timings[i].end) return i;
  }
  let lastPast = -1;
  for (let i = 0; i < timings.length; i++) {
    if (timings[i].end < mediaTime) lastPast = i;
    else break;
  }
  return lastPast;
}

export function syntheticWordTimings(words: string[], startTime: number, endTime: number): WordTiming[] {
  const dur = endTime - startTime;
  const per = dur / Math.max(1, words.length);
  return words.map((w, i) => ({
    text: w,
    start: startTime + i * per,
    end:   startTime + (i + 1) * per,
  }));
}

// ── Animation duration estimate (used by preview's GSAP-equivalent) ─────────

export function estimateAnimationDuration(dsl: HyperframesDSL, unitCount: number): number {
  const stagger = dsl.stagger ?? 0;
  return dsl.duration + stagger * Math.max(0, unitCount - 1);
}

// ── Built-in starter DSL — referenced by the AI prompt's worked example ────

export const STARTER_DSL: HyperframesDSL = {
  name: 'Pop Bounce',
  version: 1,
  split: 'word',
  layout: { bottom: 100, maxWidth: 1600, lineHeight: 1.2, align: 'center' },
  style: {
    fontFamily: 'Impact',
    fontWeight: '900',
    fontSize: 88,
    color: '#ffffff',
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  duration: 0.45,
  stagger: 0.06,
  staggerFn: 'linear',
  tracks: [
    { prop: 'translateY', from: 60, to: 0, at: [0, 0.7], easing: 'outBack' },
    { prop: 'scale',      from: 0.4, to: 1, at: [0, 0.6], easing: 'outBack' },
    { prop: 'rotate',     from: -10, to: 0, at: [0, 0.6], easing: 'outBack' },
    { prop: 'opacity',    from: 0, to: 1, at: [0, 0.3], easing: 'easeOut' },
  ],
  effects: {
    shadow: { color: '#000000', blur: 8 },
    stroke: { color: '#000000', width: 3 },
  },
  karaoke: {
    enabled: true,
    color: '#FFD700',
    scale: 1.2,
    glow: { color: '#FFD700', blur: 14 },
  },
};
