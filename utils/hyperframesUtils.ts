import type { HyperframesVariable, HyperframesConfig } from '../types';

export interface HyperframesCompositionMeta {
  id: string;
  name: string;
  description: string;
  src: string;
  /** Hardcoded defaults matching each composition's JS fallback values */
  defaults: Record<string, string | number | boolean>;
}

/** Common variables all compositions share (overridable per-composition) */
const COMMON_TEXT_DEFAULTS = {
  'font-family': 'Inter',
  'weight': '700',
  'letter-spacing': 0,
  'text-transform': 'none',
};

/** Karaoke / word-highlight defaults (shared structure across compositions) */
const KARAOKE_DEFAULTS = {
  'highlight-enabled':     true,
  'highlight-color':       '#FFD700',
  'highlight-scale':       1.15,
  'highlight-glow':        'transparent',
  'highlight-glow-blur':   0,
  'highlight-stroke-color':'transparent',
  'highlight-stroke-width':0,
  'highlight-bg-color':    'transparent',
  'highlight-bg-padx':     14,
  'highlight-bg-pady':     6,
};

export const HYPERFRAMES_COMPOSITIONS: HyperframesCompositionMeta[] = [
  {
    id: 'bounce-caption',
    name: 'Bounce',
    description: 'Words bounce in from above with spring physics',
    src: '/hyperframes/bounce-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS, ...KARAOKE_DEFAULTS,
      size: 80, color: '#ffffff',
      'shadow-color': '#000000', 'shadow-blur': 8,
      'stroke-color': '#000000', 'stroke-width': 3,
      'font-family': 'Impact',  weight: '900',
      bottom: 80, duration: 0.5, stagger: 0.06,
      'text-transform': 'uppercase',
      'highlight-color': '#FFD700', 'highlight-scale': 1.2,
    },
  },
  {
    id: 'slide-up-caption',
    name: 'Slide Up',
    description: 'Lines slide up from below, clip-masked',
    src: '/hyperframes/slide-up-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS, ...KARAOKE_DEFAULTS,
      size: 72, color: '#ffffff',
      'shadow-color': 'rgba(0,0,0,0.8)', 'shadow-blur': 10,
      'bg-color': 'transparent',
      'font-family': 'Inter',  weight: '700',
      duration: 0.55, stagger: 0.1, bottom: 80,
      'highlight-color': '#FFD700', 'highlight-scale': 1.1,
    },
  },
  {
    id: 'pop-word-caption',
    name: 'Pop',
    description: 'Words pop in with scale; every Nth word is accented',
    src: '/hyperframes/pop-word-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS, ...KARAOKE_DEFAULTS,
      size: 76, color: '#ffffff',
      'accent-color': '#FFD700', 'accent-every': 3,
      'stroke-color': '#000000', 'stroke-width': 2,
      'shadow-color': 'transparent', 'shadow-blur': 0,
      'font-family': 'Montserrat', weight: '900',
      duration: 0.35, stagger: 0.07, bottom: 80,
      'text-transform': 'uppercase',
      'highlight-color': '#FFD700', 'highlight-scale': 1.25,
      'highlight-glow': '#FFD700', 'highlight-glow-blur': 12,
    },
  },
  {
    id: 'neon-caption',
    name: 'Neon',
    description: 'Neon flicker glow with outer colour halo',
    src: '/hyperframes/neon-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS,
      size: 80, color: '#ffffff',
      glow: '#ffffff', 'glow-outer': '#ff00ff',
      'glow-inner-blur': 10, 'glow-mid-blur': 42, 'glow-far-blur': 82,
      'font-family': 'Poppins', weight: '900',
      duration: 0.6, bottom: 80,
      'letter-spacing': 2, flicker: true,
    },
  },
  {
    id: 'typewriter-caption',
    name: 'Typewriter',
    description: 'Character-by-character reveal with blinking cursor',
    src: '/hyperframes/typewriter-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS,
      size: 70, color: '#ffffff',
      'shadow-color': 'rgba(0,0,0,0.9)', 'shadow-blur': 8,
      'bg-color': 'transparent',
      'font-family': 'Courier Prime', weight: '700',
      duration: 1.5, cursor: true, bottom: 80,
    },
  },
  {
    id: 'karaoke-caption',
    name: 'Karaoke',
    description: 'Progressive word-by-word highlight (uses per-word timings)',
    src: '/hyperframes/karaoke-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS,
      size: 80, color: '#ffffff',
      'active-color': '#FFD700', 'past-color': '#ffffff',
      'active-scale': 1.2,
      'active-glow': '#FFD700', 'active-glow-blur': 18,
      'active-bg-color': 'transparent',
      'shadow-color': 'rgba(0,0,0,0.8)', 'shadow-blur': 10,
      'stroke-color': '#000000', 'stroke-width': 3,
      'font-family': 'Impact', weight: '900',
      'text-transform': 'uppercase',
      duration: 0.3, bottom: 100,
    },
  },
  {
    id: 'wave-caption',
    name: 'Wave',
    description: 'Words bob in a sine wave; active word highlighted',
    src: '/hyperframes/wave-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS, ...KARAOKE_DEFAULTS,
      size: 72, color: '#ffffff',
      'shadow-color': 'rgba(0,0,0,0.8)', 'shadow-blur': 8,
      'wave-amplitude': 15, 'wave-speed': 1.2, 'wave-phase-gap': 0.5,
      'font-family': 'Poppins', weight: '700',
      duration: 0.4, bottom: 100,
      'highlight-color': '#00ffff', 'highlight-scale': 1.2,
      'highlight-glow': '#00ffff', 'highlight-glow-blur': 14,
    },
  },
  {
    id: 'glitch-caption',
    name: 'Glitch',
    description: 'RGB channel split + jitter for a digital-glitch vibe',
    src: '/hyperframes/glitch-caption.html',
    defaults: {
      ...COMMON_TEXT_DEFAULTS,
      size: 84, color: '#ffffff',
      'red-channel': '#ff0044', 'blue-channel': '#00ddff',
      'split-amount': 6, 'jitter-amount': 3, 'jitter-freq': 8,
      'shadow-color': 'transparent', 'shadow-blur': 0,
      'font-family': 'Impact', weight: '900',
      'letter-spacing': 2, 'text-transform': 'uppercase',
      duration: 0.3, bottom: 100,
    },
  },
];

/** Sensible slider ranges for known variable names */
const NUMBER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  'size':                 { min: 20,   max: 200,  step: 1 },
  'duration':             { min: 0,    max: 1.0,  step: 0.01 },
  'stagger':              { min: 0,    max: 0.15, step: 0.01 },
  'bottom':               { min: 0,    max: 500,  step: 1 },
  'stroke-width':         { min: 0,    max: 20,   step: 0.5 },
  'shadow-blur':          { min: 0,    max: 60,   step: 1 },
  'letter-spacing':       { min: -5,   max: 30,   step: 0.5 },
  'accent-every':         { min: 0,    max: 10,   step: 1 },
  'glow-inner-blur':      { min: 0,    max: 60,   step: 1 },
  'glow-mid-blur':        { min: 0,    max: 120,  step: 1 },
  'glow-far-blur':        { min: 0,    max: 200,  step: 1 },
  'active-scale':         { min: 0.5,  max: 2.5,  step: 0.05 },
  'active-glow-blur':     { min: 0,    max: 60,   step: 1 },
  'wave-amplitude':       { min: 0,    max: 60,   step: 1 },
  'wave-speed':           { min: 0,    max: 5,    step: 0.1 },
  'wave-phase-gap':       { min: 0,    max: 3,    step: 0.1 },
  'split-amount':         { min: 0,    max: 30,   step: 0.5 },
  'jitter-amount':        { min: 0,    max: 20,   step: 0.5 },
  'jitter-freq':          { min: 0,    max: 30,   step: 0.5 },
  'highlight-scale':      { min: 0.5,  max: 2.5,  step: 0.05 },
  'highlight-glow-blur':  { min: 0,    max: 60,   step: 1 },
  'highlight-stroke-width': { min: 0,  max: 20,   step: 0.5 },
  'highlight-bg-padx':    { min: 0,    max: 50,   step: 1 },
  'highlight-bg-pady':    { min: 0,    max: 30,   step: 1 },
};

/** Assign a variable to a form group based on its name */
function groupFor(name: string): 'Text' | 'Animation' | 'Effects' | 'Karaoke' {
  if (name.startsWith('highlight-') || name.startsWith('active-') || name === 'past-color') return 'Karaoke';
  if (name === 'duration' || name === 'stagger' || name === 'cursor' || name === 'flicker' ||
      name.startsWith('wave-') || name.startsWith('jitter-') || name === 'split-amount' ||
      name.startsWith('red-channel') || name.startsWith('blue-channel')) return 'Animation';
  if (name.includes('glow') || name.includes('shadow') || name.includes('stroke') ||
      name.includes('bg-') || name === 'accent-color' || name === 'accent-every') return 'Effects';
  return 'Text';
}

/** Select options for known variable names */
const SELECT_OPTIONS: Record<string, string[]> = {
  'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
  'weight':         ['300', '400', '500', '600', '700', '800', '900'],
};

/** Infer a HyperframesVariable entry from a default value (used when HTML doesn't declare data-var) */
export function inferVariable(name: string, value: string | number | boolean): HyperframesVariable {
  const group = groupFor(name);
  const label = toLabel(name);

  // Explicit select options
  if (SELECT_OPTIONS[name]) {
    return { name, type: 'select', label, group, options: SELECT_OPTIONS[name] };
  }
  // Font family → font picker
  if (name === 'font-family' || name === 'font') {
    return { name, type: 'font', label, group };
  }
  if (typeof value === 'boolean') {
    return { name, type: 'boolean', label, group };
  }
  if (typeof value === 'number') {
    const range = NUMBER_RANGES[name] ?? { min: 0, max: 100, step: 1 };
    return { name, type: 'number', label, group, ...range };
  }
  // string: detect color vs plain
  const s = String(value);
  const isColor = s.startsWith('#') || s.startsWith('rgb') || s === 'transparent';
  if (isColor || name.endsWith('-color') || name.endsWith('-channel') || name === 'color' || name === 'glow' || name === 'accent') {
    return { name, type: 'color', label, group };
  }
  return { name, type: 'string', label, group };
}

/** Parse data-var-* attributes from a fetched composition HTML string */
export function parseVariableSchema(html: string): HyperframesVariable[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const root = doc.querySelector('[data-composition-id]');
  if (!root) return [];

  const vars: HyperframesVariable[] = [];
  for (const attr of Array.from(root.attributes)) {
    if (!attr.name.startsWith('data-var-')) continue;
    const name = attr.name.slice('data-var-'.length);
    if (name === 'text') continue;
    const rawType = attr.value.trim();
    const group = groupFor(name);
    const label = toLabel(name);

    if (rawType.startsWith('select:')) {
      vars.push({ name, type: 'select', label, group, options: rawType.slice(7).split(',') });
    } else if (rawType === 'number') {
      const range = NUMBER_RANGES[name] ?? { min: 0, max: 500, step: 1 };
      vars.push({ name, type: 'number', label, group, ...range });
    } else if (rawType === 'boolean') {
      vars.push({ name, type: 'boolean', label, group });
    } else if (rawType === 'color') {
      vars.push({ name, type: 'color', label, group });
    } else if (rawType === 'font') {
      vars.push({ name, type: 'font', label, group });
    } else {
      vars.push({ name, type: 'string', label, group });
    }
  }
  return vars;
}

/**
 * Merge an HTML-parsed schema with inferred entries from the composition's defaults.
 * The returned schema contains an entry for every key in `defaults`, using the
 * parsed schema when available and inferring otherwise. This is what the form
 * actually uses to render controls.
 */
export function buildFullSchema(
  parsedSchema: HyperframesVariable[],
  defaults: Record<string, string | number | boolean>,
): HyperframesVariable[] {
  const byName = new Map<string, HyperframesVariable>();
  for (const v of parsedSchema) byName.set(v.name, v);
  for (const [name, value] of Object.entries(defaults)) {
    if (!byName.has(name)) byName.set(name, inferVariable(name, value));
  }
  // Stable order: Text → Animation → Effects → Karaoke, alphabetic within
  const groupRank: Record<string, number> = { Text: 0, Animation: 1, Effects: 2, Karaoke: 3 };
  return Array.from(byName.values()).sort((a, b) => {
    const ga = groupRank[a.group ?? 'Text'] ?? 99;
    const gb = groupRank[b.group ?? 'Text'] ?? 99;
    if (ga !== gb) return ga - gb;
    return a.name.localeCompare(b.name);
  });
}

function toLabel(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Fetch a composition's HTML and build its variable schema */
export async function loadCompositionSchema(src: string): Promise<HyperframesVariable[]> {
  const res = await fetch(src);
  const html = await res.text();
  return parseVariableSchema(html);
}

/** Build the iframe src URL with text + user variables injected as query params */
export function buildCompositionSrc(config: HyperframesConfig, text: string): string {
  const params = new URLSearchParams({ text });
  for (const [k, v] of Object.entries(config.variables)) {
    params.set(k, String(v));
  }
  return `${config.compositionSrc}?${params.toString()}`;
}

/** Build a default HyperframesConfig from a composition meta + schema */
export function buildDefaultConfig(
  meta: HyperframesCompositionMeta,
  schema: HyperframesVariable[],
): HyperframesConfig {
  // Start with the hardcoded defaults embedded in the composition registry
  const variables: Record<string, string | number | boolean> = { ...meta.defaults };
  // Schema-level overrides (if parseVariableSchema ever extracts defaultValue)
  for (const v of schema) {
    if (v.defaultValue !== undefined) {
      variables[v.name] = v.defaultValue;
    }
  }
  return { compositionSrc: meta.src, variables, variableSchema: schema };
}
