import React, { useState, useRef, useEffect, useMemo } from 'react';
import Timeline from './components/Timeline';
import ChatPanel from './components/ChatPanel';
import TranscriptPanel from './components/TranscriptPanel';
import PropertiesPanel from './components/PropertiesPanel';
import MediaBin from './components/MediaBin';
import ViewportOverlay from './components/ViewportOverlay';
import ExportModal from './components/ExportModal';
import GraphEditor from './components/GraphEditor';
import { ProjectState, Segment, ChatMessage, ProcessingStatus, MediaItem, TransitionType, Transition, SubtitleStyle, TitleStyle, TitleLayer, AnalysisEvent, ViewportSettings, ClipKeyframe, ExportSettings, AspectRatioPreset } from './types';
import { analyzeVideoContent, generateVibeEdit, chatWithVideoContext, transcribeAudio, performDeepAnalysis } from './services/geminiService';
import { YoutubeImportModal } from './components/YoutubeImportModal';
import ContentLibraryPage from './pages/ContentLibraryPage';
import { GeneratedShort, contentDB } from './services/contentDatabase';
import { getInterpolatedTransform, transformToCss, ASPECT_RATIO_PRESETS, calculateCropRegion } from './utils/interpolation';

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
  titleLayer: null
};

function App() {
  const [project, setProject] = useState<ProjectState>(INITIAL_STATE);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

  // Persistence Loading
  useEffect(() => {
    contentDB.getProject().then(saved => {
      if (saved) {
        setProject(saved);
        console.log('Project loaded from storage');
      }
    });
  }, []);

  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'model', text: 'Welcome to VibeCut Pro. Upload clips to the Media Bin to begin editing.', timestamp: new Date() }
  ]);
  const [status, setStatus] = useState<ProcessingStatus>(ProcessingStatus.IDLE);
  const [editPrompt, setEditPrompt] = useState('');

  // Right Panel State
  const [activeRightTab, setActiveRightTab] = useState<'properties' | 'chat' | 'transcript'>('properties');

  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);

  // Selection State
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [selectedTransition, setSelectedTransition] = useState<{ segId: string; side: 'in' | 'out' } | null>(null);

  // Dialogue Selection { mediaId, eventIndex }
  const [selectedDialogue, setSelectedDialogue] = useState<{ mediaId: string; index: number } | null>(null);

  // Title Selection
  const [isTitleSelected, setIsTitleSelected] = useState(false);

  const [isCaching, setIsCaching] = useState(false);
  const [rippleMode, setRippleMode] = useState(true);
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [isSaving, setIsSaving] = useState(false);
  const [showYoutubeModal, setShowYoutubeModal] = useState(false);
  const [activePage, setActivePage] = useState<'editor' | 'library'>('editor');

  // Viewport & Export Settings
  const [viewportSettings, setViewportSettings] = useState<ViewportSettings>({
    previewAspectRatio: '9:16',
    showOverlay: false,
    overlayOpacity: 0.6
  });
  const [showExportModal, setShowExportModal] = useState(false);
  const [showGraphEditor, setShowGraphEditor] = useState(false);
  const [activeBottomTab, setActiveBottomTab] = useState<'timeline' | 'graph'>('timeline');

  // Undo/Redo history for keyframes
  const [undoStack, setUndoStack] = useState<Array<{ segmentId: string; keyframes: ClipKeyframe[] }>>([]);
  const [redoStack, setRedoStack] = useState<Array<{ segmentId: string; keyframes: ClipKeyframe[] }>>([]);

  // Global/Root transform keyframes (affects all clips)
  const [globalKeyframes, setGlobalKeyframes] = useState<ClipKeyframe[]>([]);

  // Transform target: 'global' for root transform, or segment ID for individual clip
  const [transformTarget, setTransformTarget] = useState<'global' | string>('global');

  // Viewport dragging state
  const [isViewportDragging, setIsViewportDragging] = useState(false);
  const [viewportDragStart, setViewportDragStart] = useState({ x: 0, y: 0 });
  const [viewportDragStartTransform, setViewportDragStartTransform] = useState({ translateX: 0, translateY: 0 });

  // We now manage a map of video refs for multi-track playback
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const overlayRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Audio Context for Export
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>>(new WeakMap());

  const viewportContainerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

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

  // Identify active segments at the current time (Logical)
  const activeSegments = useMemo(() => {
    return project.segments.filter(s =>
      project.currentTime >= s.timelineStart &&
      project.currentTime < (s.timelineStart + (s.endTime - s.startTime))
    ).sort((a, b) => a.track - b.track);
  }, [project.segments, project.currentTime]);

  // Identify segments to render (Active + Preload) to avoid black frames on cut
  const renderedSegments = useMemo(() => {
    const LOOKAHEAD = 2.0; // Preload 2s ahead
    return project.segments.filter(s => {
      const duration = s.endTime - s.startTime;
      const timelineEnd = s.timelineStart + duration;
      // Include if it overlaps current time OR is starting soon
      const isActive = project.currentTime >= s.timelineStart && project.currentTime < timelineEnd;
      const isUpcoming = s.timelineStart > project.currentTime && s.timelineStart < (project.currentTime + LOOKAHEAD);
      return isActive || isUpcoming;
    }).sort((a, b) => a.track - b.track);
  }, [project.segments, project.currentTime]);

  // Find the top-most visual media for "Main" analysis/transcript context
  const currentTopMedia = useMemo(() => {
    if (selectedSegmentIds.length === 1) {
      const seg = project.segments.find(s => s.id === selectedSegmentIds[0]);
      if (seg) return project.library.find(m => m.id === seg.mediaId);
    }

    if (activeSegments.length > 0) {
      const topSeg = activeSegments[activeSegments.length - 1];
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

  // Subtitles (from top-most media)
  const activeSubtitleEvent = useMemo(() => {
    if (!currentTopMedia || !currentTopMedia.analysis) return null;
    const topSeg = activeSegments[activeSegments.length - 1];
    if (!topSeg) return null;

    // Calculate source time for the top segment
    const sourceTime = topSeg.startTime + (project.currentTime - topSeg.timelineStart);

    const match = currentTopMedia.analysis.events.find(e =>
      e.type === 'dialogue' && sourceTime >= e.startTime && sourceTime <= e.endTime
    );
    if (match) console.log('[App] Overlay match:', match.details, 'Time:', sourceTime.toFixed(2));
    return match;
  }, [currentTopMedia, project.currentTime, activeSegments]);

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
      // If there is an active video playing, use its time as the source of truth (Video Master)
      // This prevents drift and stuttering by ensuring the UI matches the video exact frame.
      const activeSeg = p.segments.find(s =>
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
          // Seek to start and pause, hide it.
          // Check if we need to seek (only if significantly off to avoid thrashing)
          if (Math.abs(videoEl.currentTime - seg.startTime) > 0.1) {
            videoEl.currentTime = seg.startTime;
          }
          if (!videoEl.paused) videoEl.pause();
          videoEl.style.opacity = '0';
          // Keep display block so it buffers
          return;
        }

        // --- ACTIVE STATE ---
        const sourceTime = seg.startTime + (project.currentTime - seg.timelineStart);

        if (project.isPlaying) {
          if (videoEl.paused) videoEl.play().catch(() => { });

          // Drift correction: Only seek if SIGNIFICANTLY off (e.g. > 0.5s) to prevent micro-stutter loops
          if (Math.abs(videoEl.currentTime - sourceTime) > 0.5) {
            videoEl.currentTime = sourceTime;
          }
        } else {
          if (!videoEl.paused) videoEl.pause();
          videoEl.currentTime = sourceTime; // Force sync when paused
        }

        // --- Transition Logic ---
        let opacity = 1;
        let overlayOpacity = 0;
        let overlayColor = 'white';
        let videoBlendMode = 'normal'; // Blend mode for the video itself (Photoshop mode)
        let overlayBlendMode = 'normal'; // Blend mode for the solid color wash

        const relTime = project.currentTime - seg.timelineStart;

        // Intro Transition
        if (seg.transitionIn && relTime < seg.transitionIn.duration) {
          const progress = Math.max(0, Math.min(1, relTime / seg.transitionIn.duration));

          if (seg.transitionIn.type === 'FADE' || seg.transitionIn.type === 'CROSSFADE') {
            opacity = progress;
          } else if (seg.transitionIn.type.startsWith('WASH')) {
            opacity = 1;
            overlayOpacity = 1 - progress;
            if (seg.transitionIn.type === 'WASH_BLACK') overlayColor = 'black';
            else if (seg.transitionIn.type === 'WASH_WHITE') overlayColor = 'white';
            else if (seg.transitionIn.type === 'WASH_COLOR') overlayColor = seg.transitionIn.color || '#ff0000';

            overlayBlendMode = seg.transitionIn.blendMode || 'normal';
          }

          // Apply custom blend mode to the video if specified (e.g. Screen/Multiply on entrance)
          if (seg.transitionIn.blendMode && !seg.transitionIn.type.startsWith('WASH')) {
            videoBlendMode = seg.transitionIn.blendMode;
          }
        }

        // Outro Transition
        if (seg.transitionOut && relTime > (duration - seg.transitionOut.duration)) {
          const remaining = duration - relTime;
          const progress = Math.max(0, Math.min(1, remaining / seg.transitionOut.duration)); // 1 -> 0

          if (seg.transitionOut.type === 'FADE' || seg.transitionOut.type === 'CROSSFADE') {
            opacity = progress;
          } else if (seg.transitionOut.type.startsWith('WASH')) {
            opacity = 1;
            overlayOpacity = 1 - progress;
            if (seg.transitionOut.type === 'WASH_BLACK') overlayColor = 'black';
            else if (seg.transitionOut.type === 'WASH_WHITE') overlayColor = 'white';
            else if (seg.transitionOut.type === 'WASH_COLOR') overlayColor = seg.transitionOut.color || '#ff0000';

            overlayBlendMode = seg.transitionOut.blendMode || 'normal';
          }

          // Apply custom blend mode to the video if specified (e.g. Screen/Multiply on exit)
          if (seg.transitionOut.blendMode && !seg.transitionOut.type.startsWith('WASH')) {
            videoBlendMode = seg.transitionOut.blendMode;
          }
        }

        videoEl.style.opacity = opacity.toString();
        videoEl.style.mixBlendMode = videoBlendMode;

        if (overlayEl) {
          overlayEl.style.opacity = overlayOpacity.toString();
          overlayEl.style.backgroundColor = overlayColor;
          overlayEl.style.mixBlendMode = overlayBlendMode;
        }
      }
    });
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

  // Keyboard Listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Undo/Redo shortcuts
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

      if (selectedSegmentIds.length > 0) {
        if (e.key === 'Delete') performDelete(selectedSegmentIds, false);
        else if (e.key === 'Backspace') performDelete(selectedSegmentIds, true);
      } else if (selectedDialogue) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          handleDeleteDialogue(selectedDialogue.mediaId, selectedDialogue.index);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSegmentIds, undoStack, redoStack]);

  // Viewport resize observer - reinitialize when switching pages
  useEffect(() => {
    const container = viewportContainerRef.current;
    if (!container) {
      // Reset size when container not available (e.g., on library page)
      setViewportSize({ width: 0, height: 0 });
      return;
    }

    // Set initial size immediately
    setViewportSize({ width: container.clientWidth, height: container.clientHeight });

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [activePage]); // Re-run when page changes

  // Handler for updating segment keyframes (with undo support)
  const handleUpdateKeyframes = (segmentId: string, keyframes: ClipKeyframe[], skipUndo = false) => {
    if (segmentId === 'global') {
      // Handle global keyframes
      if (!skipUndo) {
        setUndoStack(prev => [...prev.slice(-49), { segmentId: 'global', keyframes: globalKeyframes }]);
        setRedoStack([]);
      }
      setGlobalKeyframes(keyframes);
      return;
    }

    if (!skipUndo) {
      // Save current state to undo stack
      const currentSegment = project.segments.find(s => s.id === segmentId);
      if (currentSegment) {
        setUndoStack(prev => [...prev.slice(-49), { segmentId, keyframes: currentSegment.keyframes || [] }]);
        setRedoStack([]); // Clear redo stack on new change
      }
    }

    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s =>
        s.id === segmentId ? { ...s, keyframes } : s
      )
    }));
  };

  // Combine global and clip transforms
  const getCombinedTransform = (clipKeyframes: ClipKeyframe[] | undefined, clipTime: number, timelineTime: number) => {
    const globalTransform = getInterpolatedTransform(globalKeyframes, timelineTime);
    const clipTransform = getInterpolatedTransform(clipKeyframes, clipTime);

    // Combine: first apply global, then clip (additive for translate, multiplicative for scale)
    return {
      translateX: globalTransform.translateX + clipTransform.translateX,
      translateY: globalTransform.translateY + clipTransform.translateY,
      scale: globalTransform.scale * clipTransform.scale,
      rotation: globalTransform.rotation + clipTransform.rotation
    };
  };

  // Undo handler
  const handleUndo = () => {
    if (undoStack.length === 0) return;

    const lastState = undoStack[undoStack.length - 1];

    if (lastState.segmentId === 'global') {
      // Push current global to redo
      setRedoStack(prev => [...prev, { segmentId: 'global', keyframes: globalKeyframes }]);
      // Restore from undo
      setGlobalKeyframes(lastState.keyframes);
      // Remove from undo stack
      setUndoStack(prev => prev.slice(0, -1));
    } else {
      const currentSegment = project.segments.find(s => s.id === lastState.segmentId);
      if (currentSegment) {
        // Push current to redo
        setRedoStack(prev => [...prev, { segmentId: lastState.segmentId, keyframes: currentSegment.keyframes || [] }]);
        // Restore from undo
        handleUpdateKeyframes(lastState.segmentId, lastState.keyframes, true);
        // Remove from undo stack
        setUndoStack(prev => prev.slice(0, -1));
      }
    }
  };

  // Redo handler
  const handleRedo = () => {
    if (redoStack.length === 0) return;

    const lastState = redoStack[redoStack.length - 1];

    if (lastState.segmentId === 'global') {
      // Push current global to undo
      setUndoStack(prev => [...prev, { segmentId: 'global', keyframes: globalKeyframes }]);
      // Restore from redo
      setGlobalKeyframes(lastState.keyframes);
      // Remove from redo stack
      setRedoStack(prev => prev.slice(0, -1));
    } else {
      const currentSegment = project.segments.find(s => s.id === lastState.segmentId);
      if (currentSegment) {
        // Push current to undo
        setUndoStack(prev => [...prev, { segmentId: lastState.segmentId, keyframes: currentSegment.keyframes || [] }]);
        // Restore from redo
        handleUpdateKeyframes(lastState.segmentId, lastState.keyframes, true);
        // Remove from redo stack
        setRedoStack(prev => prev.slice(0, -1));
      }
    }
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
    if (!isViewportDragging || viewportSize.width === 0) return;

    const dx = e.clientX - viewportDragStart.x;
    const dy = e.clientY - viewportDragStart.y;

    // Convert pixel delta to percentage of viewport
    const deltaX = (dx / viewportSize.width) * 100;
    const deltaY = (dy / viewportSize.height) * 100;

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
  };

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

  // Export video with animations
  // Export video with animations (real-time playback capture)
  const handleExportVideo = async (settings: ExportSettings) => {
    console.log('[Export] Starting REAL-TIME export:', settings);

    // 1. Audio Setup
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const actx = audioContextRef.current;
    if (actx.state === 'suspended') await actx.resume();

    const dest = actx.createMediaStreamDestination();

    // Connect videos to destination
    videoRefs.current.forEach((vid) => {
      let source;
      if (audioSourcesRef.current.has(vid)) {
        source = audioSourcesRef.current.get(vid);
      } else {
        try {
          source = actx.createMediaElementSource(vid);
          audioSourcesRef.current.set(vid, source);
          source.connect(actx.destination); // Keep output to speakers
        } catch (e) {
          // Already connected or error
          console.warn('[Export] Audio connect warning:', e);
        }
      }
      // Connect to export stream
      if (source) {
        try { source.connect(dest); } catch (e) { }
      }
    });

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
      setProject(p => ({ ...p, isPlaying: false, currentTime: 0 }));
    };

    // 4. Playback & Render Loop
    setProject(p => ({ ...p, isPlaying: false, currentTime: 0 }));

    // Tiny delay to allow state to settle / video to seek to 0
    await new Promise(r => setTimeout(r, 200));

    mediaRecorder.start();
    setProject(p => ({ ...p, isPlaying: true }));

    const totalDuration = contentDuration;

    const renderLoop = () => {
      // Check current time from fresh project ref
      const currentTime = projectRef.current.currentTime;

      // Add 0.5s buffer for audio tail, or stop if main playback ended
      if (currentTime >= totalDuration || (!projectRef.current.isPlaying && currentTime > 0)) {
        // Wait a tiny bit to ensure last frame is captured
        setTimeout(() => {
          if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        }, 500);
        return;
      }

      // Draw!
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outputWidth, outputHeight);

      // Find ALL active segments (Multi-track support)
      const activeSegments = projectRef.current.segments
        .filter(s => currentTime >= s.timelineStart && currentTime < (s.timelineStart + (s.endTime - s.startTime)))
        .sort((a, b) => (a.track || 0) - (b.track || 0));

      activeSegments.forEach(activeSeg => {
        const vid = videoRefs.current.get(activeSeg.id);
        if (vid && vid.readyState >= 2) {
          // Transform logic
          const clipTime = currentTime - activeSeg.timelineStart;
          const transform = getCombinedTransform(activeSeg.keyframes, clipTime, currentTime);

          ctx.save();
          ctx.translate(outputWidth / 2, outputHeight / 2);
          ctx.translate(transform.translateX * outputWidth / 100, transform.translateY * outputHeight / 100);
          ctx.scale(transform.scale, transform.scale);
          ctx.rotate(transform.rotation * Math.PI / 180);

          const scale = Math.max(outputWidth / vid.videoWidth, outputHeight / vid.videoHeight);
          const drawWidth = vid.videoWidth * scale;
          const drawHeight = vid.videoHeight * scale;
          ctx.drawImage(vid, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
          ctx.restore();

          // Draw Subtitles
          const media = projectRef.current.library.find(m => m.id === activeSeg.mediaId);
          if (media && media.analysis) {
            const mediaTime = activeSeg.startTime + (clipTime);
            const subtitle = media.analysis.events.find(e =>
              e.type === 'dialogue' && mediaTime >= e.startTime && mediaTime < e.endTime
            );

            if (subtitle) {
              const style = subtitle.styleOverride || projectRef.current.subtitleStyle;
              const scaleFactor = outputHeight / 720;
              const fontSize = (style.fontSize || 24) * scaleFactor;

              ctx.save();
              ctx.font = `${style.bold ? 'bold ' : ''}${style.italic ? 'italic ' : ''}${fontSize}px ${style.fontFamily || 'Arial'}`;
              ctx.textAlign = (style.textAlign as CanvasTextAlign) || 'center';
              ctx.textBaseline = 'bottom';

              const x = style.textAlign === 'left' ? outputWidth * 0.05 :
                style.textAlign === 'right' ? outputWidth * 0.95 :
                  outputWidth / 2;
              const y = outputHeight - (outputHeight * ((style.bottomOffset || 10) / 100));

              const text = subtitle.details;

              // Background Box
              if (style.backgroundType === 'box' || style.backgroundType === 'rounded') {
                const metrics = ctx.measureText(text);
                const padding = 10 * scaleFactor;
                const w = metrics.width + padding * 2;
                const h = fontSize + padding;
                const bx = x - (style.textAlign === 'center' ? w / 2 : style.textAlign === 'right' ? w : 0);
                const by = y - h + (padding / 2);

                ctx.fillStyle = style.backgroundColor || 'rgba(0,0,0,0.5)';
                if (style.backgroundType === 'rounded') {
                  if (ctx.roundRect) {
                    ctx.beginPath();
                    ctx.roundRect(bx, by, w, h, (style.boxBorderRadius || 4) * scaleFactor);
                    ctx.fill();
                  } else {
                    ctx.fillRect(bx, by, w, h);
                  }
                } else {
                  ctx.fillRect(bx, by, w, h);
                }
              } else if (style.backgroundType === 'outline') {
                ctx.strokeStyle = style.backgroundColor || '#000000';
                ctx.lineWidth = 4 * scaleFactor;
                ctx.lineJoin = 'round';
                ctx.strokeText(text, x, y);
              }

              ctx.fillStyle = style.color || '#ffffff';
              ctx.fillText(text, x, y);
              ctx.restore();
            }
          }
        }
      });

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
      const video = document.createElement('video');
      video.src = url;
      await new Promise(r => video.onloadedmetadata = r);
      newItems.push({
        id: Math.random().toString(36).substr(2, 9),
        file,
        url,
        duration: (video.duration && isFinite(video.duration)) ? video.duration : 10, // Default to 10s if unknown
        name: file.name,
        analysis: null
      });
    }
    setProject(prev => ({ ...prev, library: [...prev.library, ...newItems] }));
  };

  const handleYoutubeImport = async (url: string, download: boolean, manualFile?: File) => {
    console.log('[Import] Starting import...', { url, download, manualFile });
    setStatus(ProcessingStatus.TRANSCRIBING);
    try {
      // 1. Fetch Transcript
      console.log('[Import] Fetching transcript...');
      // Cache busting to ensure fresh data
      const transcriptRes = await fetch(`/api/transcript?url=${encodeURIComponent(url)}&_t=${Date.now()}`);
      console.log('[Import] Transcript response status:', transcriptRes.status);

      const transcriptData = await transcriptRes.json();
      console.log('[Import] Transcript data received:', transcriptData);

      if (transcriptData.error) throw new Error(transcriptData.error);

      if (!transcriptData.segments) {
        throw new Error('No segments found in transcript data');
      }

      // Process segments: Split sentences into words if needed to ensure "One Word" blocks
      const events: AnalysisEvent[] = [];

      if (transcriptData.segments) {
        transcriptData.segments.forEach((seg: any) => {
          // Clean text: replace tags with space, then trim
          // Fixes: "We<00:00:00.400><c>" -> "We"
          let text = seg.text || "";
          text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

          if (!text) return;

          const words = text.split(/\s+/);
          // Sanitize values from server
          const segDurationMs = Math.abs(Number(seg.duration));
          const segStartMs = Number(seg.start);

          if (words.length > 1) {
            // Distribute duration equally
            const durationPerWord = segDurationMs / words.length;
            words.forEach((w: string, i: number) => {
              events.push({
                type: 'dialogue',
                startTime: segStartMs + (i * durationPerWord),
                endTime: segStartMs + ((i + 1) * durationPerWord),
                label: 'speech',
                details: w
              });
            });
          } else {
            // Single word or empty
            events.push({
              type: 'dialogue',
              startTime: segStartMs,
              endTime: segStartMs + segDurationMs,
              label: 'speech',
              details: text
            });
          }
        });
        console.log(`[Import] Generated ${events.length} raw word events.`);
      }

      // Post-Process: Combine short/rapid words into "Slides"
      // Rules:
      // 1. If an event is < 0.2s, it MUST be merged unless it's the last one.
      // 2. Accumulate words up to ~3 words or ~0.8s max duration for readability.
      const processedEvents: AnalysisEvent[] = [];
      if (events.length > 0) {
        let buffer: AnalysisEvent[] = [events[0]];

        for (let i = 1; i < events.length; i++) {
          const current = events[i];
          const prev = buffer[buffer.length - 1];

          // Check continuity (gap < 0.1s)
          const isContiguous = (current.startTime - prev.endTime) < 0.1;

          // Conditions to merge:
          // - Contiguous AND
          // - (Current buffer is too short duration OR too few words)
          // - AND adding next word doesn't exceed Max limits

          const bufferDuration = prev.endTime - buffer[0].startTime;
          const combinedDuration = current.endTime - buffer[0].startTime;
          const wordCount = buffer.length;

          // Merge if:
          // 1. Gap is small
          // 2. AND (Buffer is very short (<0.5s) OR Words < 3)
          // 3. AND Combined duration < 1.0s (don't make super long slides)



          // Deduplication Check
          const isDuplicate = current.details.trim().toLowerCase() === prev.details.trim().toLowerCase();
          const isOverlap = current.startTime < prev.endTime;
          if (isDuplicate && isOverlap) {
            prev.endTime = Math.max(prev.endTime, current.endTime);
            continue; // Skip adding to buffer
          }

          // Merge if:
          // 1. Gap is small
          // 2. AND (Buffer is very short (<0.5s) OR Words < 3)
          // 3. AND Combined duration < 1.0s (don't make super long slides)

          if (isContiguous && (bufferDuration < 0.5 || wordCount < 3) && combinedDuration < 1.2) {
            buffer.push(current);
            // Update the "previous" (which is actually just the last in buffer for continuity check next loop)
          } else {
            // Flush buffer
            const start = buffer[0].startTime;
            const end = buffer[buffer.length - 1].endTime;
            const text = buffer.map(e => e.details).join(' ');

            processedEvents.push({
              type: 'dialogue',
              startTime: start,
              endTime: end,
              label: 'speech',
              details: text
            });

            // Start new buffer
            buffer = [current];
          }
        }

        // Flush remaining
        if (buffer.length > 0) {
          const start = buffer[0].startTime;
          const end = buffer[buffer.length - 1].endTime;
          const text = buffer.map(e => e.details).join(' ');
          processedEvents.push({
            type: 'dialogue',
            startTime: start,
            endTime: end,
            label: 'speech',
            details: text
          });
        }
      } else {
        // No events
      }

      console.log(`[Import] Post-processed into ${processedEvents.length} slides.`);


      // 2. Handle Media (Download or Upload placeholder)
      let file: File;
      let videoUrl: string;

      if (download) {
        console.log('[Import] Starting download fetch...');
        // Cache busting for video too, though less critical
        const downloadRes = await fetch(`/api/download?url=${encodeURIComponent(url)}&_t=${Date.now()}`);
        console.log('[Import] Download response status:', downloadRes.status);

        if (!downloadRes.ok) {
          const errText = await downloadRes.text();
          throw new Error(`Download failed: ${downloadRes.status} ${errText}`);
        }

        console.log('[Import] Download starting blob conversion...');
        const blob = await downloadRes.blob();
        console.log('[Import] Blob received size:', blob.size);

        file = new File([blob], `${transcriptData.title}.mp4`, { type: 'video/mp4' });
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
      // Get duration with timeout
      const video = document.createElement('video');
      video.src = videoUrl;

      let duration = 0;
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve(null), 5000); // 5s timeout
          video.onloadedmetadata = () => {
            clearTimeout(timeout);
            resolve(null);
          };
          video.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('Video format not supported or corrupt'));
          };
        });
        duration = video.duration || 0;
      } catch (e) {
        console.warn('Could not determine video duration:', e);
        // Fallback or alert? We'll allow it with 0 duration but warn.
      }
      console.log('[Import] Duration determined:', duration);

      if (!duration || isNaN(duration)) {
        duration = processedEvents.length > 0 ? processedEvents[processedEvents.length - 1].endTime : 10; // Fallback to transcript length or 10s
      }

      const newItem: MediaItem = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        url: videoUrl,
        duration: duration,
        name: transcriptData.title || "YouTube Video",
        analysis: {
          summary: "Imported from YouTube",
          events: processedEvents,
          generatedAt: new Date()
        }
      };

      setProject(prev => ({ ...prev, library: [...prev.library, newItem] }));

      // Auto-select the new item so the user sees the transcript immediately
      setSelectedMediaId(newItem.id);
      setActiveRightTab('transcript');

      setShowYoutubeModal(false);
      console.log('[Import] Import complete!');

    } catch (e) {
      console.error('[Import] Error:', e);
      alert(`Import failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
    }
  };

  const handleAddToTimeline = (item: MediaItem) => {
    const insertionTime = project.currentTime;
    const duration = item.duration;

    let targetTrack = 0;
    while (true) {
      const collision = project.segments.some(s =>
        s.track === targetTrack &&
        !(s.timelineStart + (s.endTime - s.startTime) <= insertionTime + 0.01 ||
          s.timelineStart >= insertionTime + duration - 0.01)
      );
      if (!collision) break;
      targetTrack++;
      if (targetTrack > 10) break;
    }

    const newSeg: Segment = {
      id: Math.random().toString(36).substr(2, 9),
      mediaId: item.id,
      startTime: 0,
      endTime: item.duration,
      timelineStart: insertionTime,
      track: targetTrack,
      description: item.name,
      color: `hsl(${Math.random() * 360}, 60%, 40%)`
    };
    console.log('[App] Adding segment to timeline:', newSeg);
    setProject(prev => ({ ...prev, segments: [...prev.segments, newSeg] }));
    safeSetTimelineZoom(1);
  };

  // Export Short from Content Library to Editor
  const handleExportShort = async (short: GeneratedShort) => {
    console.log('[Export Short] Starting export...', short);
    setStatus(ProcessingStatus.TRANSCRIBING);

    try {
      // 1. Get the source video info from Content Library DB
      const videoRecord = await contentDB.getVideo(short.videoId);
      if (!videoRecord) {
        throw new Error('Source video not found in library');
      }

      // 2. Download the video from YouTube
      console.log('[Export Short] Downloading video:', videoRecord.url);
      const downloadRes = await fetch(`/api/download?url=${encodeURIComponent(videoRecord.url)}&_t=${Date.now()}`);

      if (!downloadRes.ok) {
        const errText = await downloadRes.text();
        throw new Error(`Download failed: ${downloadRes.status} ${errText}`);
      }

      const blob = await downloadRes.blob();
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

      // 4. Get granular transcript segments and GROUP them into slides (Karaoke style)
      const allVideoSegments = await contentDB.getSegmentsByVideoId(short.videoId);
      console.log('[ExportShort] VideoId:', short.videoId);
      console.log('[ExportShort] allVideoSegments from DB:', allVideoSegments.length, allVideoSegments.slice(0, 3));
      console.log('[ExportShort] short.segments (clips):', short.segments);

      const analysisEvents: AnalysisEvent[] = [];
      const rawClipEvents: any[] = [];
      const processedSegmentIds = new Set<string>(); // Track processed segments to avoid duplicates

      short.segments.forEach((clipSeg, clipIdx) => {
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

            analysisEvents.push({
              type: 'dialogue',
              startTime: start,
              endTime: end,
              label: 'speech',
              details: text
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
          analysisEvents.push({
            type: 'dialogue',
            startTime: start,
            endTime: end,
            label: 'speech',
            details: text
          });
        }
      }

      // Fallback: This usually happens if DB is empty or logic fails
      // Use the short.segments directly with SOURCE VIDEO times
      if (analysisEvents.length === 0) {
        console.log('[ExportShort] Fallback triggered - using short.segments directly');
        short.segments.forEach(seg => {
          analysisEvents.push({
            type: 'dialogue',
            startTime: seg.startTime,
            endTime: seg.endTime,
            label: 'speech',
            details: seg.text
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

      // 6. Add to library
      setProject(prev => ({ ...prev, library: [...prev.library, newMediaItem] }));

      // 7. Create timeline segments from the short clips
      // startTime/endTime = position in SOURCE VIDEO (for playback)
      // timelineStart = position on TIMELINE (for display)
      let timelinePosition = 0;
      const newSegments: Segment[] = short.segments.map((clipSeg, index) => {
        const clipDuration = clipSeg.endTime - clipSeg.startTime;
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
          color: `hsl(${280 + index * 20}, 60%, 40%)` // Purple-ish gradient
        };
        timelinePosition += clipDuration;
        return segment;
      });

      // 8. Add segments to project and create title layer
      const titleLayer: TitleLayer = {
        id: Math.random().toString(36).substr(2, 9),
        text: short.hookTitle || short.title,
        startTime: 0,
        endTime: 4, // Default 4 seconds duration for the title
        fadeInDuration: 0.5,
        fadeOutDuration: 0.5,
        style: INITIAL_TITLE_STYLE,
        keyframes: []
      };

      setProject(prev => ({
        ...prev,
        segments: [...prev.segments, ...newSegments],
        titleLayer: titleLayer
      }));

      // 9. Switch to editor view
      setSelectedMediaId(newMediaItem.id);
      setActiveRightTab('transcript');
      setActivePage('editor');
      safeSetTimelineZoom(1);

      console.log('[Export Short] Export complete!');

    } catch (e) {
      console.error('[Export Short] Error:', e);
      alert(`Export failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setStatus(ProcessingStatus.IDLE);
    }
  };

  const handleSplit = (time: number) => {
    const segmentsToSplit = project.segments.filter(s =>
      time > s.timelineStart && time < (s.timelineStart + (s.endTime - s.startTime))
    );
    if (segmentsToSplit.length === 0) return;

    setProject(prev => {
      let newSegments = [...prev.segments];
      segmentsToSplit.forEach(seg => {
        const splitPointSource = seg.startTime + (time - seg.timelineStart);
        const splitPointTimeline = time;
        const seg1 = { ...seg, id: Math.random().toString(36).substr(2, 9), endTime: splitPointSource, transitionOut: undefined };
        const seg2 = { ...seg, id: Math.random().toString(36).substr(2, 9), startTime: splitPointSource, timelineStart: splitPointTimeline, transitionIn: undefined };
        newSegments = newSegments.filter(s => s.id !== seg.id);
        newSegments.push(seg1, seg2);
      });
      return { ...prev, segments: newSegments };
    });
  };

  const handleUpdateSegment = (updated: Segment) => {
    setProject(prev => ({
      ...prev,
      segments: prev.segments.map(s => s.id === updated.id ? updated : s)
    }));
  };

  const handleUpdateTransition = (segId: string, side: 'in' | 'out', transition: Transition | undefined) => {
    setProject(prev => {
      const segIndex = prev.segments.findIndex(s => s.id === segId);
      if (segIndex === -1) return prev;

      const seg = prev.segments[segIndex];
      let updatedSegments = [...prev.segments];

      updatedSegments[segIndex] = {
        ...seg,
        [side === 'in' ? 'transitionIn' : 'transitionOut']: transition
      };

      // Sync logic for overlapping clips
      if (side === 'out') {
        const segEnd = seg.timelineStart + (seg.endTime - seg.startTime);
        const neighbor = prev.segments.find(s =>
          s.id !== seg.id &&
          s.track === seg.track &&
          s.timelineStart < segEnd &&
          s.timelineStart >= seg.timelineStart
        );

        if (neighbor) {
          const neighborIndex = updatedSegments.findIndex(s => s.id === neighbor.id);
          if (neighborIndex !== -1) {
            updatedSegments[neighborIndex] = {
              ...updatedSegments[neighborIndex],
              transitionIn: transition
            };
          }
        }
      } else if (side === 'in') {
        const neighbor = prev.segments.find(s =>
          s.id !== seg.id &&
          s.track === seg.track &&
          (s.timelineStart + (s.endTime - s.startTime)) > seg.timelineStart &&
          s.timelineStart <= seg.timelineStart
        );

        if (neighbor) {
          const neighborIndex = updatedSegments.findIndex(s => s.id === neighbor.id);
          if (neighborIndex !== -1) {
            updatedSegments[neighborIndex] = {
              ...updatedSegments[neighborIndex],
              transitionOut: transition
            };
          }
        }
      }

      return { ...prev, segments: updatedSegments };
    });
  };

  const handleSegmentSelect = (seg: Segment, isMulti: boolean) => {
    setSelectedTransition(null);
    setSelectedDialogue(null); // Deselect dialogue
    setIsTitleSelected(false); // Deselect title
    setActiveRightTab('properties');
    if (isMulti) {
      setSelectedSegmentIds(prev => prev.includes(seg.id) ? prev.filter(id => id !== seg.id) : [...prev, seg.id]);
    } else {
      setSelectedSegmentIds([seg.id]);
    }
  };

  const handleTransitionSelect = (segId: string, side: 'in' | 'out', x: number, y: number) => {
    setSelectedSegmentIds([segId]);
    setSelectedDialogue(null); // Deselect dialogue
    setIsTitleSelected(false); // Deselect title
    setSelectedTransition({ segId, side });
    setActiveRightTab('properties');
  };

  const handleDialogueSelect = (mediaId: string, index: number) => {
    console.log('[App] Dialog Selected:', { mediaId, index });
    setSelectedSegmentIds([]); // Deselect clips
    setSelectedTransition(null);
    setIsTitleSelected(false); // Deselect title
    setSelectedDialogue({ mediaId, index });
    setActiveRightTab('properties');
  };

  const handleTitleSelect = (title: TitleLayer) => {
    console.log('[App] Title Selected:', title);
    setSelectedSegmentIds([]);
    setSelectedTransition(null);
    setSelectedDialogue(null);
    setIsTitleSelected(true);
    setActiveRightTab('properties');
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
      setSelectedDialogue(null);
    }
  };

  const handleUpdateDialogueText = (newText: string) => {
    updateSelectedEvent(evt => ({ ...evt, details: newText }));
  };

  const handleUpdateSubtitleStyle = (newStyle: Partial<SubtitleStyle>) => {
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
      return {
        ...prev,
        titleLayer: { ...prev.titleLayer, ...updates }
      };
    });
  };

  const handleToggleSubtitleUnlink = () => {
    if (!selectedDialogue) return;

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

  const performDelete = (idsToDelete: string[], ripple: boolean) => {
    setProject(prev => {
      const segmentsToDelete = prev.segments.filter(s => idsToDelete.includes(s.id));
      if (segmentsToDelete.length === 0) return prev;
      segmentsToDelete.sort((a, b) => b.timelineStart - a.timelineStart);

      let newSegments = [...prev.segments];
      segmentsToDelete.forEach(seg => {
        const deletedDuration = seg.endTime - seg.startTime;
        const deletedStart = seg.timelineStart;
        newSegments = newSegments.filter(s => s.id !== seg.id);
        if (ripple) {
          newSegments = newSegments.map(s => {
            if (s.timelineStart > deletedStart + 0.001) {
              return { ...s, timelineStart: s.timelineStart - deletedDuration };
            }
            return s;
          });
        }
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

  // Helper to generate dynamic styles for subtitle
  const getSubtitleStyles = (s: SubtitleStyle | undefined) => {
    if (!s) return { container: {}, text: {} };

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
      paddingRight: '5%'
    };

    const textStyle: React.CSSProperties = {
      fontFamily: s.fontFamily,
      fontSize: `${s.fontSize}px`,
      color: s.color,
      fontWeight: s.bold ? 'bold' : 'normal',
      fontStyle: s.italic ? 'italic' : 'normal',
      lineHeight: 1.4,
      padding: '8px 16px',
      whiteSpace: 'pre-wrap',
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
      // Stripe is handled by parent width 100% usually, but for simple text, let's just make it full width background
      textStyle.backgroundColor = hexToRgba(s.backgroundColor, s.backgroundOpacity);
      textStyle.width = '100%';
      textStyle.borderTop = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      textStyle.borderBottom = `${s.boxBorderWidth}px solid ${s.boxBorderColor}`;
      base.paddingLeft = 0;
      base.paddingRight = 0;
    } else if (s.backgroundType === 'outline') {
      textStyle.textShadow = `
             -1px -1px 0 ${s.backgroundColor},  
              1px -1px 0 ${s.backgroundColor},
             -1px  1px 0 ${s.backgroundColor},
              1px  1px 0 ${s.backgroundColor}`;
    } else {
      textStyle.textShadow = '0px 2px 4px rgba(0,0,0,0.5)';
    }

    return { container: base, text: textStyle };
  };

  const getTitleStyles = (s: TitleStyle | undefined, opacity: number) => {
    if (!s) return { container: {}, text: {} };

    const base: React.CSSProperties = {
      position: 'absolute',
      top: `${s.topOffset}%`,
      left: 0,
      right: 0,
      textAlign: s.textAlign,
      pointerEvents: 'none',
      zIndex: 10000, // Higher than subtitles
      display: 'flex',
      justifyContent: s.textAlign === 'left' ? 'flex-start' : s.textAlign === 'right' ? 'flex-end' : 'center',
      paddingLeft: '5%',
      paddingRight: '5%',
      opacity: opacity
    };

    const textStyle: React.CSSProperties = {
      fontFamily: s.fontFamily,
      fontSize: `${s.fontSize}px`,
      color: s.color,
      fontWeight: s.bold ? 'bold' : 'normal',
      fontStyle: s.italic ? 'italic' : 'normal',
      lineHeight: 1.4,
      padding: '12px 24px',
      whiteSpace: 'pre-wrap',
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
      textStyle.textShadow = `
             -1px -1px 0 ${s.backgroundColor},  
              1px -1px 0 ${s.backgroundColor},
             -1px  1px 0 ${s.backgroundColor},
              1px  1px 0 ${s.backgroundColor}`;
    } else {
      textStyle.textShadow = '0px 4px 8px rgba(0,0,0,0.6)';
    }

    return { container: base, text: textStyle };
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
    />;
  }

  return (
    <div className="flex h-screen w-screen bg-[#121212] text-gray-200 overflow-hidden relative font-sans">
      {/* Top Navigation Bar */}
      <div className="absolute top-0 right-0 z-50 flex gap-2 p-2 bg-[#1a1a1a]/90 rounded-bl-lg border-l border-b border-[#333]">
        <button
          onClick={async () => {
            setIsSaving(true);
            try {
              await contentDB.saveProject(project);
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
          {isSaving ? '💾 Saving...' : '💾 Save Project'}
        </button>
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

      {/* LEFT: Media Bin */}
      <div className="w-64 flex-shrink-0">
        <MediaBin
          items={project.library}
          onUpload={handleUpload}
          onAddToTimeline={handleAddToTimeline}
          onSelect={m => setSelectedMediaId(m.id)}
          onYoutubeClick={() => setShowYoutubeModal(true)}
        />
      </div>

      {/* MIDDLE: Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex min-h-0">

          {/* Program Monitor */}
          <div className="flex-1 bg-black flex flex-col relative overflow-hidden">
            <div
              ref={viewportContainerRef}
              className="flex-1 relative overflow-hidden group flex items-center justify-center"
              style={{ cursor: (transformTarget === 'global' || primarySelectedSegment) ? (isViewportDragging ? 'grabbing' : 'grab') : 'default' }}
              onMouseDown={handleViewportMouseDown}
              onMouseMove={handleViewportMouseMove}
              onMouseUp={handleViewportMouseUp}
              onMouseLeave={handleViewportMouseUp}
            >
              {renderedSegments.length > 0 ? (
                renderedSegments.map((seg, index) => {
                  // Get combined transform (global + clip)
                  const clipTime = project.currentTime - seg.timelineStart;
                  const transform = getCombinedTransform(seg.keyframes, clipTime, project.currentTime);
                  const cssTransform = transformToCss(transform);

                  return (
                    <div key={seg.id} className="absolute inset-0 w-full h-full" style={{ zIndex: seg.track * 10 }}>
                      <video
                        ref={el => { if (el) videoRefs.current.set(seg.id, el); }}
                        src={project.library.find(m => m.id === seg.mediaId)?.url}
                        className="w-full h-full object-contain pointer-events-none"
                        style={{ transform: cssTransform, transformOrigin: 'center center' }}
                        muted={false}
                      />
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
                <div className="text-gray-600 text-sm">No Active Clip</div>
              )}

              {/* Viewport Aspect Ratio Overlay */}
              <ViewportOverlay
                containerWidth={viewportSize.width}
                containerHeight={viewportSize.height}
                aspectRatio={viewportSettings.previewAspectRatio}
                opacity={viewportSettings.overlayOpacity}
                visible={viewportSettings.showOverlay}
              />

              {activeSubtitleEvent && (
                <div style={styles.container}>
                  <div style={styles.text}>
                    {activeSubtitleEvent.details}
                  </div>
                </div>
              )}

              {/* Title Layer Overlay */}
              {project.titleLayer && project.currentTime >= project.titleLayer.startTime && project.currentTime <= project.titleLayer.endTime && (() => {
                const t = project.currentTime - project.titleLayer.startTime;
                const duration = project.titleLayer.endTime - project.titleLayer.startTime;

                // Calculate opacity for fade in/out
                let opacity = 1;
                if (t < project.titleLayer.fadeInDuration) {
                  opacity = t / project.titleLayer.fadeInDuration;
                } else if (t > duration - project.titleLayer.fadeOutDuration) {
                  opacity = (duration - t) / project.titleLayer.fadeOutDuration;
                }

                const titleStyle = project.titleLayer.style || project.titleStyle;
                const computedStyles = getTitleStyles(titleStyle, opacity);

                // Apply transforms if keyframes exist
                let transform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
                if (project.titleLayer.keyframes && project.titleLayer.keyframes.length > 0) {
                  transform = getCombinedTransform(project.titleLayer.keyframes, t, project.currentTime);
                }
                const cssTransform = transformToCss(transform);

                return (
                  <div style={{ ...computedStyles.container, transform: cssTransform, transformOrigin: 'center center' }}>
                    <div style={computedStyles.text}>
                      {project.titleLayer.text}
                    </div>
                  </div>
                );
              })()}
            </div>

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

              {/* Right: Export & Graph Editor */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveBottomTab(prev => prev === 'graph' ? 'timeline' : 'graph')}
                  className={`px-2 py-1 text-xs rounded ${activeBottomTab === 'graph' ? 'bg-orange-600 text-white' : 'bg-[#333] text-gray-400 hover:text-white'}`}
                  title="Toggle Graph Editor"
                >
                  📈 Graph
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

          {/* Right Panels (Split view: Top = Properties, Bottom = Tabs) */}
          <div className="w-80 border-l border-[#333] flex flex-col bg-[#1e1e1e]">
            {/* Top Half: Properties Panel */}
            <div className="h-1/2 border-b border-[#333] overflow-hidden">
              <PropertiesPanel
                selectedSegment={primarySelectedSegment}
                selectedTransition={selectedTransition}
                selectedDialogue={selectedDialogue}
                selectedDialogueText={selectedDialogueEvent?.details || ""}
                subtitleStyle={effectiveSubtitleStyle}
                isSubtitleUnlinked={isSubtitleUnlinked}
                mediaAnalysis={selectedMediaAnalysis}
                onUpdateSegment={handleUpdateSegment}
                onUpdateTransition={handleUpdateTransition}
                onUpdateDialogueText={handleUpdateDialogueText}
                onUpdateSubtitleStyle={handleUpdateSubtitleStyle}
                onToggleSubtitleUnlink={handleToggleSubtitleUnlink}
                onAnalyze={handleDeepAnalyze}
                isProcessing={status === ProcessingStatus.DEEP_ANALYZING}
                isTitleSelected={isTitleSelected}
                titleLayer={project.titleLayer}
                onUpdateTitleLayer={handleUpdateTitleLayer}
              />
            </div>

            {/* Bottom Half: Tabs */}
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex border-b border-[#333] bg-[#252525]">
                <button onClick={() => setActiveRightTab('chat')} className={`flex-1 py-2 text-xs font-bold ${activeRightTab === 'chat' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>CHAT</button>
                <button onClick={() => setActiveRightTab('transcript')} className={`flex-1 py-2 text-xs font-bold ${activeRightTab === 'transcript' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>TRANSCRIPT</button>
              </div>
              <div className="flex-1 overflow-hidden">
                {activeRightTab === 'chat' && <ChatPanel messages={messages} onSendMessage={handleChat} isLoading={isChatLoading} />}
                {activeRightTab === 'chat' && <ChatPanel messages={messages} onSendMessage={handleChat} isLoading={isChatLoading} />}
                {activeRightTab === 'transcript' && (() => {
                  const transcriptMedia = currentTopMedia || project.library.find(m => m.id === selectedMediaId);
                  return (
                    <TranscriptPanel
                      analysis={transcriptMedia?.analysis || null}
                      currentTime={project.currentTime}
                      onSeek={(t) => setProject(p => ({ ...p, currentTime: t }))}
                      onSelect={(idx) => transcriptMedia && handleDialogueSelect(transcriptMedia.id, idx)}
                      selectedIndex={selectedDialogue?.mediaId === transcriptMedia?.id ? selectedDialogue.index : null}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* Timeline/Graph Section */}
        <div className="h-[500px] flex flex-col shadow-[0_-4px_10px_rgba(0,0,0,0.3)] z-10 border-t border-[#333]">
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
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">AI Vibe Editor</div>
                <input value={editPrompt} onChange={e => setEditPrompt(e.target.value)} placeholder="E.g. 'Shorten the video to highlights'" className="flex-1 bg-[#121212] border border-[#333] rounded px-3 py-1 text-xs text-white focus:border-blue-500 outline-none" />
                <button onClick={handleVibeEdit} disabled={status !== ProcessingStatus.IDLE} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold hover:bg-blue-500 disabled:opacity-50">Generate Sequence</button>
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
                onUpdateSegment={handleUpdateSegment}
                onDeleteSegment={id => performDelete([id], rippleMode)}
                onToggleRipple={() => setRippleMode(!rippleMode)}
                onToggleSnapping={() => setSnappingEnabled(!snappingEnabled)}
                onEditTransition={handleTransitionSelect}
                onDialogueSelect={handleDialogueSelect}
                selectedDialogue={selectedDialogue}
                onUpdateDialogue={handleUpdateDialogue}
                onDeleteDialogue={handleDeleteDialogue}
                titleLayer={project.titleLayer}
                onTitleSelect={handleTitleSelect}
                zoom={timelineZoom}
                onZoomChange={safeSetTimelineZoom}
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
                    {project.segments.map(seg => (
                      <option key={seg.id} value={seg.id}>
                        📹 Clip: {project.library.find(m => m.id === seg.mediaId)?.name?.slice(0, 20) || seg.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                  {transformTarget === 'global' && (
                    <span className="text-xs text-yellow-400 ml-2">⚡ Affects all clips</span>
                  )}
                </div>
                <div className="flex-1">
                  <GraphEditor
                    visible={true}
                    onClose={() => setActiveBottomTab('timeline')}
                    segment={transformTarget === 'global' || transformTarget === 'title_layer' ? null : project.segments.find(s => s.id === transformTarget) || primarySelectedSegment}
                    segmentDuration={(() => {
                      if (transformTarget === 'global') return contentDuration;
                      if (transformTarget === 'title_layer' && project.titleLayer) return project.titleLayer.endTime - project.titleLayer.startTime;
                      const seg = project.segments.find(s => s.id === transformTarget);
                      if (seg) return seg.endTime - seg.startTime;
                      return graphEditorSegmentDuration;
                    })()}
                    currentTime={(() => {
                      if (transformTarget === 'global') return project.currentTime;
                      if (transformTarget === 'title_layer' && project.titleLayer) return Math.max(0, project.currentTime - project.titleLayer.startTime);
                      const seg = project.segments.find(s => s.id === transformTarget);
                      if (seg) return Math.max(0, project.currentTime - seg.timelineStart);
                      return graphEditorClipTime;
                    })()}
                    keyframes={
                      transformTarget === 'global' ? globalKeyframes :
                        transformTarget === 'title_layer' ? (project.titleLayer?.keyframes || []) :
                          (project.segments.find(s => s.id === transformTarget)?.keyframes || primarySelectedSegment?.keyframes)
                    }
                    isGlobalMode={transformTarget === 'global' || transformTarget === 'title_layer'}
                    onSeek={(time) => {
                      if (transformTarget === 'global') {
                        setProject(p => ({ ...p, currentTime: time }));
                      } else if (transformTarget === 'title_layer' && project.titleLayer) {
                        setProject(p => ({ ...p, currentTime: (p.titleLayer?.startTime || 0) + time }));
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

      {/* Export Modal */}
      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        onExport={handleExportVideo}
        duration={contentDuration}
      />

      {showYoutubeModal && (
        <YoutubeImportModal
          onImport={handleYoutubeImport}
          onCancel={() => setShowYoutubeModal(false)}
          status={status}
        />
      )}
    </div>
  );
}

export default App;
