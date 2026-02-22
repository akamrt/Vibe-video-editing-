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
  fillerDetections?: CachedFillerDetection[];
}

export type TransitionType = 'FADE' | 'CROSSFADE' | 'WASH_WHITE' | 'WASH_BLACK' | 'WASH_COLOR' | 'NONE';

export interface Transition {
  type: TransitionType;
  duration: number;
  blendMode?: string; // CSS mix-blend-mode values (e.g., 'multiply', 'screen', 'overlay')
  color?: string; // Hex code for WASH_COLOR
}

export interface Segment {
  id: string;
  type?: 'video' | 'blank'; // Defaults to video if undefined for backwards compatibility
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