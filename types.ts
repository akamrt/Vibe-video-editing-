
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

// ============ MEDIA & SEGMENTS ============
export interface MediaItem {
  id: string;
  file: File;
  url: string;
  duration: number;
  name: string;
  analysis: VideoAnalysis | null;
  isCached?: boolean;
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
  mediaId: string; // References MediaItem
  startTime: number; // Start point in SOURCE video
  endTime: number;   // End point in SOURCE video
  timelineStart: number; // Start point on the SEQUENCE timeline
  track: number; // Vertical layering (0 = V1, 1 = V2, etc.)
  description: string;
  color: string;
  transitionIn?: Transition;
  transitionOut?: Transition;
  keyframes?: ClipKeyframe[]; // Animation keyframes for pan/zoom/rotate within clip
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
  topOffset: number; // % from top (titles typically appear at top or center)
  textAlign: 'left' | 'center' | 'right';
  bold: boolean;
  italic: boolean;
}

export interface TitleLayer {
  id: string;
  text: string; // The hook title text
  startTime: number; // When the title starts appearing on timeline
  endTime: number; // When the title fully disappears
  fadeInDuration: number; // Duration of fade-in effect (seconds)
  fadeOutDuration: number; // Duration of fade-out effect (seconds)
  style?: TitleStyle; // Optional style override
  keyframes?: ClipKeyframe[]; // Animation keyframes for the title
}

export interface AnalysisEvent {
  startTime: number;
  endTime: number;
  type: 'dialogue' | 'visual' | 'action' | 'sound';
  label: string;
  details: string;
  styleOverride?: SubtitleStyle; // Optional override for specific subtitle events
}

export interface VideoAnalysis {
  summary: string;
  events: AnalysisEvent[];
  generatedAt: Date;
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
}

export enum ProcessingStatus {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  DEEP_ANALYZING = 'DEEP_ANALYZING',
  EDITING = 'EDITING',
  TRANSCRIBING = 'TRANSCRIBING',
  ERROR = 'ERROR'
}