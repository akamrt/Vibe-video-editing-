import type { CSSProperties } from 'react';

// ============ GRADIENT STOPS ============
export interface GradientStop {
  color: string;      // hex color
  position: number;   // 0-100 (percentage along gradient)
  opacity?: number;   // 0-1, defaults to 1
}

// ============ EXPORT SETTINGS ============
export type AspectRatioPreset = '16:9' | '9:16' | '1:1' | '4:5' | 'custom';

export interface ExportSettings {
  aspectRatio: AspectRatioPreset;
  customAspectRatio?: { width: number; height: number };
  resolution: '720p' | '1080p' | '4K' | 'custom';
  customResolution?: { width: number; height: number };
  format: 'mp4' | 'webm';
  bitrateMbps: number;
  fps: number;
}

// ============ VIEWPORT SETTINGS ============
export interface ViewportSettings {
  previewAspectRatio: AspectRatioPreset;
  showOverlay: boolean;
  overlayOpacity: number;
}

// ============ KEYFRAME ANIMATION ============
export interface KeyTangent {
  x: number; // Frame offset (relative)
  y: number; // Value offset (relative)
}

export interface KeyframeConfig {
  inTangent?: KeyTangent;
  outTangent?: KeyTangent;
  broken?: boolean; // If true, tangents move independently
}

export interface ClipKeyframe {
  time: number; // Time within clip (relative to clip start, in seconds)
  translateX: number; // Percentage offset (-100 to 100)
  translateY: number; // Percentage offset (-100 to 100)
  scale: number; // 1.0 = 100%, 0.5 = 50%, 2.0 = 200%
  rotation: number; // Degrees
  volume?: number; // 0.0 = silent, 1.0 = full (default when absent)
  pivotX?: number; // Transform origin X, 0-100% (default 50 = center)
  pivotY?: number; // Transform origin Y, 0-100% (default 50 = center)
  keyframeConfig?: Record<string, KeyframeConfig>; // Per-property tangents
}

// ============ PIVOT KEYFRAMES ============
export interface PivotKeyframe {
  time: number;  // Clip-relative time (seconds)
  x: number;     // Pivot X in safe-zone % (0=left, 100=right)
  y: number;     // Pivot Y in safe-zone % (0=top, 100=bottom)
}

// ============ TRACKING SYSTEM ============
export interface VibeCutTracker {
  id: string;
  color: string;
  x: number;           // Video-space pixel X
  y: number;           // Video-space pixel Y
  patchSize: number;   // Template patch size in pixels (16-128, default 32)
  searchWindow: number; // Search area radius in pixels (20-200, default 60)
  sensitivity: number;  // 0-100, threshold for match rejection (default 50)
  type: 'stabilizer' | 'parent';
  matchScore?: number;  // Last known match quality 0-100
  isActive: boolean;    // Whether this tracker participates in tracking
}

export interface TrackedFrame {
  time: number;         // Absolute video time (seconds)
  trackers: Array<{
    id: string;
    x: number;
    y: number;
    matchScore: number;
  }>;
}

export type TrackingMode = 'idle' | 'placing-stabilizer' | 'placing-parent' | 'tracking' | 'reviewing';

// ============ MEDIA & SEGMENTS ============
export interface CachedFillerDetection {
  startTime: number;
  endTime: number;
  text: string;
  type: 'filler' | 'repeated' | 'stammer';
}

export interface MediaItem {
  id: string;
  file: File;
  url: string;
  duration: number;
  name: string;
  analysis: VideoAnalysis | null;
  isCached?: boolean;
  isAudioOnly?: boolean; // true when file is audio/* with no video track
  fillerDetections?: CachedFillerDetection[];
  youtubeVideoId?: string; // YouTube video ID for local cache lookups
  transcriptSource?: 'youtube' | 'assemblyai' | 'gemini' | 'none';
}

// ============ TRANSITION SYSTEM ============
export type TransitionType =
  // Basic
  | 'FADE' | 'CROSSFADE' | 'FADE_BLACK' | 'FADE_WHITE' | 'DIP_TO_BLACK' | 'DIP_TO_WHITE'
  // Wipes
  | 'WIPE_LEFT' | 'WIPE_RIGHT' | 'WIPE_UP' | 'WIPE_DOWN'
  | 'WIPE_DIAGONAL_TL' | 'WIPE_DIAGONAL_TR' | 'WIPE_DIAGONAL_BL' | 'WIPE_DIAGONAL_BR'
  | 'WIPE_RADIAL_CW' | 'WIPE_RADIAL_CCW' | 'WIPE_CLOCK'
  // Shapes
  | 'SHAPE_CIRCLE' | 'SHAPE_DIAMOND' | 'SHAPE_STAR' | 'SHAPE_HEART'
  | 'SHAPE_HEXAGON' | 'SHAPE_TRIANGLE'
  | 'IRIS_OPEN' | 'IRIS_CLOSE'
  // Slide / Push
  | 'SLIDE_LEFT' | 'SLIDE_RIGHT' | 'SLIDE_UP' | 'SLIDE_DOWN'
  | 'PUSH_LEFT' | 'PUSH_RIGHT' | 'PUSH_UP' | 'PUSH_DOWN'
  // Effects
  | 'ZOOM_IN' | 'ZOOM_OUT' | 'ZOOM_ROTATE'
  | 'BLUR' | 'BLUR_DIRECTIONAL'
  | 'SPIN_CW' | 'SPIN_CCW'
  | 'GLITCH'
  | 'SPLIT_HORIZONTAL' | 'SPLIT_VERTICAL'
  // Blend dissolves
  | 'DISSOLVE_MULTIPLY' | 'DISSOLVE_SCREEN' | 'DISSOLVE_OVERLAY' | 'DISSOLVE_LUMINOSITY'
  // Creative
  | 'PIXELATE' | 'MOSAIC' | 'FILM_BURN' | 'LIGHT_LEAK'
  | 'NONE';

export type TransitionEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'bounce';

export type TransitionCategory = 'Basic' | 'Wipes' | 'Shapes' | 'Slide' | 'Effects' | 'Blend' | 'Creative';

export interface Transition {
  type: TransitionType;
  duration: number;            // seconds (0.1 - 3.0)
  easing?: TransitionEasing;
  blendMode?: string;          // CSS globalCompositeOperation value
  color?: string;              // hex color for wash/dip/film-burn
  direction?: 'left' | 'right' | 'up' | 'down' | 'cw' | 'ccw';
  softness?: number;           // 0-100 feather width for wipe edges
  centerX?: number;            // 0-1 normalized, default 0.5
  centerY?: number;            // 0-1 normalized, default 0.5
  intensity?: number;          // 0-100 for blur/glitch/pixelate strength
  segments?: number;           // star points, mosaic grid size
  angle?: number;              // degrees for diagonal/radial
  audioCurve?: 'linear' | 'equalPower'; // crossfade curve for audio overlaps
}

export interface TransitionParamSchema {
  key: keyof Transition;
  label: string;
  type: 'range' | 'select' | 'color' | 'number';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  default?: number | string;
}

export interface TransitionDefinition {
  id: TransitionType;
  name: string;
  category: TransitionCategory;
  description: string;
  icon: string;                // Unicode character for compact display
  defaultParams: Partial<Transition>;
  paramSchema: TransitionParamSchema[];
}

// ============ COLOR CORRECTION (Phase 1 - legacy) ============
export interface ColorCorrection {
  brightness: number;    // 0-200 (100 = default, maps to CSS brightness(1.0))
  contrast: number;      // 0-200 (100 = default)
  saturation: number;    // 0-200 (100 = default)
  exposure: number;      // -100 to 100 (0 = default, brightness offset)
  temperature: number;   // -100 to 100 (0 = neutral, warm ↔ cool)
  tint: number;          // -100 to 100 (0 = neutral, green ↔ magenta)
  highlights: number;    // -100 to 100 (0 = default)
  shadows: number;       // -100 to 100 (0 = default)
  hueRotate: number;     // -180 to 180 degrees
  gamma: number;         // 0.1-3.0 (1.0 = default)
}

// ============ COLOR GRADING (Phase 2 - advanced) ============
export interface ColorWheelValue {
  r: number;   // -1 to 1 (0 = neutral)
  g: number;   // -1 to 1
  b: number;   // -1 to 1
  y: number;   // luminance/master, -1 to 1
}

export interface CurvePoint {
  x: number;   // 0-1 (input value)
  y: number;   // 0-1 (output value)
}

export interface QualifierRange {
  center: number;
  width: number;
  softness: number;
}

export interface HSLQualifier {
  enabled: boolean;
  hue: QualifierRange;
  saturation: QualifierRange;
  luminance: QualifierRange;
  blurRadius: number;
  invert: boolean;
}

export interface ColorGrading {
  // Basic corrections (same as Phase 1)
  brightness: number;    // 0-200 (100 = default)
  contrast: number;      // 0-200 (100 = default)
  saturation: number;    // 0-200 (100 = default)
  exposure: number;      // -100 to 100
  temperature: number;   // -100 to 100
  tint: number;          // -100 to 100
  highlights: number;    // -100 to 100
  shadows: number;       // -100 to 100
  hueRotate: number;     // -180 to 180
  gamma: number;         // 0.1-3.0

  // Color Wheels
  lift: ColorWheelValue;
  gammaWheel: ColorWheelValue;   // "gammaWheel" to avoid clash with gamma slider
  gain: ColorWheelValue;
  offset: ColorWheelValue;

  // RGB Curves (control points)
  curveMaster: CurvePoint[];
  curveRed: CurvePoint[];
  curveGreen: CurvePoint[];
  curveBlue: CurvePoint[];

  // HSL Curves
  hueVsHue: CurvePoint[];
  hueVsSat: CurvePoint[];
  hueVsLum: CurvePoint[];
  lumVsSat: CurvePoint[];
  satVsSat: CurvePoint[];

  // HSL Qualifier
  qualifier?: HSLQualifier;
}

export interface Segment {
  id: string;
  type?: 'video' | 'audio' | 'blank'; // 'audio' = unlinked audio-only segment
  mediaId: string; // References MediaItem
  startTime: number; // Start point in SOURCE video
  endTime: number;   // End point in SOURCE video
  timelineStart: number; // Start point on the SEQUENCE timeline
  track: number; // Vertical layering (0 = V1, 1 = V2, etc.)
  description: string;
  customText?: string; // Text to display for blank chunks
  color: string;
  transitionIn?: Transition;
  transitionOut?: Transition;
  keyframes?: ClipKeyframe[]; // Animation keyframes for pan/zoom/rotate within clip
  trackers?: VibeCutTracker[];       // Manually placed tracker points
  trackingData?: TrackedFrame[];      // Frame-by-frame tracking results
  // Audio unlinking
  audioLinked?: boolean;      // true (default) = audio moves with video. false = audio is separate
  linkedSegmentId?: string;   // ID of counterpart segment (video ↔ audio) when unlinked
  colorCorrection?: ColorCorrection; // Phase 1 legacy (migrated to colorGrading on load)
  colorGrading?: ColorGrading;       // Full color grading (Phase 2)
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model' | 'system';
  text: string;
  timestamp: Date;
}

export interface SubtitleStyle {
  fontFamily: string;
  fontSize: number; // px
  color: string;
  backgroundColor: string;
  backgroundOpacity: number; // 0-1
  backgroundType: 'none' | 'box' | 'rounded' | 'stripe' | 'outline';
  boxBorderColor: string;
  boxBorderWidth: number; // px
  boxBorderRadius: number; // px
  bottomOffset: number; // % from bottom
  textAlign: 'left' | 'center' | 'right';
  bold: boolean;
  italic: boolean;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';

  // Customization expansions
  textShadowColor?: string;
  textShadowBlur?: number;
  textShadowOffsetX?: number;
  textShadowOffsetY?: number;

  glowColor?: string;
  glowBlur?: number;

  backdropShadowColor?: string;
  backdropShadowBlur?: number;
  backdropShadowOffsetX?: number;
  backdropShadowOffsetY?: number;

  backdropGlowColor?: string;
  backdropGlowBlur?: number;

  innerGlowColor?: string;
  innerGlowBlur?: number;

  gradientColors?: string[]; // e.g. ["#ff0000", "#00ff00"] (legacy 2-color)
  gradientStops?: GradientStop[]; // Multi-stop gradient (takes priority over gradientColors)
  gradientType?: 'none' | 'linear' | 'radial';
  gradientAngle?: number; // degrees

  outlineColor?: string;
  outlineWidth?: number; // px for text stroke

  // Layer style blend modes (Photoshop-style per-effect blending)
  textBlendMode?: string;           // blend mode for the text fill itself
  shadowBlendMode?: string;         // blend mode for text drop shadow
  glowBlendMode?: string;           // blend mode for text outer glow
  innerGlowBlendMode?: string;      // blend mode for inner glow
  backdropBlendMode?: string;       // blend mode for the background box
  backdropShadowBlendMode?: string; // blend mode for background drop shadow
  backdropGlowBlendMode?: string;   // blend mode for background outer glow
  gradientBlendMode?: string;       // blend mode for the gradient fill

  // Word highlight box (karaoke-style)
  wordHighlightEnabled?: boolean;
  wordHighlightColor?: string;          // box fill color, default '#FFD700'
  wordHighlightOpacity?: number;        // 0-1, default 0.85
  wordHighlightPaddingH?: number;       // horizontal padding px, default 4
  wordHighlightPaddingV?: number;       // vertical padding px, default 2
  wordHighlightBorderRadius?: number;   // px, default 4
  wordHighlightBlendMode?: string;      // CSS blend mode, default 'normal'
  wordHighlightTransitionMs?: number;   // slide duration ms, default 150
  wordHighlightScale?: number;          // scale relative to word box, default 1.0
  wordHighlightActiveColor?: string;    // override text color of active word
  wordHighlightIdleOpacity?: number;    // opacity of non-active words, default 1.0
  wordHighlightShadowColor?: string;
  wordHighlightShadowBlur?: number;
  wordHighlightShadowOffsetX?: number;
  wordHighlightShadowOffsetY?: number;
  wordHighlightGlowColor?: string;
  wordHighlightGlowBlur?: number;
  wordHighlightOffsetX?: number;         // manual X offset px, default 0
  wordHighlightOffsetY?: number;         // manual Y offset px, default 0
  wordHighlightSkipKeywords?: boolean;   // skip keyword-emphasized words (highlight jumps past them)

  // In-flight effects (applied while active word is still animating in)
  wordHighlightFlightColorEnabled?: boolean;
  wordHighlightFlightColor?: string;          // in-flight box color, default '#FFFFFF'
  wordHighlightFlightColorOpacity?: number;   // in-flight box opacity, default 1.0
  wordHighlightFlightGlowEnabled?: boolean;
  wordHighlightFlightGlowColor?: string;      // runtime fallback: wordHighlightColor
  wordHighlightFlightGlowBlur?: number;       // in-flight glow blur px, default 20
  wordHighlightFlightScaleEnabled?: boolean;
  wordHighlightFlightScale?: number;          // multiplier on top of wordHighlightScale, default 1.25

  // Keyword highlight effects (replace normal in-flight effects when active word is a keyword)
  wordHighlightKwInvertEnabled?: boolean;     // invert box/text colors
  wordHighlightKwShimmerEnabled?: boolean;    // animated gradient sweep across box
  wordHighlightKwShimmerColor?: string;       // shimmer highlight color, default '#FFFFFF'
  wordHighlightKwShimmerSpeed?: number;       // shimmer cycle duration in seconds, default 0.6
  wordHighlightKwParticlesEnabled?: boolean;  // floating sparkle particles from box
  wordHighlightKwParticleCount?: number;      // number of particles, default 6
  wordHighlightKwParticleColor?: string;      // particle color, default '#FFD700'
  wordHighlightKwGlowEnabled?: boolean;       // keyword-specific glow surge
  wordHighlightKwGlowColor?: string;          // keyword glow color, runtime fallback: keyword color
  wordHighlightKwGlowBlur?: number;           // keyword glow blur px, default 30
  wordHighlightKwScaleEnabled?: boolean;      // keyword-specific scale pop
  wordHighlightKwScale?: number;              // keyword scale multiplier, default 1.4
}

// ============ TITLE LAYER ============
export interface TitleStyle {
  fontFamily: string;
  fontSize: number; // px
  color: string;
  backgroundColor: string;
  backgroundOpacity: number; // 0-1
  backgroundType: 'none' | 'box' | 'rounded' | 'stripe' | 'outline';
  boxBorderColor: string;
  boxBorderWidth: number; // px
  boxBorderRadius: number; // px
  topOffset: number; // % from top
  textAlign: 'left' | 'center' | 'right';
  bold: boolean;
  italic: boolean;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';

  // Customization expansions
  textShadowColor?: string;
  textShadowBlur?: number;
  textShadowOffsetX?: number;
  textShadowOffsetY?: number;

  glowColor?: string;
  glowBlur?: number;

  backdropShadowColor?: string;
  backdropShadowBlur?: number;
  backdropShadowOffsetX?: number;
  backdropShadowOffsetY?: number;

  backdropGlowColor?: string;
  backdropGlowBlur?: number;

  innerGlowColor?: string;
  innerGlowBlur?: number;

  gradientColors?: string[];
  gradientStops?: GradientStop[];
  gradientType?: 'none' | 'linear' | 'radial';
  gradientAngle?: number;

  outlineColor?: string;
  outlineWidth?: number;

  // Layer style blend modes (Photoshop-style per-effect blending)
  textBlendMode?: string;
  shadowBlendMode?: string;
  glowBlendMode?: string;
  innerGlowBlendMode?: string;
  backdropBlendMode?: string;
  backdropShadowBlendMode?: string;
  backdropGlowBlendMode?: string;
  gradientBlendMode?: string;

  // Word highlight box (karaoke-style)
  wordHighlightEnabled?: boolean;
  wordHighlightColor?: string;
  wordHighlightOpacity?: number;
  wordHighlightPaddingH?: number;
  wordHighlightPaddingV?: number;
  wordHighlightBorderRadius?: number;
  wordHighlightBlendMode?: string;
  wordHighlightTransitionMs?: number;
  wordHighlightScale?: number;
  wordHighlightActiveColor?: string;
  wordHighlightIdleOpacity?: number;
  wordHighlightShadowColor?: string;
  wordHighlightShadowBlur?: number;
  wordHighlightShadowOffsetX?: number;
  wordHighlightShadowOffsetY?: number;
  wordHighlightGlowColor?: string;
  wordHighlightGlowBlur?: number;
  wordHighlightOffsetX?: number;         // manual X offset px, default 0
  wordHighlightOffsetY?: number;         // manual Y offset px, default 0
  wordHighlightSkipKeywords?: boolean;   // skip keyword-emphasized words (highlight jumps past them)

  // In-flight effects (applied while active word is still animating in)
  wordHighlightFlightColorEnabled?: boolean;
  wordHighlightFlightColor?: string;
  wordHighlightFlightColorOpacity?: number;
  wordHighlightFlightGlowEnabled?: boolean;
  wordHighlightFlightGlowColor?: string;
  wordHighlightFlightGlowBlur?: number;
  wordHighlightFlightScaleEnabled?: boolean;
  wordHighlightFlightScale?: number;

  // Keyword highlight effects (replace normal in-flight effects when active word is a keyword)
  wordHighlightKwInvertEnabled?: boolean;
  wordHighlightKwShimmerEnabled?: boolean;
  wordHighlightKwShimmerColor?: string;
  wordHighlightKwShimmerSpeed?: number;
  wordHighlightKwParticlesEnabled?: boolean;
  wordHighlightKwParticleCount?: number;
  wordHighlightKwParticleColor?: string;
  wordHighlightKwGlowEnabled?: boolean;
  wordHighlightKwGlowColor?: string;
  wordHighlightKwGlowBlur?: number;
  wordHighlightKwScaleEnabled?: boolean;
  wordHighlightKwScale?: number;
}

export interface TitleLayer {
  id: string;
  text: string; // The hook title text
  startTime: number; // When the title starts appearing on timeline
  endTime: number; // When the title fully disappears
  fadeInDuration: number; // Duration of fade-in effect (seconds)
  fadeOutDuration: number; // Duration of fade-out effect (seconds)
  style?: TitleStyle; // Optional style override
  animation?: TextAnimation; // Custom animation for this title instance
  keyframes?: ClipKeyframe[]; // Animation keyframes for the title
  pivotKeyframes?: PivotKeyframe[];  // Head-tracking pivot animation
}

export interface AnalysisEvent {
  startTime: number;
  endTime: number;
  type: 'dialogue' | 'visual' | 'action' | 'sound';
  label: string;
  details: string;
  styleOverride?: SubtitleStyle; // Optional override for specific subtitle events
  templateOverride?: SubtitleTemplate;
  wordEmphases?: KeywordEmphasis[]; // Optional per-event animation template override
  translateX?: number; // percentage offset from default position
  translateY?: number; // percentage offset from default position
  keyframes?: ClipKeyframe[]; // Animation keyframes for subtitle event transforms
  keywordAnimation?: TextAnimation; // separate animation for keyword words
  pivotKeyframes?: PivotKeyframe[];  // Head-tracking pivot animation
  confidence?: number; // Word-level confidence from AssemblyAI (0-1)
  wordTimings?: Array<{ // Per-word timings for karaoke accuracy (AssemblyAI)
    text: string;
    start: number;  // seconds
    end: number;    // seconds
    confidence: number;
  }>;
}

export interface VideoAnalysis {
  summary: string;
  events: AnalysisEvent[];
  generatedAt: Date;
}

export interface RemovedWord {
  id: string;
  mediaId: string;
  text: string;
  startTime: number;
  endTime: number;
  originalEventIndex: number;
}

// ============ AUDIO MIXER ============
export interface EQBand {
  frequency: number;          // Hz (e.g., 100 for bass, 1000 for mid, 8000 for treble)
  gain: number;               // dB, -12 to +12
  Q: number;                  // Quality factor, 0.5 to 10
  type: BiquadFilterType;     // 'lowshelf' | 'peaking' | 'highshelf'
}

export interface AudioEffects {
  // Noise Reduction (RNNoise WASM)
  noiseReduction: boolean;

  // 3-band EQ (bass/mid/treble)
  eqEnabled: boolean;
  eqBands: [EQBand, EQBand, EQBand];

  // Dynamics Compressor
  compressorEnabled: boolean;
  compressorThreshold: number;  // dB, -100 to 0
  compressorKnee: number;       // dB, 0 to 40
  compressorRatio: number;      // 1 to 20
  compressorAttack: number;     // seconds, 0 to 1
  compressorRelease: number;    // seconds, 0 to 1

  // Limiter (hard limiter)
  limiterEnabled: boolean;
  limiterThreshold: number;     // dB, -30 to 0

  // Loudness Normalization
  normalizationEnabled: boolean;
  normalizationTarget: number;  // LUFS (e.g., -14 YouTube, -16 podcast, -23 broadcast)
}

export interface AudioMixerState {
  masterVolume: number;         // 0.0 to 2.0 (1.0 = unity gain)
  effects: AudioEffects;
}

export interface ProjectState {
  library: MediaItem[];
  segments: Segment[]; // The active sequence
  currentTime: number; // Current sequence playhead time
  isPlaying: boolean;
  activeSegmentIndex: number;
  loopMode: boolean;
  subtitleStyle: SubtitleStyle;
  titleStyle: TitleStyle;
  titleLayer: TitleLayer | null; // The title layer for the current project
  activeSubtitleTemplate: SubtitleTemplate | null;
  activeTitleTemplate: SubtitleTemplate | null;
  activeKeywordAnimation: TextAnimation | null;
  removedWords: RemovedWord[];
  audioMixer?: AudioMixerState;
  dialogueLayerVisible: boolean;
  titlesLayerVisible: boolean;
  /** Independent DSL-driven graphic overlays (shapes, images, decorative text) */
  graphicLayers?: GraphicLayer[];
  /** Hide all graphic layers (visibility toggle for the whole track) */
  graphicLayersVisible?: boolean;
}

// ============ REMOTION TEMPLATE SYSTEM ============

export type EasingType = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'elastic' | 'bounce' | 'spring';

export type AnimationScope = 'element' | 'line' | 'word' | 'character';

export interface KeywordEmphasis {
  word: string;
  wordIndex: number;
  enabled: boolean;
  color?: string;
}

export type EffectWordTarget =
  | { mode: 'all' }
  | { mode: 'keywords' }
  | { mode: 'non-keywords' }
  | { mode: 'indices'; indices: number[] };

export interface AnimationEffect {
  id: string;
  type: 'opacity' | 'translateY' | 'translateX' | 'scale' | 'rotate' | 'blur' | 'letterSpacing';
  from: number;
  to: number;
  // Timing within the total animation duration (0.0 to 1.0)
  startAt: number;
  endAt: number;
  easing: EasingType;
  // Easing config (optional)
  bounciness?: number; // 0-20
  stiffness?: number; // 0-500
  wordTarget?: EffectWordTarget;
}

export interface TextAnimation {
  id: string;
  name: string;
  duration: number; // Overall duration in seconds
  scope: AnimationScope; // Default scope for the animation
  stagger: number; // seconds delay per item (character/word/line)
  effects: AnimationEffect[];
}

// Backwards compatibility wrapper (if needed) or just replace AnimationPreset
export type AnimationPreset = TextAnimation;

export interface HyperframesVariable {
  name: string;
  type: 'string' | 'color' | 'number' | 'boolean' | 'select' | 'font';
  /** Optional grouping (e.g. 'Text', 'Animation', 'Effects', 'Karaoke') for form sections */
  group?: 'Text' | 'Animation' | 'Effects' | 'Karaoke';
  label?: string;
  defaultValue?: string | number | boolean;
  options?: string[];   // for 'select' type
  min?: number;         // for 'number' type
  max?: number;
  step?: number;
}

export interface HyperframesConfig {
  compositionSrc: string;                           // e.g. '/hyperframes/bounce-caption.html', or 'dsl://custom' / 'html://custom'
  variables: Record<string, string | number | boolean>;  // current user values
  variableSchema: HyperframesVariable[];            // parsed from composition data-var-* attrs
  /** When set, the DSL renderer is used (preview + canvas export). Overrides compositionSrc. */
  dsl?: HyperframesDSL;
  /** When set, raw HTML is loaded into a sandboxed iframe (preview only — does not export). */
  rawHtml?: string;
}

// ============ HYPERFRAMES DSL — declarative animated caption spec ============
// Lets the AI generator (and humans) describe novel caption animations in JSON
// without writing code. Both the preview component and canvas exporter
// interpret the same DSL, so what you see in preview is what gets exported.

export type HyperframesEasing =
  | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  | 'power2In' | 'power2Out' | 'power2InOut'
  | 'power3In' | 'power3Out' | 'power3InOut'
  | 'outBack' | 'outElastic' | 'outBounce' | 'inBack';

export type HyperframesTrackProp =
  | 'opacity' | 'translateX' | 'translateY' | 'scale' | 'scaleX' | 'scaleY'
  | 'rotate' | 'skewX' | 'skewY' | 'blur' | 'colorMix';

export interface HyperframesTrack {
  /** Which transform/property this track drives */
  prop: HyperframesTrackProp;
  // ── Mode 1: tween (use `from`, `to`, `at`) ──
  from?: number;
  to?: number;
  /** [startProgress, endProgress] within unit's animation duration, normalized 0..1 */
  at?: [number, number];
  easing?: HyperframesEasing;
  // ── Mode 2: continuous loop (use `loop`, `amplitude`, `period`) ──
  loop?: 'sine' | 'cosine' | 'sawtooth' | 'triangle' | 'random';
  amplitude?: number;
  /** Loop period in seconds */
  period?: number;
  /** Phase offset 0..1 (multiplied by unit index for staggered loops) */
  phasePerUnit?: number;
  /** Random loop seed (for reproducibility) */
  seed?: number;
  // ── colorMix only ──
  colors?: [string, string];
}

export interface HyperframesDSL {
  /** Display name for UI */
  name?: string;
  /** Schema version */
  version?: 1;
  /** How to break the text into independently animated units */
  split: 'element' | 'line' | 'word' | 'letter';
  /** Layout / positioning (in 1920x1080 author space) */
  layout: {
    /** Distance from bottom of frame in px */
    bottom: number;
    /** Max width before wrapping (px) */
    maxWidth?: number;
    /** Line height multiplier (default 1.15) */
    lineHeight?: number;
    /** Horizontal alignment */
    align?: 'center' | 'left' | 'right';
  };
  /** Base text styling */
  style: {
    fontFamily?: string;
    fontWeight?: string | number;
    /** Font size in px in 1920x1080 author space */
    fontSize?: number;
    color?: string;
    letterSpacing?: number;
    textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  };
  /** How long each unit's animation runs (seconds) */
  duration: number;
  /** Stagger between units (seconds) */
  stagger?: number;
  /** Stagger pattern (default 'linear' = unitIndex * stagger) */
  staggerFn?: 'linear' | 'wave' | 'random' | 'fromCenter' | 'reverse';
  /** Per-unit animation tracks */
  tracks: HyperframesTrack[];
  /** Static (non-animated) effects */
  effects?: {
    shadow?: { color: string; blur: number; offsetX?: number; offsetY?: number };
    stroke?: { color: string; width: number };
    glow?: { color: string; blur: number };
    rgbSplit?: {
      redOffset: [number, number];
      blueOffset: [number, number];
      jitter?: number;
      jitterFreq?: number;
    };
  };
  /** Karaoke / active-word highlighting */
  karaoke?: {
    enabled: boolean;
    color?: string;
    scale?: number;
    glow?: { color: string; blur: number };
    background?: { color: string; padX: number; padY: number };
    /** Opacity for already-spoken words (default 1 = no dimming) */
    pastOpacity?: number;
    /** Stroke override for active word */
    stroke?: { color: string; width: number };
  };
  /** Optional graphic primitives — when present, drawn alongside (or instead of) text.
   *  Used by independent GraphicLayer overlays; can also decorate captions. */
  graphics?: GraphicNode[];
}

// ============ GRAPHIC NODES (DSL primitives for shapes/images/text) =========
// Each node has its own tracks and lifecycle within the parent's duration.

export interface GraphicNodeBase {
  id?: string;
  /** Author-space x (1920x1080). Interpretation depends on node kind. */
  x: number;
  y: number;
  /** Per-node animation tracks (same evaluator as text-unit tracks) */
  tracks?: HyperframesTrack[];
  /** Per-node animation duration in seconds (defaults to parent dsl.duration) */
  animDuration?: number;
  /** When this node enters within the parent's lifecycle (seconds, default 0) */
  appearAt?: number;
  /** When this node exits within the parent's lifecycle (seconds, default Infinity) */
  disappearAt?: number;
  /** Transform origin for scale/rotate, normalized 0..1 within bounding box (default 0.5,0.5) */
  origin?: { x: number; y: number };
  /** Static opacity multiplier (combined with track-driven opacity) */
  opacity?: number;
}

export interface GraphicRect extends GraphicNodeBase {
  kind: 'rect';
  /** Top-left at (x, y); width/height in author space */
  width: number;
  height: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
}

export interface GraphicCircle extends GraphicNodeBase {
  kind: 'circle';
  /** (x, y) is center */
  radius: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface GraphicLine extends GraphicNodeBase {
  kind: 'line';
  /** From (x, y) to (x2, y2) */
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  lineCap?: 'butt' | 'round' | 'square';
  /** 0..1 — clip-reveal progress (animatable via tracks targeting "scaleX") */
  drawProgress?: number;
}

export interface GraphicPath extends GraphicNodeBase {
  kind: 'path';
  /** SVG path "d" attribute. Coordinates relative to (x, y). */
  d: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

export interface GraphicImage extends GraphicNodeBase {
  kind: 'image';
  /** URL or data URI. SVG data URIs recommended for export safety. */
  src: string;
  width: number;
  height: number;
}

export interface GraphicText extends GraphicNodeBase {
  kind: 'text';
  text: string;
  fontFamily?: string;
  fontWeight?: string | number;
  fontSize?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  letterSpacing?: number;
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; offsetX?: number; offsetY?: number };
  glow?: { color: string; blur: number };
}

export type GraphicNode = GraphicRect | GraphicCircle | GraphicLine | GraphicPath | GraphicImage | GraphicText;

// ============ INDEPENDENT GRAPHIC LAYERS (top-level overlays) ===============

export interface GraphicLayer {
  id: string;
  name: string;
  /** Media-time start/end (seconds) */
  startTime: number;
  endTime: number;
  /** Fade-in/out durations in seconds, applied as multiplier on opacity */
  fadeInDuration?: number;
  fadeOutDuration?: number;
  /** The DSL describing the graphic. `graphics` array drives shape rendering;
   *  text-related DSL fields are ignored unless the DSL explicitly includes a text mode. */
  dsl: HyperframesDSL;
  /** Optional translate/scale/rotate transform applied to whole layer */
  translateX?: number;
  translateY?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  /** Z-order: higher draws on top. Defaults to insertion order. */
  zIndex?: number;
  /** Visibility toggle */
  visible: boolean;
}

export interface SubtitleTemplate {
  id: string;
  name: string;
  style: CSSProperties;
  animation: TextAnimation; // Updated to use the new rich type
  keywordAnimation?: TextAnimation; // optional keyword-specific animation bundled with template
  hyperframes?: HyperframesConfig; // when set, Hyperframes renders the caption overlay
}

export const REMOTION_FPS = 30;

export enum ProcessingStatus {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  DEEP_ANALYZING = 'DEEP_ANALYZING',
  EDITING = 'EDITING',
  TRANSCRIBING = 'TRANSCRIBING',
  CENTERING = 'CENTERING',
  SCANNING = 'SCANNING',
  CLEANING_FILLERS = 'CLEANING_FILLERS',
  ERROR = 'ERROR'
}

// ============ TRENDS SYSTEM ============
export interface TrendItem {
  id: string;
  title: string;
  source: 'youtube' | 'google' | 'reddit';
  category: string;
  rank: number;
  previousRank: number | null;  // null = new entry
  velocity: 'exploding' | 'rising' | 'stable' | 'falling';
  viewCount?: number;
  engagement?: number;
  growthPercent?: number;
  keywords: string[];
  thumbnailUrl?: string;
  url?: string;
  fetchedAt: number;
}

export interface TrendAnalysis {
  shortId: string;
  trendScore: number;          // 0-100
  matchedTrends: string[];
  reasoning: string;
  suggestedAngle?: string;
  analyzedAt: number;
}

export interface TrendState {
  items: TrendItem[];
  previousRanks: Record<string, number>;  // id -> previous rank for animations
  analyses: TrendAnalysis[];
  analysesTimestamp: number | null;
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
  activeFilters: TrendFilters;
}

export interface TrendFilters {
  source: 'all' | 'youtube' | 'google' | 'reddit';
  category: string;
  region: string;
  timeRange: 'today' | 'week' | 'month';
}

// ============ RENDER QUEUE ============

export type RenderJobStatus = 'queued' | 'rendering' | 'done' | 'error' | 'aborted';

export interface RenderJob {
  id: string;
  name: string;
  settings: ExportSettings;
  status: RenderJobStatus;
  progress: number;
  currentFrame: number;
  totalFrames: number;
  startedAt: number | null;
  eta: number | null;
  error: string | null;
  outputUrl: string | null;
}