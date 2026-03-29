import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { loadHotkeyOverrides, getAllBindings, matchesBinding } from './utils/hotkeys';
import { createPortal } from 'react-dom';
import Timeline from './components/Timeline';
import ChatPanel from './components/ChatPanel';
import TranscriptPanel from './components/TranscriptPanel';
import PropertiesPanel from './components/PropertiesPanel';
import MediaBin from './components/MediaBin';
import ViewportOverlay from './components/ViewportOverlay';
import ExportModal from './components/ExportModal';
import SettingsPanel from './components/SettingsPanel';
import GraphEditor from './components/GraphEditor';
import { ProjectState, Segment, ChatMessage, ProcessingStatus, MediaItem, TransitionType, Transition, SubtitleStyle, TitleStyle, TitleLayer, AnalysisEvent, ViewportSettings, ClipKeyframe, ExportSettings, AspectRatioPreset, SubtitleTemplate, REMOTION_FPS, VibeCutTracker, TrackedFrame, TrackingMode, KeywordEmphasis, TextAnimation, RemovedWord, PivotKeyframe, ColorCorrection, ColorGrading } from './types';
import { DEFAULT_COLOR_CORRECTION, buildCSSFilter, buildSVGFilterMarkup, buildCanvasFilter, needsAdvancedCorrection, applyAdvancedCorrection, isDefaultCC } from './utils/colorCorrection';
import { DEFAULT_COLOR_GRADING, isGradingDefault, migrateColorCorrection } from './utils/colorGradingDefaults';
import { applyColorGradingToImageData } from './utils/colorGradingExport';
import ColorGradingCanvas from './components/ColorGradingCanvas';
import RemotionPreview from './components/remotion/RemotionPreview';
import TemplateManager from './components/remotion/TemplateManager';
import TransitionPanel from './components/TransitionPanel';
import { renderTransition as renderTransitionCanvas } from './utils/transitionRenderer';
import AnimatedText from './components/remotion/AnimatedText';
import { analyzeVideoContent, generateVibeEdit, chatWithVideoContext, transcribeAudio, performDeepAnalysis, detectPersonPosition, detectFillerWords, detectFillersFromTranscript, redetectFillerWords, redetectFillersFromTranscript, FillerDetection } from './services/geminiService';
import FillerConfirmModal from './components/FillerConfirmModal';
import type { FillerDetectionWithMedia } from './components/FillerConfirmModal';
import { YoutubeImportModal } from './components/YoutubeImportModal';
import ContentLibraryPage from './pages/ContentLibraryPage';
import { GeneratedShort, contentDB } from './services/contentDatabase';
import { getInterpolatedTransform, ASPECT_RATIO_PRESETS, calculateCropRegion, getInterpolatedPivot, compensatePivotChange } from './utils/interpolation';
import { resolveGradientStops, buildGradientCSS } from './utils/gradientUtils';
import { drawSubtitleOnCanvas } from './utils/canvasSubtitleRenderer';
import { analyzeAndGenerateKeyframes, TrackingSegment, captureTemplateFromVideo, trackManualTrackers, generateStabilizationKeyframes, generateFollowKeyframes, scanAndGenerateThresholdKeyframes, detectPersonInFrame } from './services/templateTrackingService';
import { fullScanAndCenter, trackHeadForPivot, headTrackForPivot } from './services/trackingBridge';
import TrackingPanel from './components/TrackingPanel';
import RenderQueuePanel from './components/RenderQueuePanel';
import { renderQueue } from './services/renderQueue';
import TrackerOverlay from './components/TrackerOverlay';
import GizmoOverlay from './components/GizmoOverlay';
import StockBrowser from './components/StockBrowser';
import ResizeHandle from './components/ResizeHandle';
import { getSessionLog, getSessionTotal, clearSession, onCostUpdate, offCostUpdate, initCostTracker, CostEntry } from './services/costTracker';
import { getAudioBuffer, getAudioBufferLowRes, findNearestSilence, snapFillerRange, snapClipBoundaries, clearAudioBufferCache, findSilenceGaps } from './utils/audioAnalysis';
import { crossfadeVolumes } from './utils/audioCrossfade';
import { autoWrapDialogueText } from './utils/autoWrapText';
import { startHealthPolling, stopHealthPolling, onStatusChange } from './services/serverHealth';
import { loadGoogleFont } from './services/googleFontsService';
import { listSavedProjects, saveProjectToFile, loadProjectFromFile, deleteProjectFile, exportAllData, importAllData, SavedProjectInfo } from './services/saveApi';

const INITIAL_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Arial',
  fontSize: 16,
  color: '#ffffff',
  backgroundColor: '#000000',
  backgroundOpacity: 0.8,
  backgroundType: 'rounded',
  boxBorderColor: '#ffffff',
  boxBorderWidth: 0,
  boxBorderRadius: 8,
  bottomOffset: 10,
  textAlign: 'center',
  bold: false,
  italic: false
};

const INITIAL_TITLE_STYLE: TitleStyle = {
  fontFamily: 'Arial',
  fontSize: 20,
  color: '#ffffff',
  backgroundColor: '#6366f1',
  backgroundOpacity: 0.9,
  backgroundType: 'rounded',
  boxBorderColor: '#818cf8',
  boxBorderWidth: 2,
  boxBorderRadius: 12,
  topOffset: 15,
  textAlign: 'center',
  bold: true,
  italic: false
};

const INITIAL_STATE: ProjectState = {
  library: [],
  segments: [],
  currentTime: 0,
  isPlaying: false,
  activeSegmentIndex: 0,
  loopMode: false,
  subtitleStyle: INITIAL_SUBTITLE_STYLE,
  titleStyle: INITIAL_TITLE_STYLE,
  titleLayer: null,
  activeSubtitleTemplate: null,
  activeTitleTemplate: null,
  activeKeywordAnimation: null,
  removedWords: [],
};

// --- Auto-center utilities (used by handleCenterPerson + autoCenterSegment) ---

async function seekAndCaptureFrame(
  videoEl: HTMLVideoElement,
  targetTime: number,
  timeoutMs = 5000
): Promise<Blob | null> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      videoEl.removeEventListener('seeked', onSeeked);
      resolve();
    };
    const onSeeked = () => {
      if (videoEl.readyState >= 2) {
        finish();
      } else {
        let attempts = 0;
        const poll = () => {
          if (resolved) return;
          if (videoEl.readyState >= 2 || attempts >= 50) finish();
          else { attempts++; setTimeout(poll, 10); }
        };
        setTimeout(poll, 10);
      }
    };
    if (Math.abs(videoEl.currentTime - targetTime) < 0.01 && videoEl.readyState >= 2) {
      finish();
      return;
    }
    videoEl.addEventListener('seeked', onSeeked);
    videoEl.currentTime = targetTime;
    setTimeout(finish, timeoutMs);
  });

  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(videoEl, 0, 0);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

function computeCenterTranslation(
  detection: { centerX: number; centerY: number },
  videoNativeW: number,
  videoNativeH: number,
  previewAspectRatio: string
): { translateX: number; translateY: number } {
  const videoAR = videoNativeW / videoNativeH;
  const arPreset = previewAspectRatio !== 'custom'
    ? ASPECT_RATIO_PRESETS[previewAspectRatio]
    : null;
  const cropAR = arPreset ? arPreset.ratio : videoAR;

  const visibleFractionX = Math.min(1, cropAR / videoAR);
  const visibleFractionY = Math.min(1, videoAR / cropAR);

  const translateX = -(detection.centerX - 50);
  const translateY = -(detection.centerY - 50);

  const maxShiftX = Math.max(5, (1 - visibleFractionX) * 50);
  const maxShiftY = Math.max(5, (1 - visibleFractionY) * 50);

  return {
    translateX: Math.max(-maxShiftX, Math.min(maxShiftX, translateX)),
    translateY: Math.max(-maxShiftY, Math.min(maxShiftY, translateY)),
  };
}

function App() {
  const [project, setProject] = useState<ProjectState>(INITIAL_STATE);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);
  const safeZoneRef = useRef<HTMLDivElement>(null);
  // Gizmo element refs — assigned to the subtitle/title container divs for bounding rect measurement
  const subtitleGizmoRef = useRef<HTMLDivElement | null>(null);
  const titleGizmoRef = useRef<HTMLDivElement | null>(null);
  const [showGizmos, setShowGizmos] = useState(true);
  const [pivotTrackingProgress, setPivotTrackingProgress] = useState<{ progress: number; label: string } | null>(null);

  // Register render queue deps provider (always supplies fresh state)
  useEffect(() => {
    renderQueue.setDepsProvider(() => ({
      segments: projectRef.current.segments,
      globalKeyframes: globalKeyframesRef.current,
      titleLayer: projectRef.current.titleLayers?.[0] || null,
      subtitleStyle: projectRef.current.subtitleStyle || {} as any,
      titleStyle: (projectRef.current as any).titleStyle || projectRef.current.subtitleStyle || {},
      activeSubtitleTemplate: (projectRef.current as any).activeSubtitleTemplate || null,
      activeTitleTemplate: (projectRef.current as any).activeTitleTemplate || null,
      activeKeywordAnimation: (projectRef.current as any).activeKeywordAnimation || null,
      removedWords: (projectRef.current as any).removedWords || [],
      library: projectRef.current.library,
      videoRefs: videoRefs.current,
      audioContext: audioContextRef.current || new AudioContext(),
      audioSourcesRef: audioSourcesRef.current,
      safeZoneHeight: safeZoneRef.current?.getBoundingClientRect().height || viewportSize.height,
      getCombinedTransform,
      setIsExporting: (v: boolean) => { isExportingRef.current = v; setIsExporting(v); },
    }));
  });

  // Register render queue deps provider (always supplies fresh state)
  useEffect(() => {
    renderQueue.setDepsProvider(() => ({
      segments: projectRef.current.segments,
      globalKeyframes: globalKeyframesRef.current,
      titleLayer: projectRef.current.titleLayers?.[0] || null,
      subtitleStyle: projectRef.current.subtitleStyle || {} as any,
      titleStyle: (projectRef.current as any).titleStyle || projectRef.current.subtitleStyle || {},
      activeSubtitleTemplate: (projectRef.current as any).activeSubtitleTemplate || null,
      activeTitleTemplate: (projectRef.current as any).activeTitleTemplate || null,
      activeKeywordAnimation: (projectRef.current as any).activeKeywordAnimation || null,
      removedWords: (projectRef.current as any).removedWords || [],
      library: projectRef.current.library,
      videoRefs: videoRefs.current,
      audioContext: audioContextRef.current || new AudioContext(),
      audioSourcesRef: audioSourcesRef.current,
      safeZoneHeight: safeZoneRef.current?.getBoundingClientRect().height || viewportSize.height,
      getCombinedTransform,
      setIsExporting: (v: boolean) => { isExportingRef.current = v; setIsExporting(v); },
    }));
  });

  // Server health polling — shows banner when backend is unreachable
  useEffect(() => {
    startHealthPolling();
    const unsub = onStatusChange(setServerStatus);
    return () => { stopHealthPolling(); unsub(); };
  }, []);

  // Cost tracker: load persisted data + subscribe to updates
  useEffect(() => {
    const sync = () => { setCostTotal(getSessionTotal()); setCostLog(getSessionLog()); };
    initCostTracker().then(sync);
    onCostUpdate(sync);
    return () => offCostUpdate(sync);
  }, []);

  // Migration helper: unwrap project state that was accidentally nested under a 'project' key
  // due to the old bug where contentDB.getProject()'s { project, globalKeyframes } wrapper
  // was spread directly into the state instead of spreading the inner 'project' value.
  const unwrapProjectState = (state: any): any => {
    let p = state;
    while (
      p?.project &&
      typeof p.project === 'object' &&
      !Array.isArray(p.project) &&
      (!p.library || p.library.length === 0) &&
      (!p.segments || p.segments.length === 0) &&
      (p.project.library?.length > 0 || p.project.segments?.length > 0 || p.project.project)
    ) {
      console.log('[Migration] Unwrapping nested project state (legacy save bug)');
      p = p.project;
    }
    return p;
  };

  // Persistence Loading (with migration for new fields)
  useEffect(() => {
    clearAudioBufferCache(); // Clear stale audio caches from any prior session
    contentDB.getProject().then(saved => {
      if (saved) {
        // getProject() returns { project: ProjectState, globalKeyframes: [...] }
        // Previously this was spread directly (bug): ...saved would add a 'project' key into state
        // and leave library/segments at INITIAL_STATE defaults (empty).
        const { project: rawProject, globalKeyframes: savedGlobalKeyframes } = saved;
        const savedProject = unwrapProjectState(rawProject);

        setProject({
          ...INITIAL_STATE,
          ...savedProject,
          activeSubtitleTemplate: savedProject.activeSubtitleTemplate ?? null,
          activeTitleTemplate: savedProject.activeTitleTemplate ?? null,
          activeKeywordAnimation: savedProject.activeKeywordAnimation ?? null,
        });
        // Restore global keyframes if any were saved
        if (savedGlobalKeyframes?.length) {
          setGlobalKeyframes(savedGlobalKeyframes);
        }
        // Pre-load any Google Fonts used in the saved project
        if (savedProject.subtitleStyle?.fontFamily) loadGoogleFont(savedProject.subtitleStyle.fontFamily);
        if (savedProject.titleLayers) {
          for (const tl of savedProject.titleLayers) {
            if (tl.style?.fontFamily) loadGoogleFont(tl.style.fontFamily);
          }
        }
        console.log('Project loaded from storage');
      }
    });
  }, []);

  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'model', text: 'Welcome to VibeCut Pro. Upload clips to the Media Bin to begin editing.', timestamp: new Date() }
  ]);
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [transcriptionJobs, setTranscriptionJobs] = useState<Map<string, { status: string; progress?: string; mediaId: string }>>(new Map());
  const [isExporting, setIsExporting] = useState(false);
  const isExportingRef = useRef(false); // Ref version readable inside playback engine closure
  const [centeringProgress, setCenteringProgress] = useState('');
  const [outOfZoneThreshold, setOutOfZoneThreshold] = useState(0); // % distance from center before centering (0=always follow)
  const [scanSmooth, setScanSmooth] = useState(false);             // Apply Gaussian smoothing after scan
  const [scanSmoothAmount, setScanSmoothAmount] = useState(50);    // Smoothing strength 0-100
  const [scanProgress, setScanProgress] = useState('');
  const [scanMethod, setScanMethod] = useState<'python' | 'browser' | ''>(''); // Which tracking engine is active
  const [showScanPanel, setShowScanPanel] = useState(false);
  const scanButtonRef = useRef<HTMLButtonElement>(null);
  const [fillerProgress, setFillerProgress] = useState('');
  const [showCostPanel, setShowCostPanel] = useState(false);
  const [costTotal, setCostTotal] = useState(0);
  const [costLog, setCostLog] = useState<CostEntry[]>([]);
  const [trackingProgress, setTrackingProgress] = useState<{ progress: number; label: string } | null>(null);
  const [trackingMode, setTrackingMode] = useState<TrackingMode>('idle');
  const [selectedTrackerId, setSelectedTrackerId] = useState<string | null>(null);
  const trackingTemplatesRef = useRef<Map<string, ImageData>>(new Map());
  const trackingAbortRef = useRef<AbortController | null>(null);
  const autoCenteringRef = useRef(false);
  const [autoCenterOnImport, setAutoCenterOnImport] = useState(false);
  const [trackingZoom, setTrackingZoom] = useState(1);
  const [trackingPan, setTrackingPan] = useState({ x: 0, y: 0 });
  const [editPrompt, setEditPrompt] = useState('');

  // Selected track for targeted clip insertion (null = auto-place on new track)
  const [selectedInsertTrack, setSelectedInsertTrack] = useState<number | null>(null);

  // Left Panel State (Media Bin vs Properties)
  const [activeLeftTab, setActiveLeftTab] = useState<'media' | 'stock' | 'properties'>('media');

  // Right Panel State
  const [activeRightTab, setActiveRightTab] = useState<'transcript' | 'templates' | 'tracking' | 'transitions' | 'render'>('transitions');

  // Resizable Panel Sizes (persisted to localStorage)
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    parseInt(localStorage.getItem('vibecut-leftPanelWidth') || '256'));
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    parseInt(localStorage.getItem('vibecut-rightPanelWidth') || '320'));
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() =>
    parseInt(localStorage.getItem('vibecut-bottomPanelHeight') || '500'));

  // Persist resizable panel sizes to localStorage (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem('vibecut-leftPanelWidth', String(leftPanelWidth));
      localStorage.setItem('vibecut-rightPanelWidth', String(rightPanelWidth));
      localStorage.setItem('vibecut-bottomPanelHeight', String(bottomPanelHeight));
    }, 300);
    return () => clearTimeout(timer);
  }, [leftPanelWidth, rightPanelWidth, bottomPanelHeight]);

  const handleLeftResize = useCallback((delta: number) => {
    setLeftPanelWidth(prev => Math.max(200, Math.min(500, prev + delta)));
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightPanelWidth(prev => Math.max(200, Math.min(600, prev - delta)));
  }, []);
  const handleBottomResize = useCallback((delta: number) => {
    setBottomPanelHeight(prev => Math.max(150, Math.min(800, prev - delta)));
  }, []);

  // Reset zoom/pan when leaving tracking tab
  useEffect(() => {
    if (activeRightTab !== 'tracking') {
      setTrackingZoom(1);
      setTrackingPan({ x: 0, y: 0 });
    }
  }, [activeRightTab]);

  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);

  // Selection State
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [selectedTransition, setSelectedTransition] = useState<{ segId: string; side: 'in' | 'out' } | null>(null);

  // Dialogue Selection { mediaId, eventIndex }
  const [selectedDialogues, setSelectedDialogues] = useState<Array<{ mediaId: string; index: number }>>([]);
  const selectedDialogue = selectedDialogues[0] || null;

  // Title Selection
  const [isTitleSelected, setIsTitleSelected] = useState(false);

  const [isCaching, setIsCaching] = useState(false);
  const [rippleMode, setRippleMode] = useState(true);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [isSaving, setIsSaving] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [savedProjects, setSavedProjects] = useState<Array<{ id: string; name: string; savedAt: number; segmentCount: number; duration: number }>>([]);
  const [projectName, setProjectName] = useState('');
  const [showLoadMenu, setShowLoadMenu] = useState(false);
  const [fileProjects, setFileProjects] = useState<SavedProjectInfo[]>([]);
  const loadMenuBtnRef = useRef<HTMLButtonElement>(null);
  const projectMenuBtnRef = useRef<HTMLButtonElement>(null);
  const [loadMenuRect, setLoadMenuRect] = useState<DOMRect | null>(null);
  const [projectMenuRect, setProjectMenuRect] = useState<DOMRect | null>(null);
  const [showYoutubeModal, setShowYoutubeModal] = useState(false);
  const [showFillerModal, setShowFillerModal] = useState(false);
  const [fillerDetections, setFillerDetections] = useState<FillerDetectionWithMedia[]>([]);
  const [activePage, setActivePage] = useState<'editor' | 'library'>('editor');
  const [serverStatus, setServerStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connecting');

  // Viewport & Export Settings
  const [viewportSettings, setViewportSettings] = useState<ViewportSettings>({
    previewAspectRatio: '9:16',
    showOverlay: true,
    overlayOpacity: 0.6
  });
  const [showExportModal, setShowExportModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGraphEditor, setShowGraphEditor] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<'timeline' | 'graph'>('timeline');
  const [viewportMode, setViewportMode] = useState<'standard' | 'remotion'>('standard');

  // Undo/Redo history (generic union type)
  type UndoAction =
    | { type: 'keyframes'; segmentId: string; keyframes: ClipKeyframe[] }
    | { type: 'dialogueEvent'; mediaId: string; index: number; event: AnalysisEvent }
    | { type: 'dialogueEvents'; mediaId: string; events: AnalysisEvent[] }
    | { type: 'subtitleTemplate'; template: SubtitleTemplate | null }
    | { type: 'subtitleStyle'; style: SubtitleStyle }
    | { type: 'keywordAnimation'; animation: TextAnimation | null }
    | { type: 'segments'; segments: Segment[] }
    | { type: 'fillerClean'; segments: Segment[]; library: MediaItem[] }
    | { type: 'transcriptEdit'; segments: Segment[]; removedWords: RemovedWord[]; library?: MediaItem[] }
    | { type: 'transcriptRestore'; segments: Segment[]; removedWords: RemovedWord[]; library?: MediaItem[] }
    | { type: 'titleLayer'; titleLayer: TitleLayer }
    | { type: 'colorCorrection'; segmentId: string; colorCorrection: ColorCorrection | undefined }
    | { type: 'colorGrading'; segmentId: string; colorGrading: ColorGrading | undefined };

  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);
  const [redoStack, setRedoStack] = useState<UndoAction[]>([]);

  // Global/Root transform keyframes (affects all clips)
  const [globalKeyframes, setGlobalKeyframes] = useState<ClipKeyframe[]>([]);
  const globalKeyframesRef = useRef<ClipKeyframe[]>(globalKeyframes);
  useEffect(() => { globalKeyframesRef.current = globalKeyframes; }, [globalKeyframes]);

  // Transform target: 'global' for root transform, or segment ID for individual clip
  const [transformTarget, setTransformTarget] = useState<'global' | string>('global');

  // Viewport dragging state
  const [isViewportDragging, setIsViewportDragging] = useState(false);
  const [viewportDragStart, setViewportDragStart] = useState({ x: 0, y: 0 });
  const [viewportDragStartTransform, setViewportDragStartTransform] = useState({ translateX: 0, translateY: 0 });

  // Subtitle viewport drag state
  const [subtitleDragState, setSubtitleDragState] = useState<{
    mediaId: string; index: number;
    startX: number; startY: number;
    origTx: number; origTy: number;
  } | null>(null);

  // Title viewport drag state
  const [titleDragState, setTitleDragState] = useState<{
    startX: number; startY: number;
    origTx: number; origTy: number;
  } | null>(null);

  // Debounced undo capture for continuous style changes (sliders)
  const styleUndoCaptured = useRef<boolean>(false);
  const styleUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced undo capture for color correction slider changes
  const ccUndoCaptured = useRef<boolean>(false);
  const ccUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced undo capture for color grading changes
  const cgUndoCaptured = useRef<boolean>(false);
  const cgUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Matte preview mode for HSL Qualifier
  const [mattePreviewing, setMattePreviewing] = useState(false);

  // We now manage a map of video refs for multi-track playback
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const overlayRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const transitionCanvasRef = useRef<HTMLCanvasElement>(null);

  // Audio Context for Export
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>>(new WeakMap());

  const viewportContainerRef = useRef<HTMLDivElement>(null);
  const viewportOuterRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  // Effective crop region dimensions (accounts for aspect ratio letterboxing)
  const cropDims = useMemo(() => {
    if (viewportSize.width === 0 || viewportSize.height === 0) return viewportSize;
    const arPreset = viewportSettings.previewAspectRatio !== 'custom'
      ? ASPECT_RATIO_PRESETS[viewportSettings.previewAspectRatio]
      : null;
    if (!arPreset) return viewportSize;
    const cr = viewportSize.width / viewportSize.height;
    if (cr > arPreset.ratio) {
      return { width: viewportSize.height * arPreset.ratio, height: viewportSize.height };
    } else {
      return { width: viewportSize.width, height: viewportSize.width / arPreset.ratio };
    }
  }, [viewportSize, viewportSettings.previewAspectRatio]);

  // Computed Sequence Info
  const contentDuration = useMemo(() => {
    if (project.segments.length === 0) return 0;
    const maxTime = Math.max(...project.segments.map(s => {
      const end = s.timelineStart + (s.endTime - s.startTime);
      return isNaN(end) ? 0 : end;
    }));
    return isFinite(maxTime) ? maxTime : 0;
  }, [project.segments]);

  const safeSetTimelineZoom = (z: number) => {
    if (!isNaN(z) && isFinite(z) && z > 0) {
      setTimelineZoom(z);
    } else {
      console.warn('Attempted to set invalid zoom:', z);
    }
  };

  const timelineViewDuration = useMemo(() => {
    return Math.max(contentDuration + 5, 30); // Min 30s view, always some padding
  }, [contentDuration]);

  // Map of mediaId → File for waveform rendering in Timeline
  const mediaFilesMap = useMemo(() => new Map(project.library.map(m => [m.id, m.file])), [project.library]);

  // Identify active segments at the current time (Logical)
  const activeSegments = useMemo(() => {
    return project.segments.filter(s =>
      project.currentTime >= s.timelineStart &&
      project.currentTime < (s.timelineStart + (s.endTime - s.startTime))
    ).sort((a, b) => a.track - b.track);
  }, [project.segments, project.currentTime]);

  // Identify segments to render (Active + Preload) to avoid black frames on cut
  // During export, use a larger lookahead window but NOT all segments — rendering all
  // simultaneously causes OOM crashes with many silence-cut segments from large files.
  const renderedSegments = useMemo(() => {
    const LOOKAHEAD = isExporting ? 6.0 : 2.0; // Larger lookahead during export for smooth audio
    return project.segments.filter(s => {
      const duration = s.endTime - s.startTime;
      const timelineEnd = s.timelineStart + duration;
      const isActive = project.currentTime >= s.timelineStart && project.currentTime < timelineEnd;
      const isUpcoming = s.timelineStart > project.currentTime && s.timelineStart < (project.currentTime + LOOKAHEAD);
      // During export, also keep recently-finished segments briefly so audio tail doesn't cut off
      const isRecentlyFinished = isExporting && timelineEnd > (project.currentTime - 0.5) && timelineEnd <= project.currentTime;
      return isActive || isUpcoming || isRecentlyFinished;
    }).sort((a, b) => a.track - b.track);
  }, [project.segments, project.currentTime, isExporting]);

  // Compute z-indices for overlapping segments — outgoing (left) clip must be on top
  // This ensures z-index survives React re-renders (vs dynamic DOM manipulation)
  const segmentZIndices = useMemo(() => {
    // Higher track number = higher z-index, matching timeline layer order.
    const trackZ = (track: number) => (track || 0) * 10;
    const zMap = new Map<string, number>();
    renderedSegments.forEach(seg => {
      zMap.set(seg.id, trackZ(seg.track || 0));
    });

    // For each segment that overlaps the next clip, boost its z-index (outgoing on top)
    renderedSegments.forEach(seg => {
      if (seg.type === 'audio' || seg.type === 'blank') return;
      const segEnd = seg.timelineStart + (seg.endTime - seg.startTime);

      // Find overlapping neighbor (incoming clip that starts before this clip ends)
      const neighbor = renderedSegments.find(s =>
        s.id !== seg.id && s.type !== 'audio' && s.type !== 'blank' &&
        (s.track || 0) === (seg.track || 0) &&
        s.timelineStart > seg.timelineStart && s.timelineStart < segEnd
      );

      if (neighbor && project.currentTime >= neighbor.timelineStart) {
        // During the overlap region: outgoing (left/earlier) clip on top
        const baseZ = trackZ(seg.track || 0);
        zMap.set(seg.id, baseZ + 2);
        zMap.set(neighbor.id, baseZ + 1);
      }
    });

    return zMap;
  }, [renderedSegments, project.currentTime]);

  // Find the top-most visual media for "Main" analysis/transcript context
  const currentTopMedia = useMemo(() => {
    if (selectedSegmentIds.length === 1) {
      const seg = project.segments.find(s => s.id === selectedSegmentIds[0]);
      // Skip audio-only segments — they have no analysis, so they should not
      // override the visual context used for subtitle/dialogue display.
      if (seg && seg.type !== 'audio') return project.library.find(m => m.id === seg.mediaId);
    }

    if (activeSegments.length > 0) {
      // Use top-most VISUAL segment (ignore audio-only) for subtitle/analysis context
      const visualSegments = activeSegments.filter(s => s.type !== 'audio');
      const topSeg = visualSegments.length > 0
        ? visualSegments[visualSegments.length - 1]
        : activeSegments[activeSegments.length - 1];
      return project.library.find(m => m.id === topSeg.mediaId);
    }
    return project.library.find(m => m.id === selectedMediaId);
  }, [activeSegments, project.library, selectedMediaId, selectedSegmentIds, project.segments]);

  // Debugging: Log what the UI thinks is the "Active" media
  console.log('[App Render] Library Size:', project.library.length);
  console.log('[App Render] Selected ID:', selectedMediaId);
  console.log('[App Render] Current Top Media:', currentTopMedia ? currentTopMedia.name : 'None');
  if (currentTopMedia?.analysis) {
    console.log('[App Render] Analysis Events:', currentTopMedia.analysis.events.length);
  }

  // Identify currently selected segment object for properties panel
  const primarySelectedSegment = useMemo(() => {
    if (selectedTransition) {
      return project.segments.find(s => s.id === selectedTransition.segId) || null;
    }
    if (selectedSegmentIds.length === 1) {
      return project.segments.find(s => s.id === selectedSegmentIds[0]) || null;
    }
    return null;
  }, [selectedSegmentIds, selectedTransition, project.segments]);

  // Get analysis for the selected segment's media
  const selectedMediaAnalysis = useMemo(() => {
    if (!primarySelectedSegment) return null;
    const media = project.library.find(m => m.id === primarySelectedSegment.mediaId);
    return media?.analysis || null;
  }, [primarySelectedSegment, project.library]);

  // Subtitles (always from track 0 / dialogue track, not the topmost visual)
  // When B-roll (track 1+) overlaps dialogue (track 0), we must still show the
  // dialogue captions — they come from the track 0 media, not the B-roll media.
  const activeDialogueSeg = useMemo(() => {
    const visualSegments = activeSegments.filter(s => s.type !== 'audio');
    return visualSegments.find(s => (s.track || 0) === 0) ?? visualSegments[0] ?? null;
  }, [activeSegments]);

  const activeSubtitleEvent = useMemo(() => {
    if (!activeDialogueSeg) return null;

    const media = project.library.find(m => m.id === activeDialogueSeg.mediaId);
    if (!media?.analysis) return null;

    const sourceTime = activeDialogueSeg.startTime + (project.currentTime - activeDialogueSeg.timelineStart);
    const match = media.analysis.events.find((e: any) =>
      e.type === 'dialogue' && sourceTime >= e.startTime && sourceTime <= e.endTime
    );
    if (match) console.log('[App] Overlay match:', match.details, 'Time:', sourceTime.toFixed(2));
    return match;
  }, [activeDialogueSeg, project.currentTime, project.library]);

  // Get the specific selected dialogue event object for Properties
  const selectedDialogueEvent = useMemo(() => {
    if (!selectedDialogue) return null;
    const media = project.library.find(m => m.id === selectedDialogue.mediaId);
    if (!media) console.warn('[App] Media not found for dialog:', selectedDialogue.mediaId);
    const event = media?.analysis?.events[selectedDialogue.index] || null;
    console.log('[App] Resolved Selected Dialog Event:', event);
    return event;
  }, [selectedDialogue, project.library]);

  // Effective Subtitle Style for the Properties Panel and selected item
  const effectiveSubtitleStyle = useMemo(() => {
    return selectedDialogueEvent?.styleOverride || project.subtitleStyle;
  }, [selectedDialogueEvent, project.subtitleStyle]);

  const isSubtitleUnlinked = !!selectedDialogueEvent?.styleOverride;

  const isTemplateUnlinked = !!selectedDialogueEvent?.templateOverride;

  const effectiveSubtitleTemplate = useMemo(() => {
    return selectedDialogueEvent?.templateOverride || project.activeSubtitleTemplate;
  }, [selectedDialogueEvent, project.activeSubtitleTemplate]);


  // Playback Engine
  useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();

    const engineLoop = () => {
      const p = projectRef.current;
      if (!p.isPlaying) return;

      const now = performance.now();
      let dt = (now - lastTime) / 1000;
      lastTime = now;

      let nextTime = p.currentTime + dt;

      // Master Clock Logic:
      // During export use a wall-clock timer (dt-based) so the canvas render loop
      // advances at a perfectly steady rate with no video-induced jumps.
      // During normal preview, slave to the active video for drift-free playback.
      const activeSeg = isExportingRef.current ? null : p.segments.find(s =>
        p.currentTime >= s.timelineStart &&
        p.currentTime < (s.timelineStart + (s.endTime - s.startTime))
      );

      if (activeSeg) {
        const vid = videoRefs.current.get(activeSeg.id);
        // Only slave to video if it's actually playing and progressing
        if (vid && !vid.paused && !vid.seeking && vid.readyState > 2) {
          const calculatedTime = activeSeg.timelineStart + (vid.currentTime - activeSeg.startTime);
          // Sanity check: Ensure we don't jump wildly (e.g. loops/seeks might cause issues if not handled)
          if (Math.abs(calculatedTime - nextTime) < 1.0) {
            nextTime = calculatedTime;
          }
        }
      }

      const durationLimit = Math.max(...p.segments.map(s => s.timelineStart + (s.endTime - s.startTime)), 0);

      if (nextTime >= durationLimit && durationLimit > 0) {
        if (p.loopMode) {
          setProject(prev => ({ ...prev, currentTime: 0 }));
        } else {
          setProject(prev => ({ ...prev, isPlaying: false, currentTime: durationLimit }));
        }
      } else {
        setProject(prev => ({ ...prev, currentTime: nextTime }));
      }
      animationFrameId = requestAnimationFrame(engineLoop);
    };

    if (project.isPlaying) {
      lastTime = performance.now();
      animationFrameId = requestAnimationFrame(engineLoop);
    }

    return () => cancelAnimationFrame(animationFrameId);
  }, [project.isPlaying]);

  // Sync Video Elements & Handle Transitions
  useEffect(() => {
    // Track whether any segment needs canvas-based transition rendering this frame
    let canvasUsed = false;

    renderedSegments.forEach(seg => {
      const videoEl = videoRefs.current.get(seg.id);
      const overlayEl = overlayRefs.current.get(seg.id);
      const media = project.library.find(m => m.id === seg.mediaId);

      if (videoEl && media) {
        // Determine if this segment is ACTIVE or PRELOADING
        const duration = seg.endTime - seg.startTime;
        const timelineEnd = seg.timelineStart + duration;
        const isActive = project.currentTime >= seg.timelineStart && project.currentTime < timelineEnd;

        if (videoEl.src !== media.url) {
          videoEl.src = media.url;
          videoEl.load();
        }

        if (!isActive) {
          // --- PRELOADING STATE ---
          if (Math.abs(videoEl.currentTime - seg.startTime) > 0.1) {
            videoEl.currentTime = seg.startTime;
          }
          if (!videoEl.paused) videoEl.pause();
          if (seg.type !== 'audio') videoEl.style.opacity = '0';
          videoEl.volume = 0;
          return;
        }

        // --- ACTIVE STATE ---
        const sourceTime = seg.startTime + (project.currentTime - seg.timelineStart);

        if (project.isPlaying) {
          if (videoEl.paused) videoEl.play().catch(() => { });
          // Tighter tolerance during export to minimise visible drift at cut boundaries
          const resyncThreshold = isExporting ? 0.1 : 0.5;
          if (Math.abs(videoEl.currentTime - sourceTime) > resyncThreshold) {
            videoEl.currentTime = sourceTime;
          }
        } else {
          if (!videoEl.paused) videoEl.pause();
          if (trackingMode !== 'tracking' && !autoCenteringRef.current) {
            videoEl.currentTime = sourceTime;
          }
        }

        // --- AUDIO-ONLY SEGMENT: overlap-aware crossfade + solo fades ---
        if (seg.type === 'audio') {
          const relTime = project.currentTime - seg.timelineStart;
          const segEnd = seg.timelineStart + duration;
          const clipTransform = getInterpolatedTransform(seg.keyframes, relTime);
          let audioVolume = clipTransform.volume;

          // --- Overlap-aware crossfade (same-track only) ---
          // Find overlapping audio neighbor AFTER this clip on the same track (this is outgoing)
          const audioOverlapNext = project.segments.find(s =>
            s.id !== seg.id && s.type === 'audio' &&
            (s.track || 0) === (seg.track || 0) &&
            s.timelineStart > seg.timelineStart && s.timelineStart < segEnd
          ) || null;

          // Check if a PREVIOUS audio clip on the same track overlaps us (this is incoming)
          const audioOverlapPrev = project.segments.find(s =>
            s.id !== seg.id && s.type === 'audio' &&
            (s.track || 0) === (seg.track || 0) &&
            s.timelineStart < seg.timelineStart &&
            (s.timelineStart + (s.endTime - s.startTime)) > seg.timelineStart
          ) || null;

          let outgoingCrossfade = false;
          let incomingCrossfade = false;

          if (audioOverlapNext) {
            // THIS CLIP IS THE OUTGOING (LEFT) — volume fades 1→0 over overlap
            const overlapStart = audioOverlapNext.timelineStart;
            const overlapDuration = segEnd - overlapStart;
            if (overlapDuration > 0 && project.currentTime >= overlapStart) {
              const progress = (project.currentTime - overlapStart) / overlapDuration;
              const curve = seg.transitionOut?.audioCurve || 'linear';
              const { outgoing } = crossfadeVolumes(progress, curve);
              audioVolume *= outgoing;
              outgoingCrossfade = true;
            }
          }

          if (audioOverlapPrev) {
            // THIS CLIP IS THE INCOMING (RIGHT) — volume fades 0→1 over overlap
            const predEnd = audioOverlapPrev.timelineStart + (audioOverlapPrev.endTime - audioOverlapPrev.startTime);
            const overlapStart = seg.timelineStart;
            const overlapDuration = predEnd - overlapStart;
            if (overlapDuration > 0 && project.currentTime < predEnd) {
              const progress = (project.currentTime - overlapStart) / overlapDuration;
              const curve = audioOverlapPrev.transitionOut?.audioCurve || 'linear';
              const { incoming } = crossfadeVolumes(progress, curve);
              audioVolume *= incoming;
              incomingCrossfade = true;
            }
          }

          // Solo fades (transitionIn/Out) at non-overlapping edges
          if (!incomingCrossfade && seg.transitionIn && relTime < seg.transitionIn.duration) {
            const progress = Math.max(0, Math.min(1, relTime / seg.transitionIn.duration));
            audioVolume *= progress;
          }
          if (!outgoingCrossfade && seg.transitionOut && relTime > (duration - seg.transitionOut.duration)) {
            const remaining = duration - relTime;
            const progress = Math.max(0, Math.min(1, remaining / seg.transitionOut.duration));
            audioVolume *= progress;
          }

          // Micro-fades at edges (always apply for click prevention)
          const AUDIO_FADE_SEC = 0.03;
          if (relTime < AUDIO_FADE_SEC) audioVolume *= relTime / AUDIO_FADE_SEC;
          if (relTime > duration - AUDIO_FADE_SEC) audioVolume *= Math.max(0, (duration - relTime) / AUDIO_FADE_SEC);

          videoEl.volume = Math.max(0, Math.min(1, audioVolume));
          return; // Skip all visual transition logic
        }

        // --- VIDEO SEGMENT with unlinked audio: mute the video element ---
        if (seg.audioLinked === false && seg.type !== 'audio') {
          // Audio is on the separate audio segment, mute this video
          // (the audio segment handles its own volume above)
        }

        // --- Transition Logic ---
        let opacity = 1;
        let overlayOpacity = 0;
        let overlayColor = 'white';
        let videoBlendMode = 'normal';
        let overlayBlendMode = 'normal';
        let segUsedCanvas = false;

        const relTime = project.currentTime - seg.timelineStart;
        const segEnd = seg.timelineStart + duration;

        // Determine active transition — overlap-aware
        // KEY PRINCIPLE: Only the OUTGOING (left) clip drives cross-transitions.
        // It renders ON TOP and the transition reveals the incoming clip below.
        // The incoming clip just renders at full opacity underneath — no transition processing.
        // When clips overlap with NO explicit transition, a default crossfade is applied.
        let activeTransition: Transition | null = null;
        let activeProgress = 0;
        let isIntro = true;
        let overlapNeighborEl: HTMLVideoElement | null = null;
        let isCrossTransitionDriver = false;

        // Find ANY overlapping neighbor AFTER this clip on same track (this clip would be outgoing)
        const overlapNeighborOut = project.segments.find(s =>
          s.id !== seg.id && s.type !== 'audio' && s.type !== 'blank' &&
          s.track === seg.track &&
          s.timelineStart > seg.timelineStart && s.timelineStart < segEnd
        ) || null;

        // Check if this clip is the INCOMING clip in an overlap (a previous clip overlaps us)
        const overlappingPredecessor = project.segments.find(s =>
          s.id !== seg.id && s.type !== 'audio' && s.type !== 'blank' &&
          s.track === seg.track &&
          s.timelineStart < seg.timelineStart &&
          (s.timelineStart + (s.endTime - s.startTime)) > seg.timelineStart
        );
        // The incoming clip is passive if the predecessor is driving the cross-transition
        const isIncomingInCrossTransition = !!overlappingPredecessor;

        if (overlapNeighborOut) {
          // THIS CLIP IS THE OUTGOING (LEFT) CLIP — it drives the cross-transition
          const overlapStart = overlapNeighborOut.timelineStart;
          const overlapEnd = segEnd;
          const overlapDuration = overlapEnd - overlapStart;
          if (overlapDuration > 0 && project.currentTime >= overlapStart) {
            const overlapProgress = (project.currentTime - overlapStart) / overlapDuration;
            // Use explicit transition if set, otherwise default to a crossfade
            activeTransition = seg.transitionOut || { type: 'CROSSFADE' as any, duration: overlapDuration };
            // Progress 0→1 where 0 = outgoing fully visible, 1 = incoming fully revealed
            activeProgress = Math.max(0, Math.min(1, overlapProgress));
            isIntro = false;
            isCrossTransitionDriver = true;
            overlapNeighborEl = videoRefs.current.get(overlapNeighborOut.id) || null;
          }
        } else if (isIncomingInCrossTransition) {
          // THIS CLIP IS THE INCOMING (RIGHT) CLIP — skip transition, just render at full opacity
          // The outgoing clip handles the cross-transition.
          // Z-index is handled by segmentZIndices in the JSX render.
          // No active transition — render at full opacity
        } else if (seg.transitionIn && relTime < seg.transitionIn.duration) {
          // SOLO TRANSITION IN (no overlap — fade from black)
          activeTransition = seg.transitionIn;
          activeProgress = Math.max(0, Math.min(1, relTime / seg.transitionIn.duration));
          isIntro = true;
        } else if (seg.transitionOut && relTime > (duration - seg.transitionOut.duration)) {
          // SOLO TRANSITION OUT (no overlap — fade to black)
          const remaining = duration - relTime;
          activeTransition = seg.transitionOut;
          activeProgress = Math.max(0, Math.min(1, remaining / seg.transitionOut.duration));
          isIntro = false;
        }

        // Z-index for cross-transitions is handled by segmentZIndices in the JSX render
        // (dynamic DOM manipulation was unreliable — React re-renders would overwrite it)

        if (activeTransition) {
          const type = activeTransition.type;
          // Simple DOM-based transitions: fades, dips, dissolves
          const isSimpleDom = type === 'FADE' || type === 'CROSSFADE' || type === 'NONE'
            || type === 'DIP_TO_BLACK' || type === 'DIP_TO_WHITE'
            || type === 'FADE_BLACK' || type === 'FADE_WHITE'
            || type.startsWith('DISSOLVE_');

          if (isSimpleDom) {
            if (type === 'DIP_TO_BLACK' || type === 'DIP_TO_WHITE' || type === 'FADE_BLACK' || type === 'FADE_WHITE') {
              const color = activeTransition.color || (type.includes('BLACK') ? '#000000' : '#ffffff');
              overlayColor = color;
              if (isCrossTransitionDriver) {
                // Cross-transition: dip overlay appears then disappears across the overlap
                overlayOpacity = 1 - Math.abs(activeProgress * 2 - 1);
                // Outgoing clip stays visible, incoming clip shows through overlay
              } else {
                overlayOpacity = 1 - Math.abs(activeProgress * 2 - 1);
              }
              overlayBlendMode = activeTransition.blendMode || 'normal';
            } else if (type === 'FADE' || type === 'CROSSFADE') {
              if (isCrossTransitionDriver) {
                // Outgoing clip on top: fade from 1→0, revealing incoming clip below
                opacity = 1 - activeProgress;
              } else {
                // Solo transition
                opacity = activeProgress;
              }
            } else if (type.startsWith('DISSOLVE_')) {
              if (isCrossTransitionDriver) {
                opacity = 1 - activeProgress;
              } else {
                opacity = activeProgress;
              }
              videoBlendMode = activeTransition.blendMode || 'screen';
            }
          } else {
            // Complex transition — render on canvas
            const tCanvas = transitionCanvasRef.current;
            const vw = videoEl.videoWidth;
            const vh = videoEl.videoHeight;
            const cw = viewportContainerRef.current?.clientWidth || 0;
            const ch = viewportContainerRef.current?.clientHeight || 0;
            if (tCanvas && videoEl.readyState >= 2 && vw > 0 && vh > 0 && cw > 0 && ch > 0) {
              const ctx = tCanvas.getContext('2d');
              if (ctx) {
                canvasUsed = true;
                segUsedCanvas = true;

                if (tCanvas.width !== cw || tCanvas.height !== ch) {
                  tCanvas.width = cw;
                  tCanvas.height = ch;
                }

                // Helper: capture a video element frame to an offscreen canvas
                // Letterbox areas are left transparent so V1 shows through beneath B-roll
                const captureFrame = (el: HTMLVideoElement) => {
                  const fc = document.createElement('canvas');
                  fc.width = cw; fc.height = ch;
                  const fctx = fc.getContext('2d')!;
                  const evw = el.videoWidth, evh = el.videoHeight;
                  if (evw === 0 || evh === 0) return fc;
                  const ear = evw / evh, car = cw / ch;
                  let dw: number, dh: number, dx: number, dy: number;
                  if (car > ear) { dh = ch; dw = ch * ear; dx = (cw - dw) / 2; dy = 0; }
                  else { dw = cw; dh = cw / ear; dx = 0; dy = (ch - dh) / 2; }
                  fctx.drawImage(el, dx, dy, dw, dh);
                  return fc;
                };

                const thisFrame = captureFrame(videoEl);
                // Capture neighbor frame for cross-transitions
                const neighborFrame = overlapNeighborEl && overlapNeighborEl.readyState >= 2
                  ? captureFrame(overlapNeighborEl) : null;

                // For B-roll solo transitions, capture the current V1 frame to use as the
                // background instead of black, so wipe/shape effects show correctly over V1
                const isBRollSegment = seg.track > 0 && seg.audioLinked === false && seg.type !== 'audio';
                let v1BackgroundFrame: HTMLCanvasElement | null = null;
                if (isBRollSegment && !isCrossTransitionDriver) {
                  const v1Seg = project.segments.find(s =>
                    s.track === 0 &&
                    project.currentTime >= s.timelineStart &&
                    project.currentTime < s.timelineStart + (s.endTime - s.startTime)
                  );
                  if (v1Seg) {
                    const v1El = videoRefs.current.get(v1Seg.id);
                    if (v1El && v1El.readyState >= 2) {
                      v1BackgroundFrame = captureFrame(v1El);
                    }
                  }
                }

                tCanvas.style.display = 'block';
                tCanvas.style.zIndex = '50';

                if (isCrossTransitionDriver) {
                  // CROSS-TRANSITION: this clip is outgoing (on top)
                  // outFrame = this clip (going away), inFrame = neighbor (being revealed)
                  // progress 0→1: outgoing disappears, incoming appears
                  renderTransitionCanvas({
                    ctx,
                    width: cw,
                    height: ch,
                    outFrame: thisFrame,
                    inFrame: neighborFrame,
                    progress: activeProgress,
                    transition: activeTransition,
                  });
                } else {
                  // SOLO TRANSITION: for B-roll use V1 as background so effects show
                  // correctly; for V1 segments use null (fade from/to black)
                  renderTransitionCanvas({
                    ctx,
                    width: cw,
                    height: ch,
                    outFrame: isIntro ? v1BackgroundFrame : thisFrame,
                    inFrame: isIntro ? thisFrame : v1BackgroundFrame,
                    progress: activeProgress,
                    transition: activeTransition,
                  });
                }

                // Hide both video elements — canvas shows the composited result
                videoEl.style.opacity = '0';
                if (overlapNeighborEl) overlapNeighborEl.style.opacity = '0';
              }
            }
          }
        }

        // Apply DOM-based video styles (only when canvas isn't handling this segment's transition)
        if (!segUsedCanvas) {
          videoEl.style.opacity = opacity.toString();
          videoEl.style.mixBlendMode = videoBlendMode;
        }

        if (overlayEl) {
          overlayEl.style.opacity = overlayOpacity.toString();
          overlayEl.style.backgroundColor = overlayColor;
          overlayEl.style.mixBlendMode = overlayBlendMode;
        }

        // --- Audio: keyframed volume + transition crossfade + micro-fade ---
        const clipTime = project.currentTime - seg.timelineStart;
        const clipTransform = getInterpolatedTransform(seg.keyframes, clipTime);
        let audioVolume = clipTransform.volume; // from keyframes, defaults to 1.0

        // Audio crossfade during visual transitions (intro: 0→1, outro: 1→0)
        if (activeTransition && activeTransition.type !== 'NONE') {
          audioVolume *= activeProgress;
        }

        // 30ms fade-in/out at segment edges to prevent clicks at cuts
        const AUDIO_FADE_SEC = 0.03;
        if (relTime < AUDIO_FADE_SEC) {
          audioVolume *= relTime / AUDIO_FADE_SEC;
        }
        if (relTime > duration - AUDIO_FADE_SEC) {
          audioVolume *= Math.max(0, (duration - relTime) / AUDIO_FADE_SEC);
        }
        // If audio is unlinked, mute the video element (audio plays from separate audio segment)
        if (seg.audioLinked === false) {
          videoEl.volume = 0;
        } else {
          videoEl.volume = Math.max(0, Math.min(1, audioVolume));
        }
      }
    });

    // Hide transition canvas if no segment needed it this frame
    const tCanvas = transitionCanvasRef.current;
    if (tCanvas && !canvasUsed) {
      tCanvas.style.display = 'none';
    }
  }, [project.currentTime, renderedSegments, project.isPlaying, project.library]);

  // Clean up refs
  useEffect(() => {
    const currentIds = new Set(renderedSegments.map(s => s.id));
    for (const [id] of videoRefs.current) {
      if (!currentIds.has(id)) videoRefs.current.delete(id);
    }
    for (const [id] of overlayRefs.current) {
      if (!currentIds.has(id)) overlayRefs.current.delete(id);
    }
  }, [renderedSegments]);

  // Keyboard Listeners — driven by the user-configurable hotkeys system (utils/hotkeys.ts)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Load bindings fresh each event so Settings changes take effect immediately
      const bindings = getAllBindings(loadHotkeyOverrides());

      // Undo/Redo (fixed — not rebindable)
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          handleUndo();
          return;
        }
        if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
          e.preventDefault();
          handleRedo();
          return;
        }
      }

      // Play / Pause
      if (matchesBinding(e, bindings['play-pause'])) {
        e.preventDefault();
        setProject(p => ({ ...p, isPlaying: !p.isPlaying }));
        return;
      }

      // Rewind 5s
      if (matchesBinding(e, bindings['rewind'])) {
        e.preventDefault();
        setProject(p => ({ ...p, isPlaying: false, currentTime: Math.max(0, p.currentTime - 5) }));
        return;
      }

      // Skip Forward 5s
      if (matchesBinding(e, bindings['forward'])) {
        e.preventDefault();
        setProject(p => ({ ...p, isPlaying: false, currentTime: p.currentTime + 5 }));
        return;
      }

      // Don't intercept Delete when graph editor has focus — it handles its own keyframe deletion
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const inGraphEditor = document.activeElement?.closest('[data-graph-editor]');
        if (inGraphEditor) return;
      }

      // Delete selected clip / subtitle
      if (matchesBinding(e, bindings['delete-selected']) || e.key === 'Backspace') {
        if (selectedSegmentIds.length > 0) {
          performDelete(selectedSegmentIds, false);
        } else if (selectedDialogue) {
          handleDeleteDialogue(selectedDialogue.mediaId, selectedDialogue.index);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSegmentIds, undoStack, redoStack]);

  // Viewport size — measure outer wrapper once on mount, then lock so panel resizing doesn't change resolution
  const viewportSizeLockedRef = useRef(false);
  useEffect(() => {
    const outer = viewportOuterRef.current;
    if (!outer) {
      setViewportSize({ width: 0, height: 0 });
      viewportSizeLockedRef.current = false;
      return;
    }

    if (!viewportSizeLockedRef.current) {
      setViewportSize({ width: outer.clientWidth, height: outer.clientHeight });
      viewportSizeLockedRef.current = true;
    }
  }, [activePage]); // Re-run when page changes

  // Push an undo action onto the stack
  const pushUndo = (action: UndoAction) => {
    setUndoStack(prev => [...prev.slice(-49), action]);
    setRedoStack([]);
  };

  // Handler for updating segment keyframes (with undo support)
  const handleUpdateKeyframes = (segmentId: string, keyframes: ClipKeyframe[], skipUndo = false) => {
    if (segmentId === 'global') {
      if (!skipUndo) {
        pushUndo({ type: 'keyframes', segmentId: 'global', keyframes: globalKeyframes });
      }
      setGlobalKeyframes(keyframes);
      return;
    }

    if (!skipUndo) {
      const currentSegment = project.segments.find(s => s.id === segmentId);
      if (currentSegment) {
        pushUndo({ type: 'keyframes', segmentId, keyframes: currentSegment.keyframes || [] });
      }
    }

    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, keyframes } : s
      )
    }));
  };

  // Handler for updating segment color correction (with debounced undo)
  const handleColorCorrectionChange = (segmentId: string, field: keyof ColorCorrection, value: number) => {
    // Capture undo snapshot on first change in a drag
    if (!ccUndoCaptured.current) {
      const seg = project.segments.find(s => s.id === segmentId);
      if (seg) {
        pushUndo({ type: 'colorCorrection', segmentId, colorCorrection: seg.colorCorrection ? { ...seg.colorCorrection } : undefined });
        ccUndoCaptured.current = true;
      }
    }
    if (ccUndoTimer.current) clearTimeout(ccUndoTimer.current);
    ccUndoTimer.current = setTimeout(() => { ccUndoCaptured.current = false; }, 500);

    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s => {
        if (s.id !== segmentId) return s;
        const cc = s.colorCorrection ?? { ...DEFAULT_COLOR_CORRECTION };
        return { ...s, colorCorrection: { ...cc, [field]: value } };
      })
    }));
  };

  const handleResetColorCorrection = (segmentId: string) => {
    const seg = project.segments.find(s => s.id === segmentId);
    if (seg) {
      pushUndo({ type: 'colorCorrection', segmentId, colorCorrection: seg.colorCorrection ? { ...seg.colorCorrection } : undefined });
    }
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, colorCorrection: undefined } : s
      )
    }));
  };

  // Handler for updating full color grading (Phase 2 — WebGL pipeline)
  const handleColorGradingChange = (segmentId: string, grading: ColorGrading) => {
    if (!cgUndoCaptured.current) {
      const seg = project.segments.find(s => s.id === segmentId);
      if (seg) {
        pushUndo({ type: 'colorGrading', segmentId, colorGrading: seg.colorGrading ? { ...seg.colorGrading } : undefined });
        cgUndoCaptured.current = true;
      }
    }
    if (cgUndoTimer.current) clearTimeout(cgUndoTimer.current);
    cgUndoTimer.current = setTimeout(() => { cgUndoCaptured.current = false; }, 500);

    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, colorGrading: grading } : s
      )
    }));
  };

  const handleResetColorGrading = (segmentId: string) => {
    const seg = project.segments.find(s => s.id === segmentId);
    if (seg) {
      pushUndo({ type: 'colorGrading', segmentId, colorGrading: seg.colorGrading ? { ...seg.colorGrading } : undefined });
    }
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, colorGrading: undefined } : s
      )
    }));
    setMattePreviewing(false);
  };

  // Combine global and clip transforms
  const getCombinedTransform = (clipKeyframes: ClipKeyframe[] | undefined, clipTime: number, timelineTime: number) => {
    const globalTransform = getInterpolatedTransform(globalKeyframes, timelineTime);
    const clipTransform = getInterpolatedTransform(clipKeyframes, clipTime);

    // Combine: first apply global, then clip (additive for translate, multiplicative for scale)
    // Pivot is clip-level only (not combined with global)
    return {
      translateX: globalTransform.translateX + clipTransform.translateX,
      translateY: globalTransform.translateY + clipTransform.translateY,
      scale: globalTransform.scale * clipTransform.scale,
      rotation: globalTransform.rotation + clipTransform.rotation,
      pivotX: clipTransform.pivotX,
      pivotY: clipTransform.pivotY
    };
  };

  // Apply an undo/redo action, pushing the inverse onto the other stack
  const applyUndoAction = (action: UndoAction, pushToStack: (a: UndoAction) => void) => {
    switch (action.type) {
      case 'keyframes': {
        if (action.segmentId === 'global') {
          pushToStack({ type: 'keyframes', segmentId: 'global', keyframes: globalKeyframes });
          setGlobalKeyframes(action.keyframes);
        } else if (action.segmentId === 'title_layer') {
          pushToStack({ type: 'keyframes', segmentId: 'title_layer', keyframes: project.titleLayer?.keyframes || [] });
          handleUpdateTitleLayer({ keyframes: action.keyframes });
        } else {
          const seg = project.segments.find(s => s.id === action.segmentId);
          if (seg) {
            pushToStack({ type: 'keyframes', segmentId: action.segmentId, keyframes: seg.keyframes || [] });
            handleUpdateKeyframes(action.segmentId, action.keyframes, true);
          }
        }
        break;
      }
      case 'dialogueEvent': {
        const media = project.library.find(m => m.id === action.mediaId);
        const currentEvent = media?.analysis?.events[action.index];
        if (currentEvent) {
          pushToStack({ type: 'dialogueEvent', mediaId: action.mediaId, index: action.index, event: { ...currentEvent } });
          handleUpdateDialogue(action.mediaId, action.index, action.event);
        }
        break;
      }
      case 'dialogueEvents': {
        const media = project.library.find(m => m.id === action.mediaId);
        if (media?.analysis) {
          pushToStack({ type: 'dialogueEvents', mediaId: action.mediaId, events: [...media.analysis.events] });
          setProject(prev => ({
            ...prev,
            library: prev.library.map(m =>
              m.id === action.mediaId && m.analysis
                ? { ...m, analysis: { ...m.analysis, events: action.events } }
                : m
            )
          }));
        }
        break;
      }
      case 'subtitleTemplate': {
        pushToStack({ type: 'subtitleTemplate', template: project.activeSubtitleTemplate });
        setProject(p => ({ ...p, activeSubtitleTemplate: action.template }));
        break;
      }
      case 'subtitleStyle': {
        pushToStack({ type: 'subtitleStyle', style: { ...project.subtitleStyle } });
        setProject(p => ({ ...p, subtitleStyle: action.style }));
        break;
      }
      case 'keywordAnimation': {
        pushToStack({ type: 'keywordAnimation', animation: project.activeKeywordAnimation });
        setProject(p => ({ ...p, activeKeywordAnimation: action.animation }));
        break;
      }
      case 'segments': {
        pushToStack({ type: 'segments', segments: [...project.segments] });
        setProject(prev => ({ ...prev, segments: action.segments }));
        break;
      }
      case 'fillerClean': {
        pushToStack({
          type: 'fillerClean',
          segments: [...project.segments],
          library: project.library.map(m => ({ ...m, analysis: m.analysis ? { ...m.analysis, events: [...m.analysis.events] } : null }))
        });
        setProject(prev => ({ ...prev, segments: action.segments, library: action.library }));
        break;
      }
      case 'titleLayer': {
        if (project.titleLayer) {
          pushToStack({ type: 'titleLayer', titleLayer: { ...project.titleLayer } });
          setProject(prev => ({ ...prev, titleLayer: action.titleLayer }));
        }
        break;
      }
      case 'colorCorrection': {
        const seg = project.segments.find(s => s.id === action.segmentId);
        if (seg) {
          pushToStack({ type: 'colorCorrection', segmentId: action.segmentId, colorCorrection: seg.colorCorrection });
          setProject(prev => ({
            ...prev,
            segments: prev.segments.map(s =>
              s.id === action.segmentId ? { ...s, colorCorrection: action.colorCorrection } : s
            )
          }));
        }
        break;
      }
      case 'colorGrading': {
        const seg = project.segments.find(s => s.id === action.segmentId);
        if (seg) {
          pushToStack({ type: 'colorGrading', segmentId: action.segmentId, colorGrading: seg.colorGrading });
          setProject(prev => ({
            ...prev,
            segments: prev.segments.map(s =>
              s.id === action.segmentId ? { ...s, colorGrading: action.colorGrading } : s
            )
          }));
        }
        break;
      }
      case 'transcriptEdit':
      case 'transcriptRestore': {
        pushToStack({
          type: action.type,
          segments: [...project.segments],
          removedWords: project.removedWords ? [...project.removedWords] : [],
          library: project.library.map(m => ({ ...m, analysis: m.analysis ? { ...m.analysis, events: m.analysis.events.map(e => ({ ...e })) } : null }))
        });
        setProject(prev => ({
          ...prev,
          segments: action.segments,
          removedWords: action.removedWords,
          library: action.library ? action.library : prev.library
        }));
        break;
      }
    }
  };

  // Undo handler
  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const action = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));
    applyUndoAction(action, (a) => setRedoStack(prev => [...prev, a]));
  };

  // Redo handler
  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const action = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));
    applyUndoAction(action, (a) => setUndoStack(prev => [...prev, a]));
  };

  // Viewport drag handlers for repositioning clips
  const handleViewportMouseDown = (e: React.MouseEvent) => {
    // Only on left click
    if (e.button !== 0) return;

    // Can drag if we have a global transform selected or a clip selected
    const canDrag = transformTarget === 'global' || primarySelectedSegment;
    if (!canDrag) return;

    let currentTransform;
    if (transformTarget === 'global') {
      currentTransform = getInterpolatedTransform(globalKeyframes, project.currentTime);
    } else {
      if (!primarySelectedSegment) return;
      const clipTime = project.currentTime - primarySelectedSegment.timelineStart;
      currentTransform = getInterpolatedTransform(primarySelectedSegment.keyframes, clipTime);
    }

    setIsViewportDragging(true);
    setViewportDragStart({ x: e.clientX, y: e.clientY });
    setViewportDragStartTransform({ translateX: currentTransform.translateX, translateY: currentTransform.translateY });
    e.preventDefault();
  };

  const handleViewportMouseMove = (e: React.MouseEvent) => {
    // Subtitle drag takes priority — use crop region dims for 1:1 mapping
    if (subtitleDragState && cropDims.width > 0) {
      const dx = (e.clientX - subtitleDragState.startX) / cropDims.width * 100;
      const dy = (e.clientY - subtitleDragState.startY) / cropDims.height * 100;
      const media = project.library.find(m => m.id === subtitleDragState.mediaId);
      const evt = media?.analysis?.events[subtitleDragState.index];
      if (evt) {
        handleUpdateDialogue(subtitleDragState.mediaId, subtitleDragState.index, {
          ...evt,
          translateX: subtitleDragState.origTx + dx,
          translateY: subtitleDragState.origTy + dy,
        });
      }
      return;
    }

    // Title drag — update keyframe at current time
    if (titleDragState && cropDims.width > 0 && project.titleLayer) {
      const dx = (e.clientX - titleDragState.startX) / cropDims.width * 100;
      const dy = (e.clientY - titleDragState.startY) / cropDims.height * 100;
      const newTx = titleDragState.origTx + dx;
      const newTy = titleDragState.origTy + dy;
      const t = project.currentTime - project.titleLayer.startTime;
      const existingKfs = project.titleLayer.keyframes || [];
      const existingIdx = existingKfs.findIndex(kf => Math.abs(kf.time - t) < 0.01);
      const baseKf: ClipKeyframe = existingIdx >= 0 ? existingKfs[existingIdx]
        : { time: t, translateX: 0, translateY: 0, scale: 1, rotation: 0 };
      const updatedKf = { ...baseKf, time: t, translateX: newTx, translateY: newTy };
      const newKfs = existingIdx >= 0
        ? existingKfs.map((kf, i) => i === existingIdx ? updatedKf : kf)
        : [...existingKfs, updatedKf].sort((a, b) => a.time - b.time);
      handleUpdateTitleLayer({ keyframes: newKfs });
      return;
    }

    if (!isViewportDragging || viewportSize.width === 0) return;

    const dx = e.clientX - viewportDragStart.x;
    const dy = e.clientY - viewportDragStart.y;

    // Convert pixel delta to percentage of video display area (object-contain),
    // matching the coordinate space used by tracking keyframes (% of video native dims)
    const dragVideoEl = primarySelectedSegment ? videoRefs.current.get(primarySelectedSegment.id) : null;
    const dragVW = dragVideoEl?.videoWidth || 1920;
    const dragVH = dragVideoEl?.videoHeight || 1080;
    const dragVideoAR = dragVW / dragVH;
    const dragContainerAR = viewportSize.width / (viewportSize.height || 1);
    const dragDisplayW = dragContainerAR > dragVideoAR ? viewportSize.height * dragVideoAR : viewportSize.width;
    const dragDisplayH = dragContainerAR > dragVideoAR ? viewportSize.height : viewportSize.width / dragVideoAR;
    const deltaX = (dx / dragDisplayW) * 100;
    const deltaY = (dy / dragDisplayH) * 100;

    const newTranslateX = viewportDragStartTransform.translateX + deltaX;
    const newTranslateY = viewportDragStartTransform.translateY + deltaY;

    if (transformTarget === 'global') {
      // Update global keyframes
      const keyframes = [...globalKeyframes];
      const existingIdx = keyframes.findIndex(kf => Math.abs(kf.time - project.currentTime) < 0.05);

      if (existingIdx >= 0) {
        keyframes[existingIdx] = {
          ...keyframes[existingIdx],
          translateX: newTranslateX,
          translateY: newTranslateY
        };
      } else {
        const currentTransform = getInterpolatedTransform(globalKeyframes, project.currentTime);
        keyframes.push({
          time: project.currentTime,
          translateX: newTranslateX,
          translateY: newTranslateY,
          scale: currentTransform.scale,
          rotation: currentTransform.rotation
        });
        keyframes.sort((a, b) => a.time - b.time);
      }

      setGlobalKeyframes(keyframes);
    } else if (primarySelectedSegment) {
      // Update clip keyframes
      const clipTime = project.currentTime - primarySelectedSegment.timelineStart;
      const keyframes = [...(primarySelectedSegment.keyframes || [])];

      const existingIdx = keyframes.findIndex(kf => Math.abs(kf.time - clipTime) < 0.05);

      if (existingIdx >= 0) {
        keyframes[existingIdx] = {
          ...keyframes[existingIdx],
          translateX: newTranslateX,
          translateY: newTranslateY
        };
      } else {
        const currentTransform = getInterpolatedTransform(primarySelectedSegment.keyframes, clipTime);
        keyframes.push({
          time: clipTime,
          translateX: newTranslateX,
          translateY: newTranslateY,
          scale: currentTransform.scale,
          rotation: currentTransform.rotation
        });
        keyframes.sort((a, b) => a.time - b.time);
      }

      setProject(prev => ({
        ...prev,
        segments: prev.segments.map(s =>
          s.id === primarySelectedSegment.id ? { ...s, keyframes } : s
        )
      }));
    }
  };

  const handleViewportMouseUp = () => {
    setIsViewportDragging(false);
    setSubtitleDragState(null);
    setTitleDragState(null);
  };

  // Tracking zoom: wheel to zoom-about-point, middle-drag to pan
  const handleTrackingWheel = useCallback((e: React.WheelEvent) => {
    if (activeRightTab !== 'tracking') return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Zoom-about-point
    const workspaceX = (mouseX - trackingPan.x) / trackingZoom;
    const workspaceY = (mouseY - trackingPan.y) / trackingZoom;

    const delta = -Math.sign(e.deltaY) * 0.15;
    const newZoom = Math.max(0.5, Math.min(8, trackingZoom + delta));

    const newPanX = mouseX - workspaceX * newZoom;
    const newPanY = mouseY - workspaceY * newZoom;

    setTrackingZoom(newZoom);
    setTrackingPan({ x: newPanX, y: newPanY });
  }, [activeRightTab, trackingZoom, trackingPan]);

  const trackingPanRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);

  const handleTrackingPanStart = useCallback((e: React.MouseEvent) => {
    // Middle mouse button or Alt+left click for panning
    if (activeRightTab !== 'tracking' || trackingZoom === 1) return;
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      trackingPanRef.current = {
        startX: e.clientX, startY: e.clientY,
        startPanX: trackingPan.x, startPanY: trackingPan.y,
      };
      const handleMove = (me: MouseEvent) => {
        if (!trackingPanRef.current) return;
        setTrackingPan({
          x: trackingPanRef.current.startPanX + (me.clientX - trackingPanRef.current.startX),
          y: trackingPanRef.current.startPanY + (me.clientY - trackingPanRef.current.startY),
        });
      };
      const handleUp = () => {
        trackingPanRef.current = null;
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    }
  }, [activeRightTab, trackingZoom, trackingPan]);

  // Get current clip time for graph editor (time within the selected segment)
  const graphEditorClipTime = useMemo(() => {
    if (!primarySelectedSegment) return 0;
    const localTime = project.currentTime - primarySelectedSegment.timelineStart;
    return Math.max(0, localTime);
  }, [primarySelectedSegment, project.currentTime]);

  // Get segment duration for graph editor
  const graphEditorSegmentDuration = useMemo(() => {
    if (!primarySelectedSegment) return 0;
    return primarySelectedSegment.endTime - primarySelectedSegment.startTime;
  }, [primarySelectedSegment]);

  // Add export to offline render queue
  const handleAddToRenderQueue = (settings: ExportSettings) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    renderQueue.addJob(settings);
    setActiveRightTab('render');
  };

  // Export video with animations (real-time playback capture) — legacy, kept as fallback
  const handleExportVideo = async (settings: ExportSettings) => {
    console.log('[Export] Starting REAL-TIME export:', settings);

    // Capture safe zone height from DOM BEFORE export mode changes layout
    const measuredSafeZoneHeight = safeZoneRef.current?.getBoundingClientRect().height || 0;

    // 0. Render ALL segments so their video elements exist for audio connection
    isExportingRef.current = true;
    setIsExporting(true);
    // Wait for React to render the initial window of segment video elements
    await new Promise(r => setTimeout(r, 300));

    // 1. Audio Setup
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const actx = audioContextRef.current;
    if (actx.state === 'suspended') await actx.resume();

    const dest = actx.createMediaStreamDestination();
    // Track which video elements have been connected to the export dest stream.
    // Audio sources are connected lazily in the render loop as segments enter the
    // lookahead window — this avoids creating all <video> elements at once, which
    // causes OOM crashes when a large file has many silence-cut segments.
    const exportAudioConnected = new WeakSet<HTMLVideoElement>();

    const connectExportAudio = (vid: HTMLVideoElement, segId: string) => {
      if (exportAudioConnected.has(vid)) return;
      exportAudioConnected.add(vid);
      let source = audioSourcesRef.current.get(vid);
      if (!source) {
        try {
          source = actx.createMediaElementSource(vid);
          audioSourcesRef.current.set(vid, source);
          source.connect(actx.destination);
        } catch (e) {
          console.warn('[Export] Audio source creation failed for segment', segId, e);
          return;
        }
      }
      try { source.connect(dest); } catch (e) {
        console.warn('[Export] Audio dest connect failed for segment', segId, e);
      }
    };

    // 2. Visual Setup
    const preset = ASPECT_RATIO_PRESETS[settings.aspectRatio];
    const baseRes = settings.resolution === '4K' ? 2160 : settings.resolution === '1080p' ? 1080 : 720;

    let outputWidth: number, outputHeight: number;
    if (preset.ratio > 1) {
      outputHeight = baseRes;
      outputWidth = Math.round(baseRes * preset.ratio);
    } else {
      outputWidth = Math.round(baseRes * preset.ratio);
      outputHeight = baseRes;
    }

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d')!;

    // Use actual DOM-measured safe zone height for accurate scaling.
    // Falls back to computed value if ref wasn't available.
    let safeZoneHeight = measuredSafeZoneHeight;
    if (safeZoneHeight <= 0) {
      safeZoneHeight = viewportSize.height || 360;
      const arPresetExport = viewportSettings.previewAspectRatio !== 'custom'
        ? ASPECT_RATIO_PRESETS[viewportSettings.previewAspectRatio]
        : null;
      if (arPresetExport && viewportSize.width > 0 && viewportSize.height > 0) {
        const cr = viewportSize.width / viewportSize.height;
        if (cr > arPresetExport.ratio) {
          safeZoneHeight = viewportSize.height;
        } else {
          safeZoneHeight = viewportSize.width / arPresetExport.ratio;
        }
      }
    }

    // 3. Recorder Setup
    const canvasStream = canvas.captureStream(settings.fps);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);

    const mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: settings.bitrateMbps * 1000000
    });

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `export_${settings.aspectRatio.replace(':', 'x')}_${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);

      // Cleanup: revert to start
      isExportingRef.current = false;
      setIsExporting(false);
      setProject(p => ({ ...p, isPlaying: false, currentTime: 0 }));
    };

    // 4. Pre-seek all videos active at t=0 and wait for readyState >= 2 before
    //    starting the recorder. Prevents black/blank frames at the very start.
    setProject(p => ({ ...p, isPlaying: false, currentTime: 0 }));
    await new Promise(r => setTimeout(r, 150)); // let React re-render + sync effect fire

    const segsAtStart = project.segments.filter(s =>
      0 >= s.timelineStart && 0 < s.timelineStart + (s.endTime - s.startTime)
    );

    await Promise.all(segsAtStart.map(seg => new Promise<void>(resolve => {
      const vid = videoRefs.current.get(seg.id);
      if (!vid) { resolve(); return; }
      vid.pause();
      vid.currentTime = seg.startTime;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const checkReady = () => { if (vid.readyState >= 2) finish(); else setTimeout(checkReady, 20); };
      vid.addEventListener('seeked', checkReady, { once: true });
      setTimeout(finish, 3000);
    })));

    // Keep a copy of the last successfully drawn frame to prevent black flashes
    // when a video element hasn't seeked to the right time yet at cut boundaries.
    const lastGoodFrame = document.createElement('canvas');
    lastGoodFrame.width = outputWidth;
    lastGoodFrame.height = outputHeight;
    const lastGoodCtx = lastGoodFrame.getContext('2d')!;

    // Pre-draw the first frame to canvas and prime lastGoodFrame so
    // the recorder never starts with a black canvas.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, outputWidth, outputHeight);
    segsAtStart.forEach(seg => {
      const vid = videoRefs.current.get(seg.id);
      if (!vid || vid.readyState < 2 || !vid.videoWidth) return;
      const transform = getCombinedTransform(seg.keyframes, 0, 0);
      const coverScale = Math.max(outputWidth / vid.videoWidth, outputHeight / vid.videoHeight);
      const dw = vid.videoWidth * coverScale;
      const dh = vid.videoHeight * coverScale;
      ctx.save();
      ctx.translate(outputWidth / 2, outputHeight / 2);
      ctx.translate(transform.translateX * dw / 100, transform.translateY * dh / 100);
      ctx.scale(transform.scale, transform.scale);
      ctx.rotate(transform.rotation * Math.PI / 180);
      ctx.drawImage(vid, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    });
    lastGoodCtx.clearRect(0, 0, outputWidth, outputHeight);
    lastGoodCtx.drawImage(canvas, 0, 0); // Prime with real first frame

    // 5. Start recorder and playback
    mediaRecorder.start();
    setProject(p => ({ ...p, isPlaying: true }));

    const totalDuration = contentDuration;
    const exportStartTime = performance.now();

    // Pre-allocate reusable tmpCanvas for transition rendering (avoid creating per-frame)
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = outputWidth;
    tmpCanvas.height = outputHeight;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    // Track previous segment's last frame for crossfade transitions
    let prevSegmentFrame: ImageData | null = null;
    let prevSegmentCanvas: HTMLCanvasElement | null = null;

    let exportFrameCount = 0;

    const renderLoop = () => {
      // Use monotonic clock for smooth, jitter-free timing
      const currentTime = (performance.now() - exportStartTime) / 1000;

      if (currentTime >= totalDuration) {
        setTimeout(() => {
          if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        }, 500);
        return;
      }

      exportFrameCount++;

      // Find ALL active segments (Multi-track support)
      const activeSegments = projectRef.current.segments
        .filter(s => currentTime >= s.timelineStart && currentTime < (s.timelineStart + (s.endTime - s.startTime)))
        .sort((a, b) => (a.track || 0) - (b.track || 0));

      // Lazily connect audio for any rendered segment whose video element now exists.
      // This handles the sliding-window approach: segments are rendered as they enter
      // the lookahead window, so we connect their audio on first appearance.
      videoRefs.current.forEach((vid, segId) => {
        connectExportAudio(vid, segId);
      });

      // Diagnostic logging (first 5 frames + every 60th frame)
      const shouldLog = exportFrameCount <= 5 || exportFrameCount % 60 === 0;
      if (shouldLog) {
        console.log(`[Export Frame ${exportFrameCount}] t=${currentTime.toFixed(3)}s, activeSegs=${activeSegments.length}, template=${projectRef.current.activeSubtitleTemplate?.name || 'NONE'}`);
      }

      // Check if any segment has video ready — if not, hold the last good frame
      // to prevent black flashes at cut boundaries while video seeks.
      const anyVideoReady = activeSegments.some(s => {
        const v = videoRefs.current.get(s.id);
        return v && v.readyState >= 2;
      });

      if (anyVideoReady || activeSegments.length === 0) {
        // Clear to black only when we have video to draw (or no segments at all)
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, outputWidth, outputHeight);
      } else {
        // No video ready yet — redraw last good frame to avoid black flash
        ctx.drawImage(lastGoodFrame, 0, 0);
      }

      activeSegments.forEach(activeSeg => {
        const vid = videoRefs.current.get(activeSeg.id);
        const clipTime = currentTime - activeSeg.timelineStart;
        const segDuration = activeSeg.endTime - activeSeg.startTime;

        // --- VIDEO DRAWING ---
        if (vid && vid.readyState >= 2) {
          const transform = getCombinedTransform(activeSeg.keyframes, clipTime, currentTime);

          // --- Transition handling for export ---
          let transitionActive = false;
          let transitionProgress = 0;
          let activeTransition: Transition | undefined;
          let isTransitionIn = false;

          // Check intro transition
          if (activeSeg.transitionIn && clipTime < activeSeg.transitionIn.duration) {
            transitionActive = true;
            transitionProgress = Math.max(0, Math.min(1, clipTime / activeSeg.transitionIn.duration));
            activeTransition = activeSeg.transitionIn;
            isTransitionIn = true;
          }
          // Check outro transition
          if (activeSeg.transitionOut && clipTime > (segDuration - activeSeg.transitionOut.duration)) {
            transitionActive = true;
            const remaining = segDuration - clipTime;
            transitionProgress = 1 - Math.max(0, Math.min(1, remaining / activeSeg.transitionOut.duration));
            activeTransition = activeSeg.transitionOut;
            isTransitionIn = false;
          }

          // Color grading / correction for export
          const hasGrading = activeSeg.colorGrading && !isGradingDefault(activeSeg.colorGrading);
          const ccFilter = !hasGrading && activeSeg.colorCorrection && !isDefaultCC(activeSeg.colorCorrection)
            ? buildCanvasFilter(activeSeg.colorCorrection) : 'none';
          const ccAdvanced = !hasGrading && activeSeg.colorCorrection && needsAdvancedCorrection(activeSeg.colorCorrection);

          if (transitionActive && activeTransition && activeTransition.type !== 'NONE') {
            if (shouldLog) console.log(`[Export] Transition: ${activeTransition.type}, progress=${transitionProgress.toFixed(2)}, isIn=${isTransitionIn}`);
            // Draw video frame to reusable tmpCanvas (with transforms applied)
            tmpCtx.clearRect(0, 0, outputWidth, outputHeight);
            const coverScale = Math.max(outputWidth / vid.videoWidth, outputHeight / vid.videoHeight);
            const drawWidth = vid.videoWidth * coverScale;
            const drawHeight = vid.videoHeight * coverScale;
            tmpCtx.save();
            if (ccFilter !== 'none') tmpCtx.filter = ccFilter;
            tmpCtx.translate(outputWidth / 2, outputHeight / 2);
            tmpCtx.translate(transform.translateX * drawWidth / 100, transform.translateY * drawHeight / 100);
            tmpCtx.scale(transform.scale, transform.scale);
            tmpCtx.rotate(transform.rotation * Math.PI / 180);
            tmpCtx.drawImage(vid, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
            tmpCtx.restore();
            tmpCtx.filter = 'none';
            // Apply advanced pixel corrections (temperature/tint/gamma) or full grading
            if (hasGrading && activeSeg.colorGrading) {
              const imgData = tmpCtx.getImageData(0, 0, outputWidth, outputHeight);
              applyColorGradingToImageData(imgData, activeSeg.colorGrading);
              tmpCtx.putImageData(imgData, 0, 0);
            } else if (ccAdvanced && activeSeg.colorCorrection) {
              const imgData = tmpCtx.getImageData(0, 0, outputWidth, outputHeight);
              applyAdvancedCorrection(imgData, activeSeg.colorCorrection);
              tmpCtx.putImageData(imgData, 0, 0);
            }

            // For crossfade: use previous segment's last frame if available
            if (isTransitionIn) {
              const outFrame = (activeTransition.type === 'CROSSFADE' && prevSegmentCanvas) ? prevSegmentCanvas : null;
              renderTransitionCanvas({
                ctx, width: outputWidth, height: outputHeight,
                outFrame, inFrame: tmpCanvas,
                progress: transitionProgress, transition: activeTransition,
              });
            } else {
              renderTransitionCanvas({
                ctx, width: outputWidth, height: outputHeight,
                outFrame: tmpCanvas, inFrame: null,
                progress: transitionProgress, transition: activeTransition,
              });
              // Capture this frame for potential crossfade into next segment
              if (!prevSegmentCanvas) {
                prevSegmentCanvas = document.createElement('canvas');
                prevSegmentCanvas.width = outputWidth;
                prevSegmentCanvas.height = outputHeight;
              }
              const pCtx = prevSegmentCanvas.getContext('2d')!;
              pCtx.clearRect(0, 0, outputWidth, outputHeight);
              pCtx.drawImage(tmpCanvas, 0, 0);
            }
          } else {
            // Normal draw (no transition)
            ctx.save();
            if (ccFilter !== 'none') ctx.filter = ccFilter;
            const coverScale = Math.max(outputWidth / vid.videoWidth, outputHeight / vid.videoHeight);
            const drawWidth = vid.videoWidth * coverScale;
            const drawHeight = vid.videoHeight * coverScale;
            ctx.translate(outputWidth / 2, outputHeight / 2);
            ctx.translate(transform.translateX * drawWidth / 100, transform.translateY * drawHeight / 100);
            ctx.scale(transform.scale, transform.scale);
            ctx.rotate(transform.rotation * Math.PI / 180);
            ctx.drawImage(vid, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
            ctx.restore();
            ctx.filter = 'none';
            // Apply full color grading or advanced pixel corrections
            if (hasGrading && activeSeg.colorGrading) {
              const imgData = ctx.getImageData(0, 0, outputWidth, outputHeight);
              applyColorGradingToImageData(imgData, activeSeg.colorGrading);
              ctx.putImageData(imgData, 0, 0);
            } else if (ccAdvanced && activeSeg.colorCorrection) {
              const imgData = ctx.getImageData(0, 0, outputWidth, outputHeight);
              applyAdvancedCorrection(imgData, activeSeg.colorCorrection);
              ctx.putImageData(imgData, 0, 0);
            }

            // Capture current frame for potential crossfade with next segment
            if (!prevSegmentCanvas) {
              prevSegmentCanvas = document.createElement('canvas');
              prevSegmentCanvas.width = outputWidth;
              prevSegmentCanvas.height = outputHeight;
            }
            const pCtx = prevSegmentCanvas.getContext('2d')!;
            pCtx.clearRect(0, 0, outputWidth, outputHeight);
            pCtx.drawImage(ctx.canvas, 0, 0);
          }
        }

        // --- SUBTITLE DRAWING (outside vid.readyState guard — subtitles should render even if video is buffering) ---
        const media = projectRef.current.library.find(m => m.id === activeSeg.mediaId);
        if (media && media.analysis) {
          const mediaTime = activeSeg.startTime + clipTime;
          // Use <= for endTime (matching viewport behavior)
          const subtitle = media.analysis.events.find(e =>
            e.type === 'dialogue' && mediaTime >= e.startTime && mediaTime <= e.endTime
          );

          if (shouldLog) {
            if (subtitle) {
              const subTemplate = subtitle.templateOverride || projectRef.current.activeSubtitleTemplate;
              const kwAnim = subtitle.keywordAnimation || subTemplate?.keywordAnimation || projectRef.current.activeKeywordAnimation || null;
              console.log(`[Export] Subtitle: "${subtitle.details.slice(0, 50)}" | template=${subTemplate?.name || 'NONE'} | anim=${subTemplate?.animation?.effects?.length || 0} effects (scope=${subTemplate?.animation?.scope || 'N/A'}) | kwAnim=${kwAnim ? kwAnim.effects.length + ' effects' : 'NONE'} | wordEmphases=${subtitle.wordEmphases?.filter(w => w.enabled).length || 0} | frame=${Math.round((mediaTime - subtitle.startTime) * settings.fps)}`);
            } else {
              console.log(`[Export] No subtitle at mediaTime=${mediaTime.toFixed(3)}, events=${media.analysis.events.filter(e => e.type === 'dialogue').length}`);
            }
          }

          if (subtitle) {
            // Resolve template and style (same logic as viewport)
            const subTemplate = subtitle.templateOverride || projectRef.current.activeSubtitleTemplate;
            const sourceStyle = subtitle.styleOverride || projectRef.current.subtitleStyle;

            // Calculate interpolated transform for this frame
            let kfTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
            if (subtitle.keyframes && subtitle.keyframes.length > 0) {
              const sourceTime = activeSeg.startTime + clipTime;
              const subTime = sourceTime - subtitle.startTime;
              kfTransform = getInterpolatedTransform(subtitle.keyframes, subTime);
            }

            // Base offsets
            const evtTx = subtitle.translateX || 0;
            const evtTy = subtitle.translateY || 0;

            // Animation frame (local to subtitle event)
            const sourceTime = activeSeg.startTime + clipTime;
            const localFrame = Math.round((sourceTime - subtitle.startTime) * settings.fps);
            const subAnim = subTemplate?.animation || null;

            // Resolve keyword animation (same cascade as viewport: per-event → template → global)
            const kwAnim = subtitle.keywordAnimation || subTemplate?.keywordAnimation || projectRef.current.activeKeywordAnimation || null;

            drawSubtitleOnCanvas({
              ctx,
              text: subtitle.details,
              style: sourceStyle,
              templateStyle: subTemplate?.style || null,
              animation: subAnim,
              frame: localFrame,
              fps: settings.fps,
              outputWidth,
              outputHeight,
              viewportSafeZoneHeight: safeZoneHeight,
              totalTx: evtTx + kfTransform.translateX,
              totalTy: evtTy + kfTransform.translateY,
              totalScale: kfTransform.scale,
              totalRotation: kfTransform.rotation,
              wordEmphases: subtitle.wordEmphases,
              keywordAnimation: kwAnim,
              wordTimings: subtitle.wordTimings,
              sourceTime,
              eventStartTime: subtitle.startTime,
              eventEndTime: subtitle.endTime,
            });
          }
        }
      });

      // --- TITLE DRAWING (outside segment loop — titles are global) ---
      const titleLayer = projectRef.current.titleLayer;
      if (titleLayer && currentTime >= titleLayer.startTime && currentTime < titleLayer.endTime) {
        const titleStyle = titleLayer.style || projectRef.current.titleStyle;
        const titleTemplate = projectRef.current.activeTitleTemplate;
        const titleAnim = titleLayer.animation || titleTemplate?.animation || null;

        const titleClipTime = currentTime - titleLayer.startTime;
        const titleDuration = titleLayer.endTime - titleLayer.startTime;
        const titleLocalFrame = Math.round(titleClipTime * settings.fps);

        // Fade-in / fade-out opacity
        let titleOpacity = 1;
        if (titleLayer.fadeInDuration > 0 && titleClipTime < titleLayer.fadeInDuration) {
          titleOpacity = titleClipTime / titleLayer.fadeInDuration;
        }
        if (titleLayer.fadeOutDuration > 0 && titleClipTime > (titleDuration - titleLayer.fadeOutDuration)) {
          titleOpacity = (titleDuration - titleClipTime) / titleLayer.fadeOutDuration;
        }

        // Keyframe transforms
        let titleKfTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
        if (titleLayer.keyframes && titleLayer.keyframes.length > 0) {
          titleKfTransform = getInterpolatedTransform(titleLayer.keyframes, titleClipTime);
        }

        if (shouldLog) {
          console.log(`[Export] Title: "${titleLayer.text.slice(0, 40)}" opacity=${titleOpacity.toFixed(2)} frame=${titleLocalFrame}`);
        }

        drawSubtitleOnCanvas({
          ctx,
          text: titleLayer.text,
          style: titleStyle as any,
          templateStyle: titleTemplate?.style || null,
          animation: titleAnim,
          frame: titleLocalFrame,
          fps: settings.fps,
          outputWidth,
          outputHeight,
          viewportSafeZoneHeight: safeZoneHeight,
          totalTx: titleKfTransform.translateX,
          totalTy: titleKfTransform.translateY,
          totalScale: titleKfTransform.scale,
          totalRotation: titleKfTransform.rotation,
          topOffset: (titleStyle as any).topOffset ?? 15,
          globalOpacity: titleOpacity,
        });
      }

      // Save this frame as the last good frame (for fallback at cut boundaries)
      if (anyVideoReady) {
        lastGoodCtx.clearRect(0, 0, outputWidth, outputHeight);
        lastGoodCtx.drawImage(canvas, 0, 0);
      }

      requestAnimationFrame(renderLoop);
    };

    renderLoop();
  };


  // Handlers
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    const newItems: MediaItem[] = [];
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const isAudioOnly = file.type.startsWith('audio/');

      // Use <audio> for audio files, <video> for video files
      const el = document.createElement(isAudioOnly ? 'audio' : 'video');
      el.src = url;
      await new Promise(r => el.onloadedmetadata = r);
      newItems.push({
        id: Math.random().toString(36).substr(2, 9),
        file,
        url,
        duration: (el.duration && isFinite(el.duration)) ? el.duration : 10, // Default to 10s if unknown
        name: file.name,
        analysis: null,
        isAudioOnly,
      });
    }
    // Persist blobs to IndexedDB BEFORE updating project state so they're
    // guaranteed to exist if the user saves + refreshes immediately after upload.
    await Promise.all(newItems.map(item =>
      item.file ? contentDB.saveMediaBlob(item.id, item.file).catch(e => console.warn('[MediaBlob] save failed:', e)) : Promise.resolve()
    ));
    setProject(prev => ({ ...prev, library: [...prev.library, ...newItems] }));
  };

  // Extract YouTube video ID from URL (client-side helper)
  const extractYoutubeVideoId = (url: string): string | null => {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const handleYoutubeImport = async (url: string, download: boolean, manualFile?: File) => {
    console.log('[Import] Starting import...', { url, download, manualFile });
    setStatus(ProcessingStatus.TRANSCRIBING);
    try {
      const videoId = extractYoutubeVideoId(url);

      // Check local cache first (skip YouTube entirely if cached)
      if (videoId && download) {
        try {
          const cacheRes = await fetch(`/api/local-cache?videoId=${videoId}`);
          const cache = await cacheRes.json();

          if (cache.hasVideo) {
            console.log(`[Import] Found local cache for ${videoId}. Loading locally...`);

            // Load video from local cache
            const localVideoRes = await fetch(`/api/local-video?videoId=${videoId}`);
            if (localVideoRes.ok) {
              const blob = await localVideoRes.blob();
              const videoUrl = URL.createObjectURL(blob);
              let videoTitle = "YouTube Video";

              // Load cached AssemblyAI transcript if available
              let processedEvents: AnalysisEvent[] = [];
              let transcriptSource: 'youtube' | 'assemblyai' | 'none' = 'none';

              if (cache.hasTranscript) {
                try {
                  const transcriptRes = await fetch(`/api/local-transcript?videoId=${videoId}`);
                  const cachedTranscript = await transcriptRes.json();
                  if (cachedTranscript.events && cachedTranscript.events.length > 0) {
                    processedEvents = cachedTranscript.events;
                    transcriptSource = (cachedTranscript.source as any) || 'assemblyai';
                    console.log(`[Import] Loaded cached ${transcriptSource} transcript: ${processedEvents.length} events`);
                  }
                } catch (e) {
                  console.warn('[Import] Failed to load cached transcript:', e);
                }
              }

              // If no cached transcript, try YouTube transcript as fallback
              if (processedEvents.length === 0) {
                try {
                  const ytResult = await fetchYoutubeTranscript(url);
                  processedEvents = ytResult.events;
                  videoTitle = ytResult.title;
                  transcriptSource = 'youtube';
                } catch { /* will have no transcript */ }
              }

              // Get duration
              const video = document.createElement('video');
              video.src = videoUrl;
              let duration = 0;
              try {
                await new Promise((resolve) => {
                  const timeout = setTimeout(() => resolve(null), 5000);
                  video.onloadedmetadata = () => { clearTimeout(timeout); resolve(null); };
                  video.onerror = () => { clearTimeout(timeout); resolve(null); };
                });
                duration = video.duration || 0;
              } catch { /* ignore */ }
              if (!duration || isNaN(duration)) {
                duration = processedEvents.length > 0 ? processedEvents[processedEvents.length - 1].endTime : 10;
              }

              const file = new File([blob], `${videoTitle}.mp4`, { type: 'video/mp4' });
              const newItem: MediaItem = {
                id: Math.random().toString(36).substr(2, 9),
                file, url: videoUrl, duration, name: videoTitle,
                youtubeVideoId: videoId,
                transcriptSource,
                analysis: processedEvents.length > 0 ? { summary: `Loaded from local cache (${transcriptSource})`, events: processedEvents, generatedAt: new Date() } : null,
              };

              setProject(prev => ({ ...prev, library: [...prev.library, newItem] }));
              if (newItem.file) contentDB.saveMediaBlob(newItem.id, newItem.file).catch(e => console.warn('[MediaBlob] save failed:', e));
              setSelectedMediaId(newItem.id);
              setActiveRightTab('transcript');
              setShowYoutubeModal(false);
              console.log('[Import] Import from local cache complete!');
              setStatus(ProcessingStatus.IDLE);
              return;
            }
          }
        } catch (cacheErr) {
          console.warn('[Import] Local cache check failed (continuing with YouTube):', cacheErr);
        }
      }

      // Standard YouTube import flow (no local cache)
      let processedEvents: AnalysisEvent[] = [];
      let videoTitle = "YouTube Video";
      let transcriptWarning = '';

      try {
        const ytResult = await fetchYoutubeTranscript(url);
        processedEvents = ytResult.events;
        videoTitle = ytResult.title;
        if (ytResult.warning) transcriptWarning = ytResult.warning;
      } catch (transcriptErr) {
        transcriptWarning = transcriptErr instanceof Error ? transcriptErr.message : String(transcriptErr);
        console.warn('[Import] Transcript fetch failed (continuing without transcript):', transcriptWarning);
      }

      // 2. Handle Media (Download or Upload placeholder)
      let file: File;
      let videoUrl: string;

      if (download) {
        console.log('[Import] Starting download fetch...');
        const downloadRes = await fetch(`/api/download?url=${encodeURIComponent(url)}&_t=${Date.now()}`);
        console.log('[Import] Download response status:', downloadRes.status);

        if (!downloadRes.ok) {
          const errText = await downloadRes.text();
          throw new Error(`Download failed: ${downloadRes.status} ${errText}`);
        }

        console.log('[Import] Download starting blob conversion...');
        const blob = await downloadRes.blob();
        console.log('[Import] Blob received size:', blob.size);

        file = new File([blob], `${videoTitle}.mp4`, { type: 'video/mp4' });
        videoUrl = URL.createObjectURL(blob);
      } else if (manualFile) {
        file = manualFile;
        videoUrl = URL.createObjectURL(manualFile);
      } else {
        alert("For manual mode, please select a file.");
        setStatus(ProcessingStatus.IDLE);
        return;
      }

      console.log('[Import] Getting video duration...');
      const video = document.createElement('video');
      video.src = videoUrl;

      let duration = 0;
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(null), 5000);
          video.onloadedmetadata = () => { clearTimeout(timeout); resolve(null); };
          video.onerror = () => { clearTimeout(timeout); reject(new Error('Video format not supported or corrupt')); };
        });
        duration = video.duration || 0;
      } catch (e) {
        console.warn('Could not determine video duration:', e);
      }
      console.log('[Import] Duration determined:', duration);

      if (!duration || isNaN(duration)) {
        duration = processedEvents.length > 0 ? processedEvents[processedEvents.length - 1].endTime : 10;
      }

      const newItem: MediaItem = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        url: videoUrl,
        duration: duration,
        name: videoTitle,
        youtubeVideoId: videoId || undefined,
        transcriptSource: processedEvents.length > 0 ? 'youtube' : 'none',
        analysis: {
          summary: "Imported from YouTube",
          events: processedEvents,
          generatedAt: new Date()
        }
      };

      setProject(prev => ({ ...prev, library: [...prev.library, newItem] }));
      if (newItem.file) contentDB.saveMediaBlob(newItem.id, newItem.file).catch(e => console.warn('[MediaBlob] save failed:', e));
      setSelectedMediaId(newItem.id);
      setActiveRightTab('transcript');
      setShowYoutubeModal(false);
      console.log('[Import] Import complete!');

      if (transcriptWarning) {
        setTimeout(() => {
          alert(`Video imported, but transcript could not be fetched.\n\nReason: ${transcriptWarning}\n\nTip: Try updating yt-dlp ("yt-dlp -U" in terminal), or upload a cookies.txt file in the import dialog's Advanced Options.`);
        }, 100);
      }

    } catch (e) {
      console.error('[Import] Error:', e);
      alert(`Import failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
    }
  };

  // Helper: Fetch and process YouTube transcript
  const fetchYoutubeTranscript = async (url: string): Promise<{ events: AnalysisEvent[]; title: string; warning?: string }> => {
    console.log('[Import] Fetching transcript...');
    const transcriptRes = await fetch(`/api/transcript?url=${encodeURIComponent(url)}&_t=${Date.now()}`);
    const transcriptData = await transcriptRes.json();

    if (transcriptData.error) {
      return { events: [], title: "YouTube Video", warning: transcriptData.error };
    }

    const videoTitle = transcriptData.title || "YouTube Video";
    const events: AnalysisEvent[] = [];
    let warning: string | undefined;

    if (transcriptData.segments && transcriptData.segments.length > 0) {
      transcriptData.segments.forEach((seg: any) => {
        let text = seg.text || "";
        text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return;

        const words = text.split(/\s+/);
        const segDurationMs = Math.abs(Number(seg.duration));
        const segStartMs = Number(seg.start);

        if (words.length > 1) {
          const durationPerWord = segDurationMs / words.length;
          words.forEach((w: string, i: number) => {
            events.push({ type: 'dialogue', startTime: segStartMs + (i * durationPerWord), endTime: segStartMs + ((i + 1) * durationPerWord), label: 'speech', details: w });
          });
        } else {
          events.push({ type: 'dialogue', startTime: segStartMs, endTime: segStartMs + segDurationMs, label: 'speech', details: text });
        }
      });
    } else {
      warning = 'No caption segments found for this video.';
    }

    // Post-Process: Combine rapid/short words into readable "Slides"
    const processedEvents: AnalysisEvent[] = [];
    if (events.length > 0) {
      let buffer: AnalysisEvent[] = [events[0]];
      for (let i = 1; i < events.length; i++) {
        const current = events[i];
        const prev = buffer[buffer.length - 1];
        const isContiguous = (current.startTime - prev.endTime) < 0.1;
        const bufferDuration = prev.endTime - buffer[0].startTime;
        const combinedDuration = current.endTime - buffer[0].startTime;
        const wordCount = buffer.length;

        const isDuplicate = current.details.trim().toLowerCase() === prev.details.trim().toLowerCase();
        const isOverlap = current.startTime < prev.endTime;
        if (isDuplicate && isOverlap) { prev.endTime = Math.max(prev.endTime, current.endTime); continue; }

        if (isContiguous && (bufferDuration < 0.5 || wordCount < 3) && combinedDuration < 1.2) {
          buffer.push(current);
        } else {
          processedEvents.push({ type: 'dialogue', startTime: buffer[0].startTime, endTime: buffer[buffer.length - 1].endTime, label: 'speech', details: buffer.map(e => e.details).join(' ') });
          buffer = [current];
        }
      }
      if (buffer.length > 0) {
        processedEvents.push({ type: 'dialogue', startTime: buffer[0].startTime, endTime: buffer[buffer.length - 1].endTime, label: 'speech', details: buffer.map(e => e.details).join(' ') });
      }
    }

    return { events: processedEvents, title: videoTitle, warning };
  };

  // Transcribe media with AssemblyAI (SSE progress)
  const handleTranscribeWithAssemblyAI = async (mediaId: string) => {
    const item = project.library.find(m => m.id === mediaId);
    if (!item) return;

    // Update job status
    setTranscriptionJobs(prev => {
      const next = new Map(prev);
      next.set(mediaId, { status: 'starting', mediaId });
      return next;
    });

    try {
      let response: Response;

      if (item.youtubeVideoId) {
        // YouTube video — use locally cached file via videoId
        const formData = new FormData();
        formData.append('videoId', item.youtubeVideoId);
        response = await fetch('/api/transcribe', { method: 'POST', body: formData });
      } else {
        // Local file upload — send the file itself
        const formData = new FormData();
        formData.append('file', item.file);
        response = await fetch('/api/transcribe', { method: 'POST', body: formData });
      }

      if (!response.ok && !response.headers.get('content-type')?.includes('text/event-stream')) {
        const err = await response.json();
        throw new Error(err.error || 'Transcription request failed');
      }

      // Read SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      if (!reader) throw new Error('No response stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));

            // Update job progress
            setTranscriptionJobs(prev => {
              const next = new Map(prev);
              next.set(mediaId, { status: data.status, progress: data.detail, mediaId });
              return next;
            });

            if (data.status === 'completed' && data.events) {
              // Hot-swap transcript events on the MediaItem
              setProject(prev => ({
                ...prev,
                library: prev.library.map(m =>
                  m.id === mediaId
                    ? {
                      ...m,
                      transcriptSource: 'assemblyai' as const,
                      analysis: {
                        summary: `Transcribed with AssemblyAI (${data.wordCount} words)`,
                        events: data.events,
                        generatedAt: new Date(),
                      },
                    }
                    : m
                ),
              }));

              // Clean up job after a delay
              setTimeout(() => {
                setTranscriptionJobs(prev => {
                  const next = new Map(prev);
                  next.delete(mediaId);
                  return next;
                });
              }, 3000);
            }

            if (data.status === 'error') {
              throw new Error(data.detail || 'Transcription failed');
            }
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'Transcription failed' && !parseErr.message.startsWith('AssemblyAI')) {
              console.warn('[Transcribe] SSE parse error:', parseErr);
            } else {
              throw parseErr;
            }
          }
        }
      }
    } catch (err) {
      console.error('[Transcribe] Error:', err);
      alert(`Transcription failed: ${err instanceof Error ? err.message : 'Unknown error'}`);

      setTranscriptionJobs(prev => {
        const next = new Map(prev);
        next.set(mediaId, { status: 'error', progress: err instanceof Error ? err.message : 'Unknown error', mediaId });
        return next;
      });

      // Clean up error state after a delay
      setTimeout(() => {
        setTranscriptionJobs(prev => {
          const next = new Map(prev);
          next.delete(mediaId);
          return next;
        });
      }, 5000);
    }
  };

  const handleAddToTimeline = (item: MediaItem, importMode: 'both' | 'video' | 'audio' = 'both') => {
    // Snapshot before inserting so the add can be undone
    pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });

    const insertionTime = project.currentTime;
    const isAudio = importMode === 'audio' || !!item.isAudioOnly;
    const videoOnly = importMode === 'video';

    let targetTrack = 0;

    if (selectedInsertTrack !== null && !isAudio) {
      // User has locked a specific video track — insert there at the cursor
      targetTrack = selectedInsertTrack;
    } else if (isAudio) {
      // Audio clips always go on a new audio track
      const existingAudioTracks = project.segments
        .filter(s => s.type === 'audio')
        .map(s => s.track);
      targetTrack = existingAudioTracks.length > 0 ? Math.max(...existingAudioTracks) + 1 : 1;
    } else {
      // Default: place on a new track above all existing video tracks
      const existingVideoTracks = project.segments
        .filter(s => s.type !== 'audio')
        .map(s => s.track);
      targetTrack = existingVideoTracks.length > 0 ? Math.max(...existingVideoTracks) + 1 : 0;
    }

    const newSeg: Segment = {
      id: Math.random().toString(36).substr(2, 9),
      type: isAudio ? 'audio' : undefined,
      mediaId: item.id,
      startTime: 0,
      endTime: item.duration,
      timelineStart: insertionTime,
      track: targetTrack,
      description: item.name,
      color: `hsl(${Math.random() * 360}, 60%, 40%)`,
      // Video-only: unlink audio track so it stays silent
      ...(videoOnly ? { audioLinked: false } : {}),
    };
    setProject(prev => ({ ...prev, segments: [...prev.segments, newSeg] }));
    safeSetTimelineZoom(1);

    // Auto-center person at start and end of the clip (if enabled)
    if (autoCenterOnImport && !isAudio) {
      setTimeout(() => autoCenterSegment(newSeg.id, newSeg.startTime, newSeg.endTime, newSeg.timelineStart), 0);
    }
  };

  const handleSwapMedia = (newItem: MediaItem) => {
    if (selectedSegmentIds.length !== 1) return;
    pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });
    const segId = selectedSegmentIds[0];
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segId
          ? { ...s, mediaId: newItem.id, startTime: 0, endTime: newItem.duration, description: newItem.name }
          : s
      )
    }));
  };

  const handleAddStockToLibrary = async (downloadUrl: string, name: string, duration: number, isPhoto: boolean) => {
    try {
      const proxyUrl = `/api/pexels/download?url=${encodeURIComponent(downloadUrl)}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error('Download failed');
      const blob = await response.blob();
      const file = new File([blob], name + (isPhoto ? '.jpg' : '.mp4'), {
        type: isPhoto ? 'image/jpeg' : 'video/mp4'
      });
      const url = URL.createObjectURL(blob);

      const newItem: MediaItem = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        url,
        duration,
        name,
        analysis: null,
      };

      setProject(prev => ({
        ...prev,
        library: [...prev.library, newItem]
      }));
      if (newItem.file) contentDB.saveMediaBlob(newItem.id, newItem.file).catch(e => console.warn('[MediaBlob] save failed:', e));

      handleAddToTimeline(newItem);
    } catch (err) {
      console.error('Stock download error:', err);
      alert('Failed to download stock clip. Try again.');
    }
  };

  const handleInsertBlank = (insertionTime: number) => {
    const duration = 2; // Default 2 seconds for a blank card
    let targetTrack = 0;
    while (true) {
      const collision = project.segments.some(s =>
        s.track === targetTrack &&
        !(s.timelineStart + (s.endTime - s.startTime) <= insertionTime + 0.01 ||
          s.timelineStart >= insertionTime + duration - 0.01)
      );
      if (!collision) break;
      targetTrack++;
      if (targetTrack > 10) break; // Arbitrary high limit
    }

    const newBlankSeg: Segment = {
      id: Math.random().toString(36).substr(2, 9),
      type: 'blank',
      mediaId: '', // Blanks don't have underlying media
      startTime: 0,
      endTime: duration,
      timelineStart: insertionTime,
      track: targetTrack,
      description: 'Blank Dialog',
      customText: '',
      color: '#444444' // Neutral dark gray for blanks
    };

    pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });
    setProject(prev => ({ ...prev, segments: [...prev.segments, newBlankSeg] }));
  };

  const handleInsertTitle = (insertionTime: number = project.currentTime) => {
    setProject(prev => ({
      ...prev,
      titleLayer: prev.titleLayer ? prev.titleLayer : {
        id: `title-${Date.now()}`,
        text: 'New Title',
        startTime: insertionTime,
        endTime: insertionTime + 3,
        fadeInDuration: 0.2,
        fadeOutDuration: 0.2,
      },
    }));
    setIsTitleSelected(true);
  };

  const handleInsertDialogue = (insertionTime: number = project.currentTime) => {
    // Find media under playhead
    const topSeg = project.segments
      .filter(s => s.timelineStart <= insertionTime && (s.timelineStart + s.endTime - s.startTime) > insertionTime)
      .sort((a, b) => b.track - a.track)[0];

    if (!topSeg || topSeg.type === 'blank') {
      alert("Please place the playhead over a valid media clip to insert a dialogue.");
      return;
    }

    setProject(prev => {
      const mediaIndex = prev.library.findIndex(m => m.id === topSeg.mediaId);
      if (mediaIndex === -1) return prev;

      const sourceTime = topSeg.startTime + (insertionTime - topSeg.timelineStart);

      const newLib = [...prev.library];
      const currentMedia = newLib[mediaIndex];
      const newAnalysis = currentMedia.analysis ? { ...currentMedia.analysis } : { events: [], summary: '', generatedAt: new Date() };
      if (!newAnalysis.events) newAnalysis.events = [];

      const newEvent: AnalysisEvent = {
        startTime: sourceTime,
        endTime: sourceTime + 2,
        type: 'dialogue',
        label: 'Unknown',
        details: 'New Dialogue',
      };

      newAnalysis.events = [...newAnalysis.events, newEvent].sort((a, b) => a.startTime - b.startTime);
      newLib[mediaIndex] = { ...currentMedia, analysis: newAnalysis as any };
      return { ...prev, library: newLib };
    });
  };

  // ============ TRACKING PANEL HANDLERS ============
  const TRACKER_COLORS = ['#00ff00', '#00ffff', '#ff00ff', '#ffff00', '#ff9900', '#adff2f', '#00bfff'];

  const handlePlaceTracker = (videoX: number, videoY: number) => {
    if (!primarySelectedSegment) return;
    const trackers = primarySelectedSegment.trackers || [];
    const newTracker: VibeCutTracker = {
      id: `tracker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      color: TRACKER_COLORS[trackers.length % TRACKER_COLORS.length],
      x: videoX,
      y: videoY,
      patchSize: 32,
      searchWindow: 60,
      sensitivity: 50,
      type: trackingMode === 'placing-stabilizer' ? 'stabilizer' : 'parent',
      isActive: true,
    };

    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === primarySelectedSegment.id
          ? { ...s, trackers: [...(s.trackers || []), newTracker] }
          : s
      ),
    }));

    // Capture template from current video frame
    const videoEl = videoRefs.current.get(primarySelectedSegment.id);
    if (videoEl) {
      captureTemplateFromVideo(newTracker, videoEl, trackingTemplatesRef.current);
    }

    setSelectedTrackerId(newTracker.id);
    setTrackingMode('reviewing'); // Exit placement mode after placing
  };

  const handleTrackerDrag = (trackerId: string, newVideoX: number, newVideoY: number) => {
    if (!primarySelectedSegment) return;
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === primarySelectedSegment.id
          ? {
            ...s,
            trackers: (s.trackers || []).map((t: VibeCutTracker) => t.id === trackerId ? { ...t, x: newVideoX, y: newVideoY } : t),
            // Clear tracking data when tracker is repositioned — old data is no longer valid
            trackingData: undefined,
          }
          : s
      ),
    }));
    // Re-capture template at new position
    const videoEl = videoRefs.current.get(primarySelectedSegment.id);
    const tracker = primarySelectedSegment.trackers?.find(t => t.id === trackerId);
    if (videoEl && tracker) {
      captureTemplateFromVideo({ ...tracker, x: newVideoX, y: newVideoY }, videoEl, trackingTemplatesRef.current);
    }
  };

  const handleUpdateTracker = (segmentId: string, trackerId: string, updates: Partial<VibeCutTracker>) => {
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId
          ? {
            ...s,
            trackers: (s.trackers || []).map((t: VibeCutTracker) => t.id === trackerId ? { ...t, ...updates } : t),
            // Don't clear tracking data when settings change — existing data is still valid
            // for display/review. Template re-capture handles future tracking runs.
          }
          : s
      ),
    }));
    // Re-capture template when patch size changes (for future tracking runs)
    if (updates.patchSize !== undefined) {
      const segment = project.segments.find(s => s.id === segmentId);
      const tracker = segment?.trackers?.find(t => t.id === trackerId);
      const videoEl = videoRefs.current.get(segmentId);
      if (tracker && videoEl) {
        captureTemplateFromVideo({ ...tracker, ...updates }, videoEl, trackingTemplatesRef.current);
      }
    }
  };

  const handleDeleteTracker = (segmentId: string, trackerId: string) => {
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId
          ? {
            ...s,
            trackers: (s.trackers || []).filter((t: VibeCutTracker) => t.id !== trackerId),
            trackingData: (s.trackingData || []).map(frame => ({
              ...frame,
              trackers: frame.trackers.filter(t => t.id !== trackerId),
            })),
          }
          : s
      ),
    }));
    trackingTemplatesRef.current.delete(trackerId);
    if (selectedTrackerId === trackerId) setSelectedTrackerId(null);
  };

  const handleClearTrackingData = (segmentId: string) => {
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, trackingData: undefined } : s
      ),
    }));
    setTrackingMode('reviewing');
  };

  const handleClearTracking = (segmentId: string) => {
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, trackers: [], trackingData: undefined } : s
      ),
    }));
    setSelectedTrackerId(null);
    setTrackingMode('idle');
    trackingTemplatesRef.current.clear();
  };

  const handleStartTracking = async (segmentId: string) => {
    const segment = project.segments.find(s => s.id === segmentId);
    if (!segment || !segment.trackers?.length) return;

    const videoEl = videoRefs.current.get(segmentId);
    if (!videoEl) return;

    // Stop playback — tracking service owns the video element
    setProject(prev => ({ ...prev, isPlaying: false }));

    // Create abort controller
    const abort = new AbortController();
    trackingAbortRef.current = abort;

    // Resume support: if we have existing tracking data, continue from last frame
    // Fresh start: begin from the current viewing time (where the user placed trackers),
    // NOT segment.startTime — avoids seeking away from the placement frame & using wrong template
    const existingData = segment.trackingData || [];
    const isResuming = existingData.length > 0;
    const currentMediaTime = segment.startTime + (project.currentTime - segment.timelineStart);
    const resumeTime = isResuming
      ? existingData[existingData.length - 1].time
      : Math.max(segment.startTime, Math.min(segment.endTime, currentMediaTime));

    // If resuming, update tracker positions to their last known positions
    // so the service initializes from the right spot
    let trackersForService = segment.trackers;
    if (isResuming) {
      const lastFrame = existingData[existingData.length - 1];
      trackersForService = segment.trackers.map((t: VibeCutTracker) => {
        const lastPos = lastFrame.trackers.find((ft: { id: string; x: number; y: number }) => ft.id === t.id);
        return lastPos ? { ...t, x: lastPos.x, y: lastPos.y } : t;
      });
    }

    setTrackingMode('tracking');
    setTrackingProgress({ progress: 0, label: isResuming ? 'Resuming...' : 'Starting...' });

    // Accumulate frames locally, flush to state periodically to reduce re-render churn
    let pendingFrames: typeof existingData = [];
    let lastFlushTime = 0;
    const FLUSH_INTERVAL = 300; // ms — flush state every 300ms

    const flushFrames = () => {
      if (pendingFrames.length === 0) return;
      const framesToFlush = pendingFrames;
      pendingFrames = [];
      const lastFrame = framesToFlush[framesToFlush.length - 1];
      setProject((prev: ProjectState) => ({
        ...prev,
        currentTime: segment.timelineStart + (lastFrame.time - segment.startTime),
        segments: prev.segments.map(s =>
          s.id === segmentId
            ? { ...s, trackingData: [...(s.trackingData || []), ...framesToFlush] }
            : s
        ),
      }));
    };

    try {
      const results = await trackManualTrackers(
        videoEl,
        { startTime: resumeTime, endTime: segment.endTime },
        trackersForService,
        trackingTemplatesRef.current,
        {
          onProgress: (p, l) => setTrackingProgress({ progress: p, label: l }),
          onFrame: (frame) => {
            pendingFrames.push(frame);
            const now = performance.now();
            if (now - lastFlushTime > FLUSH_INTERVAL) {
              lastFlushTime = now;
              flushFrames();
            }
          },
          signal: abort.signal,
        }
      );

      // Final flush + complete data
      const allData = [...existingData, ...results.slice(isResuming ? 1 : 0)];
      setProject(prev => ({
        ...prev,
        segments: prev.segments.map(s =>
          s.id === segmentId ? { ...s, trackingData: allData } : s
        ),
      }));
      setTrackingMode('reviewing');
    } catch (e) {
      // Flush any pending frames on abort/error
      flushFrames();
      if (abort.signal.aborted) {
        setTrackingMode('reviewing');
      } else {
        console.error('[Tracking] Failed:', e);
        setTrackingMode('reviewing');
      }
    } finally {
      setTrackingProgress(null);
      trackingAbortRef.current = null;
    }
  };

  const handleStopTracking = () => {
    trackingAbortRef.current?.abort();
  };

  // ── Head Pivot Tracking ──
  const handleTrackHeadPivot = async (segmentId: string, applyToAll: boolean) => {
    const targetSegments = applyToAll
      ? project.segments.filter(s => selectedSegmentIds.includes(s.id))
      : project.segments.filter(s => s.id === segmentId);

    if (targetSegments.length === 0) return;

    // Determine crop aspect ratio from current viewport/export settings
    const arPreset = ASPECT_RATIO_PRESETS[viewportSettings.previewAspectRatio];
    const cropAR = arPreset ? arPreset.ratio : 9 / 16;

    for (const seg of targetSegments) {
      const media = project.library.find(m => m.id === seg.mediaId);
      const videoEl = videoRefs.current.get(seg.id);
      if (!videoEl) {
        console.warn('[App] handleTrackHeadPivot: no video element for segment', seg.id);
        continue;
      }

      setPivotTrackingProgress({ progress: 0, label: 'Starting head tracker...' });

      const pivotKfs = await trackHeadForPivot(
        media?.file ?? null,
        videoEl,
        { startTime: seg.startTime, endTime: seg.endTime },
        cropAR,
        (progress, label) => setPivotTrackingProgress({ progress, label }),
      );

      setPivotTrackingProgress(null);

      if (!pivotKfs || pivotKfs.length === 0) {
        console.warn('[App] handleTrackHeadPivot: no keyframes for segment', seg.id);
        continue;
      }

      console.log(`[App] handleTrackHeadPivot: applying ${pivotKfs.length} pivot kfs to segment ${seg.id}`);

      // Apply to subtitle events in this media that overlap the segment
      const mediaItem = project.library.find(m => m.id === seg.mediaId);
      if (mediaItem?.analysis?.events) {
        const updatedEvents: AnalysisEvent[] = mediaItem.analysis.events.map(evt => {
          if (evt.type !== 'dialogue') return evt;
          if (evt.endTime <= seg.startTime || evt.startTime >= seg.endTime) return evt;

          // Re-key pivot keyframes relative to this subtitle event
          const evtPivotKfs: PivotKeyframe[] = pivotKfs
            .filter(kf => {
              const absTime = seg.startTime + kf.time;
              return absTime >= evt.startTime - 0.05 && absTime <= evt.endTime + 0.05;
            })
            .map(kf => ({
              time: Math.round(Math.max(0, seg.startTime + kf.time - evt.startTime) * 1000) / 1000,
              x: kf.x,
              y: kf.y,
            }));

          if (evtPivotKfs.length === 0) return evt;
          return { ...evt, pivotKeyframes: evtPivotKfs };
        });

        setProject(p => ({
          ...p,
          library: p.library.map(m =>
            m.id === seg.mediaId
              ? { ...m, analysis: m.analysis ? { ...m.analysis, events: updatedEvents } : m.analysis }
              : m
          ),
        }));
      }

      // Apply to title layer if it overlaps the segment
      if (project.titleLayer) {
        const tl = project.titleLayer;
        if (tl.startTime < seg.endTime && tl.endTime > seg.startTime) {
          const titlePivotKfs: PivotKeyframe[] = pivotKfs
            .filter(kf => {
              const absTime = seg.startTime + kf.time;
              return absTime >= tl.startTime && absTime <= tl.endTime;
            })
            .map(kf => ({
              time: Math.round(Math.max(0, seg.startTime + kf.time - tl.startTime) * 1000) / 1000,
              x: kf.x,
              y: kf.y,
            }));
          if (titlePivotKfs.length > 0) {
            setProject(p => ({
              ...p,
              titleLayer: p.titleLayer ? { ...p.titleLayer, pivotKeyframes: titlePivotKfs } : null,
            }));
          }
        }
      }
    }
  };

  // Strip unchecked channels from keyframes: set to defaults, then remove pure-default keyframes
  const stripUncheckedChannels = (keyframes: ClipKeyframe[], channels: Set<string>): ClipKeyframe[] => {
    console.log('[StripChannels] Active bake channels:', [...channels], '| Input keyframes:', keyframes.length);
    const result = keyframes.map(kf => ({
      ...kf,
      translateX: channels.has('translateX') ? kf.translateX : 0,
      translateY: channels.has('translateY') ? kf.translateY : 0,
      scale: channels.has('scale') ? kf.scale : 1,
      rotation: channels.has('rotation') ? kf.rotation : 0,
      pivotX: channels.has('pivotX') ? (kf.pivotX ?? 50) : 50,
      pivotY: channels.has('pivotY') ? (kf.pivotY ?? 50) : 50,
    })).filter(kf =>
      kf.translateX !== 0 || kf.translateY !== 0 || kf.scale !== 1 || kf.rotation !== 0 ||
      (kf.pivotX !== undefined && kf.pivotX !== 50) || (kf.pivotY !== undefined && kf.pivotY !== 50)
    );
    console.log('[StripChannels] Output keyframes:', result.length, '| Sample:', result[0] ? { tX: result[0].translateX.toFixed(3), tY: result[0].translateY.toFixed(3), s: result[0].scale.toFixed(3), r: result[0].rotation.toFixed(3) } : 'none');
    return result;
  };

  const handleApplyStabilization = (segmentId: string, channels?: Set<string>) => {
    const segment = project.segments.find(s => s.id === segmentId);
    if (!segment?.trackingData || !segment.trackers) return;

    const videoEl = videoRefs.current.get(segmentId);
    const vw = videoEl?.videoWidth || 1920;
    const vh = videoEl?.videoHeight || 1080;

    const stabTrackerIds = segment.trackers.filter(t => t.type === 'stabilizer' && t.isActive).map(t => t.id);
    if (stabTrackerIds.length === 0) return;

    // Step 1: Generate ALL keyframes
    const allKeyframes = generateStabilizationKeyframes(
      segment.trackingData, stabTrackerIds,
      { startTime: segment.startTime, endTime: segment.endTime },
      vw, vh
    );

    // Step 2: Strip unchecked channels and remove pure-default keyframes
    const bake = channels || new Set(['translateX', 'translateY', 'scale', 'rotation']);
    const keyframes = stripUncheckedChannels(allKeyframes, bake);

    if (keyframes.length > 0) {
      handleUpdateKeyframes(segmentId, keyframes);
      handleClearTrackingData(segmentId);
      setTransformTarget(segmentId);
      setActiveBottomTab('graph');
    }
  };

  const handleApplyToSegment = (segmentId: string, trackerId: string, channels?: Set<string>) => {
    const segment = project.segments.find(s => s.id === segmentId);
    if (!segment?.trackingData) return;

    const videoEl = videoRefs.current.get(segmentId);
    const vw = videoEl?.videoWidth || 1920;
    const vh = videoEl?.videoHeight || 1080;

    const allKeyframes = generateFollowKeyframes(
      segment.trackingData, trackerId,
      { startTime: segment.startTime, endTime: segment.endTime },
      vw, vh
    );

    const bake = channels || new Set(['translateX', 'translateY', 'scale', 'rotation']);
    const keyframes = stripUncheckedChannels(allKeyframes, bake);

    if (keyframes.length > 0) {
      handleUpdateKeyframes(segmentId, keyframes);
      handleClearTrackingData(segmentId);
      setTransformTarget(segmentId);
      setActiveBottomTab('graph');
    }
  };

  const handleApplyToTitle = (segmentId: string, trackerId: string, channels?: Set<string>) => {
    const segment = project.segments.find(s => s.id === segmentId);
    if (!segment?.trackingData || !project.titleLayer) return;

    const videoEl = videoRefs.current.get(segmentId);
    const vw = videoEl?.videoWidth || 1920;
    const vh = videoEl?.videoHeight || 1080;

    const allKeyframes = generateFollowKeyframes(
      segment.trackingData, trackerId,
      { startTime: segment.startTime, endTime: segment.endTime },
      vw, vh
    );

    const bake = channels || new Set(['translateX', 'translateY', 'scale', 'rotation']);
    const keyframes = stripUncheckedChannels(allKeyframes, bake);

    if (keyframes.length > 0) {
      handleUpdateTitleLayer({ keyframes });
      handleClearTrackingData(segmentId);
      setTransformTarget('title_layer');
      setActiveBottomTab('graph');
    }
  };

  // Escape key to cancel placement mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (trackingMode === 'placing-stabilizer' || trackingMode === 'placing-parent')) {
        setTrackingMode('reviewing');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [trackingMode]);

  // ============ GIZMO HANDLERS ============

  // Helper: find-or-create keyframe at current time for a given keyframes array
  const upsertKeyframe = (
    keyframes: ClipKeyframe[] | undefined,
    t: number,
    updates: Partial<ClipKeyframe>
  ): ClipKeyframe[] => {
    const kfs = keyframes || [];
    const existingIdx = kfs.findIndex(kf => Math.abs(kf.time - t) < 0.01);
    const baseKf: ClipKeyframe = existingIdx >= 0
      ? kfs[existingIdx]
      : { time: t, translateX: 0, translateY: 0, scale: 1, rotation: 0 };
    // If inserting new keyframe, interpolate current values as base
    if (existingIdx < 0 && kfs.length > 0) {
      const interp = getInterpolatedTransform(kfs, t);
      baseKf.translateX = interp.translateX;
      baseKf.translateY = interp.translateY;
      baseKf.scale = interp.scale;
      baseKf.rotation = interp.rotation;
      baseKf.pivotX = interp.pivotX;
      baseKf.pivotY = interp.pivotY;
    }
    const updatedKf = { ...baseKf, time: t, ...updates };
    if (existingIdx >= 0) {
      return kfs.map((kf, i) => i === existingIdx ? updatedKf : kf);
    }
    return [...kfs, updatedKf].sort((a, b) => a.time - b.time);
  };

  // Determine what the gizmo is targeting and get relevant state
  const getGizmoTarget = (): {
    type: 'clip' | 'subtitle' | 'title' | null;
    segmentId?: string;
    mediaId?: string;
    eventIndex?: number;
  } => {
    // Title selected
    if (transformTarget === 'title_layer' && project.titleLayer) {
      return { type: 'title' };
    }
    // Subtitle selected
    if (transformTarget?.startsWith('subtitle_') && activeSubtitleEvent) {
      const parts = transformTarget.split('_');
      const mediaId = parts[1];
      const index = parseInt(parts[2]);
      return { type: 'subtitle', mediaId, eventIndex: index };
    }
    // Clip selected
    if (primarySelectedSegment && transformTarget !== 'global') {
      return { type: 'clip', segmentId: primarySelectedSegment.id };
    }
    return { type: null };
  };

  // onTranslate receives ABSOLUTE translate values (startTranslate + pixelDelta)
  const handleGizmoTranslate = (newTx: number, newTy: number) => {
    const target = getGizmoTarget();
    if (target.type === 'clip' && target.segmentId) {
      const seg = project.segments.find(s => s.id === target.segmentId);
      if (!seg) return;
      const clipTime = project.currentTime - seg.timelineStart;
      const newKfs = upsertKeyframe(seg.keyframes, clipTime, {
        translateX: newTx,
        translateY: newTy,
      });
      handleUpdateKeyframes(target.segmentId, newKfs, true);
    } else if (target.type === 'title' && project.titleLayer) {
      const t = project.currentTime - project.titleLayer.startTime;
      const newKfs = upsertKeyframe(project.titleLayer.keyframes, t, {
        translateX: newTx,
        translateY: newTy,
      });
      handleUpdateTitleLayer({ keyframes: newKfs });
    } else if (target.type === 'subtitle' && target.mediaId !== undefined && target.eventIndex !== undefined) {
      const media = project.library.find(m => m.id === target.mediaId);
      const evt = media?.analysis?.events[target.eventIndex!];
      if (!evt) return;
      const visualSegs = activeSegments.filter(s => s.type !== 'audio');
      const topSeg = visualSegs.length > 0 ? visualSegs[visualSegs.length - 1] : activeSegments[activeSegments.length - 1];
      const sourceTime = topSeg ? topSeg.startTime + (project.currentTime - topSeg.timelineStart) : 0;
      const subTime = sourceTime - evt.startTime;
      const newKfs = upsertKeyframe(evt.keyframes, subTime, {
        translateX: newTx,
        translateY: newTy,
      });
      handleUpdateDialogue(target.mediaId!, target.eventIndex!, { ...evt, keyframes: newKfs });
    }
  };

  const handleGizmoScale = (newScale: number) => {
    const target = getGizmoTarget();
    if (target.type === 'clip' && target.segmentId) {
      const seg = project.segments.find(s => s.id === target.segmentId);
      if (!seg) return;
      const clipTime = project.currentTime - seg.timelineStart;
      const newKfs = upsertKeyframe(seg.keyframes, clipTime, { scale: newScale });
      handleUpdateKeyframes(target.segmentId, newKfs, true);
    } else if (target.type === 'title' && project.titleLayer) {
      const t = project.currentTime - project.titleLayer.startTime;
      const newKfs = upsertKeyframe(project.titleLayer.keyframes, t, { scale: newScale });
      handleUpdateTitleLayer({ keyframes: newKfs });
    } else if (target.type === 'subtitle' && target.mediaId !== undefined && target.eventIndex !== undefined) {
      const media = project.library.find(m => m.id === target.mediaId);
      const evt = media?.analysis?.events[target.eventIndex!];
      if (!evt) return;
      const visualSegs = activeSegments.filter(s => s.type !== 'audio');
      const topSeg = visualSegs.length > 0 ? visualSegs[visualSegs.length - 1] : activeSegments[activeSegments.length - 1];
      const sourceTime = topSeg ? topSeg.startTime + (project.currentTime - topSeg.timelineStart) : 0;
      const subTime = sourceTime - evt.startTime;
      const newKfs = upsertKeyframe(evt.keyframes, subTime, { scale: newScale });
      handleUpdateDialogue(target.mediaId!, target.eventIndex!, { ...evt, keyframes: newKfs });
    }
  };

  const handleGizmoRotate = (newRotation: number) => {
    const target = getGizmoTarget();
    if (target.type === 'clip' && target.segmentId) {
      const seg = project.segments.find(s => s.id === target.segmentId);
      if (!seg) return;
      const clipTime = project.currentTime - seg.timelineStart;
      const newKfs = upsertKeyframe(seg.keyframes, clipTime, { rotation: newRotation });
      handleUpdateKeyframes(target.segmentId, newKfs, true);
    } else if (target.type === 'title' && project.titleLayer) {
      const t = project.currentTime - project.titleLayer.startTime;
      const newKfs = upsertKeyframe(project.titleLayer.keyframes, t, { rotation: newRotation });
      handleUpdateTitleLayer({ keyframes: newKfs });
    } else if (target.type === 'subtitle' && target.mediaId !== undefined && target.eventIndex !== undefined) {
      const media = project.library.find(m => m.id === target.mediaId);
      const evt = media?.analysis?.events[target.eventIndex!];
      if (!evt) return;
      const visualSegs = activeSegments.filter(s => s.type !== 'audio');
      const topSeg = visualSegs.length > 0 ? visualSegs[visualSegs.length - 1] : activeSegments[activeSegments.length - 1];
      const sourceTime = topSeg ? topSeg.startTime + (project.currentTime - topSeg.timelineStart) : 0;
      const subTime = sourceTime - evt.startTime;
      const newKfs = upsertKeyframe(evt.keyframes, subTime, { rotation: newRotation });
      handleUpdateDialogue(target.mediaId!, target.eventIndex!, { ...evt, keyframes: newKfs });
    }
  };

  const handleGizmoPivotMove = (newPivotX: number, newPivotY: number) => {
    const target = getGizmoTarget();
    if (target.type === 'clip' && target.segmentId) {
      const seg = project.segments.find(s => s.id === target.segmentId);
      if (!seg) return;
      const clipTime = project.currentTime - seg.timelineStart;
      const interp = getInterpolatedTransform(seg.keyframes, clipTime);
      // Compensate translation so element doesn't visually jump
      const comp = compensatePivotChange(
        interp.translateX, interp.translateY, interp.scale, interp.rotation,
        interp.pivotX, interp.pivotY, newPivotX, newPivotY
      );
      const newKfs = upsertKeyframe(seg.keyframes, clipTime, {
        pivotX: newPivotX, pivotY: newPivotY,
        translateX: comp.translateX, translateY: comp.translateY,
      });
      handleUpdateKeyframes(target.segmentId, newKfs, true);
    } else if (target.type === 'title' && project.titleLayer) {
      const t = project.currentTime - project.titleLayer.startTime;
      const interp = getInterpolatedTransform(project.titleLayer.keyframes, t);
      const comp = compensatePivotChange(
        interp.translateX, interp.translateY, interp.scale, interp.rotation,
        interp.pivotX, interp.pivotY, newPivotX, newPivotY
      );
      const newKfs = upsertKeyframe(project.titleLayer.keyframes, t, {
        pivotX: newPivotX, pivotY: newPivotY,
        translateX: comp.translateX, translateY: comp.translateY,
      });
      handleUpdateTitleLayer({ keyframes: newKfs });
    } else if (target.type === 'subtitle' && target.mediaId !== undefined && target.eventIndex !== undefined) {
      const media = project.library.find(m => m.id === target.mediaId);
      const evt = media?.analysis?.events[target.eventIndex!];
      if (!evt) return;
      const visualSegs = activeSegments.filter(s => s.type !== 'audio');
      const topSeg = visualSegs.length > 0 ? visualSegs[visualSegs.length - 1] : activeSegments[activeSegments.length - 1];
      const sourceTime = topSeg ? topSeg.startTime + (project.currentTime - topSeg.timelineStart) : 0;
      const subTime = sourceTime - evt.startTime;
      const interp = getInterpolatedTransform(evt.keyframes, subTime);
      const comp = compensatePivotChange(
        interp.translateX, interp.translateY, interp.scale, interp.rotation,
        interp.pivotX, interp.pivotY, newPivotX, newPivotY
      );
      const newKfs = upsertKeyframe(evt.keyframes, subTime, {
        pivotX: newPivotX, pivotY: newPivotY,
        translateX: comp.translateX, translateY: comp.translateY,
      });
      handleUpdateDialogue(target.mediaId!, target.eventIndex!, { ...evt, keyframes: newKfs });
    }
  };

  const handleGizmoDragStart = () => {
    const target = getGizmoTarget();
    if (target.type === 'clip' && target.segmentId) {
      const seg = project.segments.find(s => s.id === target.segmentId);
      if (seg) pushUndo({ type: 'keyframes', segmentId: target.segmentId, keyframes: seg.keyframes || [] });
    } else if (target.type === 'title' && project.titleLayer) {
      pushUndo({ type: 'keyframes', segmentId: 'title_layer', keyframes: project.titleLayer.keyframes || [] });
    } else if (target.type === 'subtitle' && target.mediaId !== undefined && target.eventIndex !== undefined) {
      const media = project.library.find(m => m.id === target.mediaId);
      const evt = media?.analysis?.events[target.eventIndex!];
      if (evt) pushUndo({ type: 'dialogueEvent', mediaId: target.mediaId!, index: target.eventIndex!, event: { ...evt } });
    }
  };

  const handleGizmoDragEnd = () => {
    // Drag end — undo snapshot was already taken on drag start
  };

  // ============ AUTO-PIVOT TO HEAD ============

  const [autoPivotProgress, setAutoPivotProgress] = useState<{ progress: number; label: string } | null>(null);

  const handleAutoPivotToHead = async (scope: 'selected' | 'all') => {
    const segmentsToProcess = scope === 'all'
      ? project.segments.filter(s => s.type !== 'audio' && s.type !== 'blank')
      : primarySelectedSegment && primarySelectedSegment.type !== 'audio' && primarySelectedSegment.type !== 'blank'
        ? [primarySelectedSegment]
        : [];

    if (segmentsToProcess.length === 0) return;

    // Push a single undo entry that captures all segments (one Ctrl+Z to revert)
    pushUndo({ type: 'segments', segments: [...project.segments] });

    setAutoPivotProgress({ progress: 0, label: 'Starting head detection...' });

    for (let i = 0; i < segmentsToProcess.length; i++) {
      const seg = segmentsToProcess[i];
      const videoEl = videoRefs.current.get(seg.id);
      if (!videoEl) continue;

      const mediaItem = project.library.find(m => m.id === seg.mediaId);
      const videoFile = mediaItem?.file || null;

      const segLabel = segmentsToProcess.length > 1 ? ` (${i + 1}/${segmentsToProcess.length})` : '';

      const result = await headTrackForPivot(
        videoEl,
        { startTime: seg.startTime, endTime: seg.endTime },
        videoFile,
        (p, label) => setAutoPivotProgress({ progress: (i + p) / segmentsToProcess.length, label: label + segLabel }),
      );

      if (result && result.keyframes.length > 0) {
        // Merge pivot keyframes with existing keyframes (preserve transform values)
        const existingKfs = seg.keyframes || [];
        let mergedKfs = [...existingKfs];
        for (const pivotKf of result.keyframes) {
          const existingIdx = mergedKfs.findIndex(kf => Math.abs(kf.time - pivotKf.time) < 0.01);
          if (existingIdx >= 0) {
            // Existing keyframe at this time — just update pivot
            mergedKfs[existingIdx] = { ...mergedKfs[existingIdx], pivotX: pivotKf.pivotX, pivotY: pivotKf.pivotY };
          } else {
            // New time — interpolate existing transform values and add pivot
            const interp = getInterpolatedTransform(existingKfs, pivotKf.time);
            mergedKfs.push({
              time: pivotKf.time,
              translateX: interp.translateX,
              translateY: interp.translateY,
              scale: interp.scale,
              rotation: interp.rotation,
              pivotX: pivotKf.pivotX,
              pivotY: pivotKf.pivotY,
            });
          }
        }
        mergedKfs.sort((a, b) => a.time - b.time);
        handleUpdateKeyframes(seg.id, mergedKfs, true);
      }
    }

    setAutoPivotProgress(null);
    setActiveBottomTab('graph');
  };

  // Clean segment text by removing words at removedWordIndices, and re-index keywords
  const cleanSegmentText = (text: string, removedIndices?: number[], keywords?: KeywordEmphasis[]): { text: string; keywords: KeywordEmphasis[] } => {
    if (!removedIndices || removedIndices.length === 0) return { text, keywords: keywords || [] };
    const words = text.split(/\s+/);
    const removedSet = new Set(removedIndices);
    const kept: string[] = [];
    const indexMap = new Map<number, number>(); // old index -> new index
    for (let i = 0; i < words.length; i++) {
      if (!removedSet.has(i)) {
        indexMap.set(i, kept.length);
        kept.push(words[i]);
      }
    }
    const reindexed = (keywords || [])
      .filter(kw => !removedSet.has(kw.wordIndex))
      .map(kw => ({ ...kw, wordIndex: indexMap.get(kw.wordIndex) ?? kw.wordIndex }));
    return { text: kept.join(' '), keywords: reindexed };
  };

  // Export Short from Content Library to Editor
  const resolveKeywordsForEvent = (eventText: string, shortSegments: { startTime: number; endTime: number; keywords?: KeywordEmphasis[] }[], clipStartTime: number, clipEndTime: number): KeywordEmphasis[] => {
    const eventWords = eventText.split(/\s+/);
    const allKeywords: KeywordEmphasis[] = [];
    for (const seg of shortSegments) {
      if (!seg.keywords || seg.endTime <= clipStartTime || seg.startTime >= clipEndTime) continue;
      for (const kw of seg.keywords) {
        if (!kw.enabled) continue;
        const kwNorm = kw.word.toLowerCase().replace(/[.,!?;:'"()]/g, '');
        const idx = eventWords.findIndex((w, i) =>
          w.toLowerCase().replace(/[.,!?;:'"()]/g, '') === kwNorm &&
          !allKeywords.some(ak => ak.wordIndex === i)
        );
        if (idx >= 0) {
          allKeywords.push({ word: kw.word, wordIndex: idx, enabled: true, color: kw.color });
        }
      }
    }
    return allKeywords;
  };

  const handleExportShort = async (short: GeneratedShort) => {
    console.log('[Export Short] Starting export...', short);
    setStatus(ProcessingStatus.TRANSCRIBING);

    try {
      // 1. Get the source video info from Content Library DB
      const videoRecord = await contentDB.getVideo(short.videoId);
      if (!videoRecord) {
        throw new Error('Source video not found in library');
      }

      // 2. Try local cache first, fall back to YouTube download
      let blob: Blob;
      const videoId = extractYoutubeVideoId(videoRecord.url);
      let usedCache = false;

      if (videoId) {
        try {
          const cacheRes = await fetch(`/api/local-cache?videoId=${videoId}`);
          const cache = await cacheRes.json();
          if (cache.hasVideo) {
            console.log(`[Export Short] Found local cache for ${videoId}. Loading locally...`);
            const localVideoRes = await fetch(`/api/local-video?videoId=${videoId}`);
            if (localVideoRes.ok) {
              blob = await localVideoRes.blob();
              usedCache = true;
              console.log('[Export Short] Loaded from local cache, size:', blob.size);
            }
          }
        } catch (e) {
          console.warn('[Export Short] Local cache check failed, falling back to download:', e);
        }
      }

      if (!usedCache) {
        console.log('[Export Short] Downloading video:', videoRecord.url);
        const downloadRes = await fetch(`/api/download?url=${encodeURIComponent(videoRecord.url)}&_t=${Date.now()}`);

        if (!downloadRes.ok) {
          const errText = await downloadRes.text();
          throw new Error(`Download failed: ${downloadRes.status} ${errText}`);
        }

        blob = await downloadRes.blob();
      }
      console.log('[Export Short] Blob received size:', blob.size);

      const file = new File([blob], `${short.title}.mp4`, { type: 'video/mp4' });
      const videoUrl = URL.createObjectURL(blob);

      // 3. Get video duration
      const video = document.createElement('video');
      video.src = videoUrl;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => resolve(null), 5000);
        video.onloadedmetadata = () => {
          clearTimeout(timeout);
          resolve(null);
        };
        video.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Video format not supported'));
        };
      });
      const duration = video.duration || short.totalDuration || 60;

      // 3.5. Snap clip boundaries to audio silence using directional search
      // Searches BEFORE clip start and AFTER clip end for silence gaps,
      // with 20ms padding to preserve word onset/release phonemes.
      let snappedShortSegments = short.segments;
      try {
        const audioBuffer = await getAudioBuffer(`short_export_${short.id}`, file);
        snappedShortSegments = short.segments.map(seg => {
          const snapped = snapClipBoundaries(audioBuffer, seg.startTime, seg.endTime, 0.4);
          return {
            ...seg,
            startTime: snapped.startTime,
            endTime: snapped.endTime,
          };
        });
        console.log('[Export Short] Snapped clip boundaries to silence (directional)');
      } catch (e) {
        console.warn('[Export Short] Skipping snap-to-silence:', e instanceof Error ? e.message : e);
      }

      // 4. Get granular transcript segments and GROUP them into slides (Karaoke style)
      const allVideoSegments = await contentDB.getSegmentsByVideoId(short.videoId);
      console.log('[ExportShort] VideoId:', short.videoId);
      console.log('[ExportShort] allVideoSegments from DB:', allVideoSegments.length, allVideoSegments.slice(0, 3));
      console.log('[ExportShort] short.segments (clips):', short.segments);

      // Pre-clean segments: apply word removal before processing
      const cleanedSegments = snappedShortSegments.map(seg => {
        const cleaned = cleanSegmentText(seg.text, seg.removedWordIndices, seg.keywords);
        return { ...seg, text: cleaned.text, keywords: cleaned.keywords };
      });

      const analysisEvents: AnalysisEvent[] = [];
      const rawClipEvents: any[] = [];
      const processedSegmentIds = new Set<string>(); // Track processed segments to avoid duplicates

      cleanedSegments.forEach((clipSeg, clipIdx) => {
        console.log(`[ExportShort] Processing clip ${clipIdx}: ${clipSeg.startTime}s - ${clipSeg.endTime}s`);
        // Find all granular segments that overlap this clip
        const clipRaw = allVideoSegments.filter(s => {
          const segEnd = s.start + s.duration;
          const clipEnd = clipSeg.endTime;
          // Overlap check: Segment ends after Clip starts AND Segment starts before Clip ends
          return segEnd > clipSeg.startTime && s.start < clipEnd;
        });
        console.log(`[ExportShort] Clip ${clipIdx} matched ${clipRaw.length} segments`);

        // Keep ORIGINAL source video times - Timeline.tsx handles the time conversion
        const filteredSegments = clipRaw
          .filter(s => {
            // Skip if already processed (avoid duplicates from overlapping clips)
            if (processedSegmentIds.has(s.id)) {
              return false;
            }
            processedSegmentIds.add(s.id);
            return true;
          });

        rawClipEvents.push(...filteredSegments);
      });

      console.log('[ExportShort] rawClipEvents total (de-duplicated):', rawClipEvents.length);

      // Sort by time just in case
      rawClipEvents.sort((a, b) => a.start - b.start);

      // Apply Slide Grouping Logic (Same as Import)
      if (rawClipEvents.length > 0) {
        let buffer: any[] = [rawClipEvents[0]];

        for (let i = 1; i < rawClipEvents.length; i++) {
          const current = rawClipEvents[i];
          const prev = buffer[buffer.length - 1];

          // Check continuity (gap < 0.2s) - slightly looser for shorts
          const isContiguous = (current.start - (prev.start + prev.duration)) < 0.2;

          const bufferDuration = (prev.start + prev.duration) - buffer[0].start;
          const combinedDuration = (current.start + current.duration) - buffer[0].start;
          const wordCount = buffer.length;

          // Merge if:
          // 1. Gap is small
          // 2. AND (Buffer is very short (<0.5s) OR Words < 3)
          // 3. AND Combined duration < 1.5s
          if (isContiguous && (bufferDuration < 0.5 || wordCount < 3) && combinedDuration < 1.5) {
            buffer.push(current);
          } else {
            // Flush buffer
            const start = buffer[0].start;
            const end = buffer[buffer.length - 1].start + buffer[buffer.length - 1].duration;
            const text = buffer.map(e => e.text).join(' ');

            // Collect wordTimings from buffered segments (AssemblyAI data)
            const collectedWordTimings = buffer
              .flatMap(seg => seg.wordTimings || [])
              .filter((wt: any) => wt && wt.text);

            analysisEvents.push({
              type: 'dialogue',
              startTime: start,
              endTime: end,
              label: 'speech',
              details: text,
              wordEmphases: resolveKeywordsForEvent(text, cleanedSegments, start, end),
              ...(collectedWordTimings.length > 0 ? { wordTimings: collectedWordTimings } : {})
            });

            // Start new buffer
            buffer = [current];
          }
        }

        // Flush remaining
        if (buffer.length > 0) {
          const start = buffer[0].start;
          const end = buffer[buffer.length - 1].start + buffer[buffer.length - 1].duration;
          const text = buffer.map(e => e.text).join(' ');

          const collectedWordTimings = buffer
            .flatMap(seg => seg.wordTimings || [])
            .filter((wt: any) => wt && wt.text);

          analysisEvents.push({
            type: 'dialogue',
            startTime: start,
            endTime: end,
            label: 'speech',
            details: text,
            wordEmphases: resolveKeywordsForEvent(text, cleanedSegments, start, end),
            ...(collectedWordTimings.length > 0 ? { wordTimings: collectedWordTimings } : {})
          });
        }
      }

      // Fallback: This usually happens if DB is empty or logic fails
      // Use the short.segments directly with SOURCE VIDEO times
      if (analysisEvents.length === 0) {
        console.log('[ExportShort] Fallback triggered - using cleanedSegments directly');
        cleanedSegments.forEach(seg => {
          analysisEvents.push({
            type: 'dialogue',
            startTime: seg.startTime,
            endTime: seg.endTime,
            label: 'speech',
            details: seg.text,
            wordEmphases: seg.keywords?.filter(k => k.enabled) || []
          });
        });
      }

      console.log('[ExportShort] Final analysisEvents count:', analysisEvents.length, analysisEvents);

      // 5. Create MediaItem
      const newMediaItem: MediaItem = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        url: videoUrl,
        duration: duration,
        name: short.title,
        analysis: {
          summary: `AI Short: ${short.prompt || 'Auto-generated'}`,
          events: analysisEvents,
          generatedAt: new Date()
        }
      };

      // 6. Add to library — persist blob immediately so it survives save+refresh
      if (newMediaItem.file) contentDB.saveMediaBlob(newMediaItem.id, newMediaItem.file).catch(e => console.warn('[MediaBlob] save failed:', e));
      setProject(prev => ({ ...prev, library: [...prev.library, newMediaItem] }));

      // 7. Create timeline segments from the short clips
      // startTime/endTime = position in SOURCE VIDEO (for playback)
      // timelineStart = position on TIMELINE (for display)
      const clipCount = snappedShortSegments.length;
      const FADE_DURATION = 1.0;  // Fade-from/to-black duration
      let timelinePosition = 0;
      const newSegments: Segment[] = snappedShortSegments.map((clipSeg, index) => {
        const clipDuration = clipSeg.endTime - clipSeg.startTime;
        // Apply fade/crossfade transitions between clips
        const transitionIn: Transition | undefined =
          index === 0
            ? { type: 'FADE' as TransitionType, duration: FADE_DURATION, easing: 'easeOut' }       // First clip: fade from black
            : undefined;
        const transitionOut: Transition | undefined =
          index === clipCount - 1
            ? { type: 'FADE' as TransitionType, duration: FADE_DURATION, easing: 'easeIn' }    // Last clip: fade to black
            : undefined;

        // Clips butt up against each other with no overlap

        const segment: Segment = {
          id: Math.random().toString(36).substr(2, 9),
          mediaId: newMediaItem.id,
          // Use ORIGINAL source video times for correct video playback
          startTime: clipSeg.startTime,
          endTime: clipSeg.endTime,
          // Timeline position is where this clip appears in the edit
          timelineStart: timelinePosition,
          track: 0,
          description: `${short.title} - Clip ${index + 1}`,
          color: `hsl(${280 + index * 20}, 60%, 40%)`, // Purple-ish gradient
          transitionIn,
          transitionOut,
        };
        timelinePosition += clipDuration; // Advance to end of this clip
        return segment;
      });

      // 7.6. Import into editor FIRST (user sees clips immediately)
      const titleLayer: TitleLayer = {
        id: Math.random().toString(36).substr(2, 9),
        text: short.hookTitle || short.title,
        startTime: 0,
        endTime: 4,
        fadeInDuration: 0.5,
        fadeOutDuration: 0.5,
        style: INITIAL_TITLE_STYLE,
        keyframes: []
      };

      // 7.6. Set default subtitle animation if none is active
      // "Fade Up" — gentle fade with upward slide, renders well on short-form content
      const defaultSubtitleTemplate = !project.activeSubtitleTemplate ? {
        id: `preset_live_short_${Date.now()}`,
        name: 'Fade Up',
        style: {} as import('react').CSSProperties,
        animation: {
          id: `anim_short_${Date.now()}`,
          name: 'Fade Up Animation',
          duration: 1.5,
          scope: 'line' as const,
          stagger: 0.2,
          effects: [
            { id: 'su1', type: 'opacity' as const, from: 0, to: 1, startAt: 0, endAt: 0.6, easing: 'easeOut' as const },
            { id: 'su2', type: 'translateY' as const, from: 20, to: 0, startAt: 0, endAt: 0.6, easing: 'easeOut' as const },
          ],
        },
      } : null;

      // 7.7. Download and place approved B-roll on V2
      const bRollMediaItems: MediaItem[] = [];
      const bRollSegments: Segment[] = [];
      const approvedBRoll = (short.bRollSuggestions || []).filter(
        s => s.approved && s.pexelsResults && s.pexelsResults.length > 0
      );

      if (approvedBRoll.length > 0) {
        console.log(`[Export Short] Downloading ${approvedBRoll.length} B-roll clips...`);
        for (const broll of approvedBRoll) {
          try {
            const selectedVideo = broll.pexelsResults![(broll.selectedVideoIndex ?? 0)];
            if (!selectedVideo?.videoFileUrl) continue;

            // Download via server proxy
            const dlRes = await fetch(`/api/pexels/download?url=${encodeURIComponent(selectedVideo.videoFileUrl)}`);
            if (!dlRes.ok) { console.warn('[Export Short] B-roll download failed:', dlRes.status); continue; }
            const brollBlob = await dlRes.blob();
            const brollFile = new File([brollBlob], `broll_${broll.searchQuery.replace(/\s+/g, '_')}.mp4`, { type: 'video/mp4' });
            const brollUrl = URL.createObjectURL(brollBlob);

            // Probe duration
            const brollVideo = document.createElement('video');
            brollVideo.src = brollUrl;
            await new Promise(r => { brollVideo.onloadedmetadata = r; setTimeout(r, 3000); });
            const brollDuration = brollVideo.duration && isFinite(brollVideo.duration) ? brollVideo.duration : broll.duration;

            const brollMediaItem: MediaItem = {
              id: Math.random().toString(36).substr(2, 9),
              file: brollFile,
              url: brollUrl,
              duration: brollDuration,
              name: `B-Roll: ${broll.searchQuery}`,
              analysis: null,
            };
            bRollMediaItems.push(brollMediaItem);

            // Calculate timeline position: find V1 segment for this clip index
            const v1Seg = newSegments[broll.clipIndex];
            if (!v1Seg) continue;
            const brollTimelineStart = v1Seg.timelineStart + broll.offsetInClip;
            const brollEndTime = Math.min(broll.duration, brollDuration);

            bRollSegments.push({
              id: Math.random().toString(36).substr(2, 9),
              mediaId: brollMediaItem.id,
              startTime: 0,
              endTime: brollEndTime,
              timelineStart: brollTimelineStart,
              track: 1, // V2 — renders on top of V1
              description: `B-Roll: ${broll.searchQuery}`,
              color: '#0d9488', // teal
              audioLinked: false, // No audio from B-roll
              transitionIn: { type: 'FADE' as TransitionType, duration: 0.3, easing: 'easeOut' },
              transitionOut: { type: 'FADE' as TransitionType, duration: 0.3, easing: 'easeIn' },
            });
            console.log(`[Export Short] B-roll placed: "${broll.searchQuery}" at ${brollTimelineStart.toFixed(1)}s on V2`);
          } catch (e) {
            console.warn(`[Export Short] B-roll "${broll.searchQuery}" failed:`, e);
          }
        }
      }

      setProject(prev => ({
        ...prev,
        library: [...prev.library, ...bRollMediaItems],
        segments: [...prev.segments, ...newSegments, ...bRollSegments],
        titleLayer: titleLayer,
        ...(defaultSubtitleTemplate ? { activeSubtitleTemplate: defaultSubtitleTemplate } : {}),
      }));
      // Use the short's title as the project name so quick-save labels it correctly
      setProjectName(short.title);
      // Persist blobs for all new media items
      [newMediaItem, ...bRollMediaItems].forEach(item => {
        if (item.file) contentDB.saveMediaBlob(item.id, item.file).catch(e => console.warn('[MediaBlob] save failed:', e));
      });

      // Switch to editor view so user sees the imported clips
      setSelectedMediaId(newMediaItem.id);
      setActiveRightTab('transcript');
      setActivePage('editor');
      safeSetTimelineZoom(1);
      console.log('[Export Short] Clips imported into editor.');

      // Auto-center person at start and end of each clip (if enabled)
      if (autoCenterOnImport) {
        setTimeout(async () => {
          for (const seg of newSegments) {
            await autoCenterSegment(seg.id, seg.startTime, seg.endTime, seg.timelineStart);
          }
        }, 0);
      }

      console.log('[Export Short] Export complete!');

    } catch (e) {
      console.error('[Export Short] Error:', e);
      alert(`Export failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
    }
  };

  const handleSplit = async (time: number) => {
    const segmentsToSplit = project.segments.filter(s =>
      time > s.timelineStart && time < (s.timelineStart + (s.endTime - s.startTime))
    );
    if (segmentsToSplit.length === 0) return;

    // Save undo snapshot before modifying segments
    pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });

    // Pre-compute snapped split points
    // Prefer word boundaries (from AssemblyAI wordTimings) ±200ms, fall back to silence ±150ms
    const snappedPoints = new Map<string, number>();
    for (const seg of segmentsToSplit) {
      const rawSplitSource = seg.startTime + (time - seg.timelineStart);
      const media = project.library.find(m => m.id === seg.mediaId);

      // Try word-boundary snap first (when wordTimings available)
      let wordBoundarySnapped = false;
      if (media?.analysis?.events) {
        const allWordTimings = media.analysis.events
          .filter(e => e.type === 'dialogue' && e.wordTimings?.length)
          .flatMap(e => e.wordTimings!);

        if (allWordTimings.length > 1) {
          // Find the nearest gap between consecutive words within ±200ms
          let bestGapTime = rawSplitSource;
          let bestGapDist = 0.2; // max search radius

          for (let i = 0; i < allWordTimings.length - 1; i++) {
            const gapStart = allWordTimings[i].end;
            const gapEnd = allWordTimings[i + 1].start;
            const gapMid = (gapStart + gapEnd) / 2;
            const dist = Math.abs(gapMid - rawSplitSource);

            if (dist < bestGapDist && gapEnd > gapStart) {
              bestGapDist = dist;
              bestGapTime = gapMid;
              wordBoundarySnapped = true;
            }
          }

          if (wordBoundarySnapped) {
            snappedPoints.set(seg.id, bestGapTime);
          }
        }
      }

      // Fall back to silence detection
      if (!wordBoundarySnapped) {
        if (media?.file) {
          try {
            const audioBuf = await getAudioBuffer(seg.mediaId, media.file);
            const result = findNearestSilence(audioBuf, rawSplitSource, 0.15);
            snappedPoints.set(seg.id, result.time);
          } catch {
            snappedPoints.set(seg.id, rawSplitSource);
          }
        } else {
          snappedPoints.set(seg.id, rawSplitSource);
        }
      }
    }

    setProject(prev => {
      let newSegments = [...prev.segments];
      segmentsToSplit.forEach(seg => {
        const splitPointSource = snappedPoints.get(seg.id) ?? (seg.startTime + (time - seg.timelineStart));
        const splitPointTimeline = seg.timelineStart + (splitPointSource - seg.startTime);
        const seg1 = { ...seg, id: Math.random().toString(36).substr(2, 9), endTime: splitPointSource, transitionOut: undefined };
        const seg2 = { ...seg, id: Math.random().toString(36).substr(2, 9), startTime: splitPointSource, timelineStart: splitPointTimeline, transitionIn: undefined };
        newSegments = newSegments.filter(s => s.id !== seg.id);
        newSegments.push(seg1, seg2);
      });
      return { ...prev, segments: newSegments };
    });
  };

  const handleUpdateSegments = (updatedSegments: Segment[]) => {
    setProject(prev => {
      let newSegs = [...prev.segments];
      for (const updated of updatedSegments) {
        newSegs = newSegs.map(s => s.id === updated.id ? updated : s);
      }
      return { ...prev, segments: newSegs };
    });
  };

  const handleUpdateTransition = (segId: string, side: 'in' | 'out', transition: Transition | undefined) => {
    setProject(prev => {
      const segIndex = prev.segments.findIndex(s => s.id === segId);
      if (segIndex === -1) return prev;

      const seg = prev.segments[segIndex];
      const updatedSegments = [...prev.segments];

      updatedSegments[segIndex] = {
        ...seg,
        [side === 'in' ? 'transitionIn' : 'transitionOut']: transition
      };

      return { ...prev, segments: updatedSegments };
    });
  };

  // --- Audio Unlink/Link ---
  const handleUnlinkAudio = (segId: string) => {
    setProject(prev => {
      const segIndex = prev.segments.findIndex(s => s.id === segId);
      if (segIndex === -1) return prev;
      const seg = prev.segments[segIndex];
      if (seg.type === 'audio' || seg.type === 'blank') return prev; // already audio-only or blank
      if (seg.audioLinked === false) return prev; // already unlinked

      const audioSegId = `audio_${seg.id}_${Date.now()}`;
      const audioSeg: Segment = {
        ...seg,
        id: audioSegId,
        type: 'audio',
        audioLinked: false,
        linkedSegmentId: seg.id,
        // Audio segments don't need video-specific data
        trackers: undefined,
        trackingData: undefined,
        // Reset transitions — user can add audio fades separately
        transitionIn: undefined,
        transitionOut: undefined,
        color: '#22c55e', // green for audio
      };

      const updatedSegments = [...prev.segments];
      updatedSegments[segIndex] = {
        ...seg,
        audioLinked: false,
        linkedSegmentId: audioSegId,
      };
      updatedSegments.push(audioSeg);

      return { ...prev, segments: updatedSegments };
    });
  };

  const handleRelinkAudio = (segId: string) => {
    setProject(prev => {
      const seg = prev.segments.find(s => s.id === segId);
      if (!seg) return prev;

      // Find the counterpart
      let videoSeg: Segment | undefined;
      let audioSeg: Segment | undefined;

      if (seg.type === 'audio') {
        audioSeg = seg;
        videoSeg = prev.segments.find(s => s.id === seg.linkedSegmentId);
      } else {
        videoSeg = seg;
        audioSeg = prev.segments.find(s => s.id === seg.linkedSegmentId && s.type === 'audio');
      }

      if (!videoSeg || !audioSeg) return prev;

      // Remove audio segment, restore video segment's audio link
      const updatedSegments = prev.segments
        .filter(s => s.id !== audioSeg!.id)
        .map(s => s.id === videoSeg!.id ? {
          ...s,
          audioLinked: undefined, // back to default (linked)
          linkedSegmentId: undefined,
        } : s);

      return { ...prev, segments: updatedSegments };
    });
  };

  const handleDeleteTrack = (trackId: number) => {
    if (trackId === 0) return;
    pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });
    setProject(prev => {
      // Collect IDs of segments on the deleted track
      const deletedIds = new Set(prev.segments.filter(s => (s.track || 0) === trackId).map(s => s.id));
      // Remove segments on deleted track + orphaned linked segments
      let newSegments = prev.segments.filter(s => {
        if ((s.track || 0) === trackId) return false;
        if (s.linkedSegmentId && deletedIds.has(s.linkedSegmentId)) return false;
        return true;
      });
      // Renumber tracks above the gap to fill it
      newSegments = newSegments.map(s => {
        const t = s.track || 0;
        return t > trackId ? { ...s, track: t - 1 } : s;
      });
      return { ...prev, segments: newSegments };
    });
    setSelectedSegmentIds([]);
  };

  const handleSwapTracks = (trackA: number, trackB: number) => {
    if (trackA === trackB) return;
    // Prevent swapping between audio-only and video tracks
    const aIsAudioOnly = project.segments.some(s => (s.track || 0) === trackA && s.type === 'audio')
      && !project.segments.some(s => (s.track || 0) === trackA && s.type !== 'audio');
    const bIsAudioOnly = project.segments.some(s => (s.track || 0) === trackB && s.type === 'audio')
      && !project.segments.some(s => (s.track || 0) === trackB && s.type !== 'audio');
    if (aIsAudioOnly !== bIsAudioOnly) return; // Don't swap across categories
    pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s => {
        const t = s.track || 0;
        if (t === trackA) return { ...s, track: trackB };
        if (t === trackB) return { ...s, track: trackA };
        return s;
      })
    }));
  };

  const handleSegmentSelect = (seg: Segment, isMulti: boolean) => {
    setSelectedTransition(null);
    setSelectedDialogues([]); // Deselect dialogue
    setIsTitleSelected(false); // Deselect title
    // Don't change right tab — keep whatever the user has open
    if (isMulti) {
      setSelectedSegmentIds(prev => prev.includes(seg.id) ? prev.filter(id => id !== seg.id) : [...prev, seg.id]);
    } else {
      setSelectedSegmentIds([seg.id]);
      // Auto-select clip as transform target in Graph Editor
      setTransformTarget(seg.id);
    }
  };

  const handleTransitionSelect = (segId: string, side: 'in' | 'out', x: number, y: number) => {
    setSelectedSegmentIds([segId]);
    setSelectedDialogues([]); // Deselect dialogue
    setIsTitleSelected(false); // Deselect title
    setSelectedTransition({ segId, side });
    setActiveRightTab('transitions');
    setActiveLeftTab('properties');
  };

  const handleDialogueSelect = (mediaId: string, index: number, isShift?: boolean) => {
    console.log('[App] Dialog Selected:', { mediaId, index, isShift });
    setSelectedSegmentIds([]); // Deselect clips
    setSelectedTransition(null);
    setIsTitleSelected(false); // Deselect title
    if (isShift && selectedDialogues.length > 0 && selectedDialogues[0].mediaId === mediaId) {
      // Add to selection (if not already selected), keep sorted by index
      setSelectedDialogues(prev => {
        if (prev.some(d => d.index === index)) return prev;
        return [...prev, { mediaId, index }].sort((a, b) => a.index - b.index);
      });
    } else {
      setSelectedDialogues([{ mediaId, index }]);
    }
    // Auto-select subtitle as transform target in Graph Editor
    if (activeBottomTab === 'graph') {
      setTransformTarget(`subtitle_${mediaId}_${index}`);
    }
    // (right tab stays on whatever the user has open)
  };

  const handleTitleSelect = (title: TitleLayer) => {
    console.log('[App] Title Selected:', title);
    setSelectedSegmentIds([]);
    setSelectedTransition(null);
    setSelectedDialogues([]);
    setIsTitleSelected(true);
    // (right tab stays on whatever the user has open)
  };

  // Helper to update specific event properties deep in the library structure
  const updateSelectedEvent = (updater: (evt: AnalysisEvent) => AnalysisEvent) => {
    if (!selectedDialogue) return;
    setProject(prev => {
      const newLibrary = prev.library.map(media => {
        if (media.id !== selectedDialogue.mediaId || !media.analysis) return media;
        const newEvents = [...media.analysis.events];
        if (!newEvents[selectedDialogue.index]) return media;

        newEvents[selectedDialogue.index] = updater(newEvents[selectedDialogue.index]);

        return {
          ...media,
          analysis: { ...media.analysis, events: newEvents }
        };
      });
      return { ...prev, library: newLibrary };
    });
  };

  const handleUpdateDialogue = (mediaId: string, index: number, newEvent: AnalysisEvent) => {
    setProject(prev => {
      const newLibrary = prev.library.map(media => {
        if (media.id !== mediaId || !media.analysis) return media;
        const newEvents = [...media.analysis.events];
        if (!newEvents[index]) return media;

        newEvents[index] = newEvent;

        return {
          ...media,
          analysis: { ...media.analysis, events: newEvents }
        };
      });
      return { ...prev, library: newLibrary };
    });
  };

  const handleDeleteDialogue = (mediaId: string, index: number) => {
    setProject(prev => {
      const newLibrary = prev.library.map(media => {
        if (media.id !== mediaId || !media.analysis) return media;
        const newEvents = [...media.analysis.events];
        // Remove the event
        newEvents.splice(index, 1);

        return {
          ...media,
          analysis: { ...media.analysis, events: newEvents }
        };
      });
      return { ...prev, library: newLibrary };
    });
    // Deselect if we deleted the selected one or if selection index invalid
    if (selectedDialogue?.mediaId === mediaId) {
      setSelectedDialogues([]);
    }
  };

  const handleUpdateDialogueText = (newText: string) => {
    if (selectedDialogue) {
      const media = project.library.find(m => m.id === selectedDialogue.mediaId);
      const current = media?.analysis?.events[selectedDialogue.index];
      if (current) {
        pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
      }
    }
    updateSelectedEvent(evt => ({ ...evt, details: newText }));
  };

  const handleAutoWrapDialogue = () => {
    if (!selectedDialogue) return;
    const media = project.library.find(m => m.id === selectedDialogue.mediaId);
    const current = media?.analysis?.events[selectedDialogue.index];
    if (!current || current.type !== 'dialogue') return;

    // Compute max width from safe zone
    const szWidth = safeZoneRef.current?.getBoundingClientRect().width || viewportSize.width || 640;
    const maxWidth = szWidth * 0.9; // 90% to account for padding

    const style = current.styleOverride || project.subtitleStyle;
    const newText = autoWrapDialogueText(
      current.details,
      style.fontSize || 16,
      style.fontFamily || 'Arial',
      maxWidth,
      style.bold,
    );

    if (newText !== current.details) {
      pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
      updateSelectedEvent(evt => ({ ...evt, details: newText }));
    }
  };

  const handleToggleSubtitleKeyword = (wordIndex: number, word: string) => {
    if (!currentTopMedia || !activeSubtitleEvent) return;
    const evtIndex = currentTopMedia.analysis?.events.indexOf(activeSubtitleEvent) ?? -1;
    if (evtIndex < 0) return;

    const existing = activeSubtitleEvent.wordEmphases || [];
    const found = existing.findIndex(k => k.wordIndex === wordIndex);

    let updated: KeywordEmphasis[];
    if (found >= 0) {
      // Toggle: if enabled, disable; if disabled, remove entirely
      if (existing[found].enabled) {
        updated = existing.map((k, i) => i === found ? { ...k, enabled: false } : k);
      } else {
        updated = existing.filter((_, i) => i !== found);
      }
    } else {
      // Add new keyword
      const cleanWord = word.toLowerCase().replace(/[.,!?;:'"()]/g, '');
      updated = [...existing, { word: cleanWord, wordIndex, enabled: true }];
    }

    handleUpdateDialogue(currentTopMedia.id, evtIndex, {
      ...activeSubtitleEvent,
      wordEmphases: updated,
    });
  };

  const handleUpdateKeywordAnimation = (animation: TextAnimation | null) => {
    if (isTemplateUnlinked && selectedDialogue) {
      // Unlinked: update per-event keywordAnimation
      const media = project.library.find(m => m.id === selectedDialogue.mediaId);
      const current = media?.analysis?.events[selectedDialogue.index];
      if (current) {
        pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
        updateSelectedEvent(evt => ({ ...evt, keywordAnimation: animation || undefined }));
      }
    } else {
      // Linked: update global activeKeywordAnimation
      pushUndo({ type: 'keywordAnimation', animation: project.activeKeywordAnimation });
      setProject(p => ({ ...p, activeKeywordAnimation: animation }));
    }
  };

  const handleUpdateSubtitleStyle = (newStyle: Partial<SubtitleStyle>) => {
    // Debounced undo: capture state on first change, reset after 500ms idle
    if (!styleUndoCaptured.current) {
      styleUndoCaptured.current = true;
      if (isSubtitleUnlinked && selectedDialogue) {
        const media = project.library.find(m => m.id === selectedDialogue.mediaId);
        const current = media?.analysis?.events[selectedDialogue.index];
        if (current) {
          pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
        }
      } else {
        pushUndo({ type: 'subtitleStyle', style: { ...project.subtitleStyle } });
      }
    }
    if (styleUndoTimer.current) clearTimeout(styleUndoTimer.current);
    styleUndoTimer.current = setTimeout(() => { styleUndoCaptured.current = false; }, 500);

    if (isSubtitleUnlinked) {
      // Update the override on the specific event
      updateSelectedEvent(evt => ({
        ...evt,
        styleOverride: { ...(evt.styleOverride || project.subtitleStyle), ...newStyle }
      }));
    } else {
      // Update global style
      setProject(prev => ({
        ...prev,
        subtitleStyle: { ...prev.subtitleStyle, ...newStyle }
      }));
    }
  };

  const handleUpdateTitleLayer = (updates: Partial<TitleLayer>) => {
    if (!project.titleLayer) return;
    setProject(prev => {
      if (!prev.titleLayer) return prev;
      const updated = { ...prev, titleLayer: { ...prev.titleLayer, ...updates } };
      // Auto-seek to title start when animation changes so user sees it
      if ('animation' in updates && prev.titleLayer) {
        updated.currentTime = Math.max(0, prev.titleLayer.startTime - 0.1);
        updated.isPlaying = false;
      }
      return updated;
    });
  };

  const handleToggleSubtitleUnlink = () => {
    if (!selectedDialogue) return;
    const media = project.library.find(m => m.id === selectedDialogue.mediaId);
    const current = media?.analysis?.events[selectedDialogue.index];
    if (current) {
      pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
    }

    if (isSubtitleUnlinked) {
      // Revert to Global (Remove Override)
      updateSelectedEvent(evt => {
        const { styleOverride, ...rest } = evt;
        return rest;
      });
    } else {
      // Unlink (Create Override by copying global)
      updateSelectedEvent(evt => ({
        ...evt,
        styleOverride: { ...project.subtitleStyle }
      }));
    }
  };

  const handleToggleTemplateUnlink = () => {
    if (!selectedDialogue) return;
    const media = project.library.find(m => m.id === selectedDialogue.mediaId);
    const current = media?.analysis?.events[selectedDialogue.index];
    if (current) {
      pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
    }

    if (isTemplateUnlinked) {
      // Revert to Global (Remove Override)
      updateSelectedEvent(evt => {
        const { templateOverride, ...rest } = evt;
        return rest;
      });
    } else {
      // Unlink (Create Override by copying global template)
      if (project.activeSubtitleTemplate) {
        updateSelectedEvent(evt => ({
          ...evt,
          templateOverride: { ...project.activeSubtitleTemplate! }
        }));
      }
    }
  };

  const handleUpdateSubtitleTemplate = (template: SubtitleTemplate) => {
    if (isTemplateUnlinked) {
      // Push undo for per-event template change
      if (selectedDialogue) {
        const media = project.library.find(m => m.id === selectedDialogue.mediaId);
        const current = media?.analysis?.events[selectedDialogue.index];
        if (current) {
          pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
        }
      }
      // Update only the override on this specific event
      updateSelectedEvent(evt => ({
        ...evt,
        templateOverride: template
      }));
    } else {
      // Push undo for global template change
      pushUndo({ type: 'subtitleTemplate', template: project.activeSubtitleTemplate });
      // Update global template
      setProject(p => ({ ...p, activeSubtitleTemplate: template }));
    }

    // Auto-seek to subtitle start so user can see the animation play
    const seekTarget = getAnimationSeekTarget();
    if (seekTarget !== null) {
      setProject(p => ({ ...p, currentTime: seekTarget, isPlaying: false }));
    }
  };

  /** Find the best time to seek to so the user can preview a subtitle animation */
  const getAnimationSeekTarget = (): number | null => {
    // If a specific subtitle is selected, seek to its start
    if (selectedDialogueEvent) {
      const topSeg = activeSegments[activeSegments.length - 1];
      if (topSeg) {
        // Convert source time back to timeline time
        const timelineTime = topSeg.timelineStart + (selectedDialogueEvent.startTime - topSeg.startTime);
        return Math.max(0, timelineTime - 0.1); // Slight offset so animation starts fresh
      }
    }
    // If there's an active subtitle on screen, seek to its start
    if (activeSubtitleEvent) {
      const topSeg = activeSegments[activeSegments.length - 1];
      if (topSeg) {
        const timelineTime = topSeg.timelineStart + (activeSubtitleEvent.startTime - topSeg.startTime);
        return Math.max(0, timelineTime - 0.1);
      }
    }
    // If there are any subtitle events at all, seek to the first one
    const firstMedia = project.library.find(m => m.analysis?.events.some(e => e.type === 'dialogue'));
    if (firstMedia?.analysis) {
      const firstDialogue = firstMedia.analysis.events.find(e => e.type === 'dialogue');
      if (firstDialogue) {
        const seg = project.segments.find(s => s.mediaId === firstMedia.id);
        if (seg) {
          const timelineTime = seg.timelineStart + (firstDialogue.startTime - seg.startTime);
          return Math.max(0, timelineTime - 0.1);
        }
      }
    }
    return null;
  };

  const handleMergeDialogues = () => {
    if (selectedDialogues.length < 2) return;
    const mediaId = selectedDialogues[0].mediaId;
    if (!selectedDialogues.every(d => d.mediaId === mediaId)) return;

    const media = project.library.find(m => m.id === mediaId);
    if (!media?.analysis) return;

    const indices = selectedDialogues.map(d => d.index).sort((a, b) => a - b);
    const events = indices.map(i => media.analysis!.events[i]);

    // Push full events array for undo
    pushUndo({ type: 'dialogueEvents', mediaId, events: [...media.analysis.events] });

    const merged: AnalysisEvent = {
      startTime: events[0].startTime,
      endTime: events[events.length - 1].endTime,
      type: 'dialogue',
      label: events[0].label,
      details: events.map(e => e.details).join(' '),
      styleOverride: events[0].styleOverride,
      templateOverride: events[0].templateOverride,
      translateX: events[0].translateX,
      translateY: events[0].translateY,
    };

    const newEvents = [...media.analysis.events];
    newEvents[indices[0]] = merged;
    // Remove remaining merged events in reverse order
    for (let i = indices.length - 1; i > 0; i--) {
      newEvents.splice(indices[i], 1);
    }

    setProject(prev => ({
      ...prev,
      library: prev.library.map(m =>
        m.id === mediaId && m.analysis
          ? { ...m, analysis: { ...m.analysis, events: newEvents } }
          : m
      )
    }));
    setSelectedDialogues([{ mediaId, index: indices[0] }]);
  };

  const performDelete = (idsToDelete: string[], ripple: boolean) => {
    // Save undo snapshot before deleting
    const segmentsExist = project.segments.some(s => idsToDelete.includes(s.id));
    if (segmentsExist) {
      pushUndo({ type: 'segments', segments: project.segments.map(s => ({ ...s })) });
    }

    setProject(prev => {
      const segmentsToDelete = prev.segments.filter(s => idsToDelete.includes(s.id));
      if (segmentsToDelete.length === 0) return prev;
      segmentsToDelete.sort((a, b) => b.timelineStart - a.timelineStart);

      let newSegments = [...prev.segments];
      const deletedIdSet = new Set(segmentsToDelete.map(s => s.id));
      segmentsToDelete.forEach(seg => {
        const deletedDuration = seg.endTime - seg.startTime;
        const deletedStart = seg.timelineStart;
        const deletedTrack = seg.track || 0;
        newSegments = newSegments.filter(s => s.id !== seg.id);
        if (ripple) {
          newSegments = newSegments.map(s => {
            if (s.timelineStart > deletedStart + 0.001 && (s.track || 0) === deletedTrack) {
              return { ...s, timelineStart: s.timelineStart - deletedDuration };
            }
            return s;
          });
        }
      });
      // Clean up orphaned audio links: if the deleted segment was the unlinked
      // audio counterpart, keep the video muted (audioLinked: false) but clear
      // linkedSegmentId so the A1 lane filter can hide the ghost reference.
      newSegments = newSegments.map(s => {
        if (s.linkedSegmentId && deletedIdSet.has(s.linkedSegmentId) && s.type !== 'audio') {
          return { ...s, linkedSegmentId: undefined };
        }
        return s;
      });
      return { ...prev, segments: newSegments };
    });
    setSelectedSegmentIds([]);
    setSelectedTransition(null);
  };

  // --- Actions ---
  const handlePlayPause = () => {
    if (project.currentTime >= contentDuration && contentDuration > 0) {
      setProject(p => ({ ...p, currentTime: 0, isPlaying: true }));
      return;
    }
    setProject(p => ({ ...p, isPlaying: !p.isPlaying }));
  };

  const jumpFrame = (frames: number) => setProject(p => ({ ...p, isPlaying: false, currentTime: Math.max(0, p.currentTime + (frames / 30)) }));

  const jumpClip = (direction: 'next' | 'prev') => {
    setProject(p => {
      const points = new Set<number>([0, contentDuration]);
      p.segments.forEach(s => { points.add(s.timelineStart); points.add(s.timelineStart + (s.endTime - s.startTime)); });
      const sorted = Array.from(points).sort((a, b) => a - b);
      let target = direction === 'next' ? sorted.find(t => t > p.currentTime + 0.01) : [...sorted].reverse().find(t => t < p.currentTime - 0.01);
      return { ...p, isPlaying: false, currentTime: target ?? (direction === 'next' ? contentDuration : 0) };
    });
  };

  const handleDeepAnalyze = async (mediaId: string, customPrompt: string = "") => {
    const media = project.library.find(m => m.id === mediaId);
    if (!media) return;
    setStatus(ProcessingStatus.DEEP_ANALYZING);
    const hasDialogue = media.analysis?.events.some(e => e.type === 'dialogue');

    // If we already have dialogue (e.g. from YouTube), ask if we should skip audio analysis
    let skipAudio = false;
    if (hasDialogue) {
      // Simple heuristic: If it has > 5 dialogue events, it's likely a full transcript
      const count = media.analysis!.events.filter(e => e.type === 'dialogue').length;
      if (count > 5) {
        // In a real app we'd ask the user. For now, we assume we want to KEEP the good transcript.
        skipAudio = true;
      }
    }

    try {
      const analysis = await performDeepAnalysis(media.file, media.duration, customPrompt, media.analysis, { skipAudio });
      // Auto-wrap dialogue for portrait aspect ratio
      if (viewportSettings.previewAspectRatio === '9:16') {
        const szWidth = safeZoneRef.current?.getBoundingClientRect().width || 200;
        const maxWidth = szWidth * 0.9;
        const style = project.subtitleStyle;
        if (analysis && analysis.events) {
          for (const event of analysis.events) {
            if (event.type === 'dialogue') {
              event.details = autoWrapDialogueText(
                event.details,
                style.fontSize || 16,
                style.fontFamily || 'Arial',
                maxWidth,
                style.bold,
              );
            }
          }
        }
      }
      setProject(prev => ({
        ...prev,
        library: prev.library.map(m => m.id === mediaId ? { ...m, analysis } : m)
      }));
    } catch (e) {
      console.error(e);
      alert("Deep analysis failed. Please try again.");
    } finally {
      setStatus(ProcessingStatus.IDLE);
    }
  };

  const handleVibeEdit = async () => {
    const activeMedia = project.library.find(m => m.id === selectedMediaId) || currentTopMedia;
    if (!activeMedia || !editPrompt) return;
    setStatus(ProcessingStatus.EDITING);
    try {
      const newSegs = await generateVibeEdit(activeMedia.file, editPrompt, activeMedia.duration, activeMedia.analysis);
      let cursor = 0;
      const mappedSegs = newSegs.map(s => {
        const seg = { ...s, mediaId: activeMedia.id, timelineStart: cursor, track: 0 };
        cursor += (s.endTime - s.startTime);
        return seg;
      });
      setProject(prev => ({ ...prev, segments: mappedSegs, currentTime: 0 }));
    } catch (e) { console.error(e); } finally { setStatus(ProcessingStatus.IDLE); }
  };

  const autoCenterSegment = async (segmentId: string, startTime: number, endTime: number, timelineStart?: number) => {
    autoCenteringRef.current = true;
    setStatus(ProcessingStatus.CENTERING);
    setCenteringProgress('Waiting for video to load...');

    try {
      // Move playhead to this segment so its <video> element gets rendered
      if (timelineStart !== undefined) {
        setProject(prev => ({ ...prev, currentTime: timelineStart + 0.01 }));
        await new Promise(r => setTimeout(r, 50)); // Let React render
      }

      // Wait for the video element to appear and load (React render + video decode)
      let videoEl: HTMLVideoElement | null = null;
      const MAX_WAIT = 10000;
      const POLL = 100;
      let waited = 0;

      while (waited < MAX_WAIT) {
        videoEl = videoRefs.current.get(segmentId) || null;
        if (videoEl && videoEl.readyState >= 2) break;
        await new Promise(r => setTimeout(r, POLL));
        waited += POLL;
      }

      if (!videoEl || videoEl.readyState < 2) {
        console.warn('[AutoCenter] Video not ready after timeout, skipping');
        return;
      }

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      if (vw === 0 || vh === 0) return;

      const clipDuration = endTime - startTime;
      const MARGIN = 0.1;
      const keyframes: ClipKeyframe[] = [];

      // Center at start
      setCenteringProgress('Analyzing start of clip...');
      const startBlob = await seekAndCaptureFrame(videoEl, startTime + MARGIN);
      if (startBlob) {
        const det = await detectPersonPosition(startBlob);
        if (det.personVisible && det.confidence >= 30) {
          const t = computeCenterTranslation(det, vw, vh, viewportSettings.previewAspectRatio);
          keyframes.push({ time: MARGIN, translateX: t.translateX, translateY: t.translateY, scale: 1, rotation: 0 });
        }
      }

      // Center at end
      if (clipDuration > 0.5) {
        setCenteringProgress('Analyzing end of clip...');
        const endBlob = await seekAndCaptureFrame(videoEl, endTime - MARGIN);
        if (endBlob) {
          const det = await detectPersonPosition(endBlob);
          if (det.personVisible && det.confidence >= 30) {
            const t = computeCenterTranslation(det, vw, vh, viewportSettings.previewAspectRatio);
            keyframes.push({ time: clipDuration - MARGIN, translateX: t.translateX, translateY: t.translateY, scale: 1, rotation: 0 });
          }
        }
      }

      if (keyframes.length > 0) {
        handleUpdateKeyframes(segmentId, keyframes, true);
        setTransformTarget(segmentId);
        setCenteringProgress(`Done! (${keyframes.length} keyframe${keyframes.length > 1 ? 's' : ''} created)`);
      } else {
        setCenteringProgress('No person detected');
      }

      // Seek back to clip start
      videoEl.currentTime = startTime;
    } catch (e) {
      console.error('[AutoCenter] Error:', e);
    } finally {
      autoCenteringRef.current = false;
      await new Promise(r => setTimeout(r, 800));
      setStatus(ProcessingStatus.IDLE);
      setCenteringProgress('');
    }
  };

  const handleCenterPerson = async () => {
    const currentTime = project.currentTime;
    const activeSegment = project.segments.find(seg =>
      currentTime >= seg.timelineStart &&
      currentTime < seg.timelineStart + (seg.endTime - seg.startTime)
    );

    if (!activeSegment) {
      alert('No clip under the playhead. Move the playhead to a clip first.');
      return;
    }

    setStatus(ProcessingStatus.CENTERING);
    setCenteringProgress('Capturing frame...');

    try {
      const videoEl = videoRefs.current.get(activeSegment.id);
      if (!videoEl || videoEl.readyState < 2) {
        alert('Video not ready. Please wait for the clip to load.');
        setStatus(ProcessingStatus.IDLE);
        setCenteringProgress('');
        return;
      }

      const clipTime = currentTime - activeSegment.timelineStart;
      const frameBlob = await seekAndCaptureFrame(videoEl, activeSegment.startTime + clipTime);
      if (!frameBlob) throw new Error('Frame capture failed');

      setCenteringProgress('Analyzing person position...');
      const detection = await detectPersonPosition(frameBlob);

      if (!detection.personVisible || detection.confidence < 30) {
        alert(`No person detected (confidence: ${detection.confidence}%). Try a different frame.`);
        setStatus(ProcessingStatus.IDLE);
        setCenteringProgress('');
        return;
      }

      const translation = computeCenterTranslation(
        detection, videoEl.videoWidth, videoEl.videoHeight, viewportSettings.previewAspectRatio
      );

      // Insert/update keyframe at the CURRENT clip time
      const existing = activeSegment.keyframes ? [...activeSegment.keyframes] : [];
      const undoKeyframes = [...existing];
      const KF_SNAP = 0.05;
      const existingIdx = existing.findIndex(kf => Math.abs(kf.time - clipTime) < KF_SNAP);

      if (existingIdx >= 0) {
        existing[existingIdx] = { ...existing[existingIdx], time: clipTime, ...translation };
      } else {
        existing.push({ time: clipTime, ...translation, scale: 1, rotation: 0 });
        existing.sort((a, b) => a.time - b.time);
      }

      handleUpdateKeyframes(activeSegment.id, existing, true);
      pushUndo({ type: 'keyframes', segmentId: activeSegment.id, keyframes: undoKeyframes });
      setCenteringProgress('Done!');
    } catch (e) {
      console.error('[CenterPerson] Error:', e);
      alert(`Center Person failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
      setCenteringProgress('');
    }
  };

  // ── Gaussian smoothing for scan-generated keyframes ──────────────
  const smoothScannedKeyframes = (kfs: ClipKeyframe[], amount: number): ClipKeyframe[] => {
    const n = kfs.length;
    if (n < 3 || amount === 0) return kfs;
    const maxRadius = Math.max(2, Math.floor(n / 3));
    const radius = Math.max(1, Math.round((amount / 100) * maxRadius));
    const sigma = radius / 2.0;
    return kfs.map((kf, i) => {
      let wSum = 0, wTotal = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
        const w = Math.exp(-(Math.abs(i - j) ** 2) / (2 * sigma * sigma));
        wSum += kfs[j].translateX * w;
        wTotal += w;
      }
      return { ...kf, translateX: wTotal > 0 ? wSum / wTotal : kf.translateX };
    });
  };

  // ── Scan & Center (template-based, zero tokens) ──────────────────

  /**
   * Scan a single clip through all frames using template matching (no AI, no tokens).
   * Generates keyframes when the person is more than `outOfZoneThreshold` percent
   * away from center (0 = always follow, 28 = only at the 9:16 zone boundary).
   */
  const scanAndCenterClip = async (segmentId: string) => {
    const seg = project.segments.find(s => s.id === segmentId);
    if (!seg) return;

    setStatus(ProcessingStatus.SCANNING);
    setScanProgress('Waiting for video...');

    try {
      // Move playhead to clip so its <video> element gets rendered
      setProject(prev => ({ ...prev, currentTime: seg.timelineStart + 0.01 }));
      await new Promise(r => setTimeout(r, 80));

      let videoEl: HTMLVideoElement | null = null;
      const MAX_WAIT = 10000;
      const POLL = 100;
      let waited = 0;
      while (waited < MAX_WAIT) {
        videoEl = videoRefs.current.get(segmentId) || null;
        if (videoEl && videoEl.readyState >= 2) break;
        await new Promise(r => setTimeout(r, POLL));
        waited += POLL;
      }

      if (!videoEl || videoEl.readyState < 2) {
        alert('Video not ready. Please wait for the clip to load.');
        return;
      }

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      const segment: TrackingSegment = { startTime: seg.startTime, endTime: seg.endTime };

      // Get the File object from the media library for Python tracker upload
      const mediaItem = project.library.find(m => m.id === seg.mediaId);
      const videoFile = mediaItem?.file || null;

      // --- Try Python-enhanced full pipeline first (no API key needed) ---
      setScanMethod('python');
      setScanProgress('Trying Python tracker (MediaPipe + OpenCV)...');
      const pythonResult = await fullScanAndCenter(
        videoEl,
        segment,
        outOfZoneThreshold,
        videoFile,
        (progress, label) => setScanProgress(`${label} (${Math.round(progress * 100)}%)`)
      );

      let keyframes: ClipKeyframe[] = [];
      let triggerCount = 0;
      let frameCount = 0;
      let method = 'browser';

      if (pythonResult && pythonResult.keyframes.length > 0) {
        // Python tracker handled detection + tracking in one shot
        keyframes = pythonResult.keyframes;
        triggerCount = pythonResult.triggerCount;
        frameCount = pythonResult.frameCount;
        method = pythonResult.method;
        console.log(`[ScanCenter] Python tracker: ${keyframes.length} keyframes, ${triggerCount} triggers, method=${method}`);
      } else {
        // Fall back to browser-based auto-detect tracking (no API key needed)
        setScanMethod('browser');
        setScanProgress('Detecting person (browser)...');
        console.log('[ScanCenter] Python tracker unavailable, falling back to browser auto-detect');

        // Detect person using skin-tone + motion analysis (no API key)
        const detection = await detectPersonInFrame(videoEl, seg.startTime);
        const personPixelX = detection ? detection.x : vw / 2;
        const personPixelY = detection ? detection.y : vh * 0.4;
        console.log(`[ScanCenter] Browser person detect: (${personPixelX.toFixed(0)}, ${personPixelY.toFixed(0)}) ${detection ? `conf=${detection.confidence.toFixed(0)}%` : '(center fallback)'}`);

        setScanProgress('Tracking person (browser canvas)...');
        const browserResult = await scanAndGenerateThresholdKeyframes(
          videoEl, segment, personPixelX, personPixelY, outOfZoneThreshold,
          (progress, label) => setScanProgress(`${label} (${Math.round(progress * 100)}%)`)
        );
        keyframes = browserResult.keyframes;
        triggerCount = browserResult.triggerCount;
        frameCount = browserResult.frameCount;
        method = 'browser-autodetect';
      }

      if (keyframes.length === 0) {
        alert('Scan complete — no trackable positions found. Try a different clip.');
        return;
      }

      const methodLabel = method.includes('mediapipe') || method.includes('python') || method.includes('optical_flow')
        ? 'Python (MediaPipe + OpenCV)'
        : 'Browser (Canvas)';
      const finalKeyframes = scanSmooth ? smoothScannedKeyframes(keyframes, scanSmoothAmount) : keyframes;
      handleUpdateKeyframes(segmentId, finalKeyframes, true);
      setTransformTarget(segmentId);
      const smoothNote = scanSmooth ? `\n• Smoothed at ${scanSmoothAmount}%` : '';
      const msg = `Scan complete!\n\n• Engine: ${methodLabel}\n• ${finalKeyframes.length} keyframes added\n• ${triggerCount} centering event${triggerCount !== 1 ? 's' : ''}\n• ${frameCount} frames scanned${smoothNote}\n\nCheck the clip's keyframe track on the timeline.`;
      setScanProgress(`Done — ${keyframes.length} keyframes, ${triggerCount} centering events`);
      alert(msg);
    } catch (e) {
      console.error('[ScanCenter] Error:', e);
      alert(`Scan & Center failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
      setScanProgress('');
      setScanMethod('');
    }
  };

  /**
   * Scan all clips on the timeline sequentially.
   */
  const scanAndCenterAllClips = async () => {
    const videoSegs = project.segments.filter(s => s.type === 'video' || !s.type);
    if (videoSegs.length === 0) return;

    setStatus(ProcessingStatus.SCANNING);
    for (let i = 0; i < videoSegs.length; i++) {
      setScanProgress(`Scanning clip ${i + 1}/${videoSegs.length}...`);
      const seg = videoSegs[i];

      // Bring video into view
      setProject(prev => ({ ...prev, currentTime: seg.timelineStart + 0.01 }));
      await new Promise(r => setTimeout(r, 100));

      let videoEl: HTMLVideoElement | null = null;
      let waited = 0;
      while (waited < 10000) {
        videoEl = videoRefs.current.get(seg.id) || null;
        if (videoEl && videoEl.readyState >= 2) break;
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
      }
      if (!videoEl || videoEl.readyState < 2) continue;

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      const segment: TrackingSegment = { startTime: seg.startTime, endTime: seg.endTime };
      const mediaItem = project.library.find(m => m.id === seg.mediaId);
      const videoFile = mediaItem?.file || null;
      try {
        // Try Python-enhanced full pipeline first (no API key needed)
        setScanMethod('python');
        setScanProgress(`Clip ${i + 1}/${videoSegs.length}: trying Python tracker...`);
        const pythonResult = await fullScanAndCenter(
          videoEl, segment, outOfZoneThreshold, videoFile,
          (progress, label) => setScanProgress(`Clip ${i + 1}/${videoSegs.length}: ${label}`)
        );

        let keyframes: ClipKeyframe[] = [];
        let triggerCount = 0;
        let method = 'browser';

        if (pythonResult && pythonResult.keyframes.length > 0) {
          keyframes = pythonResult.keyframes;
          triggerCount = pythonResult.triggerCount;
          method = pythonResult.method;
        } else {
          // Fall back to browser-based auto-detect tracking (no API key needed)
          setScanMethod('browser');
          setScanProgress(`Clip ${i + 1}/${videoSegs.length}: detecting person (browser)...`);
          console.log(`[ScanAll] Clip ${i + 1}: Python tracker unavailable, falling back to browser auto-detect`);

          // Detect person using skin-tone + motion analysis (no API key)
          const detection = await detectPersonInFrame(videoEl, seg.startTime);
          const personPixelX = detection ? detection.x : vw / 2;
          const personPixelY = detection ? detection.y : vh * 0.4;

          setScanProgress(`Clip ${i + 1}/${videoSegs.length}: tracking (browser canvas)...`);
          const browserResult = await scanAndGenerateThresholdKeyframes(
            videoEl, segment, personPixelX, personPixelY, outOfZoneThreshold,
            (progress, label) => setScanProgress(`Clip ${i + 1}/${videoSegs.length}: ${label}`)
          );
          keyframes = browserResult.keyframes;
          triggerCount = browserResult.triggerCount;
          method = 'browser-autodetect';
        }

        if (keyframes.length > 0) {
          const finalKfs = scanSmooth ? smoothScannedKeyframes(keyframes, scanSmoothAmount) : keyframes;
          handleUpdateKeyframes(seg.id, finalKfs, true);
        }
        console.log(`[ScanAll] Clip ${i + 1}: ${triggerCount} centering events, ${keyframes.length} keyframes (${method})${scanSmooth ? ` (smoothed ${scanSmoothAmount}%)` : ''}`);
      } catch (e) {
        console.error(`[ScanAll] Clip ${i + 1} failed:`, e);
      }
    }

    setScanProgress(`All ${videoSegs.length} clips scanned`);
    await new Promise(r => setTimeout(r, 1500));
    setStatus(ProcessingStatus.IDLE);
    setScanProgress('');
    setScanMethod('');
  };

  // ── Filler Word Removal ──────────────────────────────────────────

  /** Merge overlapping filler ranges so removeSourceRange doesn't double-cut */
  const mergeOverlappingFillers = (fillers: FillerDetectionWithMedia[]): FillerDetectionWithMedia[] => {
    const sorted = [...fillers].sort((a, b) => a.startTime - b.startTime);
    const merged: FillerDetectionWithMedia[] = [];
    for (const f of sorted) {
      const last = merged[merged.length - 1];
      if (last && last.mediaId === f.mediaId && f.startTime <= last.endTime) {
        last.endTime = Math.max(last.endTime, f.endTime);
        last.text += ' + ' + f.text;
      } else {
        merged.push({ ...f });
      }
    }
    return merged;
  };

  /** Filter and re-zero keyframes to a sub-range of the original clip */
  const filterKeyframesForRange = (
    keyframes: ClipKeyframe[] | undefined,
    newStartInClip: number,
    newEndInClip: number
  ): ClipKeyframe[] | undefined => {
    if (!keyframes || keyframes.length === 0) return undefined;
    const filtered = keyframes
      .filter(kf => kf.time >= newStartInClip && kf.time <= newEndInClip)
      .map(kf => ({ ...kf, time: kf.time - newStartInClip }));
    return filtered.length > 0 ? filtered : undefined;
  };

  /**
   * Remove a source-time range from all segments of a given media.
   * Handles: filler at start, end, middle (split), or covering entire segment.
   */
  const removeSourceRange = (
    segments: Segment[],
    mediaId: string,
    fillerStart: number,
    fillerEnd: number
  ): Segment[] => {
    const result: Segment[] = [];
    const MIN_DURATION = 0.05; // ~1.5 frames at 30fps

    for (const seg of segments) {
      if (seg.mediaId !== mediaId) {
        result.push(seg);
        continue;
      }

      const overlapStart = Math.max(seg.startTime, fillerStart);
      const overlapEnd = Math.min(seg.endTime, fillerEnd);

      if (overlapStart >= overlapEnd) {
        // No overlap with this segment
        result.push(seg);
        continue;
      }

      // Filler covers entire segment → remove it
      if (fillerStart <= seg.startTime && fillerEnd >= seg.endTime) {
        continue;
      }

      // Filler at the START of segment
      if (fillerStart <= seg.startTime && fillerEnd < seg.endTime) {
        const newDur = seg.endTime - fillerEnd;
        if (newDur < MIN_DURATION) continue;
        result.push({
          ...seg,
          id: Math.random().toString(36).substr(2, 9),
          startTime: fillerEnd,
          // Update timelineStart to the old timeline position of fillerEnd so rippleCloseGaps
          // can correctly remap B-roll positions after silence removal
          timelineStart: seg.timelineStart + (fillerEnd - seg.startTime),
          keyframes: filterKeyframesForRange(seg.keyframes, fillerEnd - seg.startTime, seg.endTime - seg.startTime),
          trackingData: undefined,
        });
        continue;
      }

      // Filler at the END of segment
      if (fillerStart > seg.startTime && fillerEnd >= seg.endTime) {
        const newDur = fillerStart - seg.startTime;
        if (newDur < MIN_DURATION) continue;
        result.push({
          ...seg,
          id: Math.random().toString(36).substr(2, 9),
          endTime: fillerStart,
          keyframes: filterKeyframesForRange(seg.keyframes, 0, fillerStart - seg.startTime),
          trackingData: undefined,
        });
        continue;
      }

      // Filler in the MIDDLE → split into two
      const dur1 = fillerStart - seg.startTime;
      const dur2 = seg.endTime - fillerEnd;

      if (dur1 >= MIN_DURATION) {
        result.push({
          ...seg,
          id: Math.random().toString(36).substr(2, 9),
          endTime: fillerStart,
          transitionOut: undefined,
          keyframes: filterKeyframesForRange(seg.keyframes, 0, fillerStart - seg.startTime),
          trackingData: undefined,
        });
      }
      if (dur2 >= MIN_DURATION) {
        result.push({
          ...seg,
          id: Math.random().toString(36).substr(2, 9),
          startTime: fillerEnd,
          // Update timelineStart to old timeline position of fillerEnd so rippleCloseGaps
          // builds correct v1Map for B-roll repositioning
          timelineStart: seg.timelineStart + (fillerEnd - seg.startTime),
          transitionIn: undefined,
          keyframes: filterKeyframesForRange(seg.keyframes, fillerEnd - seg.startTime, seg.endTime - seg.startTime),
          trackingData: undefined,
        });
      }
    }

    return result;
  };

  /**
   * After remove-silence / filler-clean splits a tracked segment into pieces,
   * ensure transform keyframe continuity across consecutive same-media segments
   * on the same track. Without this, the subject jumps at every cut point because
   * each piece's keyframes are independent and the subject may have moved during
   * the removed section.
   */
  const ensureKeyframeContinuity = (segments: Segment[]): Segment[] => {
    // Group segment indices by track
    const byTrack = new Map<number, number[]>();
    segments.forEach((seg, i) => {
      const track = seg.track ?? 0;
      if (!byTrack.has(track)) byTrack.set(track, []);
      byTrack.get(track)!.push(i);
    });

    const result = segments.map(s => ({ ...s }));

    for (const [, indices] of byTrack) {
      // Sort by timeline position
      const sorted = [...indices].sort((a, b) => segments[a].timelineStart - segments[b].timelineStart);

      for (let i = 1; i < sorted.length; i++) {
        const prevIdx = sorted[i - 1];
        const currIdx = sorted[i];
        const prevSeg = result[prevIdx];
        const currSeg = result[currIdx];

        // Only bridge same-media segments where both have keyframes
        if (prevSeg.mediaId !== currSeg.mediaId) continue;
        if (!prevSeg.keyframes?.length || !currSeg.keyframes?.length) continue;

        // End transform of previous segment (already includes any earlier offsets)
        const prevDuration = prevSeg.endTime - prevSeg.startTime;
        const prevEnd = getInterpolatedTransform(prevSeg.keyframes, prevDuration);

        // Start transform of current segment (not yet offset)
        const currStart = getInterpolatedTransform(currSeg.keyframes, 0);

        const dX = prevEnd.translateX - currStart.translateX;
        const dY = prevEnd.translateY - currStart.translateY;
        const dS = prevEnd.scale - currStart.scale;
        const dR = prevEnd.rotation - currStart.rotation;

        if (Math.abs(dX) < 0.001 && Math.abs(dY) < 0.001 && Math.abs(dS) < 0.001 && Math.abs(dR) < 0.001) continue;

        result[currIdx] = {
          ...currSeg,
          keyframes: currSeg.keyframes.map(kf => ({
            ...kf,
            translateX: kf.translateX + dX,
            translateY: kf.translateY + dY,
            scale: kf.scale + dS,
            rotation: kf.rotation + dR,
          }))
        };
      }
    }

    return result;
  };

  /** Pack segments sequentially per track with no gaps.
   * B-roll overlay segments (track > 0, audioLinked === false, non-audio) are excluded
   * from pack-from-zero and instead repositioned to stay aligned with V1 content. */
  const rippleCloseGaps = (segments: Segment[]): Segment[] => {
    // Identify B-roll: unlinked video overlays on V2+ tracks
    const isBRoll = (s: Segment) => s.track > 0 && s.audioLinked === false && s.type !== 'audio';
    const bRollSegs = segments.filter(isBRoll);
    const regularSegs = segments.filter(s => !isBRoll(s));

    const tracks = new Map<number, Segment[]>();
    for (const seg of regularSegs) {
      const list = tracks.get(seg.track) || [];
      list.push(seg);
      tracks.set(seg.track, list);
    }

    const result: Segment[] = [];

    // Ripple-close V1 (track 0) first and record the position mapping
    const v1Sorted = (tracks.get(0) || []).sort((a, b) => a.timelineStart - b.timelineStart);
    let v1Cursor = 0;
    const v1Map: Array<{ oldStart: number; oldEnd: number; newStart: number }> = [];
    for (const seg of v1Sorted) {
      const dur = seg.endTime - seg.startTime;
      v1Map.push({ oldStart: seg.timelineStart, oldEnd: seg.timelineStart + dur, newStart: v1Cursor });
      result.push({ ...seg, timelineStart: v1Cursor });
      v1Cursor += dur;
    }

    // Ripple-close all other regular tracks (linked audio, etc.)
    for (const [track, trackSegs] of tracks) {
      if (track === 0) continue;
      const sorted = [...trackSegs].sort((a, b) => a.timelineStart - b.timelineStart);
      let cursor = 0;
      for (const seg of sorted) {
        const dur = seg.endTime - seg.startTime;
        result.push({ ...seg, timelineStart: cursor });
        cursor += dur;
      }
    }

    // Reposition B-roll by mapping through V1's position changes
    for (const broll of bRollSegs) {
      let newPos = broll.timelineStart;
      if (v1Map.length > 0) {
        // Find the last V1 segment whose oldStart <= broll position, map proportionally
        for (const entry of v1Map) {
          if (entry.oldStart <= broll.timelineStart) {
            const offset = Math.min(broll.timelineStart - entry.oldStart, entry.oldEnd - entry.oldStart);
            newPos = entry.newStart + offset;
          }
        }
      }
      result.push({ ...broll, timelineStart: newPos });
    }

    return result;
  };

  /** Remove or trim subtitle events that overlap filler regions */
  const updateSubtitleEvents = (
    library: MediaItem[],
    mediaId: string,
    fillers: FillerDetectionWithMedia[]
  ): MediaItem[] => {
    return library.map(media => {
      if (media.id !== mediaId || !media.analysis) return media;

      const sorted = [...fillers].sort((a, b) => a.startTime - b.startTime);

      let events = media.analysis.events.filter(evt => {
        if (evt.type !== 'dialogue') return true;
        // Remove events entirely contained within a filler
        return !sorted.some(f => f.startTime <= evt.startTime && f.endTime >= evt.endTime);
      });

      events = events.map(evt => {
        if (evt.type !== 'dialogue') return evt;

        let { startTime, endTime } = evt;
        let modified = false;

        for (const filler of sorted) {
          // Filler overlaps start of event
          if (filler.startTime <= startTime && filler.endTime > startTime && filler.endTime < endTime) {
            startTime = filler.endTime;
            modified = true;
          }
          // Filler overlaps end of event
          if (filler.startTime > startTime && filler.startTime < endTime && filler.endTime >= endTime) {
            endTime = filler.startTime;
            modified = true;
          }
          // Filler entirely within event → shrink duration
          if (filler.startTime > startTime && filler.endTime < endTime) {
            endTime -= (filler.endTime - filler.startTime);
            modified = true;
          }
        }

        if (!modified) return evt;
        if (endTime <= startTime) return null; // collapsed to nothing
        return { ...evt, startTime, endTime };
      }).filter(Boolean) as AnalysisEvent[];

      return { ...media, analysis: { ...media.analysis, events } };
    });
  };

  /** Save filler detections to MediaItem cache in the library */
  const cacheFillerDetections = (mediaId: string, detections: FillerDetection[]) => {
    setProject(prev => ({
      ...prev,
      library: prev.library.map(m =>
        m.id === mediaId ? { ...m, fillerDetections: detections.map(d => ({ startTime: d.startTime, endTime: d.endTime, text: d.text, type: d.type })) } : m
      )
    }));
  };

  /** Step 1: Detect fillers via AI (uses cache if available), then show confirmation modal */
  const handleCleanFillers = async () => {
    const mediaIdsOnTimeline = [...new Set(project.segments.map(s => s.mediaId))];
    const mediaItems = mediaIdsOnTimeline
      .map(id => project.library.find(m => m.id === id))
      .filter(Boolean) as MediaItem[];

    if (mediaItems.length === 0) return;

    setStatus(ProcessingStatus.CLEANING_FILLERS);
    setFillerProgress('Starting...');

    try {
      const allDetections: FillerDetectionWithMedia[] = [];

      for (let i = 0; i < mediaItems.length; i++) {
        const media = mediaItems[i];
        const prefix = mediaItems.length > 1 ? `[${i + 1}/${mediaItems.length}] ` : '';

        // Check cache first
        if (media.fillerDetections && media.fillerDetections.length > 0) {
          setFillerProgress(`${prefix}Loaded ${media.fillerDetections.length} cached fillers for "${media.name}"`);
          for (const d of media.fillerDetections) {
            allDetections.push({ ...d, mediaId: media.id, mediaName: media.name });
          }
          continue;
        }

        // Prefer transcript-based detection (~35x cheaper than video upload)
        const dialogueEvents = media.analysis?.events?.filter(e => e.type === 'dialogue') || [];
        let detections: FillerDetection[];

        if (dialogueEvents.length > 0) {
          setFillerProgress(`${prefix}Analyzing transcript for "${media.name}"...`);
          detections = await detectFillersFromTranscript(
            dialogueEvents.map(e => ({ startTime: e.startTime, endTime: e.endTime, text: e.details, wordTimings: e.wordTimings })),
            (msg) => setFillerProgress(`${prefix}${msg}`)
          );
        } else {
          // No transcript available — fall back to video upload
          setFillerProgress(`${prefix}Uploading "${media.name}" (no transcript)...`);
          detections = await detectFillerWords(media.file, media.duration, (msg) => {
            setFillerProgress(`${prefix}${msg}`);
          });
        }

        // Cache results on the MediaItem
        cacheFillerDetections(media.id, detections);

        setFillerProgress(`${prefix}Found ${detections.length} fillers`);
        for (const d of detections) {
          allDetections.push({ ...d, mediaId: media.id, mediaName: media.name });
        }
      }

      if (allDetections.length === 0) {
        alert('No filler words detected in any clip.');
        return;
      }

      setFillerDetections(allDetections);
      setShowFillerModal(true);
    } catch (e) {
      console.error('[CleanFillers] Detection failed:', e);
      alert(`Filler detection failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
      setFillerProgress('');
    }
  };

  /** Re-detect: run a second-pass AI analysis looking for missed fillers (prefers transcript) */
  const handleRedetectFillers = async () => {
    setShowFillerModal(false);

    const mediaIdsOnTimeline = [...new Set(project.segments.map(s => s.mediaId))];
    const mediaItems = mediaIdsOnTimeline
      .map(id => project.library.find(m => m.id === id))
      .filter(Boolean) as MediaItem[];

    if (mediaItems.length === 0) return;

    setStatus(ProcessingStatus.CLEANING_FILLERS);
    setFillerProgress('Re-analyzing for missed fillers...');

    try {
      const allDetections: FillerDetectionWithMedia[] = [];

      for (let i = 0; i < mediaItems.length; i++) {
        const media = mediaItems[i];
        const prefix = mediaItems.length > 1 ? `[${i + 1}/${mediaItems.length}] ` : '';
        const existing = media.fillerDetections || [];

        setFillerProgress(`${prefix}Re-analyzing "${media.name}"...`);

        // Prefer transcript-based re-detection (~35x cheaper than video upload)
        const dialogueEvents = media.analysis?.events?.filter(e => e.type === 'dialogue') || [];
        let newDetections: FillerDetection[];

        if (dialogueEvents.length > 0) {
          newDetections = await redetectFillersFromTranscript(
            dialogueEvents.map(e => ({ startTime: e.startTime, endTime: e.endTime, text: e.details, wordTimings: e.wordTimings })),
            existing,
            (msg) => setFillerProgress(`${prefix}${msg}`)
          );
        } else {
          // No transcript — fall back to video upload re-detection
          newDetections = await redetectFillerWords(media.file, media.duration, existing, (msg) => {
            setFillerProgress(`${prefix}${msg}`);
          });
        }

        // Merge with existing and update cache
        const merged = [...existing, ...newDetections].sort((a, b) => a.startTime - b.startTime);
        cacheFillerDetections(media.id, merged);

        setFillerProgress(`${prefix}Found ${newDetections.length} additional fillers`);
        for (const d of merged) {
          allDetections.push({ ...d, mediaId: media.id, mediaName: media.name });
        }
      }

      if (allDetections.length === 0) {
        alert('No filler words detected (including re-analysis).');
        return;
      }

      setFillerDetections(allDetections);
      setShowFillerModal(true);
    } catch (e) {
      console.error('[RedetectFillers] Failed:', e);
      alert(`Re-detection failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
      setFillerProgress('');
    }
  };

  /** Step 2: Apply filler removal after user confirms in modal */
  const handleConfirmFillerClean = async (selectedFillers: FillerDetectionWithMedia[]) => {
    setShowFillerModal(false);
    setFillerDetections([]);

    if (selectedFillers.length === 0) return;

    // Save undo snapshot
    pushUndo({
      type: 'fillerClean',
      segments: project.segments.map(s => ({ ...s })),
      library: project.library.map(m => ({
        ...m,
        analysis: m.analysis ? { ...m.analysis, events: m.analysis.events.map(e => ({ ...e })) } : null
      }))
    });

    // Merge overlapping fillers per media
    const merged = mergeOverlappingFillers(selectedFillers);

    // Group by mediaId
    const fillersByMedia = new Map<string, FillerDetectionWithMedia[]>();
    for (const f of merged) {
      const list = fillersByMedia.get(f.mediaId) || [];
      list.push(f);
      fillersByMedia.set(f.mediaId, list);
    }

    // Pre-decode audio buffers for snap-to-silence
    const audioBuffers = new Map<string, AudioBuffer>();
    for (const [mediaId] of fillersByMedia) {
      const media = project.library.find(m => m.id === mediaId);
      if (media?.file) {
        try {
          audioBuffers.set(mediaId, await getAudioBuffer(mediaId, media.file));
        } catch (e) {
          console.warn(`[SnapToSilence] Failed to decode audio for ${mediaId}:`, e);
        }
      }
    }

    setProject(prev => {
      let newSegments = [...prev.segments];

      // Process each media's fillers (descending so indices stay stable)
      for (const [mediaId, fillers] of fillersByMedia) {
        const audioBuf = audioBuffers.get(mediaId);
        // Collect all wordTimings from this media's events for precise boundary lookup
        const media = prev.library.find(m => m.id === mediaId);
        const allWordTimings = media?.analysis?.events
          ?.filter(e => e.type === 'dialogue' && e.wordTimings?.length)
          .flatMap(e => e.wordTimings!) || [];

        // Sort word timings by start time for gap-based snapping
        const sortedWordTimings = [...allWordTimings].sort((a, b) => a.start - b.start);

        const sortedDesc = [...fillers].sort((a, b) => b.startTime - a.startTime);
        for (const filler of sortedDesc) {
          let start = filler.startTime;
          let end = filler.endTime;

          if (sortedWordTimings.length > 1) {
            // === Word-gap precision (same approach as handleSplit) ===
            // Find words that fall within the filler's time range
            const matchingWords = sortedWordTimings.filter(w =>
              w.start >= start - 0.05 && w.end <= end + 0.05
            );

            if (matchingWords.length > 0) {
              // For repeated words ("the the"), use word timings to find the exact duplicate
              // instead of naive midpoint — keep the first occurrence, remove from second onward
              let fillerWords = matchingWords;
              if (filler.type === 'repeated' && matchingWords.length >= 2) {
                // Keep first half of matched words, remove second half
                const halfIdx = Math.ceil(matchingWords.length / 2);
                fillerWords = matchingWords.slice(halfIdx);
              }

              const firstFillerWord = fillerWords[0];
              const lastFillerWord = fillerWords[fillerWords.length - 1];

              // Find the gap BEFORE the first filler word (between previous word and filler)
              const prevWordIdx = sortedWordTimings.findIndex(w => w === firstFillerWord) - 1;
              if (prevWordIdx >= 0) {
                const gapStart = sortedWordTimings[prevWordIdx].end;
                const gapEnd = firstFillerWord.start;
                // Snap to midpoint of the gap (lands in silence between words)
                start = gapEnd > gapStart ? (gapStart + gapEnd) / 2 : firstFillerWord.start;
              } else {
                start = firstFillerWord.start;
              }

              // Find the gap AFTER the last filler word (between filler and next word)
              const nextWordIdx = sortedWordTimings.findIndex(w => w === lastFillerWord) + 1;
              if (nextWordIdx < sortedWordTimings.length) {
                const gapStart = lastFillerWord.end;
                const gapEnd = sortedWordTimings[nextWordIdx].start;
                // Snap to midpoint of the gap (lands in silence between words)
                end = gapEnd > gapStart ? (gapStart + gapEnd) / 2 : lastFillerWord.end;
              } else {
                end = lastFillerWord.end;
              }
            } else {
              // No matching words found — fall back to repeated-word midpoint heuristic
              if (filler.type === 'repeated') {
                start = (start + end) / 2;
              }
              // Fall back to audio silence snap
              if (audioBuf) {
                const snapped = snapFillerRange(audioBuf, start, end);
                start = snapped.startTime;
                end = snapped.endTime;
              }
            }
          } else {
            // No word timings available — use legacy approach
            if (filler.type === 'repeated') {
              start = (start + end) / 2;
            }
            // Snap cut points to silence boundaries for clean audio edges
            if (audioBuf) {
              const snapped = snapFillerRange(audioBuf, start, end);
              start = snapped.startTime;
              end = snapped.endTime;
            }
          }

          newSegments = removeSourceRange(newSegments, mediaId, start, end);
        }
      }

      // Ripple-close all gaps
      newSegments = rippleCloseGaps(newSegments);
      // Bridge tracking keyframe gaps so subject doesn't jump at cut points
      newSegments = ensureKeyframeContinuity(newSegments);

      // Update subtitle events
      let newLibrary = [...prev.library];
      for (const [mediaId, fillers] of fillersByMedia) {
        newLibrary = updateSubtitleEvents(newLibrary, mediaId, fillers);
      }

      return { ...prev, segments: newSegments, library: newLibrary, currentTime: 0 };
    });

    setSelectedSegmentIds([]);
    setSelectedDialogues([]);
  };

  const [removingSilences, setRemovingSilences] = useState(false);
  const [silenceThreshold, setSilenceThreshold] = useState(0.3);
  const [showSilencePanel, setShowSilencePanel] = useState(false);
  const silenceButtonRef = useRef<HTMLButtonElement>(null);

  const handleRemoveSilences = async (selectedOnly?: boolean) => {
    if (project.segments.length === 0 || removingSilences) return;
    setRemovingSilences(true);
    setShowSilencePanel(false);

    try {
      // Use selected segments if requested and any are selected, otherwise all segments
      const targetSegments = selectedOnly && selectedSegmentIds.length > 0
        ? project.segments.filter(s => selectedSegmentIds.includes(s.id))
        : project.segments;

      // Collect unique mediaIds from target segments
      const mediaIds = [...new Set(targetSegments.map(s => s.mediaId))];

      // Decode audio for each media (try full-res, fall back to low-res for large files)
      const audioBuffers = new Map<string, AudioBuffer>();
      for (const mediaId of mediaIds) {
        const media = project.library.find(m => m.id === mediaId);
        if (!media) continue;
        try {
          let file = media.file;
          // After project reload, File objects are lost — reconstruct from blob URL
          if (!file && media.url) {
            const resp = await fetch(media.url);
            const blob = await resp.blob();
            file = new File([blob], media.name || 'media', { type: blob.type });
          }
          if (file) {
            try {
              audioBuffers.set(mediaId, await getAudioBuffer(mediaId, file));
            } catch {
              // Full-res failed (likely file too large) — use low-res 8kHz decode
              audioBuffers.set(mediaId, await getAudioBufferLowRes(mediaId, file));
            }
          }
        } catch (e) {
          console.warn(`[RemoveSilences] Failed to decode audio for ${mediaId}:`, e);
        }
      }

      if (audioBuffers.size === 0) {
        alert('No audio could be decoded from the timeline clips.');
        return;
      }

      // Find silence gaps for each media
      const gapsByMedia = new Map<string, Array<{ start: number; end: number }>>();
      let totalGaps = 0;
      let totalDuration = 0;

      for (const [mediaId, audioBuf] of audioBuffers) {
        // Only scan within the source ranges actually used by target segments
        const mediaSegments = targetSegments.filter(s => s.mediaId === mediaId);
        const gaps = findSilenceGaps(audioBuf, silenceThreshold, 20);

        // Filter gaps to only those that fall within target segment source ranges
        const relevantGaps = gaps.filter(gap =>
          mediaSegments.some(seg =>
            gap.start < seg.endTime && gap.end > seg.startTime
          )
        );

        if (relevantGaps.length > 0) {
          gapsByMedia.set(mediaId, relevantGaps);
          totalGaps += relevantGaps.length;
          totalDuration += relevantGaps.reduce((sum, g) => sum + (g.end - g.start), 0);
        }
      }

      if (totalGaps === 0) {
        alert(`No silence gaps found (>${(silenceThreshold * 1000).toFixed(0)}ms).`);
        return;
      }

      // Push undo snapshot
      pushUndo({
        type: 'segments',
        segments: project.segments.map(s => ({ ...s })),
      });

      setProject(prev => {
        let newSegments = [...prev.segments];

        // Process each media's gaps in descending time order
        for (const [mediaId, gaps] of gapsByMedia) {
          const sortedDesc = [...gaps].sort((a, b) => b.start - a.start);
          for (const gap of sortedDesc) {
            newSegments = removeSourceRange(newSegments, mediaId, gap.start, gap.end);
          }
        }

        // Ripple-close all gaps on the timeline
        newSegments = rippleCloseGaps(newSegments);
        // Bridge tracking keyframe gaps so subject doesn't jump at cut points
        newSegments = ensureKeyframeContinuity(newSegments);

        // Update subtitle events that overlap removed silence regions
        let newLibrary = [...prev.library];
        for (const [mediaId, gaps] of gapsByMedia) {
          const asFillers = gaps.map(g => ({ startTime: g.start, endTime: g.end, mediaId, text: '', type: 'filler' as const }));
          newLibrary = updateSubtitleEvents(newLibrary, mediaId, asFillers);
        }

        return { ...prev, segments: newSegments, library: newLibrary, currentTime: 0 };
      });

      setSelectedSegmentIds([]);
      setSelectedDialogues([]);

      console.log(`[RemoveSilences] Removed ${totalGaps} silence gaps (${totalDuration.toFixed(1)}s total)`);
    } finally {
      setRemovingSilences(false);
    }
  };

  const handleRemoveTranscriptWords = async (words: RemovedWord[]) => {
    if (words.length === 0) return;

    pushUndo({
      type: 'transcriptEdit',
      segments: project.segments.map(s => ({ ...s })),
      removedWords: project.removedWords ? [...project.removedWords] : [],
      library: project.library.map(m => ({
        ...m,
        analysis: m.analysis ? { ...m.analysis, events: m.analysis.events.map(e => ({ ...e })) } : null
      }))
    });

    // Pre-decode audio buffers for snap-to-silence
    const mediaIdsToProcess = [...new Set(words.map(w => w.mediaId))];
    const audioBuffers = new Map<string, AudioBuffer>();
    for (const mediaId of mediaIdsToProcess) {
      const media = project.library.find(m => m.id === mediaId);
      if (media?.file) {
        try {
          audioBuffers.set(mediaId, await getAudioBuffer(mediaId, media.file));
        } catch (e) {
          console.warn(`[SnapToSilence] Failed to decode audio for ${mediaId}:`, e);
        }
      }
    }

    setProject(prev => {
      let newSegments = [...prev.segments];

      // Remove overlapping segments backwards
      const sortedWords = [...words].sort((a, b) => b.startTime - a.startTime);
      for (const word of sortedWords) {
        let start = word.startTime;
        let end = word.endTime;

        const audioBuf = audioBuffers.get(word.mediaId);
        if (audioBuf) {
          const snapped = snapFillerRange(audioBuf, start, end);
          start = snapped.startTime;
          end = snapped.endTime;
        }

        newSegments = removeSourceRange(newSegments, word.mediaId, start, end);
      }

      newSegments = rippleCloseGaps(newSegments);
      // Bridge tracking keyframe gaps so subject doesn't jump at cut points
      newSegments = ensureKeyframeContinuity(newSegments);

      // Create fake 'filler' detections out of these words to update the subtitle events
      let newLibrary = [...prev.library];
      const itemsByMedia = new Map<string, FillerDetectionWithMedia[]>();
      for (const word of sortedWords) {
        const list = itemsByMedia.get(word.mediaId) || [];
        const mediaName = prev.library.find(m => m.id === word.mediaId)?.name || '';
        list.push({
          startTime: word.startTime,
          endTime: word.endTime,
          text: word.text,
          type: 'filler',
          mediaId: word.mediaId,
          mediaName
        });
        itemsByMedia.set(word.mediaId, list);
      }

      for (const [mediaId, fillers] of itemsByMedia) {
        newLibrary = updateSubtitleEvents(newLibrary, mediaId, fillers);
      }

      return {
        ...prev,
        segments: newSegments,
        library: newLibrary,
        removedWords: [...(prev.removedWords || []), ...words]
      };
    });
  };

  const handleRestoreTranscriptWord = (wordId: string) => {
    const word = project.removedWords?.find(w => w.id === wordId);
    if (!word) return;

    pushUndo({
      type: 'transcriptRestore',
      segments: project.segments.map(s => ({ ...s })),
      removedWords: project.removedWords ? [...project.removedWords] : [],
      library: project.library.map(m => ({
        ...m,
        analysis: m.analysis ? { ...m.analysis, events: m.analysis.events.map(e => ({ ...e })) } : null
      }))
    });

    setProject(prev => {
      const newSeg: Segment = {
        id: Math.random().toString(36).substr(2, 9),
        mediaId: word.mediaId,
        startTime: word.startTime,
        endTime: word.endTime,
        timelineStart: prev.currentTime,
        track: 0,
        description: `Restored: ${word.text}`,
        color: '#8b5cf6'
      };

      let newSegments = [...prev.segments, newSeg];
      newSegments.sort((a, b) => a.timelineStart - b.timelineStart);
      newSegments = rippleCloseGaps(newSegments);

      return {
        ...prev,
        segments: newSegments,
        removedWords: prev.removedWords.filter(w => w.id !== wordId)
      };
    });
  };

  const handleChat = async (text: string) => {
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      text,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMsg]);
    setIsChatLoading(true);

    try {
      const historyForModel = messages.map(m => ({
        role: m.role === 'model' ? 'model' : 'user',
        parts: [{ text: m.text }]
      }));

      const activeMedia = project.library.find(m => m.id === selectedMediaId) || currentTopMedia;

      const responseText = await chatWithVideoContext(historyForModel, text, activeMedia?.file || null);

      const modelMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        text: responseText,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, modelMsg]);

    } catch (e) {
      console.error("Chat error", e);
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        text: "Sorry, I encountered an error. Please try again.",
        timestamp: new Date()
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // Helper to build text-shadow CSS from style effects
  // Returns main effects for the text element plus separate blend-mode layers
  const buildTextEffects = (s: SubtitleStyle | TitleStyle) => {
    // Build individual effect strings
    const textDropShadow = (s.textShadowBlur && s.textShadowBlur > 0 || s.textShadowOffsetX || s.textShadowOffsetY)
      ? `${s.textShadowOffsetX || 0}px ${s.textShadowOffsetY || 0}px ${s.textShadowBlur || 0}px ${s.textShadowColor || '#000000'}`
      : null;

    const textGlow = (s.glowBlur && s.glowBlur > 0)
      ? `0 0 ${s.glowBlur}px ${s.glowColor || '#00ff00'}, 0 0 ${s.glowBlur * 1.5}px ${s.glowColor || '#00ff00'}`
      : null;

    const backdropDropShadow = (s.backdropShadowBlur && s.backdropShadowBlur > 0 || s.backdropShadowOffsetX || s.backdropShadowOffsetY)
      ? `${s.backdropShadowOffsetX || 0}px ${s.backdropShadowOffsetY || 0}px ${s.backdropShadowBlur || 0}px ${s.backdropShadowColor || '#000000'}`
      : null;

    const backdropGlow = (s.backdropGlowBlur && s.backdropGlowBlur > 0)
      ? `0 0 ${s.backdropGlowBlur}px ${s.backdropGlowColor || '#00ff00'}, 0 0 ${s.backdropGlowBlur * 1.5}px ${s.backdropGlowColor || '#00ff00'}`
      : null;

    const innerGlowShadow = (s.innerGlowBlur && s.innerGlowBlur > 0)
      ? `inset 0 0 ${s.innerGlowBlur}px ${s.innerGlowColor || '#ffffff'}`
      : null;

    // Text gradient — pass as CSS variable so AnimatedText applies it to child spans only
    let gradientProps: Record<string, any> = {};
    if (s.gradientType && s.gradientType !== 'none') {
      const stops = resolveGradientStops(s);
      if (stops) {
        gradientProps = {
          '--text-gradient': buildGradientCSS(s.gradientType as 'linear' | 'radial', stops, s.gradientAngle),
        };
      }
    }

    // Text outline/stroke
    let strokeProps: React.CSSProperties = {};
    if (s.outlineWidth && s.outlineWidth > 0) {
      strokeProps = {
        WebkitTextStrokeWidth: `${s.outlineWidth}px`,
        WebkitTextStrokeColor: s.outlineColor || '#000000',
      } as React.CSSProperties;
    }

    // Split effects: normal blend → main element, non-normal blend → separate layers
    const mainTextShadows: string[] = [];
    const mainBoxShadows: string[] = [];
    const layers: Array<{
      type: 'text-shadow' | 'box-shadow';
      value: string;
      blendMode: string;
    }> = [];

    if (textDropShadow) {
      if (s.shadowBlendMode && s.shadowBlendMode !== 'normal') {
        layers.push({ type: 'text-shadow', value: textDropShadow, blendMode: s.shadowBlendMode });
      } else {
        mainTextShadows.push(textDropShadow);
      }
    }

    if (textGlow) {
      if (s.glowBlendMode && s.glowBlendMode !== 'normal') {
        layers.push({ type: 'text-shadow', value: textGlow, blendMode: s.glowBlendMode });
      } else {
        mainTextShadows.push(textGlow);
      }
    }

    if (backdropDropShadow) {
      if (s.backdropShadowBlendMode && s.backdropShadowBlendMode !== 'normal') {
        layers.push({ type: 'box-shadow', value: backdropDropShadow, blendMode: s.backdropShadowBlendMode });
      } else {
        mainBoxShadows.push(backdropDropShadow);
      }
    }

    if (backdropGlow) {
      if (s.backdropGlowBlendMode && s.backdropGlowBlendMode !== 'normal') {
        layers.push({ type: 'box-shadow', value: backdropGlow, blendMode: s.backdropGlowBlendMode });
      } else {
        mainBoxShadows.push(backdropGlow);
      }
    }

    if (innerGlowShadow) {
      if (s.innerGlowBlendMode && s.innerGlowBlendMode !== 'normal') {
        layers.push({ type: 'box-shadow', value: innerGlowShadow, blendMode: s.innerGlowBlendMode });
      } else {
        mainBoxShadows.push(innerGlowShadow);
      }
    }

    return {
      textShadow: mainTextShadows.length > 0 ? mainTextShadows.join(', ') : undefined,
      boxShadow: mainBoxShadows.length > 0 ? mainBoxShadows.join(', ') : undefined,
      ...gradientProps,
      ...strokeProps,
      layers,
    };
  };

  // Helper to generate dynamic styles for subtitle
  const getSubtitleStyles = (s: SubtitleStyle | undefined) => {
    if (!s) return { container: {} as React.CSSProperties, text: {} as React.CSSProperties, blendLayers: [] as React.CSSProperties[] };

    const base: React.CSSProperties = {
      position: 'absolute',
      bottom: `${s.bottomOffset}%`,
      left: 0,
      right: 0,
      textAlign: s.textAlign,
      pointerEvents: 'none',
      zIndex: 9999,
      display: 'flex',
      justifyContent: s.textAlign === 'left' ? 'flex-start' : s.textAlign === 'right' ? 'flex-end' : 'center',
      paddingLeft: '5%',
      paddingRight: '5%',
      isolation: 'isolate' as any,
    };

    const effects = buildTextEffects(s);
    const { layers: effectLayers, ...mainEffects } = effects;

    const textStyle: React.CSSProperties = {
      fontFamily: s.fontFamily,
      fontSize: `${s.fontSize}px`,
      color: s.color,
      fontWeight: s.bold ? 'bold' : 'normal',
      fontStyle: s.italic ? 'italic' : 'normal',
      textTransform: (s.textTransform && s.textTransform !== 'none') ? s.textTransform : undefined,
      lineHeight: 1.4,
      padding: '8px 16px',
      whiteSpace: 'pre-wrap',
      ...mainEffects,
    };

    if (s.backgroundType === 'box') {
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.border = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      textStyle.borderRadius = `${s.boxBorderRadius}px`;
    } else if (s.backgroundType === 'rounded') {
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.borderRadius = `${s.boxBorderRadius}px`;
      textStyle.border = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
    } else if (s.backgroundType === 'stripe') {
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.width = '100%';
      textStyle.borderTop = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      textStyle.borderBottom = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      base.paddingLeft = 0;
      base.paddingRight = 0;
    } else if (s.backgroundType === 'outline') {
      // Text outline via stroke (already in effects), plus fallback shadow outline
      if (!s.outlineWidth || s.outlineWidth === 0) {
        const outlineColor = s.backgroundColor || '#000000';
        const existingShadows = textStyle.textShadow ? textStyle.textShadow + ', ' : '';
        textStyle.textShadow = existingShadows +
          `-1px -1px 0 ${outlineColor}, 1px -1px 0 ${outlineColor}, -1px 1px 0 ${outlineColor}, 1px 1px 0 ${outlineColor}`;
      }
    } else if (s.backgroundType === 'none') {
      // No background - keep any user-set effects, add default shadow only if no effects set
      if (!mainEffects.textShadow) {
        textStyle.textShadow = '0px 2px 4px rgba(0,0,0,0.5)';
      }
    }

    // Apply blend mode to backdrop if set
    if (s.backdropBlendMode && s.backdropBlendMode !== 'normal') {
      textStyle.mixBlendMode = s.backdropBlendMode as any;
    }

    // Build blend-mode layers: each is an absolutely-positioned copy that renders
    // only one effect with its own mixBlendMode
    const blendLayers: React.CSSProperties[] = effectLayers.map((layer) => ({
      ...textStyle,
      // Reset all shadows, then set only this layer's effect
      textShadow: layer.type === 'text-shadow' ? layer.value : 'none',
      boxShadow: layer.type === 'box-shadow' ? layer.value : 'none',
      // For text-shadow layers: make text invisible (shadow-only)
      ...(layer.type === 'text-shadow' ? {
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        WebkitTextStrokeWidth: '0px',
        backgroundImage: 'none',
        '--text-gradient': undefined,
      } as any : {}),
      // For box-shadow layers: hide text but keep box shape
      ...(layer.type === 'box-shadow' ? {
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        WebkitTextStrokeWidth: '0px',
        backgroundImage: 'none',
        '--text-gradient': undefined,
      } as any : {}),
      mixBlendMode: layer.blendMode as any,
      gridArea: '1 / 1 / 2 / 2' as const,
      pointerEvents: 'none' as const,
    }));

    return { container: base, text: textStyle, blendLayers };
  };

  const getTitleStyles = (s: TitleStyle | undefined, opacity: number) => {
    if (!s) return { container: {} as React.CSSProperties, text: {} as React.CSSProperties, blendLayers: [] as React.CSSProperties[] };

    const base: React.CSSProperties = {
      position: 'absolute',
      top: `${s.topOffset}%`,
      left: 0,
      right: 0,
      textAlign: s.textAlign,
      pointerEvents: 'none',
      zIndex: 10000,
      display: 'flex',
      justifyContent: s.textAlign === 'left' ? 'flex-start' : s.textAlign === 'right' ? 'flex-end' : 'center',
      paddingLeft: '5%',
      paddingRight: '5%',
      opacity: opacity,
      isolation: 'isolate' as any,
    };

    const effects = buildTextEffects(s);
    const { layers: effectLayers, ...mainEffects } = effects;

    const textStyle: React.CSSProperties = {
      fontFamily: s.fontFamily,
      fontSize: `${s.fontSize}px`,
      color: s.color,
      fontWeight: s.bold ? 'bold' : 'normal',
      fontStyle: s.italic ? 'italic' : 'normal',
      textTransform: (s.textTransform && s.textTransform !== 'none') ? s.textTransform : undefined,
      lineHeight: 1.4,
      padding: '12px 24px',
      whiteSpace: 'pre-wrap',
      ...mainEffects,
    };

    if (s.backgroundType === 'box') {
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.border = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      textStyle.borderRadius = `${s.boxBorderRadius}px`;
    } else if (s.backgroundType === 'rounded') {
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.borderRadius = `${s.boxBorderRadius}px`;
      textStyle.border = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
    } else if (s.backgroundType === 'stripe') {
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.width = '100%';
      textStyle.borderTop = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      textStyle.borderBottom = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      base.paddingLeft = 0;
      base.paddingRight = 0;
    } else if (s.backgroundType === 'outline') {
      if (!s.outlineWidth || s.outlineWidth === 0) {
        const outlineColor = s.backgroundColor || '#000000';
        const existingShadows = textStyle.textShadow ? textStyle.textShadow + ', ' : '';
        textStyle.textShadow = existingShadows +
          `-1px -1px 0 ${outlineColor}, 1px -1px 0 ${outlineColor}, -1px 1px 0 ${outlineColor}, 1px 1px 0 ${outlineColor}`;
      }
    } else if (s.backgroundType === 'none') {
      if (!mainEffects.textShadow) {
        textStyle.textShadow = '0px 4px 8px rgba(0,0,0,0.6)';
      }
    }

    if (s.backdropBlendMode && s.backdropBlendMode !== 'normal') {
      textStyle.mixBlendMode = s.backdropBlendMode as any;
    }

    const blendLayers: React.CSSProperties[] = effectLayers.map((layer) => ({
      ...textStyle,
      textShadow: layer.type === 'text-shadow' ? layer.value : 'none',
      boxShadow: layer.type === 'box-shadow' ? layer.value : 'none',
      ...(layer.type === 'text-shadow' ? {
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        WebkitTextStrokeWidth: '0px',
        backgroundImage: 'none',
        '--text-gradient': undefined,
      } as any : {}),
      ...(layer.type === 'box-shadow' ? {
        color: 'transparent',
        WebkitTextFillColor: 'transparent',
        WebkitTextStrokeWidth: '0px',
        backgroundImage: 'none',
        '--text-gradient': undefined,
      } as any : {}),
      mixBlendMode: layer.blendMode as any,
      gridArea: '1 / 1 / 2 / 2' as const,
      pointerEvents: 'none' as const,
    }));

    return { container: base, text: textStyle, blendLayers };
  };

  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Resolve style for the currently displayed subtitle
  const displayStyle = activeSubtitleEvent?.styleOverride || project.subtitleStyle;
  const styles = getSubtitleStyles(displayStyle);

  // Show Content Library page if active
  if (activePage === 'library') {
    return <ContentLibraryPage
      onNavigateToEditor={() => setActivePage('editor')}
      onExportShort={handleExportShort}
      autoCenterOnImport={autoCenterOnImport}
      onToggleAutoCenter={setAutoCenterOnImport}
      project={project}
      onProjectLoad={(loaded) => setProject(prev => ({ ...prev, ...loaded, isPlaying: false }))}
    />;
  }

  return (
    <div className="flex h-screen w-screen bg-[#121212] text-gray-200 overflow-hidden relative font-sans">

      {/* Server disconnected banner */}
      {serverStatus === 'disconnected' && (
        <div className="fixed top-0 left-0 right-0 z-[9999] bg-red-600 text-white text-center py-1.5 text-sm font-medium">
          Backend server unreachable — reconnecting...
        </div>
      )}

      {/* Scan & Center progress banner — always visible while scanning */}
      {status === ProcessingStatus.SCANNING && (
        <div className="fixed bottom-0 left-0 right-0 z-[500] bg-cyan-900/95 border-t border-cyan-500 px-4 py-2 flex items-center gap-3">
          <svg className="w-4 h-4 text-cyan-300 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span className="text-cyan-200 text-sm font-medium">Scan & Center:</span>
          {scanMethod && (
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
              scanMethod === 'python'
                ? 'bg-green-600/80 text-green-100'
                : 'bg-yellow-600/80 text-yellow-100'
            }`}>
              {scanMethod === 'python' ? 'Python' : 'Browser'}
            </span>
          )}
          <span className="text-white text-sm flex-1">{scanProgress || 'Scanning...'}</span>
          <span className="text-cyan-400 text-xs">0 AI tokens used</span>
        </div>
      )}

      {/* Top Navigation Bar */}


      {/* LEFT: Media Bin / Properties Panel */}
      <div className="flex-shrink-0 flex flex-col bg-[#1e1e1e]" style={{ width: leftPanelWidth }}>
        {/* Tab bar */}
        <div className="flex border-b border-[#333] bg-[#252525]">
          <button onClick={() => setActiveLeftTab('media')} className={`flex-1 py-2 text-xs font-bold ${activeLeftTab === 'media' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400 hover:text-white'}`}>MEDIA</button>
          <button onClick={() => setActiveLeftTab('stock')} className={`flex-1 py-2 text-xs font-bold ${activeLeftTab === 'stock' ? 'bg-[#333] text-green-400 border-b-2 border-green-400' : 'text-gray-400 hover:text-white'}`}>STOCK</button>
          <button onClick={() => setActiveLeftTab('properties')} className={`flex-1 py-2 text-xs font-bold ${activeLeftTab === 'properties' ? 'bg-[#333] text-orange-400 border-b-2 border-orange-400' : 'text-gray-400 hover:text-white'}`}>PROPERTIES</button>
        </div>
        {/* Content */}
        {/* Insert-track banner — shown when a track is targeted */}
        {selectedInsertTrack !== null && (
          <div className="flex items-center justify-between px-2 py-1 bg-blue-600/20 border-b border-blue-500/40 text-[10px] text-blue-300 font-medium">
            <span>Adding to <strong>V{selectedInsertTrack + 1}</strong> at cursor</span>
            <button
              onClick={() => setSelectedInsertTrack(null)}
              className="text-blue-400 hover:text-white ml-2 font-bold"
              title="Clear track lock"
            >✕</button>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          {activeLeftTab === 'media' && (
            <MediaBin
              items={project.library}
              onUpload={handleUpload}
              onAddToTimeline={handleAddToTimeline}
              onSelect={m => setSelectedMediaId(m.id)}
              onYoutubeClick={() => setShowYoutubeModal(true)}
              swapActive={selectedSegmentIds.length === 1}
              onSwapMedia={handleSwapMedia}
            />
          )}
          {activeLeftTab === 'stock' && (
            <StockBrowser
              transcript={currentTopMedia?.analysis?.events
                ?.filter(e => e.type === 'dialogue')
                .map(e => e.details)
                .join(' ') || ''}
              onAddToLibrary={handleAddStockToLibrary}
            />
          )}
          {activeLeftTab === 'properties' && (
            <PropertiesPanel
              selectedSegment={primarySelectedSegment}
              selectedTransition={selectedTransition}
              selectedDialogue={selectedDialogue}
              selectedDialogueText={selectedDialogueEvent?.details || ""}
              subtitleStyle={isSubtitleUnlinked ? (selectedDialogueEvent?.styleOverride || project.subtitleStyle) : project.subtitleStyle}
              isSubtitleUnlinked={isSubtitleUnlinked}
              mediaAnalysis={selectedMediaAnalysis}
              onUpdateSegment={(s: Segment) => handleUpdateSegments([s])}
              onUpdateTransition={handleUpdateTransition}
              onUpdateDialogueText={handleUpdateDialogueText}
              onAutoWrapDialogue={handleAutoWrapDialogue}
              onUpdateSubtitleStyle={handleUpdateSubtitleStyle}
              onToggleSubtitleUnlink={handleToggleSubtitleUnlink}
              onAnalyze={performDeepAnalysis}
              isProcessing={status !== ProcessingStatus.IDLE}
              isTitleSelected={isTitleSelected}
              titleLayer={project.titleLayer}
              onUpdateTitleLayer={handleUpdateTitleLayer}
              activeSubtitleTemplate={effectiveSubtitleTemplate}
              isTemplateUnlinked={isTemplateUnlinked}
              onUpdateSubtitleTemplate={handleUpdateSubtitleTemplate}
              onToggleTemplateUnlink={handleToggleTemplateUnlink}
              activeKeywordAnimation={isTemplateUnlinked ? (selectedDialogueEvent?.keywordAnimation || project.activeKeywordAnimation) : project.activeKeywordAnimation}
              onUpdateKeywordAnimation={handleUpdateKeywordAnimation}
              wordEmphases={selectedDialogueEvent?.wordEmphases}
              onUpdateWordEmphases={selectedDialogue ? (emphases: KeywordEmphasis[]) => {
                const media = project.library.find(m => m.id === selectedDialogue.mediaId);
                const evt = media?.analysis?.events[selectedDialogue.index];
                if (evt) {
                  handleUpdateDialogue(selectedDialogue.mediaId, selectedDialogue.index, {
                    ...evt,
                    wordEmphases: emphases,
                  });
                }
              } : undefined}
              currentVolume={primarySelectedSegment ? getInterpolatedTransform(primarySelectedSegment.keyframes, project.currentTime - primarySelectedSegment.timelineStart).volume : undefined}
              onAddVolumeKey={(segId: string, volume: number) => {
                const seg = project.segments.find(s => s.id === segId);
                if (!seg) return;
                const clipTime = project.currentTime - seg.timelineStart;
                const currentVals = getInterpolatedTransform(seg.keyframes, clipTime);
                const newKf: ClipKeyframe = {
                  time: clipTime,
                  translateX: currentVals.translateX,
                  translateY: currentVals.translateY,
                  scale: currentVals.scale,
                  rotation: currentVals.rotation,
                  volume,
                };
                const existing = seg.keyframes || [];
                const filtered = existing.filter(kf => Math.abs(kf.time - clipTime) >= 0.01);
                const updated = [...filtered, newKf].sort((a, b) => a.time - b.time);
                handleUpdateSegments([{ ...seg, keyframes: updated }]);
              }}
              onColorCorrectionChange={handleColorCorrectionChange}
              onResetColorCorrection={handleResetColorCorrection}
              onColorGradingChange={handleColorGradingChange}
              onResetColorGrading={handleResetColorGrading}
              mattePreviewing={mattePreviewing}
              onMattePreview={setMattePreviewing}
            />
          )}
        </div>
      </div>

      {/* Left Panel Resize Handle */}
      <ResizeHandle direction="horizontal" onResize={handleLeftResize} onDoubleClick={() => setLeftPanelWidth(256)} />

      {/* VERTICAL TOOLBAR */}
      <div className="w-12 flex-shrink-0 bg-[#1e1e1e] border-r border-[#333] flex flex-col items-center py-4 gap-3 z-50 overflow-y-auto">

        {/* Basic Tools */}
        <button title="Selection Tool (V)" className={`p-2 rounded hover:text-white bg-[#333] text-blue-400`}>
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M7 2l12 11.2-5.8.5 3.3 7.3-2.25 1-3.2-7.4-4.4 5V2z" /></svg>
        </button>
        <button title="Razor Tool (C)" onClick={() => handleSplit(project.currentTime)} className="p-2 rounded text-gray-400 hover:text-white hover:bg-[#333]">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 15.536c-1.171 1.952-3.07 1.952-4.242 0-1.172-1.953-1.172-5.119 0-7.072 1.171-1.952 3.07-1.952 4.242 0M8 10.5h4m-4 3h4m9-1.5a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
        </button>

        <div className="w-8 h-px bg-[#444] my-1" />

        {/* Insert Options */}
        <button title="Insert Blank Video Clip" onClick={() => handleInsertBlank(project.currentTime)} className="p-2 rounded text-gray-400 hover:text-white hover:bg-[#333]">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" /></svg>
        </button>
        <button title="Insert Blank Title" onClick={() => handleInsertTitle(project.currentTime)} className="p-2 rounded text-gray-400 hover:text-white hover:bg-[#333]">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M5 4v3h5.5v12h3V7H19V4z" /></svg>
        </button>
        <button title="Insert Blank Dialogue" onClick={() => handleInsertDialogue(project.currentTime)} className="p-2 rounded text-gray-400 hover:text-white hover:bg-[#333]">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z" /></svg>
        </button>

        <div className="w-8 h-px bg-[#444] my-1" />

        {/* AI Tools */}
        <button
          title={status === ProcessingStatus.CENTERING ? (centeringProgress || 'Centering...') : 'Center Person (AI – current frame)'}
          onClick={handleCenterPerson}
          disabled={project.segments.length === 0 || status !== ProcessingStatus.IDLE}
          className="p-2 rounded text-teal-400 hover:text-white hover:bg-[#333] disabled:opacity-50">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z" /></svg>
        </button>

        {/* Scan & Center — zero-token template tracking */}
        <button
          ref={scanButtonRef}
          title={status === ProcessingStatus.SCANNING ? (scanProgress || 'Scanning...') : `Scan & Center (${outOfZoneThreshold}% threshold) — click to configure`}
          onClick={() => {
            if (status !== ProcessingStatus.SCANNING) {
              setShowScanPanel(p => !p);
            }
          }}
          disabled={project.segments.length === 0 || status === ProcessingStatus.SCANNING}
          className={`p-2 rounded hover:text-white hover:bg-[#333] disabled:opacity-40 ${status === ProcessingStatus.SCANNING ? 'text-cyan-300 animate-pulse' : 'text-cyan-500'}`}>
          {/* Scan / radar icon */}
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="2" fill="currentColor" />
            <path strokeLinecap="round" d="M12 12 L19.5 4.5" opacity="0.5"/>
            <path strokeLinecap="round" d="M12 3a9 9 0 100 18A9 9 0 0012 3z" />
            <path strokeLinecap="round" d="M12 7a5 5 0 100 10A5 5 0 0012 7z" opacity="0.5" />
          </svg>
        </button>

        {/* Scan settings popover — fixed-position to escape toolbar overflow clipping */}
        {showScanPanel && (() => {
          const rect = scanButtonRef.current?.getBoundingClientRect();
          const top = rect ? rect.top : 200;
          return (
            <div
              style={{ position: 'fixed', left: 60, top: Math.max(8, Math.min(top, window.innerHeight - 300)), zIndex: 300 }}
              className="w-64 bg-[#1e1e1e] border border-[#444] rounded-lg shadow-2xl p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">Scan & Auto-Center</span>
                <button onClick={() => setShowScanPanel(false)} className="text-gray-500 hover:text-white text-xs">✕</button>
              </div>
              <p className="text-[10px] text-gray-400 leading-tight">
                Uses template tracking — <span className="text-green-400 font-semibold">0 AI tokens</span>. Scans every 100ms and generates keyframes only when the person exits the 9:16 zone past the threshold.
              </p>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-300">Deadband from center</label>
                  <span className="text-xs font-mono text-cyan-400">{outOfZoneThreshold}%</span>
                </div>
                <input
                  type="range" min={0} max={28} step={1}
                  value={outOfZoneThreshold}
                  onChange={e => setOutOfZoneThreshold(Number(e.target.value))}
                  className="w-full accent-cyan-500 h-1.5 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-gray-500">
                  <span>0% — always follow</span>
                  <span>28% — at boundary</span>
                </div>
              </div>

              {/* Smooth keyframes toggle */}
              <div className="flex flex-col gap-1 pt-1">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none" onClick={() => setScanSmooth(v => !v)}>
                    <div className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${scanSmooth ? 'bg-emerald-600' : 'bg-[#444]'}`}>
                      <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${scanSmooth ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-xs text-gray-300">Smooth keyframes</span>
                  </label>
                  {scanSmooth && <span className="text-xs font-mono text-emerald-400">{scanSmoothAmount}%</span>}
                </div>
                {scanSmooth && (
                  <>
                    <input
                      type="range" min={1} max={100} step={1}
                      value={scanSmoothAmount}
                      onChange={e => setScanSmoothAmount(Number(e.target.value))}
                      className="w-full h-1.5 cursor-pointer"
                      style={{ accentColor: '#34d399' }}
                    />
                    <div className="flex justify-between text-[9px] text-gray-500">
                      <span>1% — subtle</span>
                      <span>50% — natural</span>
                      <span>100% — heavy</span>
                    </div>
                  </>
                )}
              </div>

              <div className="border-t border-[#333] pt-2 flex flex-col gap-1.5">
                <button
                  onClick={async () => {
                    setShowScanPanel(false);
                    const seg = project.segments.find(s =>
                      project.currentTime >= s.timelineStart &&
                      project.currentTime < s.timelineStart + (s.endTime - s.startTime)
                    ) || primarySelectedSegment;
                    if (!seg) { alert('No clip selected or under playhead.'); return; }
                    await scanAndCenterClip(seg.id);
                  }}
                  disabled={project.segments.length === 0}
                  className="w-full py-1.5 px-2 bg-cyan-700 hover:bg-cyan-600 text-white text-xs rounded disabled:opacity-50 flex items-center gap-1.5">
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  Scan Current Clip
                </button>
                <button
                  onClick={async () => {
                    setShowScanPanel(false);
                    await scanAndCenterAllClips();
                  }}
                  disabled={project.segments.length === 0}
                  className="w-full py-1.5 px-2 bg-[#2a3a3a] hover:bg-[#334] border border-cyan-800 text-cyan-300 text-xs rounded disabled:opacity-50 flex items-center gap-1.5">
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                  Scan All Clips
                </button>
              </div>

              {scanProgress && (
                <div className="text-[10px] text-cyan-300 bg-[#0a1a1a] rounded px-2 py-1 mt-1">
                  {scanProgress}
                </div>
              )}
            </div>
          );
        })()}

        <button
          title={status === ProcessingStatus.CLEANING_FILLERS ? (fillerProgress || 'Detecting fillers...') : 'Clean Fillers'}
          onClick={handleCleanFillers}
          disabled={project.segments.length === 0 || status !== ProcessingStatus.IDLE}
          className="p-2 rounded text-amber-400 hover:text-white hover:bg-[#333] disabled:opacity-50">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
        </button>

        <button
          ref={silenceButtonRef}
          title={removingSilences ? 'Removing silences...' : 'Remove Silences — click to configure'}
          onClick={() => {
            if (!removingSilences) setShowSilencePanel(p => !p);
          }}
          disabled={project.segments.length === 0 || removingSilences || status !== ProcessingStatus.IDLE}
          className={`p-2 rounded hover:text-white hover:bg-[#333] disabled:opacity-50 ${removingSilences ? 'text-purple-300 animate-pulse' : 'text-purple-400'}`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
          </svg>
        </button>

        {showSilencePanel && (() => {
          const rect = silenceButtonRef.current?.getBoundingClientRect();
          const top = rect ? rect.top : 400;
          const hasSelection = selectedSegmentIds.length > 0;
          return (
            <div
              style={{ position: 'fixed', left: 60, top: Math.max(8, Math.min(top, window.innerHeight - 220)), zIndex: 300 }}
              className="w-64 bg-[#1e1e1e] border border-[#444] rounded-lg shadow-2xl p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white">Remove Silences</span>
                <button onClick={() => setShowSilencePanel(false)} className="text-gray-500 hover:text-white text-xs">{'\u2715'}</button>
              </div>
              <p className="text-[10px] text-gray-400 leading-tight">
                Detects silence gaps using audio energy analysis — <span className="text-green-400 font-semibold">no AI tokens</span>. Cuts are snapped to zero-crossings with 20ms padding to avoid clipping speech.
              </p>

              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-gray-300">Min silence duration</label>
                  <span className="text-xs font-mono text-purple-400">{(silenceThreshold * 1000).toFixed(0)}ms</span>
                </div>
                <input
                  type="range" min={100} max={2000} step={50}
                  value={silenceThreshold * 1000}
                  onChange={e => setSilenceThreshold(Number(e.target.value) / 1000)}
                  className="w-full h-1.5 cursor-pointer"
                  style={{ accentColor: '#c084fc' }}
                />
                <div className="flex justify-between text-[9px] text-gray-500">
                  <span>100ms — tight</span>
                  <span>500ms</span>
                  <span>2000ms — conservative</span>
                </div>
              </div>

              <div className="border-t border-[#333] pt-2 flex flex-col gap-1.5">
                {hasSelection && (
                  <button
                    onClick={() => handleRemoveSilences(true)}
                    disabled={removingSilences}
                    className="w-full py-1.5 px-2 bg-purple-700 hover:bg-purple-600 text-white text-xs rounded disabled:opacity-50 flex items-center gap-1.5">
                    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    Remove from Selected ({selectedSegmentIds.length} clip{selectedSegmentIds.length !== 1 ? 's' : ''})
                  </button>
                )}
                <button
                  onClick={() => handleRemoveSilences(false)}
                  disabled={removingSilences}
                  className={`w-full py-1.5 px-2 text-xs rounded disabled:opacity-50 flex items-center gap-1.5 ${hasSelection ? 'bg-[#2a2a3a] hover:bg-[#334] border border-purple-800 text-purple-300' : 'bg-purple-700 hover:bg-purple-600 text-white'}`}>
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                  Remove from All Clips
                </button>
              </div>
            </div>
          );
        })()}

      </div>

      {/* MIDDLE: Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex min-h-0">

          {/* Program Monitor */}
          <div className="flex-1 bg-black flex flex-col relative overflow-hidden">
            {/* Top Navigation Bar */}
            <div className="flex-shrink-0 flex items-center justify-end gap-2 px-2 py-1.5 bg-[#1a1a1a] border-b border-[#333] z-50">
              {/* New Scene */}
              <button
                onClick={() => {
                  if (!window.confirm('Start a new scene? This will clear all clips, media, and timeline content. Your style presets and animation templates will be preserved.')) return;
                  setProject(prev => {
                    // Clean up stored blobs for all cleared media items
                    prev.library.forEach(m => contentDB.deleteMediaBlob(m.id).catch(() => {}));
                    return {
                      ...INITIAL_STATE,
                      subtitleStyle: prev.subtitleStyle,
                      titleStyle: prev.titleStyle,
                      activeSubtitleTemplate: prev.activeSubtitleTemplate,
                      activeTitleTemplate: prev.activeTitleTemplate,
                      activeKeywordAnimation: prev.activeKeywordAnimation,
                    };
                  });
                  setGlobalKeyframes([]);
                }}
                className="px-2 py-1 text-xs rounded font-medium bg-[#2a1a1a] text-red-400 hover:text-red-300 hover:bg-[#3a1a1a] border border-red-900/50"
                title="Clear scene content, keep style presets"
              >
                New Scene
              </button>
              {/* Quick Save (IndexedDB + file) */}
              <button
                onClick={async () => {
                  setIsSaving(true);
                  try {
                    await contentDB.saveProject(project, globalKeyframes);
                    // Also save to disk for portability
                    saveProjectToFile(projectName.trim() || 'autosave', project).catch(e => console.warn('File save failed:', e));
                    setTimeout(() => setIsSaving(false), 1000);
                  } catch (e) {
                    console.error(e);
                    setIsSaving(false);
                    alert('Save failed');
                  }
                }}
                disabled={isSaving}
                className={`px-3 py-1 text-xs rounded font-medium flex items-center gap-1 ${isSaving ? 'bg-green-600 text-white' : 'bg-[#333] text-gray-300 hover:text-white hover:bg-[#444]'}`}
              >
                {isSaving ? 'Saved!' : 'Save'}
              </button>
              {/* Load Menu */}
              <div className="relative">
                <button
                  ref={loadMenuBtnRef}
                  onClick={async () => {
                    if (!showLoadMenu) {
                      try {
                        const list = await listSavedProjects();
                        setFileProjects(list);
                      } catch { setFileProjects([]); }
                      setLoadMenuRect(loadMenuBtnRef.current?.getBoundingClientRect() ?? null);
                    }
                    setShowLoadMenu(p => !p);
                  }}
                  className="px-2 py-1 text-xs rounded font-medium bg-[#333] text-gray-300 hover:text-white hover:bg-[#444]"
                >
                  Load ▾
                </button>
                {showLoadMenu && loadMenuRect && createPortal(
                  <>
                  <div className="fixed inset-0 z-[9990]" onClick={() => setShowLoadMenu(false)} />
                  <div className="fixed w-72 bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl z-[9991] overflow-hidden" style={{ top: loadMenuRect.bottom + 4, right: window.innerWidth - loadMenuRect.right }} onClick={e => e.stopPropagation()}>
                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-3 pt-2 pb-1">Saved Files (saves/projects/)</div>
                    <div className="max-h-64 overflow-y-auto">
                      {fileProjects.length === 0 ? (
                        <div className="px-3 pb-3 text-xs text-gray-600">No saved project files yet</div>
                      ) : (
                        fileProjects.map(fp => (
                          <div key={fp.filename} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#252525] group">
                            <button
                              onClick={async () => {
                                try {
                                  const loaded = await loadProjectFromFile(fp.name);
                                  if (loaded) {
                                    setProject({ ...INITIAL_STATE, ...unwrapProjectState(loaded as unknown), isPlaying: false });
                                    setShowLoadMenu(false);
                                  }
                                } catch (err) {
                                  console.error('Load failed:', err);
                                  alert('Failed to load project file');
                                }
                              }}
                              className="flex-1 text-left min-w-0"
                            >
                              <div className="text-xs text-gray-200 font-medium truncate">{fp.name}</div>
                              <div className="text-[10px] text-gray-500">
                                {fp.segmentCount} clips &middot; {fp.duration.toFixed(1)}s &middot; {new Date(fp.savedAt).toLocaleDateString()}
                              </div>
                            </button>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await deleteProjectFile(fp.name);
                                  const list = await listSavedProjects();
                                  setFileProjects(list);
                                } catch (err) {
                                  console.error('Delete failed:', err);
                                }
                              }}
                              className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs px-1"
                              title="Delete"
                            >
                              ✕
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  </>,
                  document.body
                )}
              </div>
              {/* Project Menu */}
              <div className="relative">
                <button
                  ref={projectMenuBtnRef}
                  onClick={async () => {
                    if (!showProjectMenu) {
                      const list = await contentDB.listProjects();
                      setSavedProjects(list);
                      setProjectMenuRect(projectMenuBtnRef.current?.getBoundingClientRect() ?? null);
                    }
                    setShowProjectMenu(p => !p);
                  }}
                  className="px-2 py-1 text-xs rounded font-medium bg-[#333] text-gray-300 hover:text-white hover:bg-[#444]"
                >
                  Projects ▾
                </button>
                {showProjectMenu && projectMenuRect && createPortal(
                  <>
                  <div className="fixed inset-0 z-[9990]" onClick={() => setShowProjectMenu(false)} />
                  <div className="fixed w-72 bg-[#1a1a1a] border border-[#444] rounded-lg shadow-2xl z-[9991] overflow-hidden" style={{ top: projectMenuRect.bottom + 4, right: window.innerWidth - projectMenuRect.right }} onClick={e => e.stopPropagation()}>
                    {/* Save As (to file + IndexedDB) */}
                    <div className="p-3 border-b border-[#333]">
                      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1.5">Save As</div>
                      <div className="flex gap-1.5">
                        <input
                          value={projectName}
                          onChange={e => setProjectName(e.target.value)}
                          placeholder="Project name..."
                          className="flex-1 bg-[#111] border border-[#444] rounded px-2 py-1 text-xs text-white focus:border-blue-500 outline-none"
                          onKeyDown={e => {
                            if (e.key === 'Enter' && projectName.trim()) {
                              const name = projectName.trim();
                              Promise.all([
                                contentDB.saveNamedProject(name, project),
                                saveProjectToFile(name, project).catch(err => console.warn('File save failed:', err)),
                              ]).then(() => {
                                setProjectName('');
                                contentDB.listProjects().then(setSavedProjects);
                              });
                            }
                          }}
                        />
                        <button
                          onClick={() => {
                            if (!projectName.trim()) return;
                            const name = projectName.trim();
                            Promise.all([
                              contentDB.saveNamedProject(name, project),
                              saveProjectToFile(name, project).catch(err => console.warn('File save failed:', err)),
                            ]).then(() => {
                              setProjectName('');
                              contentDB.listProjects().then(setSavedProjects);
                            });
                          }}
                          disabled={!projectName.trim()}
                          className="px-2 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 font-medium"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                    {/* Saved Projects List (IndexedDB) */}
                    <div className="max-h-48 overflow-y-auto">
                      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-3 pt-2 pb-1">Saved Projects (Browser)</div>
                      {savedProjects.length === 0 ? (
                        <div className="px-3 pb-3 text-xs text-gray-600">No saved projects yet</div>
                      ) : (
                        savedProjects.map(p => (
                          <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-[#252525] group">
                            <button
                              onClick={async () => {
                                const loaded = await contentDB.loadNamedProject(p.id);
                                if (loaded) {
                                  setProject({ ...INITIAL_STATE, ...unwrapProjectState(loaded) });
                                  setShowProjectMenu(false);
                                }
                              }}
                              className="flex-1 text-left min-w-0"
                            >
                              <div className="text-xs text-gray-200 font-medium truncate">{p.name}</div>
                              <div className="text-[10px] text-gray-500">
                                {p.segmentCount} clips &middot; {p.duration.toFixed(1)}s &middot; {new Date(p.savedAt).toLocaleDateString()}
                              </div>
                            </button>
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                await contentDB.deleteNamedProject(p.id);
                                const list = await contentDB.listProjects();
                                setSavedProjects(list);
                              }}
                              className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs px-1"
                              title="Delete"
                            >
                              ✕
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                    {/* File Import/Export */}
                    <div className="border-t border-[#333] p-2 flex flex-col gap-1.5">
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => {
                            const data = JSON.stringify(
                              { ...project, isPlaying: false, library: project.library.map(m => ({ ...m, file: undefined })) },
                              null,
                              2
                            );
                            const blob = new Blob([data], { type: 'application/json' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = `vibecut-project-${new Date().toISOString().slice(0, 10)}.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                            setShowProjectMenu(false);
                          }}
                          className="flex-1 px-2 py-1.5 text-xs rounded bg-[#252525] text-gray-300 hover:text-white hover:bg-[#333] font-medium text-center"
                        >
                          Export .json
                        </button>
                        <button
                          onClick={() => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = '.json';
                            input.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                            document.body.appendChild(input);
                            const cleanup = () => { try { document.body.removeChild(input); } catch {} };
                            input.addEventListener('cancel', cleanup);
                            input.onchange = async (e) => {
                              const file = (e.target as HTMLInputElement).files?.[0];
                              cleanup();
                              if (!file) return;
                              try {
                                const text = await file.text();
                                const imported = JSON.parse(text) as ProjectState;
                                setProject({ ...INITIAL_STATE, ...unwrapProjectState(imported), isPlaying: false });
                                setShowProjectMenu(false);
                              } catch (err) {
                                console.error('Import failed:', err);
                                alert('Failed to import project file');
                              }
                            };
                            input.click();
                          }}
                          className="flex-1 px-2 py-1.5 text-xs rounded bg-[#252525] text-gray-300 hover:text-white hover:bg-[#333] font-medium text-center"
                        >
                          Import .json
                        </button>
                      </div>
                      <div className="flex gap-1.5">
                        <button
                          onClick={async () => {
                            try {
                              const blob = await exportAllData();
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `vibecut-full-export-${new Date().toISOString().slice(0, 10)}.json`;
                              a.click();
                              URL.revokeObjectURL(url);
                              setShowProjectMenu(false);
                            } catch (err) {
                              console.error('Export all failed:', err);
                              alert('Failed to export all data');
                            }
                          }}
                          className="flex-1 px-2 py-1.5 text-xs rounded bg-green-900/50 text-green-300 hover:text-white hover:bg-green-800/50 font-medium text-center"
                        >
                          Export All Data
                        </button>
                        <button
                          onClick={() => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = '.json';
                            input.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                            document.body.appendChild(input);
                            const cleanup = () => { try { document.body.removeChild(input); } catch {} };
                            input.addEventListener('cancel', cleanup);
                            input.onchange = async (e) => {
                              const file = (e.target as HTMLInputElement).files?.[0];
                              cleanup();
                              if (!file) return;
                              try {
                                const text = await file.text();
                                const bundle = JSON.parse(text);
                                const result = await importAllData(bundle);
                                alert(`Imported ${result.projectCount} projects, ${result.shortsCount} shorts files`);
                                setShowProjectMenu(false);
                              } catch (err) {
                                console.error('Import all failed:', err);
                                alert('Failed to import data bundle');
                              }
                            };
                            input.click();
                          }}
                          className="flex-1 px-2 py-1.5 text-xs rounded bg-green-900/50 text-green-300 hover:text-white hover:bg-green-800/50 font-medium text-center"
                        >
                          Import All Data
                        </button>
                      </div>
                    </div>
                  </div>
                  </>,
                  document.body
                )}
              </div>
              <div className="w-px h-6 bg-[#444] mx-1"></div>
              <button
                onClick={() => setActivePage('editor')}
                className={`px-3 py-1 text-xs rounded font-medium ${activePage === 'editor' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                  }`}
              >
                Video Editor
              </button>
              <button
                onClick={() => setActivePage('library')}
                className={`px-3 py-1 text-xs rounded font-medium ${activePage === 'library' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'
                  }`}
              >
                Content Library
              </button>
            </div>
            {/* Tracking Progress Overlay — only show for auto-tracking, not manual (viewport stays visible during manual) */}
            {trackingProgress && trackingMode !== 'tracking' && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                <div className="bg-[#1a1a1a] border border-[#444] rounded-xl p-6 w-80 shadow-2xl">
                  <div className="text-center mb-4">
                    <div className="text-2xl mb-2">🎯</div>
                    <h3 className="text-white font-bold text-sm">Auto-Tracking Speaker</h3>
                    <p className="text-gray-400 text-xs mt-1">{trackingProgress.label}</p>
                  </div>
                  <div className="w-full bg-[#333] rounded-full h-3 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 to-blue-500 rounded-full transition-all duration-200"
                      style={{ width: `${Math.round(trackingProgress.progress * 100)}%` }}
                    />
                  </div>
                  <div className="text-center mt-2 text-xs text-gray-500 font-mono">
                    {Math.round(trackingProgress.progress * 100)}%
                  </div>
                </div>
              </div>
            )}
            {viewportMode === 'standard' ? (
              <div ref={viewportOuterRef} className="flex-1 relative overflow-hidden flex items-center justify-center bg-black">
              <div
                ref={viewportContainerRef}
                className="relative overflow-hidden group"
                style={{
                  width: viewportSize.width || '100%',
                  height: viewportSize.height || '100%',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  cursor: (trackingMode === 'placing-stabilizer' || trackingMode === 'placing-parent') ? 'crosshair' : (transformTarget === 'global' || primarySelectedSegment) ? (isViewportDragging ? 'grabbing' : 'grab') : 'default',
                }}
                onMouseDown={(e: React.MouseEvent) => { handleTrackingPanStart(e); handleViewportMouseDown(e); }}
                onMouseMove={handleViewportMouseMove}
                onMouseUp={handleViewportMouseUp}
                onMouseLeave={handleViewportMouseUp}
                onWheel={handleTrackingWheel}
              >
                {/* Zoom wrapper — scales video + tracker overlay together when in tracking tab */}
                <div
                  className="absolute inset-0"
                  style={{
                    transform: activeRightTab === 'tracking' && trackingZoom !== 1
                      ? `translate(${trackingPan.x}px, ${trackingPan.y}px) scale(${trackingZoom})`
                      : undefined,
                    transformOrigin: '0 0',
                    width: '100%',
                    height: '100%',
                  }}
                >
                  {renderedSegments.length > 0 ? (
                    renderedSegments.map((seg, index) => {
                      // Get combined transform (global + clip)
                      const clipTime = project.currentTime - seg.timelineStart;
                      const transform = getCombinedTransform(seg.keyframes, clipTime, project.currentTime);

                      // Convert translate percentages to pixels using object-contain display area
                      // (keyframes store % of video native dims; CSS translate(%) uses element dims which differ with letterbox/pillarbox)
                      const videoEl = videoRefs.current.get(seg.id);
                      const vw = videoEl?.videoWidth || 1920;
                      const vh = videoEl?.videoHeight || 1080;
                      const videoAR = vw / vh;
                      const containerAR = viewportSize.width / (viewportSize.height || 1);
                      const displayW = containerAR > videoAR ? viewportSize.height * videoAR : viewportSize.width;
                      const displayH = containerAR > videoAR ? viewportSize.height : viewportSize.width / videoAR;

                      const txParts: string[] = [];
                      if (transform.translateX !== 0 || transform.translateY !== 0) {
                        txParts.push(`translate(${transform.translateX * displayW / 100}px, ${transform.translateY * displayH / 100}px)`);
                      }
                      if (transform.scale !== 1) txParts.push(`scale(${transform.scale})`);
                      if (transform.rotation !== 0) txParts.push(`rotate(${transform.rotation}deg)`);
                      const cssTransform = txParts.length > 0 ? txParts.join(' ') : 'none';

                      // Audio-only segments: hidden video element for audio playback only
                      if (seg.type === 'audio') {
                        return (
                          <video
                            key={seg.id}
                            ref={el => { if (el) videoRefs.current.set(seg.id, el); }}
                            src={project.library.find(m => m.id === seg.mediaId)?.url}
                            className="hidden"
                            muted={false}
                          />
                        );
                      }

                      return (
                        <div key={seg.id} className="absolute inset-0 w-full h-full" style={{ zIndex: segmentZIndices.get(seg.id) ?? (seg.track || 0) * 10 }}>
                          {seg.type === 'blank' ? (
                            <div
                              className="w-full h-full flex items-center justify-center p-8 text-center"
                              style={{
                                backgroundColor: seg.color || '#444444',
                                color: '#ffffff',
                                fontSize: '48px',
                                fontWeight: 'bold',
                                fontFamily: 'system-ui, -apple-system, sans-serif'
                              }}
                            >
                              <div style={{ transform: cssTransform, transformOrigin: `${transform.pivotX}% ${transform.pivotY}%` }}>
                                {seg.customText || ''}
                              </div>
                            </div>
                          ) : (
                            <>
                              {/* Hidden video element for decode/playback */}
                              <video
                                ref={el => { if (el) videoRefs.current.set(seg.id, el); }}
                                src={project.library.find(m => m.id === seg.mediaId)?.url}
                                className={seg.colorGrading && !isGradingDefault(seg.colorGrading) ? 'hidden' : 'w-full h-full object-contain pointer-events-none'}
                                style={seg.colorGrading && !isGradingDefault(seg.colorGrading) ? undefined : {
                                  transform: cssTransform,
                                  transformOrigin: `${transform.pivotX}% ${transform.pivotY}%`,
                                  filter: seg.colorCorrection && !isDefaultCC(seg.colorCorrection)
                                    ? buildCSSFilter(seg.colorCorrection, needsAdvancedCorrection(seg.colorCorrection) ? `cc-filter-${seg.id}` : undefined)
                                    : undefined,
                                }}
                                muted={false}
                              />
                              {/* WebGL grading canvas — shown when color grading is active */}
                              {seg.colorGrading && !isGradingDefault(seg.colorGrading) && (
                                <ColorGradingCanvas
                                  videoElement={videoRefs.current.get(seg.id) || null}
                                  grading={seg.colorGrading}
                                  mattePreviewing={mattePreviewing}
                                  className="w-full h-full object-contain pointer-events-none"
                                  style={{
                                    transform: cssTransform,
                                    transformOrigin: `${transform.pivotX}% ${transform.pivotY}%`,
                                  }}
                                />
                              )}
                              {/* SVG filter for Phase 1 CC (only when no Phase 2 grading) */}
                              {!(seg.colorGrading && !isGradingDefault(seg.colorGrading)) && seg.colorCorrection && needsAdvancedCorrection(seg.colorCorrection) && (
                                <svg width="0" height="0" style={{ position: 'absolute' }}>
                                  <defs dangerouslySetInnerHTML={{ __html: buildSVGFilterMarkup(seg.colorCorrection, `cc-filter-${seg.id}`) }} />
                                </svg>
                              )}
                            </>
                          )}
                          {/* Dynamic Wash Overlay */}
                          <div
                            ref={el => { if (el) overlayRefs.current.set(seg.id, el); }}
                            className="absolute inset-0 pointer-events-none opacity-0"
                            style={{ backgroundColor: 'white' }}
                          />
                        </div>
                      );
                    })
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm">No Active Clip</div>
                  )}

                  {/* Transition Canvas Overlay — renders complex transitions (wipes, shapes, etc.) */}
                  <canvas
                    ref={transitionCanvasRef}
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    style={{ display: 'none', zIndex: 50 }}
                  />

                  {/* Tracker Overlay — interactive tracker placement & visualization */}
                  {primarySelectedSegment && (primarySelectedSegment.trackers?.length || trackingMode === 'placing-stabilizer' || trackingMode === 'placing-parent') ? (
                    <TrackerOverlay
                      trackers={primarySelectedSegment.trackers || []}
                      trackingData={primarySelectedSegment.trackingData}
                      currentTime={project.currentTime}
                      segmentStartTime={primarySelectedSegment.startTime}
                      segmentTimelineStart={primarySelectedSegment.timelineStart}
                      videoWidth={videoRefs.current.get(primarySelectedSegment.id)?.videoWidth || 1920}
                      videoHeight={videoRefs.current.get(primarySelectedSegment.id)?.videoHeight || 1080}
                      viewportSize={viewportSize}
                      selectedTrackerId={selectedTrackerId}
                      trackingMode={trackingMode}
                      onTrackerClick={setSelectedTrackerId}
                      onTrackerDrag={handleTrackerDrag}
                      onPlaceTracker={handlePlaceTracker}
                      zoom={trackingZoom}
                    />
                  ) : null}
                </div>

                {/* Viewport Aspect Ratio Overlay — stays outside zoom wrapper */}
                <ViewportOverlay
                  containerWidth={viewportSize.width}
                  containerHeight={viewportSize.height}
                  aspectRatio={viewportSettings.previewAspectRatio}
                  opacity={viewportSettings.overlayOpacity}
                  visible={viewportSettings.showOverlay}
                />

                {/* Safe zone wrapper — constrains subtitles & titles to aspect ratio */}
                {(() => {
                  const arPreset = viewportSettings.previewAspectRatio !== 'custom'
                    ? ASPECT_RATIO_PRESETS[viewportSettings.previewAspectRatio]
                    : null;
                  let sz = { x: 0, y: 0, w: viewportSize.width, h: viewportSize.height };
                  if (arPreset && viewportSize.width > 0 && viewportSize.height > 0) {
                    const cr = viewportSize.width / viewportSize.height;
                    if (cr > arPreset.ratio) {
                      sz.h = viewportSize.height;
                      sz.w = viewportSize.height * arPreset.ratio;
                      sz.x = (viewportSize.width - sz.w) / 2;
                    } else {
                      sz.w = viewportSize.width;
                      sz.h = viewportSize.width / arPreset.ratio;
                      sz.y = (viewportSize.height - sz.h) / 2;
                    }
                  }
                  return (
                    <div ref={safeZoneRef} style={{ position: 'absolute', left: sz.x, top: sz.y, width: sz.w, height: sz.h, pointerEvents: 'none', zIndex: 500 }}>

                      {/* Animated Subtitle Overlay */}
                      {activeSubtitleEvent && (() => {
                        const subTemplate = activeSubtitleEvent.templateOverride || project.activeSubtitleTemplate;
                        const subAnim = subTemplate?.animation;
                        const subTx = activeSubtitleEvent.translateX || 0;
                        const subTy = activeSubtitleEvent.translateY || 0;
                        // Use pixel-based transform (percentage of crop region) for 1:1 drag mapping
                        const subTransform = (subTx !== 0 || subTy !== 0) ? `translate(${subTx * sz.w / 100}px, ${subTy * sz.h / 100}px)` : undefined;

                        // Find event index for drag
                        const subEvtIndex = currentTopMedia?.analysis?.events.indexOf(activeSubtitleEvent) ?? -1;

                        const handleSubtitleMouseDown = (e: React.MouseEvent) => {
                          e.stopPropagation();
                          if (!currentTopMedia || subEvtIndex < 0) return;
                          // Select this subtitle so Properties Panel shows it
                          setSelectedDialogues([{ mediaId: currentTopMedia.id, index: subEvtIndex }]);
                          pushUndo({ type: 'dialogueEvent', mediaId: currentTopMedia.id, index: subEvtIndex, event: { ...activeSubtitleEvent } });
                          setSubtitleDragState({
                            mediaId: currentTopMedia.id, index: subEvtIndex,
                            startX: e.clientX, startY: e.clientY,
                            origTx: subTx, origTy: subTy,
                          });
                        };

                        // Viewport click handler for selecting segments
                        const handleViewportMouseDown = (e: React.MouseEvent) => {
                          // Only handle if left click and not dragging subtitle/title
                          if (e.button !== 0 || subtitleDragState || titleDragState) return;

                          // If clicking on subtitle/title, their handlers stopPropagation, so we only get here if clicking "background" video
                          if (activeSegments.length > 0) {
                            const topSeg = activeSegments[activeSegments.length - 1];
                            if (!selectedSegmentIds.includes(topSeg.id)) {
                              handleSegmentSelect({ metaKey: e.metaKey || e.ctrlKey, shiftKey: e.shiftKey } as any, topSeg.id);
                            }
                          }
                        };

                        // Attach this handler to the safe zone container
                        // We need to attach it to the parent or ensuring the parent has it


                        // Apply keyframe-based transforms on top of drag offset
                        let subKfTransform = '';
                        let subPivotX = 50;
                        let subPivotY = 50;
                        if (activeSubtitleEvent.keyframes && activeSubtitleEvent.keyframes.length > 0) {
                          const sourceTime = activeDialogueSeg ? activeDialogueSeg.startTime + (project.currentTime - activeDialogueSeg.timelineStart) : 0;
                          const subTime = sourceTime - activeSubtitleEvent.startTime;
                          const kfTransform = getInterpolatedTransform(activeSubtitleEvent.keyframes, subTime);
                          const kfParts: string[] = [];
                          if (kfTransform.translateX !== 0 || kfTransform.translateY !== 0) {
                            kfParts.push(`translate(${kfTransform.translateX * sz.w / 100}px, ${kfTransform.translateY * sz.h / 100}px)`);
                          }
                          if (kfTransform.scale !== 1) kfParts.push(`scale(${kfTransform.scale})`);
                          if (kfTransform.rotation !== 0) kfParts.push(`rotate(${kfTransform.rotation}deg)`);
                          subKfTransform = kfParts.join(' ');
                          subPivotX = kfTransform.pivotX;
                          subPivotY = kfTransform.pivotY;
                        }

                        const fullSubTransform = [subTransform, subKfTransform].filter(Boolean).join(' ') || undefined;

                        // Compute pivot-aware transform-origin for rotation/scale
                        let subPivotOrigin: string | undefined;
                        if (activeSubtitleEvent.pivotKeyframes && activeSubtitleEvent.pivotKeyframes.length > 0) {
                          const sourceTimePivot = activeDialogueSeg ? activeDialogueSeg.startTime + (project.currentTime - activeDialogueSeg.timelineStart) : 0;
                          const subTimePivot = sourceTimePivot - activeSubtitleEvent.startTime;
                          const pivot = getInterpolatedPivot(activeSubtitleEvent.pivotKeyframes, subTimePivot);
                          if (pivot && safeZoneRef.current && subtitleGizmoRef.current) {
                            const safeRect = safeZoneRef.current.getBoundingClientRect();
                            const elemRect = subtitleGizmoRef.current.getBoundingClientRect();
                            const pivPxX = (pivot.x / 100) * safeRect.width;
                            const pivPxY = (pivot.y / 100) * safeRect.height;
                            subPivotOrigin = `${pivPxX - (elemRect.left - safeRect.left)}px ${pivPxY - (elemRect.top - safeRect.top)}px`;
                          }
                        }

                        const containerStyle = {
                          ...styles.container,
                          transform: fullSubTransform,
                          transformOrigin: subPivotOrigin ?? `${subPivotX}% ${subPivotY}%`,
                          pointerEvents: 'auto' as const,
                          cursor: subtitleDragState ? 'grabbing' : 'grab',
                        };

                        // Resolve keyword animation cascade
                        const kwAnim = activeSubtitleEvent.keywordAnimation || subTemplate?.keywordAnimation || project.activeKeywordAnimation || null;

                        if (subAnim && subAnim.effects.length > 0) {
                          const sourceTime = activeDialogueSeg ? activeDialogueSeg.startTime + (project.currentTime - activeDialogueSeg.timelineStart) : 0;
                          const localFrame = Math.round((sourceTime - activeSubtitleEvent.startTime) * REMOTION_FPS);
                          const { fontSize: _tfs, ...tplStyleNoSize } = subTemplate?.style || {};
                          const mergedStyle = subTemplate ? { ...tplStyleNoSize, ...styles.text } : styles.text;
                          return (
                            <div ref={subtitleGizmoRef} style={containerStyle} onMouseDown={handleSubtitleMouseDown}>
                              <div style={{ display: 'grid' }}>
                                {styles.blendLayers.map((layerStyle, i) => (
                                  <AnimatedText
                                    key={`blend-${i}`}
                                    text={activeSubtitleEvent.details}
                                    animation={subAnim}
                                    style={layerStyle}
                                    frame={localFrame}
                                    fps={REMOTION_FPS}
                                    wordEmphases={activeSubtitleEvent.wordEmphases}
                                    keywordAnimation={kwAnim || undefined}
                                  />
                                ))}
                                <AnimatedText
                                  text={activeSubtitleEvent.details}
                                  animation={subAnim}
                                  style={{ ...mergedStyle, gridArea: '1 / 1 / 2 / 2' }}
                                  frame={localFrame}
                                  fps={REMOTION_FPS}
                                  wordEmphases={activeSubtitleEvent.wordEmphases}
                                  keywordAnimation={kwAnim || undefined}
                                  onWordClick={handleToggleSubtitleKeyword}
                                  wordHighlightStyle={displayStyle}
                                  sourceTime={sourceTime}
                                  eventStartTime={activeSubtitleEvent.startTime}
                                  eventEndTime={activeSubtitleEvent.endTime}
                                  wordTimings={activeSubtitleEvent.wordTimings}
                                />
                              </div>
                            </div>
                          );
                        }
                        // Fallback: plain text (no template applied)
                        // If word highlight is enabled, use AnimatedText with a no-op animation so it
                        // can measure word positions and render the highlight box.
                        const sourceTimeFb = activeDialogueSeg ? activeDialogueSeg.startTime + (project.currentTime - activeDialogueSeg.timelineStart) : 0;
                        if (displayStyle.wordHighlightEnabled) {
                          const noOpAnim = { scope: 'word' as const, effects: [], duration: 0, stagger: 0 };
                          return (
                            <div ref={subtitleGizmoRef} style={containerStyle} onMouseDown={handleSubtitleMouseDown}>
                              <AnimatedText
                                text={activeSubtitleEvent.details}
                                animation={noOpAnim}
                                style={styles.text}
                                frame={0}
                                fps={REMOTION_FPS}
                                wordEmphases={activeSubtitleEvent.wordEmphases}
                                onWordClick={handleToggleSubtitleKeyword}
                                wordHighlightStyle={displayStyle}
                                sourceTime={sourceTimeFb}
                                eventStartTime={activeSubtitleEvent.startTime}
                                eventEndTime={activeSubtitleEvent.endTime}
                                wordTimings={activeSubtitleEvent.wordTimings}
                              />
                            </div>
                          );
                        }
                        // Extract gradient for per-word application (can't use backgroundClip on box element)
                        const textGradientVal = (styles.text as any)['--text-gradient'] as string | undefined;
                        const gradientFill: React.CSSProperties = textGradientVal ? {
                          backgroundImage: textGradientVal,
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          color: 'transparent',
                        } as React.CSSProperties : {};
                        return (
                          <div style={containerStyle} onMouseDown={handleSubtitleMouseDown}>
                            <div style={{ display: 'grid' }}>
                              {styles.blendLayers.map((layerStyle, i) => (
                                <div key={`blend-${i}`} style={layerStyle}>
                                  {activeSubtitleEvent.details.split(/(\s+)/).map((token, k) => (
                                    <span key={k}>{token}</span>
                                  ))}
                                </div>
                              ))}
                              <div style={{ ...styles.text, gridArea: '1 / 1 / 2 / 2' }}>
                                {activeSubtitleEvent.details.split(/(\s+)/).map((token, i) => {
                                  if (/^\s+$/.test(token)) return <span key={i}>{token}</span>;
                                  const wordIdx = activeSubtitleEvent.details.split(/(\s+)/)
                                    .slice(0, i).filter(t => !/^\s+$/.test(t)).length;
                                  const kw = activeSubtitleEvent.wordEmphases?.find(k => k.wordIndex === wordIdx && k.enabled);
                                  return (
                                    <span key={i}
                                      onClick={(e) => { e.stopPropagation(); handleToggleSubtitleKeyword(wordIdx, token); }}
                                      style={{
                                        cursor: 'pointer',
                                        color: kw ? (kw.color || '#FFD700') : undefined,
                                        textDecoration: kw ? 'underline' : undefined,
                                        textDecorationColor: kw ? 'rgba(255,215,0,0.4)' : undefined,
                                        ...(!kw ? gradientFill : {}),
                                      }}
                                    >{token}</span>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Animated Title Layer Overlay */}
                      {project.titleLayer && project.currentTime >= project.titleLayer.startTime && project.currentTime <= project.titleLayer.endTime && (() => {
                        const t = project.currentTime - project.titleLayer.startTime;
                        const duration = project.titleLayer.endTime - project.titleLayer.startTime;

                        // Calculate opacity for fade in/out
                        let fadeOpacity = 1;
                        if (t < project.titleLayer.fadeInDuration) {
                          fadeOpacity = t / project.titleLayer.fadeInDuration;
                        } else if (t > duration - project.titleLayer.fadeOutDuration) {
                          fadeOpacity = (duration - t) / project.titleLayer.fadeOutDuration;
                        }

                        const titleStyle = project.titleLayer.style || project.titleStyle;
                        const computedStyles = getTitleStyles(titleStyle, fadeOpacity);

                        // Apply transforms if keyframes exist — use pixel values for crop-region-relative positioning
                        let transform = { translateX: 0, translateY: 0, scale: 1, rotation: 0, pivotX: 50, pivotY: 50 };
                        if (project.titleLayer.keyframes && project.titleLayer.keyframes.length > 0) {
                          transform = getCombinedTransform(project.titleLayer.keyframes, t, project.currentTime);
                        }
                        const titleTransformParts: string[] = [];
                        if (transform.translateX !== 0 || transform.translateY !== 0) {
                          titleTransformParts.push(`translate(${transform.translateX * sz.w / 100}px, ${transform.translateY * sz.h / 100}px)`);
                        }
                        if (transform.scale !== 1) titleTransformParts.push(`scale(${transform.scale})`);
                        if (transform.rotation !== 0) titleTransformParts.push(`rotate(${transform.rotation}deg)`);
                        const cssTransform = titleTransformParts.length > 0 ? titleTransformParts.join(' ') : 'none';

                        // Drag handler for title movement
                        const handleTitleMouseDown = (e: React.MouseEvent) => {
                          e.stopPropagation();
                          setTitleDragState({
                            startX: e.clientX, startY: e.clientY,
                            origTx: transform.translateX, origTy: transform.translateY,
                          });
                        };

                        // Compute pivot-aware transform-origin for title
                        let titlePivotOrigin = 'center center';
                        if (project.titleLayer.pivotKeyframes && project.titleLayer.pivotKeyframes.length > 0) {
                          const titlePivot = getInterpolatedPivot(project.titleLayer.pivotKeyframes, t);
                          if (titlePivot && safeZoneRef.current && titleGizmoRef.current) {
                            const safeRect = safeZoneRef.current.getBoundingClientRect();
                            const titleRect = titleGizmoRef.current.getBoundingClientRect();
                            const pivPxX = (titlePivot.x / 100) * safeRect.width;
                            const pivPxY = (titlePivot.y / 100) * safeRect.height;
                            titlePivotOrigin = `${pivPxX - (titleRect.left - safeRect.left)}px ${pivPxY - (titleRect.top - safeRect.top)}px`;
                          }
                        }

                        const titleContainerStyle = {
                          ...computedStyles.container,
                          transform: cssTransform,
                          transformOrigin: titlePivotOrigin !== 'center center' ? titlePivotOrigin : `${transform.pivotX}% ${transform.pivotY}%`,
                          pointerEvents: 'auto' as const,
                          cursor: titleDragState ? 'grabbing' : 'grab',
                        };

                        // Use AnimatedText if the title has an animation with effects
                        const titleAnim = project.titleLayer.animation ?? project.activeTitleTemplate?.animation;
                        if (titleAnim && titleAnim.effects.length > 0) {
                          const localFrame = Math.round(t * REMOTION_FPS);
                          return (
                            <div ref={titleGizmoRef} style={titleContainerStyle} onMouseDown={handleTitleMouseDown}>
                              <div style={{ display: 'grid' }}>
                                {computedStyles.blendLayers?.map((layerStyle, i) => (
                                  <AnimatedText
                                    key={`blend-title-${i}`}
                                    text={project.titleLayer!.text}
                                    animation={titleAnim}
                                    style={layerStyle}
                                    frame={localFrame}
                                    fps={REMOTION_FPS}
                                  />
                                ))}
                                <AnimatedText
                                  text={project.titleLayer.text}
                                  animation={titleAnim}
                                  style={{ ...computedStyles.text, gridArea: '1 / 1 / 2 / 2' }}
                                  frame={localFrame}
                                  fps={REMOTION_FPS}
                                />
                              </div>
                            </div>
                          );
                        }

                        // Fallback: plain text (no animation set)
                        const titleGradientVal = (computedStyles.text as any)['--text-gradient'] as string | undefined;
                        const titleGradientFill: React.CSSProperties = titleGradientVal ? {
                          backgroundImage: titleGradientVal,
                          WebkitBackgroundClip: 'text',
                          backgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          color: 'transparent',
                        } as React.CSSProperties : {};
                        return (
                          <div ref={titleGizmoRef} style={titleContainerStyle} onMouseDown={handleTitleMouseDown}>
                            <div style={{ display: 'grid' }}>
                              {computedStyles.blendLayers?.map((layerStyle, i) => (
                                <div key={`blend-title-${i}`} style={layerStyle}>
                                  <span>{project.titleLayer!.text}</span>
                                </div>
                              ))}
                              <div style={{ ...computedStyles.text, gridArea: '1 / 1 / 2 / 2' }}>
                                <span style={titleGradientFill}>{project.titleLayer.text}</span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}


                      {/* Active template indicator */}
                      {project.activeSubtitleTemplate && (
                        <div style={{
                          position: 'absolute', top: 6, right: 6, zIndex: 10001,
                          background: 'rgba(79,70,229,0.85)', borderRadius: 4,
                          padding: '2px 8px', pointerEvents: 'none',
                          fontSize: 9, color: '#e5e7eb', fontWeight: 600,
                          backdropFilter: 'blur(4px)',
                        }}>
                          FX: {project.activeSubtitleTemplate.name}
                        </div>
                      )}

                      {/* Viewport Gizmo Overlay */}
                      {(() => {
                        const gizmoTarget = getGizmoTarget();
                        if (!gizmoTarget.type || activeRightTab === 'tracking') return null;

                        let gizmoTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0, pivotX: 50, pivotY: 50 };
                        let elemBounds = { width: sz.w, height: sz.h };
                        let elemCenter = { x: sz.w / 2, y: sz.h / 2 };
                        // cropDims for drag delta conversion — overridden for clips
                        let gizmoCropDims = cropDims;

                        if (gizmoTarget.type === 'clip' && primarySelectedSegment) {
                          const clipTime = project.currentTime - primarySelectedSegment.timelineStart;
                          const t = getCombinedTransform(primarySelectedSegment.keyframes, clipTime, project.currentTime);
                          gizmoTransform = { ...t, pivotX: t.pivotX ?? 50, pivotY: t.pivotY ?? 50 };
                          // Compute displayed video size using same math as the CSS transform (object-contain within full viewport)
                          const vidEl = videoRefs.current.get(primarySelectedSegment.id);
                          const vw = vidEl?.videoWidth || 1920;
                          const vh = vidEl?.videoHeight || 1080;
                          const videoAR = vw / vh;
                          const containerAR = viewportSize.width / (viewportSize.height || 1);
                          const displayW = containerAR > videoAR ? viewportSize.height * videoAR : viewportSize.width;
                          const displayH = containerAR > videoAR ? viewportSize.height : viewportSize.width / videoAR;
                          elemBounds = { width: displayW, height: displayH };
                          // Video center in safe-zone-relative coordinates
                          // (video is in viewport space, safe zone is offset by sz.x/sz.y)
                          elemCenter = {
                            x: (viewportSize.width / 2 - sz.x) + t.translateX * displayW / 100,
                            y: (viewportSize.height / 2 - sz.y) + t.translateY * displayH / 100,
                          };
                          // Drag delta must use video display dims, not safe zone dims
                          gizmoCropDims = { width: displayW, height: displayH };
                        } else if (gizmoTarget.type === 'title' && project.titleLayer) {
                          const t2 = project.currentTime - project.titleLayer.startTime;
                          const tTransform = project.titleLayer.keyframes?.length
                            ? getCombinedTransform(project.titleLayer.keyframes, t2, project.currentTime)
                            : { translateX: 0, translateY: 0, scale: 1, rotation: 0, pivotX: 50, pivotY: 50 };
                          gizmoTransform = { ...tTransform, pivotX: tTransform.pivotX ?? 50, pivotY: tTransform.pivotY ?? 50 };
                          elemBounds = { width: sz.w * 0.8, height: 60 };
                          elemCenter = {
                            x: sz.w / 2 + tTransform.translateX * sz.w / 100,
                            y: sz.h / 2 + tTransform.translateY * sz.h / 100,
                          };
                        } else if (gizmoTarget.type === 'subtitle' && activeSubtitleEvent) {
                          const subTxG = activeSubtitleEvent.translateX || 0;
                          const subTyG = activeSubtitleEvent.translateY || 0;
                          let subInterp = { translateX: 0, translateY: 0, scale: 1, rotation: 0, pivotX: 50, pivotY: 50 };
                          if (activeSubtitleEvent.keyframes?.length) {
                            const visualSegsG = activeSegments.filter(s => s.type !== 'audio');
                            const topSegG = visualSegsG.length > 0 ? visualSegsG[visualSegsG.length - 1] : activeSegments[activeSegments.length - 1];
                            const srcTime = topSegG ? topSegG.startTime + (project.currentTime - topSegG.timelineStart) : 0;
                            const sTime = srcTime - activeSubtitleEvent.startTime;
                            subInterp = getInterpolatedTransform(activeSubtitleEvent.keyframes, sTime);
                          }
                          gizmoTransform = { ...subInterp, pivotX: subInterp.pivotX ?? 50, pivotY: subInterp.pivotY ?? 50 };
                          elemBounds = { width: sz.w * 0.6, height: 40 };
                          elemCenter = {
                            x: sz.w / 2 + (subTxG + subInterp.translateX) * sz.w / 100,
                            y: sz.h * 0.85 + (subTyG + subInterp.translateY) * sz.h / 100,
                          };
                        }

                        return (
                          <GizmoOverlay
                            targetType={gizmoTarget.type}
                            transform={gizmoTransform}
                            viewportSize={{ width: sz.w, height: sz.h }}
                            cropDims={gizmoCropDims}
                            elementBounds={elemBounds}
                            elementCenter={elemCenter}
                            zoom={activeRightTab === 'tracking' ? trackingZoom : 1}
                            isPlaying={project.isPlaying}
                            onTranslate={handleGizmoTranslate}
                            onScale={handleGizmoScale}
                            onRotate={handleGizmoRotate}
                            onPivotMove={handleGizmoPivotMove}
                            onDragStart={handleGizmoDragStart}
                            onDragEnd={handleGizmoDragEnd}
                          />
                        );
                      })()}

                      {/* Auto-pivot progress overlay */}
                      {autoPivotProgress && (
                        <div style={{
                          position: 'absolute', inset: 0, zIndex: 10002,
                          background: 'rgba(0,0,0,0.7)', display: 'flex',
                          flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                          pointerEvents: 'auto',
                        }}>
                          <div style={{ color: '#fff', fontSize: 14, marginBottom: 12 }}>
                            {autoPivotProgress.label}
                          </div>
                          <div style={{ width: 200, height: 4, background: '#333', borderRadius: 2 }}>
                            <div style={{
                              width: `${Math.round(autoPivotProgress.progress * 100)}%`,
                              height: '100%', background: '#06b6d4', borderRadius: 2,
                              transition: 'width 0.3s ease',
                            }} />
                          </div>
                        </div>
                      )}

                    </div>
                  );
                })()}

              </div>
              </div>
            ) : (
              <div ref={viewportContainerRef} className="flex-1 relative overflow-hidden flex items-center justify-center">
                <RemotionPreview
                  width={viewportSize.width || 640}
                  height={viewportSize.height || 360}
                  durationInSeconds={contentDuration || 10}
                  compositionWidth={viewportSettings.previewAspectRatio === '9:16' ? 1080 : 1920}
                  compositionHeight={viewportSettings.previewAspectRatio === '9:16' ? 1920 : 1080}
                  videoProps={{
                    segments: project.segments,
                    events: currentTopMedia?.analysis?.events || [],
                    subtitleStyle: project.subtitleStyle,
                    titleStyle: project.titleStyle,
                    titleLayer: project.titleLayer,
                    activeSubtitleTemplate: project.activeSubtitleTemplate,
                    activeTitleTemplate: project.activeTitleTemplate,
                    activeKeywordAnimation: project.activeKeywordAnimation,
                    fps: REMOTION_FPS,
                  }}
                />
              </div>
            )}

            {/* TRANSPORT CONTROLS */}
            <div className="h-14 border-t border-[#333] bg-[#1e1e1e] flex items-center justify-between px-4 gap-4 z-[1000]">
              {/* Left: Aspect Ratio Controls + Undo/Redo */}
              <div className="flex items-center gap-2">
                {/* Undo/Redo */}
                <button
                  onClick={handleUndo}
                  disabled={undoStack.length === 0}
                  className={`px-2 py-1 text-xs rounded ${undoStack.length > 0 ? 'bg-[#333] text-gray-300 hover:text-white hover:bg-[#444]' : 'bg-[#222] text-gray-600 cursor-not-allowed'}`}
                  title="Undo (Ctrl+Z)"
                >
                  ↩️ Undo
                </button>
                <button
                  onClick={handleRedo}
                  disabled={redoStack.length === 0}
                  className={`px-2 py-1 text-xs rounded ${redoStack.length > 0 ? 'bg-[#333] text-gray-300 hover:text-white hover:bg-[#444]' : 'bg-[#222] text-gray-600 cursor-not-allowed'}`}
                  title="Redo (Ctrl+Y)"
                >
                  ↪️ Redo
                </button>
                <div className="w-px h-6 bg-[#444] mx-1"></div>
                <button
                  onClick={() => setShowGizmos(prev => !prev)}
                  className={`px-2 py-1 text-xs rounded font-medium ${showGizmos ? 'bg-blue-600/40 text-blue-300 border border-blue-500/50' : 'bg-[#333] text-gray-400 border border-[#444] hover:text-white'}`}
                  title="Toggle Transform Gizmos (move/rotate/scale handles)"
                >
                  Gizmos
                </button>
                <button
                  onClick={() => setViewportSettings(prev => ({ ...prev, showOverlay: !prev.showOverlay }))}
                  className={`px-2 py-1 text-xs rounded ${viewportSettings.showOverlay ? 'bg-blue-600 text-white' : 'bg-[#333] text-gray-400 hover:text-white'}`}
                  title="Toggle aspect ratio overlay"
                >
                  📐 {viewportSettings.previewAspectRatio}
                </button>
                <select
                  value={viewportSettings.previewAspectRatio}
                  onChange={e => setViewportSettings(prev => ({ ...prev, previewAspectRatio: e.target.value as AspectRatioPreset }))}
                  className="bg-[#333] text-xs text-gray-300 border border-[#444] rounded px-2 py-1"
                >
                  <option value="16:9">16:9 Landscape</option>
                  <option value="9:16">9:16 Portrait</option>
                  <option value="1:1">1:1 Square</option>
                  <option value="4:5">4:5 Instagram</option>
                </select>
              </div>

              {/* Center: Playback Controls */}
              <div className="flex items-center gap-4">
                {/* Previous */}
                <div className="flex items-center gap-1">
                  <button onClick={() => jumpClip('prev')} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg></button>
                  <button onClick={() => jumpFrame(-1)} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M11 16.07V7.93l-6 4.14zm5-8.14v8.14l-6-4.14z" /></svg></button>
                </div>

                {/* Play/Stop */}
                <button onClick={handlePlayPause} className="w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center shadow-lg transition-transform active:scale-95">
                  {project.isPlaying ?
                    <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg> :
                    <svg className="w-5 h-5 text-white pl-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  }
                </button>

                {/* Next */}
                <div className="flex items-center gap-1">
                  <button onClick={() => jumpFrame(1)} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M13 7.93v8.14l6-4.14zm-5 8.14V7.93l6 4.14z" /></svg></button>
                  <button onClick={() => jumpClip('next')} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg></button>
                </div>
              </div>

              {/* Right: Export, Graph Editor & Remotion Toggle */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setViewportMode(prev => prev === 'standard' ? 'remotion' : 'standard')}
                  className={`px-2 py-1 text-xs rounded ${viewportMode === 'remotion' ? 'bg-purple-600 text-white' : 'bg-[#333] text-gray-400 hover:text-white'}`}
                  title="Toggle Remotion Preview"
                >
                  Remotion
                </button>
                <button
                  onClick={() => setActiveBottomTab(prev => prev === 'graph' ? 'timeline' : 'graph')}
                  className={`px-2 py-1 text-xs rounded ${activeBottomTab === 'graph' ? 'bg-orange-600 text-white' : 'bg-[#333] text-gray-400 hover:text-white'}`}
                  title="Toggle Graph Editor"
                >
                  📈 Graph
                </button>
                <button
                  onClick={() => setShowSettings(true)}
                  className="px-2 py-1 text-xs rounded bg-[#333] text-gray-400 hover:text-white"
                  title="API Key Settings"
                >
                  ⚙️ Settings
                </button>
                <button
                  onClick={() => setShowExportModal(true)}
                  className="px-3 py-1 text-xs rounded bg-green-600 hover:bg-green-500 text-white font-medium"
                >
                  📹 Export
                </button>
              </div>
            </div>
          </div>

          {/* Right Panel Resize Handle */}
          <ResizeHandle direction="horizontal" onResize={handleRightResize} onDoubleClick={() => setRightPanelWidth(320)} />

          {/* Right Panels (Tabs) */}
          <div className="flex-shrink-0 flex flex-col bg-[#1e1e1e]" style={{ width: rightPanelWidth }}>
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex border-b border-[#333] bg-[#252525]">
                <button onClick={() => setActiveRightTab('transcript')} className={`flex-1 py-2 text-[10px] font-bold tracking-tight ${activeRightTab === 'transcript' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>TRANSCRIPT</button>
                <button onClick={() => setActiveRightTab('templates')} className={`flex-1 py-2 text-[10px] font-bold tracking-tight ${activeRightTab === 'templates' ? 'bg-[#333] text-purple-400 border-b-2 border-purple-400' : 'text-gray-400'}`}>TEMPLATES</button>
                <button onClick={() => setActiveRightTab('transitions')} className={`flex-1 py-2 text-[10px] font-bold tracking-tight ${activeRightTab === 'transitions' ? 'bg-[#333] text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-400'}`}>TRANS.</button>
                <button onClick={() => setActiveRightTab('tracking')} className={`flex-1 py-2 text-[10px] font-bold tracking-tight ${activeRightTab === 'tracking' ? 'bg-[#333] text-green-400 border-b-2 border-green-400' : 'text-gray-400'}`}>TRACKING</button>
                <button onClick={() => setActiveRightTab('render')} className={`flex-1 py-2 text-[10px] font-bold tracking-tight ${activeRightTab === 'render' ? 'bg-[#333] text-orange-400 border-b-2 border-orange-400' : 'text-gray-400'}`}>RENDER</button>
              </div>
              <div className="flex-1 overflow-hidden">
                {activeRightTab === 'templates' && (
                  <TemplateManager
                    currentSubtitleStyle={project.subtitleStyle}
                    activeTemplate={effectiveSubtitleTemplate}
                    activeKeywordAnimation={isTemplateUnlinked ? (selectedDialogueEvent?.keywordAnimation || project.activeKeywordAnimation) : project.activeKeywordAnimation}
                    onApplyToKeywords={(anim: TextAnimation) => handleUpdateKeywordAnimation({ ...anim, scope: 'word' })}
                    onClearKeywordAnimation={() => handleUpdateKeywordAnimation(null)}
                    onApply={handleUpdateSubtitleTemplate}
                    onClear={() => {
                      if (isTemplateUnlinked) {
                        if (selectedDialogue) {
                          const media = project.library.find(m => m.id === selectedDialogue.mediaId);
                          const current = media?.analysis?.events[selectedDialogue.index];
                          if (current) {
                            pushUndo({ type: 'dialogueEvent', mediaId: selectedDialogue.mediaId, index: selectedDialogue.index, event: { ...current } });
                          }
                        }
                        updateSelectedEvent(evt => {
                          const { templateOverride, ...rest } = evt;
                          return rest;
                        });
                      } else {
                        pushUndo({ type: 'subtitleTemplate', template: project.activeSubtitleTemplate });
                        setProject(p => ({ ...p, activeSubtitleTemplate: null }));
                      }
                    }}
                  />
                )}
                {activeRightTab === 'transitions' && (
                  <TransitionPanel
                    selectedSegment={primarySelectedSegment || null}
                    selectedTransition={selectedTransition}
                    segments={project.segments}
                    onApplyTransition={(segId, side, t) => handleUpdateTransition(segId, side, t)}
                    onRemoveTransition={(segId, side) => handleUpdateTransition(segId, side, undefined)}
                    onSelectTransitionEdge={(segId, side) => setSelectedTransition({ segId, side })}
                  />
                )}
                {activeRightTab === 'transcript' && (() => {
                  const transcriptMedia = currentTopMedia || project.library.find(m => m.id === selectedMediaId);

                  // Calculate the source time corresponding to the current timeline time for highlighting
                  let sourceTime = project.currentTime;
                  if (activeSegments.length > 0) {
                    const topSeg = activeSegments[activeSegments.length - 1];
                    if (topSeg.mediaId === transcriptMedia?.id) {
                      sourceTime = topSeg.startTime + (project.currentTime - topSeg.timelineStart);
                    }
                  }

                  return (
                    <TranscriptPanel
                      analysis={transcriptMedia?.analysis || null}
                      mediaId={transcriptMedia?.id}
                      currentTime={sourceTime}
                      onSeek={(t) => {
                        if (transcriptMedia) {
                          const segs = project.segments.filter(s => s.mediaId === transcriptMedia.id);
                          if (segs.length > 0) {
                            let target = segs.find(s => t >= s.startTime && t < s.endTime);
                            if (!target) {
                              target = [...segs].sort((a, b) => Math.abs(a.startTime - t) - Math.abs(b.startTime - t))[0];
                            }
                            if (target) {
                              const timelineTime = (t - target.startTime) + target.timelineStart;
                              setProject(p => ({ ...p, currentTime: Math.max(0, timelineTime) }));
                              return;
                            }
                          }
                        }
                        setProject(p => ({ ...p, currentTime: t }));
                      }}
                      onSelect={(idx) => transcriptMedia && handleDialogueSelect(transcriptMedia.id, idx)}
                      selectedIndex={selectedDialogue?.mediaId === transcriptMedia?.id ? selectedDialogue.index : null}
                      removedWords={project.removedWords}
                      onRemoveWords={(words) => handleRemoveTranscriptWords(words)}
                      onRestoreWord={handleRestoreTranscriptWord}
                      transcriptSource={transcriptMedia?.transcriptSource}
                      transcriptionJob={transcriptMedia ? transcriptionJobs.get(transcriptMedia.id) : undefined}
                      onTranscribe={transcriptMedia ? () => handleTranscribeWithAssemblyAI(transcriptMedia.id) : undefined}
                    />
                  );
                })()}
                {activeRightTab === 'tracking' && (
                  <TrackingPanel
                    selectedSegment={primarySelectedSegment}
                    trackingMode={trackingMode}
                    onSetTrackingMode={setTrackingMode}
                    selectedTrackerId={selectedTrackerId}
                    onSelectTracker={setSelectedTrackerId}
                    onUpdateTracker={handleUpdateTracker}
                    onDeleteTracker={handleDeleteTracker}
                    onStartTracking={handleStartTracking}
                    onStopTracking={handleStopTracking}
                    onApplyStabilization={handleApplyStabilization}
                    onApplyToSegment={handleApplyToSegment}
                    onApplyToTitle={handleApplyToTitle}
                    onClearTracking={handleClearTracking}
                    onClearTrackingData={handleClearTrackingData}
                    trackingProgress={trackingProgress}
                    onTrackHeadPivot={handleTrackHeadPivot}
                    pivotTrackingProgress={pivotTrackingProgress}
                    onAutoPivotToHead={handleAutoPivotToHead}
                    autoPivotProgress={autoPivotProgress}
                  />
                )}
                {activeRightTab === 'render' && (
                  <RenderQueuePanel />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Panel Resize Handle */}
        <ResizeHandle direction="vertical" onResize={handleBottomResize} onDoubleClick={() => setBottomPanelHeight(500)} className="z-20" />

        {/* Timeline/Graph Section */}
        <div className="flex-shrink-0 flex flex-col shadow-[0_-4px_10px_rgba(0,0,0,0.3)] z-10" style={{ height: bottomPanelHeight }}>
          {/* Tab Header */}
          <div className="h-10 bg-[#252525] border-y border-[#333] flex items-center px-4 gap-4">
            <div className="flex gap-1">
              <button
                onClick={() => setActiveBottomTab('timeline')}
                className={`px-3 py-1 text-xs font-bold rounded-t ${activeBottomTab === 'timeline' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400 hover:text-white'}`}
              >
                Timeline
              </button>
              <button
                onClick={() => setActiveBottomTab('graph')}
                className={`px-3 py-1 text-xs font-bold rounded-t ${activeBottomTab === 'graph' ? 'bg-[#333] text-orange-400 border-b-2 border-orange-400' : 'text-gray-400 hover:text-white'}`}
              >
                Graph Editor
              </button>
            </div>
            {activeBottomTab === 'timeline' && (
              <>
                {selectedDialogues.length >= 2 && (
                  <button onClick={handleMergeDialogues} className="px-2 py-1 text-xs font-bold bg-purple-600 text-white rounded hover:bg-purple-500">
                    Merge {selectedDialogues.length} Subtitles
                  </button>
                )}
                {/* AI Cost Tracker Badge */}
                <div className="relative ml-auto">
                  <button
                    onClick={() => setShowCostPanel(p => !p)}
                    className={`px-2 py-1 rounded text-xs font-mono font-bold border ${costTotal >= 2 ? 'border-red-500 text-red-400 bg-red-500/10' :
                      costTotal >= 0.50 ? 'border-yellow-500 text-yellow-400 bg-yellow-500/10' :
                        'border-green-600 text-green-400 bg-green-500/10'
                      }`}
                    title="AI cost this session (estimated)"
                  >
                    ${costTotal.toFixed(4)}
                  </button>
                  {showCostPanel && (
                    <div className="absolute bottom-full right-0 mb-1 w-80 max-h-64 overflow-y-auto bg-[#1a1a1a] border border-[#444] rounded-lg shadow-xl z-50 text-xs">
                      <div className="sticky top-0 bg-[#1a1a1a] p-2 border-b border-[#333] flex items-center justify-between">
                        <span className="font-bold text-white">AI Cost Log</span>
                        <button onClick={() => { clearSession().then(() => { setCostTotal(0); setCostLog([]); }); }} className="text-gray-400 hover:text-red-400 text-[10px]">Clear</button>
                      </div>
                      {costLog.length === 0 ? (
                        <div className="p-3 text-gray-500 text-center">No AI calls yet</div>
                      ) : (
                        <div className="divide-y divide-[#333]">
                          {[...costLog].reverse().map(e => (
                            <div key={e.id} className="px-2 py-1.5 flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="font-bold text-white truncate">{e.operation}</div>
                                <div className="text-gray-500">{e.model} &middot; {e.inputTokens.toLocaleString()} in / {e.outputTokens.toLocaleString()} out</div>
                              </div>
                              <div className="font-mono text-green-400 whitespace-nowrap">${e.estimatedCost.toFixed(4)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="sticky bottom-0 bg-[#1a1a1a] p-2 border-t border-[#333] flex justify-between font-bold">
                        <span className="text-white">Session Total</span>
                        <span className={`font-mono ${costTotal >= 2 ? 'text-red-400' : costTotal >= 0.50 ? 'text-yellow-400' : 'text-green-400'}`}>${costTotal.toFixed(4)}</span>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            {activeBottomTab === 'graph' && primarySelectedSegment && (
              <div className="text-xs text-gray-400">
                Editing: <span className="text-white font-medium">{primarySelectedSegment.description}</span>
                <span className="ml-4">Keyframes: {primarySelectedSegment.keyframes?.length || 0}</span>
              </div>
            )}
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-hidden">
            {activeBottomTab === 'timeline' && (
              <Timeline
                duration={timelineViewDuration}
                currentTime={project.currentTime}
                segments={project.segments}
                analyses={Object.fromEntries(project.library.map(m => [m.id, m.analysis]))}
                rippleMode={rippleMode}
                snappingEnabled={snappingEnabled}
                selectedSegmentIds={selectedSegmentIds}
                onSeek={t => setProject(p => ({ ...p, currentTime: t }))}
                onSegmentSelect={handleSegmentSelect}
                onSplit={handleSplit}
                onUpdateSegments={handleUpdateSegments}
                onDeleteSegment={id => performDelete([id], rippleMode)}
                onToggleRipple={() => setRippleMode(!rippleMode)}
                onToggleSnapping={() => setSnappingEnabled(!snappingEnabled)}
                onEditTransition={handleTransitionSelect}
                onDialogueSelect={handleDialogueSelect}
                selectedDialogues={selectedDialogues}
                onUpdateDialogue={handleUpdateDialogue}
                onDeleteDialogue={handleDeleteDialogue}
                onDialogueDragStart={(mediaId, index, originalEvent) => {
                  pushUndo({ type: 'dialogueEvent', mediaId, index, event: { ...originalEvent } });
                }}
                titleLayer={project.titleLayer}
                onTitleSelect={handleTitleSelect}
                onUpdateTitle={handleUpdateTitleLayer}
                onInsertBlank={handleInsertBlank}
                zoom={timelineZoom}
                onZoomChange={safeSetTimelineZoom}
                mediaFiles={mediaFilesMap}
                onUnlinkAudio={handleUnlinkAudio}
                onRelinkAudio={handleRelinkAudio}
                onDeleteTrack={handleDeleteTrack}
                onSwapTracks={handleSwapTracks}
                selectedInsertTrack={selectedInsertTrack}
                onSelectInsertTrack={(id) => setSelectedInsertTrack(prev => prev === id ? null : id)}
              />
            )}
            {activeBottomTab === 'graph' && (
              <div className="flex flex-col h-full">
                {/* Transform Target Selector */}
                <div className="flex items-center gap-2 px-3 py-2 bg-[#1e1e1e] border-b border-[#333]">
                  <span className="text-xs text-gray-400">Transform Target:</span>
                  <select
                    value={transformTarget}
                    onChange={(e) => setTransformTarget(e.target.value)}
                    className="bg-[#333] text-xs text-gray-300 border border-[#444] rounded px-2 py-1"
                  >
                    <option value="global">🌐 Global (Root)</option>
                    {project.titleLayer && (
                      <option value="title_layer">Title Layer</option>
                    )}
                    {selectedDialogueEvent && selectedDialogue && (
                      <option value={`subtitle_${selectedDialogue.mediaId}_${selectedDialogue.index}`}>
                        💬 Subtitle: {selectedDialogueEvent.details.slice(0, 25)}{selectedDialogueEvent.details.length > 25 ? '…' : ''}
                      </option>
                    )}
                    {project.segments
                      .slice()
                      .sort((a, b) => a.timelineStart - b.timelineStart)
                      .map((seg, idx) => (
                        <option key={seg.id} value={seg.id}>
                          {idx + 1} Clip: {project.library.find(m => m.id === seg.mediaId)?.name?.slice(0, 20) || seg.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                  {transformTarget === 'global' && (
                    <span className="text-xs text-yellow-400 ml-2">⚡ Affects all clips</span>
                  )}
                  {transformTarget.startsWith('subtitle_') && (
                    <span className="text-xs text-purple-400 ml-2">💬 Subtitle transform</span>
                  )}
                </div>
                <div className="flex-1">
                  <GraphEditor
                    visible={true}
                    onClose={() => setActiveBottomTab('timeline')}
                    segment={transformTarget === 'global' || transformTarget === 'title_layer' || transformTarget.startsWith('subtitle_') ? null : project.segments.find(s => s.id === transformTarget) || primarySelectedSegment}
                    segmentDuration={(() => {
                      if (transformTarget === 'global') return contentDuration;
                      if (transformTarget === 'title_layer' && project.titleLayer) return project.titleLayer.endTime - project.titleLayer.startTime;
                      if (transformTarget.startsWith('subtitle_')) {
                        const parts = transformTarget.split('_');
                        const mediaId = parts[1];
                        const idx = parseInt(parts[2]);
                        const media = project.library.find(m => m.id === mediaId);
                        const evt = media?.analysis?.events[idx];
                        if (evt) return evt.endTime - evt.startTime;
                      }
                      const seg = project.segments.find(s => s.id === transformTarget);
                      if (seg) return seg.endTime - seg.startTime;
                      return graphEditorSegmentDuration;
                    })()}
                    currentTime={(() => {
                      if (transformTarget === 'global') return project.currentTime;
                      if (transformTarget === 'title_layer' && project.titleLayer) return Math.max(0, project.currentTime - project.titleLayer.startTime);
                      if (transformTarget.startsWith('subtitle_')) {
                        const parts = transformTarget.split('_');
                        const mediaId = parts[1];
                        const idx = parseInt(parts[2]);
                        const media = project.library.find(m => m.id === mediaId);
                        const evt = media?.analysis?.events[idx];
                        if (evt) {
                          // Find source time based on active segment
                          const topSeg = project.segments.find(s => {
                            const m = project.library.find(lib => lib.id === s.mediaId);
                            return m?.id === mediaId;
                          });
                          const sourceTime = topSeg ? topSeg.startTime + (project.currentTime - topSeg.timelineStart) : project.currentTime;
                          return Math.max(0, sourceTime - evt.startTime);
                        }
                      }
                      const seg = project.segments.find(s => s.id === transformTarget);
                      if (seg) return Math.max(0, project.currentTime - seg.timelineStart);
                      return graphEditorClipTime;
                    })()}
                    keyframes={(() => {
                      if (transformTarget === 'global') return globalKeyframes;
                      if (transformTarget === 'title_layer') return project.titleLayer?.keyframes || [];
                      if (transformTarget.startsWith('subtitle_')) {
                        const parts = transformTarget.split('_');
                        const mediaId = parts[1];
                        const idx = parseInt(parts[2]);
                        const media = project.library.find(m => m.id === mediaId);
                        return media?.analysis?.events[idx]?.keyframes || [];
                      }
                      return project.segments.find(s => s.id === transformTarget)?.keyframes || primarySelectedSegment?.keyframes;
                    })()}
                    isGlobalMode={transformTarget === 'global' || transformTarget === 'title_layer' || transformTarget.startsWith('subtitle_')}
                    onSeek={(time) => {
                      if (transformTarget === 'global') {
                        setProject(p => ({ ...p, currentTime: time }));
                      } else if (transformTarget === 'title_layer' && project.titleLayer) {
                        setProject(p => ({ ...p, currentTime: (p.titleLayer?.startTime || 0) + time }));
                      } else if (transformTarget.startsWith('subtitle_')) {
                        const parts = transformTarget.split('_');
                        const mediaId = parts[1];
                        const idx = parseInt(parts[2]);
                        const media = project.library.find(m => m.id === mediaId);
                        const evt = media?.analysis?.events[idx];
                        if (evt) {
                          const topSeg = project.segments.find(s => project.library.find(lib => lib.id === s.mediaId)?.id === mediaId);
                          if (topSeg) {
                            const sourceTime = evt.startTime + time;
                            const timelineTime = topSeg.timelineStart + (sourceTime - topSeg.startTime);
                            setProject(p => ({ ...p, currentTime: timelineTime }));
                          }
                        }
                      } else {
                        const seg = project.segments.find(s => s.id === transformTarget) || primarySelectedSegment;
                        if (seg) {
                          const timelineTime = seg.timelineStart + time;
                          setProject(p => ({ ...p, currentTime: timelineTime }));
                        }
                      }
                    }}
                    onUpdateKeyframes={(keyframes) => {
                      if (transformTarget === 'global') {
                        handleUpdateKeyframes('global', keyframes);
                      } else if (transformTarget === 'title_layer') {
                        handleUpdateTitleLayer({ keyframes });
                      } else if (transformTarget.startsWith('subtitle_')) {
                        const parts = transformTarget.split('_');
                        const mediaId = parts[1];
                        const idx = parseInt(parts[2]);
                        const media = project.library.find(m => m.id === mediaId);
                        const evt = media?.analysis?.events[idx];
                        if (evt) {
                          handleUpdateDialogue(mediaId, idx, { ...evt, keyframes });
                        }
                      } else {
                        const segId = transformTarget !== 'global' ? transformTarget : primarySelectedSegment?.id;
                        if (segId) {
                          handleUpdateKeyframes(segId, keyframes);
                        }
                      }
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Settings Modal */}
      <SettingsPanel isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Export Modal */}
      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        onExport={handleAddToRenderQueue}
        duration={contentDuration}
      />

      {showYoutubeModal && (
        <YoutubeImportModal
          onImport={handleYoutubeImport}
          onCancel={() => setShowYoutubeModal(false)}
          status={status}
        />
      )}

      {showFillerModal && fillerDetections.length > 0 && (
        <FillerConfirmModal
          detections={fillerDetections}
          onConfirm={handleConfirmFillerClean}
          onRedetect={handleRedetectFillers}
          onCancel={() => { setShowFillerModal(false); setFillerDetections([]); }}
          hasCachedData={project.library.some(m => (m.fillerDetections?.length ?? 0) > 0)}
        />
      )}
    </div>
  );
}

export default App;
