import type { TransitionType, TransitionCategory, TransitionDefinition } from '../types';

// ============ CATEGORY METADATA ============
export const TRANSITION_CATEGORIES: TransitionCategory[] = [
  'Basic', 'Wipes', 'Shapes', 'Slide', 'Effects', 'Blend', 'Creative'
];

export const TRANSITION_CATEGORY_COLORS: Record<TransitionCategory, string> = {
  Basic:    '#3b82f6', // blue
  Wipes:    '#8b5cf6', // purple
  Shapes:   '#ec4899', // pink
  Slide:    '#f97316', // orange
  Effects:  '#ef4444', // red
  Blend:    '#14b8a6', // teal
  Creative: '#eab308', // yellow
};

// ============ TRANSITION CATALOG ============
export const TRANSITION_CATALOG: TransitionDefinition[] = [
  // ─── BASIC ─────────────────────────────────────────────
  {
    id: 'FADE',
    name: 'Fade',
    category: 'Basic',
    description: 'Simple opacity fade between clips',
    icon: '◐',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'CROSSFADE',
    name: 'Crossfade',
    category: 'Basic',
    description: 'Smooth dissolve between two clips',
    icon: '◑',
    defaultParams: { duration: 0.8 },
    paramSchema: [],
  },
  {
    id: 'FADE_BLACK',
    name: 'Fade to Black',
    category: 'Basic',
    description: 'Fade out to black, then fade in',
    icon: '◼',
    defaultParams: { duration: 1.0, color: '#000000' },
    paramSchema: [],
  },
  {
    id: 'FADE_WHITE',
    name: 'Fade to White',
    category: 'Basic',
    description: 'Fade out to white, then fade in',
    icon: '◻',
    defaultParams: { duration: 1.0, color: '#ffffff' },
    paramSchema: [],
  },
  {
    id: 'DIP_TO_BLACK',
    name: 'Dip to Black',
    category: 'Basic',
    description: 'Quick dip through black between clips',
    icon: '▼',
    defaultParams: { duration: 0.6, color: '#000000' },
    paramSchema: [
      { key: 'color', label: 'Color', type: 'color', default: '#000000' },
    ],
  },
  {
    id: 'DIP_TO_WHITE',
    name: 'Dip to White',
    category: 'Basic',
    description: 'Quick dip through white between clips',
    icon: '△',
    defaultParams: { duration: 0.6, color: '#ffffff' },
    paramSchema: [
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    ],
  },

  // ─── WIPES ─────────────────────────────────────────────
  {
    id: 'WIPE_LEFT',
    name: 'Wipe Left',
    category: 'Wipes',
    description: 'Incoming clip wipes in from right to left',
    icon: '◂',
    defaultParams: { duration: 0.6, softness: 10 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
    ],
  },
  {
    id: 'WIPE_RIGHT',
    name: 'Wipe Right',
    category: 'Wipes',
    description: 'Incoming clip wipes in from left to right',
    icon: '▸',
    defaultParams: { duration: 0.6, softness: 10 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
    ],
  },
  {
    id: 'WIPE_UP',
    name: 'Wipe Up',
    category: 'Wipes',
    description: 'Incoming clip wipes in from bottom to top',
    icon: '▴',
    defaultParams: { duration: 0.6, softness: 10 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
    ],
  },
  {
    id: 'WIPE_DOWN',
    name: 'Wipe Down',
    category: 'Wipes',
    description: 'Incoming clip wipes in from top to bottom',
    icon: '▾',
    defaultParams: { duration: 0.6, softness: 10 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
    ],
  },
  {
    id: 'WIPE_DIAGONAL_TL',
    name: 'Wipe Diagonal ↘',
    category: 'Wipes',
    description: 'Diagonal wipe from top-left to bottom-right',
    icon: '◢',
    defaultParams: { duration: 0.7, softness: 15 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 15 },
    ],
  },
  {
    id: 'WIPE_DIAGONAL_TR',
    name: 'Wipe Diagonal ↙',
    category: 'Wipes',
    description: 'Diagonal wipe from top-right to bottom-left',
    icon: '◣',
    defaultParams: { duration: 0.7, softness: 15 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 15 },
    ],
  },
  {
    id: 'WIPE_DIAGONAL_BL',
    name: 'Wipe Diagonal ↗',
    category: 'Wipes',
    description: 'Diagonal wipe from bottom-left to top-right',
    icon: '◥',
    defaultParams: { duration: 0.7, softness: 15 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 15 },
    ],
  },
  {
    id: 'WIPE_DIAGONAL_BR',
    name: 'Wipe Diagonal ↖',
    category: 'Wipes',
    description: 'Diagonal wipe from bottom-right to top-left',
    icon: '◤',
    defaultParams: { duration: 0.7, softness: 15 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 15 },
    ],
  },
  {
    id: 'WIPE_RADIAL_CW',
    name: 'Radial Wipe CW',
    category: 'Wipes',
    description: 'Clockwise radial wipe reveal',
    icon: '↻',
    defaultParams: { duration: 0.8, softness: 5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 5 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'WIPE_RADIAL_CCW',
    name: 'Radial Wipe CCW',
    category: 'Wipes',
    description: 'Counter-clockwise radial wipe reveal',
    icon: '↺',
    defaultParams: { duration: 0.8, softness: 5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 5 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'WIPE_CLOCK',
    name: 'Clock Wipe',
    category: 'Wipes',
    description: 'Clock-hand sweep reveal',
    icon: '⏱',
    defaultParams: { duration: 1.0 },
    paramSchema: [
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },

  // ─── SHAPES ────────────────────────────────────────────
  {
    id: 'SHAPE_CIRCLE',
    name: 'Circle Reveal',
    category: 'Shapes',
    description: 'Expanding circle reveals incoming clip',
    icon: '●',
    defaultParams: { duration: 0.7, softness: 15, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 15 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'SHAPE_DIAMOND',
    name: 'Diamond Reveal',
    category: 'Shapes',
    description: 'Expanding diamond shape reveals incoming clip',
    icon: '◆',
    defaultParams: { duration: 0.7, softness: 10, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'SHAPE_STAR',
    name: 'Star Reveal',
    category: 'Shapes',
    description: 'Expanding star shape reveals incoming clip',
    icon: '★',
    defaultParams: { duration: 0.8, softness: 5, segments: 5, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'segments', label: 'Points', type: 'range', min: 3, max: 12, step: 1, default: 5 },
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 5 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'SHAPE_HEART',
    name: 'Heart Reveal',
    category: 'Shapes',
    description: 'Expanding heart shape reveals incoming clip',
    icon: '♥',
    defaultParams: { duration: 0.8, softness: 10, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'SHAPE_HEXAGON',
    name: 'Hexagon Reveal',
    category: 'Shapes',
    description: 'Expanding hexagon reveals incoming clip',
    icon: '⬡',
    defaultParams: { duration: 0.7, softness: 10, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
    ],
  },
  {
    id: 'SHAPE_TRIANGLE',
    name: 'Triangle Reveal',
    category: 'Shapes',
    description: 'Expanding triangle reveals incoming clip',
    icon: '▲',
    defaultParams: { duration: 0.7, softness: 10, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 10 },
    ],
  },
  {
    id: 'IRIS_OPEN',
    name: 'Iris Open',
    category: 'Shapes',
    description: 'Circle opens from center to reveal',
    icon: '◎',
    defaultParams: { duration: 0.7, softness: 20, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 20 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },
  {
    id: 'IRIS_CLOSE',
    name: 'Iris Close',
    category: 'Shapes',
    description: 'Circle closes to center then opens to reveal',
    icon: '◉',
    defaultParams: { duration: 0.7, softness: 20, centerX: 0.5, centerY: 0.5 },
    paramSchema: [
      { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, default: 20 },
      { key: 'centerX', label: 'Center X', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'centerY', label: 'Center Y', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
    ],
  },

  // ─── SLIDE / PUSH ──────────────────────────────────────
  {
    id: 'SLIDE_LEFT',
    name: 'Slide Left',
    category: 'Slide',
    description: 'New clip slides in from the right',
    icon: '⇐',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'SLIDE_RIGHT',
    name: 'Slide Right',
    category: 'Slide',
    description: 'New clip slides in from the left',
    icon: '⇒',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'SLIDE_UP',
    name: 'Slide Up',
    category: 'Slide',
    description: 'New clip slides in from below',
    icon: '⇑',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'SLIDE_DOWN',
    name: 'Slide Down',
    category: 'Slide',
    description: 'New clip slides in from above',
    icon: '⇓',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'PUSH_LEFT',
    name: 'Push Left',
    category: 'Slide',
    description: 'New clip pushes old clip off to the left',
    icon: '⏴',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'PUSH_RIGHT',
    name: 'Push Right',
    category: 'Slide',
    description: 'New clip pushes old clip off to the right',
    icon: '⏵',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'PUSH_UP',
    name: 'Push Up',
    category: 'Slide',
    description: 'New clip pushes old clip upward',
    icon: '⏶',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },
  {
    id: 'PUSH_DOWN',
    name: 'Push Down',
    category: 'Slide',
    description: 'New clip pushes old clip downward',
    icon: '⏷',
    defaultParams: { duration: 0.5 },
    paramSchema: [],
  },

  // ─── EFFECTS ───────────────────────────────────────────
  {
    id: 'ZOOM_IN',
    name: 'Zoom In',
    category: 'Effects',
    description: 'Zoom into outgoing clip, then reveal incoming',
    icon: '🔍',
    defaultParams: { duration: 0.6, intensity: 50 },
    paramSchema: [
      { key: 'intensity', label: 'Zoom Amount', type: 'range', min: 10, max: 100, step: 1, default: 50 },
    ],
  },
  {
    id: 'ZOOM_OUT',
    name: 'Zoom Out',
    category: 'Effects',
    description: 'Zoom out from incoming clip reveal',
    icon: '🔎',
    defaultParams: { duration: 0.6, intensity: 50 },
    paramSchema: [
      { key: 'intensity', label: 'Zoom Amount', type: 'range', min: 10, max: 100, step: 1, default: 50 },
    ],
  },
  {
    id: 'ZOOM_ROTATE',
    name: 'Zoom Rotate',
    category: 'Effects',
    description: 'Zoom with rotation twist between clips',
    icon: '🌀',
    defaultParams: { duration: 0.8, intensity: 50, angle: 90 },
    paramSchema: [
      { key: 'intensity', label: 'Zoom Amount', type: 'range', min: 10, max: 100, step: 1, default: 50 },
      { key: 'angle', label: 'Rotation', type: 'range', min: 0, max: 360, step: 5, default: 90 },
    ],
  },
  {
    id: 'BLUR',
    name: 'Blur',
    category: 'Effects',
    description: 'Blur out, then blur in',
    icon: '⊙',
    defaultParams: { duration: 0.8, intensity: 60 },
    paramSchema: [
      { key: 'intensity', label: 'Blur Strength', type: 'range', min: 5, max: 100, step: 1, default: 60 },
    ],
  },
  {
    id: 'BLUR_DIRECTIONAL',
    name: 'Directional Blur',
    category: 'Effects',
    description: 'Motion blur effect during transition',
    icon: '⇶',
    defaultParams: { duration: 0.6, intensity: 50, direction: 'right' },
    paramSchema: [
      { key: 'intensity', label: 'Blur Strength', type: 'range', min: 5, max: 100, step: 1, default: 50 },
      { key: 'direction', label: 'Direction', type: 'select', options: [
        { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
        { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' },
      ], default: 'right' },
    ],
  },
  {
    id: 'SPIN_CW',
    name: 'Spin Clockwise',
    category: 'Effects',
    description: 'Clockwise spin transition',
    icon: '↻',
    defaultParams: { duration: 0.7, intensity: 50 },
    paramSchema: [
      { key: 'intensity', label: 'Speed', type: 'range', min: 10, max: 100, step: 1, default: 50 },
    ],
  },
  {
    id: 'SPIN_CCW',
    name: 'Spin Counter-CW',
    category: 'Effects',
    description: 'Counter-clockwise spin transition',
    icon: '↺',
    defaultParams: { duration: 0.7, intensity: 50 },
    paramSchema: [
      { key: 'intensity', label: 'Speed', type: 'range', min: 10, max: 100, step: 1, default: 50 },
    ],
  },
  {
    id: 'GLITCH',
    name: 'Glitch',
    category: 'Effects',
    description: 'Digital glitch effect between clips',
    icon: '⚡',
    defaultParams: { duration: 0.4, intensity: 60 },
    paramSchema: [
      { key: 'intensity', label: 'Glitch Amount', type: 'range', min: 10, max: 100, step: 1, default: 60 },
    ],
  },
  {
    id: 'SPLIT_HORIZONTAL',
    name: 'Split Horizontal',
    category: 'Effects',
    description: 'Screen splits horizontally to reveal',
    icon: '⬌',
    defaultParams: { duration: 0.6 },
    paramSchema: [],
  },
  {
    id: 'SPLIT_VERTICAL',
    name: 'Split Vertical',
    category: 'Effects',
    description: 'Screen splits vertically to reveal',
    icon: '⬍',
    defaultParams: { duration: 0.6 },
    paramSchema: [],
  },

  // ─── BLEND DISSOLVES ──────────────────────────────────
  {
    id: 'DISSOLVE_MULTIPLY',
    name: 'Multiply Dissolve',
    category: 'Blend',
    description: 'Dissolve using multiply blend mode',
    icon: '✕',
    defaultParams: { duration: 0.8, blendMode: 'multiply' },
    paramSchema: [],
  },
  {
    id: 'DISSOLVE_SCREEN',
    name: 'Screen Dissolve',
    category: 'Blend',
    description: 'Dissolve using screen blend mode (brightens)',
    icon: '☀',
    defaultParams: { duration: 0.8, blendMode: 'screen' },
    paramSchema: [],
  },
  {
    id: 'DISSOLVE_OVERLAY',
    name: 'Overlay Dissolve',
    category: 'Blend',
    description: 'Dissolve using overlay blend mode',
    icon: '◧',
    defaultParams: { duration: 0.8, blendMode: 'overlay' },
    paramSchema: [],
  },
  {
    id: 'DISSOLVE_LUMINOSITY',
    name: 'Luminosity Dissolve',
    category: 'Blend',
    description: 'Dissolve using luminosity blend mode',
    icon: '◨',
    defaultParams: { duration: 0.8, blendMode: 'luminosity' },
    paramSchema: [],
  },

  // ─── CREATIVE ──────────────────────────────────────────
  {
    id: 'PIXELATE',
    name: 'Pixelate',
    category: 'Creative',
    description: 'Pixelate out then in',
    icon: '▦',
    defaultParams: { duration: 0.7, intensity: 60, segments: 20 },
    paramSchema: [
      { key: 'intensity', label: 'Pixelation', type: 'range', min: 5, max: 100, step: 1, default: 60 },
      { key: 'segments', label: 'Block Size', type: 'range', min: 4, max: 50, step: 1, default: 20 },
    ],
  },
  {
    id: 'MOSAIC',
    name: 'Mosaic',
    category: 'Creative',
    description: 'Mosaic tile reveal effect',
    icon: '▤',
    defaultParams: { duration: 0.8, segments: 8 },
    paramSchema: [
      { key: 'segments', label: 'Grid Size', type: 'range', min: 2, max: 20, step: 1, default: 8 },
    ],
  },
  {
    id: 'FILM_BURN',
    name: 'Film Burn',
    category: 'Creative',
    description: 'Warm film burn effect between clips',
    icon: '🔥',
    defaultParams: { duration: 0.8, color: '#ff6600', intensity: 70 },
    paramSchema: [
      { key: 'color', label: 'Burn Color', type: 'color', default: '#ff6600' },
      { key: 'intensity', label: 'Intensity', type: 'range', min: 20, max: 100, step: 1, default: 70 },
    ],
  },
  {
    id: 'LIGHT_LEAK',
    name: 'Light Leak',
    category: 'Creative',
    description: 'Dreamy light leak between clips',
    icon: '✦',
    defaultParams: { duration: 0.9, color: '#ffcc00', intensity: 50 },
    paramSchema: [
      { key: 'color', label: 'Leak Color', type: 'color', default: '#ffcc00' },
      { key: 'intensity', label: 'Intensity', type: 'range', min: 20, max: 100, step: 1, default: 50 },
    ],
  },
];

// ============ LOOKUP HELPER ============
const catalogMap = new Map<TransitionType, TransitionDefinition>();
TRANSITION_CATALOG.forEach(def => catalogMap.set(def.id, def));

export function getTransitionDef(type: TransitionType): TransitionDefinition | undefined {
  return catalogMap.get(type);
}
