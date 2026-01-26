
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
}

export enum ProcessingStatus {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  DEEP_ANALYZING = 'DEEP_ANALYZING',
  EDITING = 'EDITING',
  TRANSCRIBING = 'TRANSCRIBING',
  ERROR = 'ERROR'
}