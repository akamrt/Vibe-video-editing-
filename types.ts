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
  format: 'webm';
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

export interface SubtitleTemplate {
  id: string;
  name: string;
  style: CSSProperties;
  animation: TextAnimation; // Updated to use the new rich type
  keywordAnimation?: TextAnimation; // optional keyword-specific animation bundled with template
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