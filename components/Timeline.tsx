import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { Segment, VideoAnalysis, Transition, TitleLayer } from '../types';
import { getAudioBuffer, getWaveformPeaks } from '../utils/audioAnalysis';
import { getTransitionDef, TRANSITION_CATEGORY_COLORS } from '../utils/transitionCatalog';

interface TimelineProps {
  duration: number;
  currentTime: number;
  segments: Segment[];
  analyses: Record<string, VideoAnalysis | null>;
  rippleMode: boolean;
  snappingEnabled: boolean;
  selectedSegmentIds: string[];
  titleLayer?: TitleLayer | null; // Optional title layer
  onSeek: (time: number) => void;
  onSegmentSelect: (segment: Segment, isMulti: boolean) => void;
  onSplit: (time: number) => void;
  onUpdateSegments: (segments: Segment[]) => void;
  onDeleteSegment: (id: string) => void;
  onToggleRipple: () => void;
  onToggleSnapping: () => void;
  onEditTransition: (segId: string, side: 'in' | 'out', x: number, y: number) => void;
  onDialogueSelect: (mediaId: string, eventIndex: number, isShift?: boolean) => void;
  selectedDialogues?: Array<{ mediaId: string; index: number }>;
  onUpdateDialogue?: (mediaId: string, index: number, newEvent: import('../types').AnalysisEvent) => void;
  onDeleteDialogue?: (mediaId: string, index: number) => void;
  onDialogueDragStart?: (mediaId: string, index: number, originalEvent: import('../types').AnalysisEvent) => void;
  onTitleSelect?: (title: TitleLayer) => void;
  onUpdateTitle?: (title: Partial<TitleLayer>) => void;
  onInsertBlank?: (time: number) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  mediaFiles?: Map<string, File>;
}

/** Small canvas component that renders an audio waveform for a segment */
const WaveformCanvas: React.FC<{
  mediaId: string;
  file: File;
  startTime: number;
  endTime: number;
  color?: string;
}> = React.memo(({ mediaId, file, startTime, endTime, color = '#22c55e' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = async () => {
      try {
        const audioBuffer = await getAudioBuffer(mediaId, file);
        if (cancelled) return;

        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;

        canvas.width = width;
        canvas.height = height;

        const peaks = getWaveformPeaks(audioBuffer, startTime, endTime, width);
        const ctx = canvas.getContext('2d');
        if (!ctx || peaks.length === 0) return;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.6;

        const centerY = height / 2;
        for (let i = 0; i < peaks.length; i++) {
          const { min, max } = peaks[i];
          const top = centerY - max * centerY;
          const bottom = centerY - min * centerY;
          const barHeight = Math.max(1, bottom - top);
          ctx.fillRect(i, top, 1, barHeight);
        }
      } catch {
        // Audio decode may fail for some formats — silently fall back to empty
      }
    };

    draw();
    return () => { cancelled = true; };
  }, [mediaId, file, startTime, endTime, color]);

  return (
    <div ref={containerRef} className="absolute inset-0">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
});

const Timeline: React.FC<TimelineProps> = ({
  duration,
  currentTime,
  segments,
  analyses,
  rippleMode,
  snappingEnabled,
  selectedSegmentIds,
  titleLayer,
  onSeek,
  onSegmentSelect,
  onSplit,
  onUpdateSegments,
  onDeleteSegment,
  onToggleRipple,
  onToggleSnapping,
  onEditTransition,
  onDialogueSelect,
  selectedDialogues,
  onUpdateDialogue,
  onDeleteDialogue,
  onDialogueDragStart,
  onTitleSelect,
  onUpdateTitle,
  onInsertBlank,
  zoom,
  onZoomChange,
  mediaFiles
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0); // Track scroll for virtualization

  // Zoom sensitivity state (max zoom level)
  const [zoomSensitivity, setZoomSensitivity] = useState(500);
  const prevZoomRef = useRef(zoom);

  const [isSeeking, setIsSeeking] = useState(false);
  const [dragState, setDragState] = useState<{
    id: string;
    type: 'move' | 'leftTrim' | 'rightTrim';
    initialX: number;
    initialTimelineStart: number;
    initialStartTime: number;
    initialEndTime: number;
    snapPoints: number[];
  } | null>(null);

  const [dialogueDragState, setDialogueDragState] = useState<{
    mediaId: string;
    index: number;
    originalEvent: import('../types').AnalysisEvent;
    type: 'move' | 'leftTrim' | 'rightTrim';
    initialX: number;
    initialStartTime: number;
    initialEndTime: number;
  } | null>(null);

  const [titleDragState, setTitleDragState] = useState<{
    type: 'move' | 'leftTrim' | 'rightTrim';
    initialX: number;
    initialStartTime: number;
    initialEndTime: number;
  } | null>(null);

  const hasDraggedRef = useRef(false);

  // Optimize virtualization by tracking scroll
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(1000);

  // Handle Zoom Anchoring (Zoom to Cursor/Playhead)
  useEffect(() => {
    if (Math.abs(zoom - prevZoomRef.current) > 0.001) {
      if (scrollContainerRef.current && duration > 0) {
        // We want to anchor the zoom around the currentTime (playhead)
        // Current Pixel Position of Playhead = (currentTime / duration) * currentTotalWidth
        // We want to keep the Playhead's *Visual Position* relative to the viewport constant??
        // NO, standard "Zoom to Cursor" logic:
        // The point under the cursor (Playhead in this case) should remain stationary relative to the viewport
        // UNLESS the playhead is currently off-screen?
        // Let's assume we want to keep the playhead centered or at its current relative offset.

        // Actually, simpler logic:
        // We want the timestamp `currentTime` to stay at the same pixel offset from the left of the VIEWPORT.
        // Old Playhead Screen X = (currentTime / duration) * OldTotalWidth - OldScrollLeft
        // New Playhead Screen X = (currentTime / duration) * NewTotalWidth - NewScrollLeft
        // We want OldScreenX == NewScreenX
        // So: (t/d)*W1 - S1 = (t/d)*W2 - S2
        // S2 = S1 + (t/d) * (W2 - W1)

        const containerWidth = scrollContainerRef.current.clientWidth; // Viewport width
        // Effective content width is (zoom * containerWidth) approximately 
        // (technically it's zoom * 100% of parent).

        const oldW = prevZoomRef.current * containerWidth;
        const newW = zoom * containerWidth;

        const currentScrollLeft = scrollContainerRef.current.scrollLeft;
        const deltaWidth = newW - oldW;

        // Calculate adjustment
        const scrollAdjustment = (currentTime / duration) * deltaWidth;

        scrollContainerRef.current.scrollLeft = currentScrollLeft + scrollAdjustment;
      }
      prevZoomRef.current = zoom;
    }
  }, [zoom, currentTime, duration]);

  const maxTrack = useMemo(() => Math.max(0, ...segments.map(s => s.track || 0)), [segments]);
  const tracks = useMemo(() => Array.from({ length: maxTrack + 1 }, (_, i) => i), [maxTrack]);

  const calculateTime = (e: MouseEvent | React.MouseEvent) => {
    if (!containerRef.current || duration === 0) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const SIDEBAR_WIDTH = 48;
    const x = e.clientX - rect.left - SIDEBAR_WIDTH;
    const percentage = Math.max(0, Math.min(1, x / (rect.width - SIDEBAR_WIDTH)));
    return percentage * duration;
  };

  const handleContainerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsSeeking(true);
    onSeek(calculateTime(e));
  };

  const startDrag = (e: React.MouseEvent, seg: Segment, type: 'move' | 'leftTrim' | 'rightTrim') => {
    e.stopPropagation();
    e.preventDefault();
    hasDraggedRef.current = false;

    const isMulti = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!isMulti && selectedSegmentIds.includes(seg.id) && selectedSegmentIds.length > 1) {
      // if clicking an already-selected item as part of a group, do not immediately clear selection, wait to see if it's a drag
    } else {
      onSegmentSelect(seg, isMulti);
    }

    // Calculate Snap Points
    const snapPoints = [0, currentTime];
    segments.forEach(s => {
      if (s.id !== seg.id) {
        snapPoints.push(s.timelineStart);
        snapPoints.push(s.timelineStart + (s.endTime - s.startTime));
      }
    });

    setDragState({
      id: seg.id,
      type,
      initialX: e.clientX,
      initialTimelineStart: seg.timelineStart,
      initialStartTime: seg.startTime,
      initialEndTime: seg.endTime,
      snapPoints
    });
  };

  const startDialogueDrag = (e: React.MouseEvent, evt: any, type: 'move' | 'leftTrim' | 'rightTrim') => {
    e.stopPropagation();
    e.preventDefault();
    onDialogueSelect(evt.mediaId, evt.originalIndex, e.shiftKey);

    // Push undo entry before drag begins
    onDialogueDragStart?.(evt.mediaId, evt.originalIndex, {
      startTime: evt.startTime, endTime: evt.endTime,
      type: evt.type, label: evt.label, details: evt.details,
      styleOverride: evt.styleOverride, templateOverride: evt.templateOverride,
      translateX: evt.translateX, translateY: evt.translateY,
    });

    setDialogueDragState({
      mediaId: evt.mediaId,
      index: evt.originalIndex,
      originalEvent: {
        startTime: evt.startTime,
        endTime: evt.endTime,
        type: evt.type,
        label: evt.label,
        details: evt.details,
        styleOverride: evt.styleOverride
      },
      type,
      initialX: e.clientX,
      initialStartTime: evt.startTime,
      initialEndTime: evt.endTime
    });
  };

  const startTitleDrag = (e: React.MouseEvent, type: 'move' | 'leftTrim' | 'rightTrim') => {
    e.stopPropagation();
    e.preventDefault();
    if (onTitleSelect && titleLayer) onTitleSelect(titleLayer);
    if (!titleLayer) return;

    setTitleDragState({
      type,
      initialX: e.clientX,
      initialStartTime: titleLayer.startTime,
      initialEndTime: titleLayer.endTime
    });
  };

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isSeeking) {
        onSeek(calculateTime(e));
        return;
      }

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const deltaX = e.clientX - ((dragState?.initialX || dialogueDragState?.initialX || titleDragState?.initialX) ?? 0);
      const SIDEBAR_WIDTH = 48;
      const deltaTime = (deltaX / (rect.width - SIDEBAR_WIDTH)) * duration;

      if (Math.abs(deltaX) > 2) {
        hasDraggedRef.current = true;
      }

      if (titleDragState && titleLayer && onUpdateTitle) {
        let newStart = titleDragState.initialStartTime;
        let newEnd = titleDragState.initialEndTime;

        if (titleDragState.type === 'move') {
          if (titleDragState.initialStartTime + deltaTime < 0) {
            const dt = -titleDragState.initialStartTime;
            newStart += dt;
            newEnd += dt;
          } else {
            newStart += deltaTime;
            newEnd += deltaTime;
          }
        } else if (titleDragState.type === 'leftTrim') {
          newStart += deltaTime;
          newStart = Math.max(0, newStart);
          newStart = Math.min(newStart, newEnd - 0.1);
        } else if (titleDragState.type === 'rightTrim') {
          newEnd += deltaTime;
          newEnd = Math.max(newStart + 0.1, newEnd);
        }

        onUpdateTitle({ startTime: newStart, endTime: newEnd });
        return;
      }

      if (dialogueDragState && onUpdateDialogue) {
        let newStart = dialogueDragState.initialStartTime;
        let newEnd = dialogueDragState.initialEndTime;

        if (dialogueDragState.type === 'move') {
          // Clamp to 0
          if (dialogueDragState.initialStartTime + deltaTime < 0) {
            const dt = -dialogueDragState.initialStartTime;
            newStart += dt;
            newEnd += dt;
          } else {
            newStart += deltaTime;
            newEnd += deltaTime;
          }
        } else if (dialogueDragState.type === 'leftTrim') {
          newStart += deltaTime;
          newStart = Math.max(0, newStart);
          // Prevent crossing
          newStart = Math.min(newStart, newEnd - 0.1);
        } else if (dialogueDragState.type === 'rightTrim') {
          newEnd += deltaTime;
          // Prevent crossing
          newEnd = Math.max(newEnd, newStart + 0.1);
        }

        // Apply Update
        onUpdateDialogue(dialogueDragState.mediaId, dialogueDragState.index, {
          ...dialogueDragState.originalEvent,
          startTime: newStart,
          endTime: newEnd
        });
        return;
      }

      if (dragState) {
        const seg = segments.find(s => s.id === dragState.id);
        if (!seg) return;

        if (dragState.type === 'move') {
          let newStart = Math.max(0, dragState.initialTimelineStart + deltaTime);

          if (snappingEnabled) {
            const SNAP_THRESHOLD = 0.2; // seconds
            let closestSnap = newStart;
            let minDist = Infinity;

            // 1. Magnetic Snapping
            for (const point of dragState.snapPoints) {
              const dist = Math.abs(newStart - point);
              if (dist < SNAP_THRESHOLD && dist < minDist) {
                minDist = dist;
                closestSnap = point;
              }
            }
            const currentDuration = seg.endTime - seg.startTime;
            const currentEnd = newStart + currentDuration;
            for (const point of dragState.snapPoints) {
              const dist = Math.abs(currentEnd - point);
              if (dist < SNAP_THRESHOLD && dist < minDist) {
                minDist = dist;
                closestSnap = point - currentDuration;
              }
            }
            if (minDist < SNAP_THRESHOLD) newStart = closestSnap;
          }

          // Calculate offset to apply to *all* selected segments
          const offset = newStart - dragState.initialTimelineStart;

          // If the dragged segment is selected, move everything selected by the same offset.
          // Otherwise, just move the dragged segment.
          if (selectedSegmentIds.includes(seg.id) && selectedSegmentIds.length > 1) {
            const updatedSegments: Segment[] = [];
            let canMove = true;

            // First check if any segment would be pushed before 0
            for (const sId of selectedSegmentIds) {
              const s = segments.find(x => x.id === sId);
              if (s && s.timelineStart + offset < 0) {
                canMove = false;
                break;
              }
            }

            if (canMove) {
              for (const sId of selectedSegmentIds) {
                const s = segments.find(x => x.id === sId);
                if (s) {
                  updatedSegments.push({ ...s, timelineStart: s.timelineStart + offset });
                }
              }
              onUpdateSegments(updatedSegments);
            }
          } else {
            onUpdateSegments([{ ...seg, timelineStart: Math.max(0, newStart) }]);
          }

        } else if (dragState.type === 'leftTrim') {
          const maxShift = dragState.initialEndTime - dragState.initialStartTime - 0.5;
          const requestedShift = Math.max(-dragState.initialStartTime, Math.min(maxShift, deltaTime));
          onUpdateSegments([{
            ...seg,
            startTime: dragState.initialStartTime + requestedShift,
            timelineStart: dragState.initialTimelineStart + requestedShift
          }]);
        } else if (dragState.type === 'rightTrim') {
          const requestedShift = Math.max(-(dragState.initialEndTime - dragState.initialStartTime - 0.5), deltaTime);
          onUpdateSegments([{ ...seg, endTime: dragState.initialEndTime + requestedShift }]);
        }
      }
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (dragState && !hasDraggedRef.current) {
        const isMulti = e.shiftKey || e.ctrlKey || e.metaKey;
        if (!isMulti && selectedSegmentIds.includes(dragState.id) && selectedSegmentIds.length > 1) {
          const seg = segments.find(s => s.id === dragState.id);
          if (seg) onSegmentSelect(seg, false);
        }
      }
      setIsSeeking(false);
      setDragState(null);
      setDialogueDragState(null);
      setTitleDragState(null);
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isSeeking, dragState, dialogueDragState, titleDragState, duration, segments, snappingEnabled, selectedSegmentIds, onUpdateDialogue, onUpdateTitle, onSegmentSelect]);

  const layoutSegments = useMemo(() => {
    return segments.map((seg) => {
      const len = seg.endTime - seg.startTime;
      return {
        ...seg,
        track: seg.track || 0,
        leftPercent: (seg.timelineStart / (duration || 1)) * 100,
        widthPercent: (len / (duration || 1)) * 100,
        timelineEnd: seg.timelineStart + len
      };
    });
  }, [segments, duration]);

  // Calculate Overlaps for rendering & handle suppression
  const { overlapZones, hiddenHandles } = useMemo(() => {
    const zones: {
      track: number;
      left: number;
      width: number;
      hasTransition: boolean;
      leftSegId: string;
      transition?: Transition;
    }[] = [];
    const hidden = new Set<string>();

    tracks.forEach(trackId => {
      const trackSegs = layoutSegments.filter(s => s.track === trackId);
      trackSegs.sort((a, b) => a.timelineStart - b.timelineStart);

      for (let i = 0; i < trackSegs.length; i++) {
        for (let j = i + 1; j < trackSegs.length; j++) {
          const s1 = trackSegs[i];
          const s2 = trackSegs[j];

          const start = Math.max(s1.timelineStart, s2.timelineStart);
          const end = Math.min(s1.timelineEnd, s2.timelineEnd);

          if (start < end) {
            const transition = s1.transitionOut;
            zones.push({
              track: trackId,
              left: (start / (duration || 1)) * 100,
              width: ((end - start) / (duration || 1)) * 100,
              hasTransition: !!transition,
              transition,
              leftSegId: s1.id
            });

            hidden.add(`${s1.id}-out`);
            hidden.add(`${s2.id}-in`);
          }
        }
      }
    });
    return { overlapZones: zones, hiddenHandles: hidden };
  }, [layoutSegments, tracks, duration]);

  // Compute Dialog Events with View Culling
  // Since we now have granular subtitles, we may have 1000s of small divs. 
  // We only want to render those visible on screen.
  // Compute Dialog Events with View Culling
  // Since we now have granular subtitles, we may have 1000s of small divs. 
  // We only want to render those visible on screen.
  // Optimize virtualization by tracking scroll
  // (Variables declared at top of component)

  const handleScroll = () => {
    if (scrollContainerRef.current) {
      setScrollLeft(scrollContainerRef.current.scrollLeft);
      setViewportWidth(scrollContainerRef.current.clientWidth);
    }
  };

  useEffect(() => {
    // Initial size
    if (scrollContainerRef.current) {
      setViewportWidth(scrollContainerRef.current.clientWidth);
    }
    window.addEventListener('resize', handleScroll);
    return () => window.removeEventListener('resize', handleScroll);
  }, []);

  // Compute Dialog Events with View Culling
  // Since we now have granular subtitles, we may have 1000s of small divs. 
  // We only want to render those visible on screen.
  const visibleDialogEvents = useMemo(() => {
    if (!duration) return [];

    // Calculate visible time range
    // Total Width = clientWidth (if zoom=1) * zoom
    // BUT we are using percentages for left/width.
    // We need to know which percentages are visible.

    // totalWidthPixels = viewportWidth // actually visual width of container?
    // No. The content width is zoom * 100%.
    // If zoom is 1, content is 100%. Scroll 0. 
    // If zoom is 10, content is 1000%. Scroll can be large.

    // Real Pixel Width of Content:
    // It is effectively `viewportWidth` if we consider 100% width = viewport.
    // BUT we style it `width: ${zoom * 100}%`.
    // So `pixelsPerSecond` is hard to know exactly without resize observer.

    // Easier: Work with Percentages.
    // Visible % Start = (scrollLeft / scrollWidth) * 100
    // Visible % End = ((scrollLeft + viewportWidth) / scrollWidth) * 100

    // Wait, scrollWidth is approximately `viewportWidth * zoom`.
    // So `visiblePercentStart = (scrollLeft / (viewportWidth * zoom)) * 100`? No.
    // `visiblePercentStart = (scrollLeft / scrollContainerRef.current.scrollWidth) * 100`.

    // Let's use Time.
    // visibleStart = (scrollLeft / scrollWidth) * duration 
    // visibleEnd = ((scrollLeft + viewportWidth) / scrollWidth) * duration

    let startCull = 0;
    let endCull = duration;

    if (scrollContainerRef.current) {
      const sw = scrollContainerRef.current.scrollWidth;
      const sl = scrollLeft; // from state
      const vw = viewportWidth;

      startCull = (sl / sw) * duration;
      endCull = ((sl + vw) / sw) * duration;

      // Add buffer
      startCull = Math.max(0, startCull - 5);
      endCull = Math.min(duration, endCull + 5);
    }

    const events: any[] = [];
    let totalRendered = 0;
    const MAX_VIEWPORT_RENDERED = 400; // Only render this many *within the view*

    layoutSegments.forEach(seg => {
      const analysis = analyses[seg.mediaId];
      if (!analysis) return;

      // Quick seg check - use TIMELINE positions, not source video times
      const segTimelineEnd = seg.timelineStart + (seg.endTime - seg.startTime);
      if (segTimelineEnd < startCull || seg.timelineStart > endCull) return;

      for (let i = 0; i < analysis.events.length; i++) {
        const evt = analysis.events[i];
        if (evt.type === 'dialogue') {
          // Check overlap with Segment (standard logic)
          const overlapStart = Math.max(evt.startTime, seg.startTime);
          const overlapEnd = Math.min(evt.endTime, seg.endTime);

          if (overlapStart < overlapEnd) {
            // Calculate the TIMELINE position for viewport culling
            const seqStart = seg.timelineStart + (overlapStart - seg.startTime);
            const seqLen = overlapEnd - overlapStart;
            const seqEnd = seqStart + seqLen;

            // NOW check viewport using timeline positions
            if (seqEnd < startCull || seqStart > endCull) continue;

            const widthPercent = (seqLen / (duration || 1)) * 100;

            if (totalRendered > MAX_VIEWPORT_RENDERED) break;

            events.push({
              ...evt,
              mediaId: seg.mediaId,
              originalIndex: i,
              leftPercent: (seqStart / (duration || 1)) * 100,
              widthPercent: Math.max(widthPercent, 0.05) // allow tiny lines
            });
            totalRendered++;
          }
        }
      }
    });

    return events;
  }, [analyses, layoutSegments, duration, scrollLeft, viewportWidth, zoom]);

  // Helper to generate gradients for clips based on transition category
  const getSegmentGradient = (t: Transition, isStart: boolean) => {
    const def = getTransitionDef(t.type);
    const color = def ? TRANSITION_CATEGORY_COLORS[def.category] + '99' : 'rgba(0,0,0,0.5)';
    return isStart
      ? `linear-gradient(90deg, ${color}, transparent)`
      : `linear-gradient(90deg, transparent, ${color})`;
  };

  return (
    <div className="w-full h-full bg-[#151515] flex flex-col select-none border-t border-[#333]">
      {/* HEADER: Tools & Zoom - Fixed at Top */}
      <div className="h-10 bg-[#202020] border-b border-[#333] flex items-center justify-between px-4 gap-4 z-[999] shrink-0">
        <div className="flex items-center gap-4">
          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">TIMELINE CONTROLS</div>
          <div className="h-4 w-px bg-[#333]"></div>
          <label className="flex items-center gap-2 cursor-pointer group hover:opacity-80 transition-opacity">
            <div className={`w-3 h-3 border rounded-sm flex items-center justify-center ${rippleMode ? 'bg-blue-600 border-blue-600' : 'border-gray-500'}`}>
              {rippleMode && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M5 13l4 4L19 7" /></svg>}
            </div>
            <span className={`text-[10px] font-medium ${rippleMode ? 'text-blue-400' : 'text-gray-400'}`}>Ripple</span>
            <input type="checkbox" className="hidden" checked={rippleMode} onChange={onToggleRipple} />
          </label>
          <label className="flex items-center gap-2 cursor-pointer group hover:opacity-80 transition-opacity">
            <div className={`w-3 h-3 border rounded-sm flex items-center justify-center ${snappingEnabled ? 'bg-green-600 border-green-600' : 'border-gray-500'}`}>
              {snappingEnabled && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
            </div>
            <span className={`text-[10px] font-medium ${snappingEnabled ? 'text-green-400' : 'text-gray-400'}`}>Snap</span>
            <input type="checkbox" className="hidden" checked={snappingEnabled} onChange={onToggleSnapping} />
          </label>
        </div>

        <div className="flex items-center gap-4">
          {/* Zoom Control */}
          <div className="flex items-center gap-2 bg-[#1a1a1a] px-2 py-1 rounded border border-[#333]">
            <span className="text-[9px] text-gray-500 font-mono uppercase">Zoom</span>
            <input
              type="range"
              min="1"
              max={zoomSensitivity}
              step="0.1"
              value={zoom}
              onChange={(e) => onZoomChange(parseFloat(e.target.value))}
              className="w-80 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
              title="Zoom Level"
            />

            {/* Sensitivity / Max Zoom Control */}
            <div className="flex items-center border-l border-[#333] pl-2 gap-1" title="Zoom Sensitivity Factor">
              <span className="text-[8px] text-gray-500">MAX:</span>
              <input
                type="number"
                min="10"
                max="5000"
                value={zoomSensitivity}
                onChange={(e) => setZoomSensitivity(Number(e.target.value))}
                className="w-10 bg-transparent text-[9px] text-blue-400 font-mono focus:outline-none text-right"
              />
            </div>

          </div>
        </div>
      </div>

      {/* SCROLLABLE TRACK AREA */}
      <div
        className="flex-1 relative bg-[#151515] overflow-auto min-w-0 custom-scrollbar"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        <div
          ref={containerRef}
          className="relative min-w-full min-h-full"
          style={{ width: `${Math.max(100, zoom * 100)}%` }}
          onMouseDown={handleContainerMouseDown}
        >
          {/* TIME RULER (Sticky Top) */}
          <div className="h-8 w-full border-b border-[#333] sticky top-0 bg-[#151515]/95 backdrop-blur-sm z-[60] flex shadow-sm">
            {/* Corner spacer for sticky sidebar labels */}
            <div className="sticky left-0 w-12 min-w-[3rem] h-full bg-[#202020] border-r border-[#333] z-[70]"></div>

            <div className="relative flex-1 h-full overflow-hidden">
              {Array.from({ length: Math.ceil(40 * zoom) }).map((_, i) => (
                <div key={i} className={`absolute h-full border-l ${i % 5 === 0 ? 'border-gray-500 h-full top-0' : 'border-[#222] h-2 bottom-0'} `} style={{ left: `${(i * 2.5) / zoom}%` }}>
                  {i % 5 === 0 && <span className="text-[8px] text-gray-400 pl-1 absolute top-0">{(duration * i / (40 * zoom)).toFixed(1)}s</span>}
                </div>
              ))}
            </div>
          </div>

          {/* TITLE TRACK (TTL) */}
          <div className="h-8 relative w-full border-b border-[#333] bg-[#1a1a1a] flex">
            <div className="sticky left-0 w-12 min-w-[3rem] h-full bg-[#202020] border-r border-[#333] flex items-center justify-center text-[9px] font-bold text-indigo-400 z-50 shadow-[2px_0_5px_rgba(0,0,0,0.2)]">TTL</div>
            <div className="relative flex-1 h-full">
              {titleLayer && (
                <div
                  className="absolute top-1 bottom-1 bg-indigo-600/60 border border-indigo-400/50 rounded-sm cursor-pointer hover:bg-indigo-500/80 transition-colors flex items-center justify-center px-2 overflow-hidden"
                  style={{
                    left: `${(titleLayer.startTime / (duration || 1)) * 100}%`,
                    width: `${((titleLayer.endTime - titleLayer.startTime) / (duration || 1)) * 100}%`
                  }}
                  onMouseDown={(e) => startTitleDrag(e, 'move')}
                  title={titleLayer.text}
                >
                  <div
                    className="absolute top-0 bottom-0 left-0 w-2 cursor-w-resize hover:bg-white/20"
                    onMouseDown={(e) => startTitleDrag(e, 'leftTrim')}
                  />
                  <div
                    className="absolute top-0 bottom-0 right-0 w-2 cursor-e-resize hover:bg-white/20"
                    onMouseDown={(e) => startTitleDrag(e, 'rightTrim')}
                  />
                  <span className="text-[9px] text-white font-bold truncate">{titleLayer.text}</span>
                </div>
              )}
            </div>
          </div>

          {/* DIALOGUE ROW */}
          <div className="h-10 relative w-full border-b border-[#333] bg-[#1a1a1a] flex">
            <div className="sticky left-0 w-12 min-w-[3rem] h-full bg-[#202020] border-r border-[#333] flex items-center justify-center text-[9px] font-bold text-purple-400 z-50 shadow-[2px_0_5px_rgba(0,0,0,0.2)]">DLG</div>
            <div className="relative flex-1 h-full">
              {visibleDialogEvents.map((evt, idx) => {
                const isSelected = selectedDialogues?.some(d => d.mediaId === evt.mediaId && d.index === evt.originalIndex) ?? false;
                const hasKeywords = evt.wordEmphases?.some((k: any) => k.enabled);

                return (
                  <div
                    key={`${evt.mediaId}-${idx}`}
                    className={`absolute top-1 bottom-1 rounded-sm cursor-pointer flex items-center px-1 overflow-visible group transition-colors ${isSelected
                      ? 'bg-purple-600 border-2 border-yellow-400 z-50'
                      : hasKeywords
                        ? 'bg-amber-800/50 border border-amber-500/50 hover:bg-amber-700/60'
                        : 'bg-purple-900/40 border border-purple-500/30 hover:bg-purple-700/60'
                      }`}
                    style={{ left: `${evt.leftPercent}%`, width: `${evt.widthPercent}%` }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      startDialogueDrag(e, evt, 'move');
                    }}
                    title={evt.details}
                  >
                    <span className="text-[9px] text-purple-100/90 truncate font-sans w-full block select-none pointer-events-none">{evt.details}</span>

                    {isSelected && (
                      <>
                        {/* Left Handle */}
                        <div
                          className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-yellow-400/50 hover:bg-yellow-400 z-50"
                          onMouseDown={(e) => startDialogueDrag(e, evt, 'leftTrim')}
                        />
                        {/* Right Handle */}
                        <div
                          className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-yellow-400/50 hover:bg-yellow-400 z-50"
                          onMouseDown={(e) => startDialogueDrag(e, evt, 'rightTrim')}
                        />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* TRACKS (Video + Audio Pairs) */}
          {tracks.slice().reverse().map(trackId => (
            <div key={`track-group-${trackId}`} className="flex flex-col w-full border-b border-[#333]">

              {/* VIDEO TRACK */}
              <div className="h-32 relative w-full flex bg-[#151515] border-b border-[#222]">
                {/* Sidebar Label (Sticky Left) */}
                <div className="sticky left-0 w-12 min-w-[3rem] h-full bg-[#202020] border-r border-[#333] flex items-center justify-center text-[9px] font-bold text-blue-400 z-50 shadow-[2px_0_5px_rgba(0,0,0,0.2)]">V{trackId + 1}</div>

                {/* Track Content */}
                <div className="relative flex-1 h-full">
                  {/* Grid Lines */}
                  <div className="absolute inset-0 pointer-events-none opacity-5" style={{ backgroundImage: 'linear-gradient(to right, #ffffff 1px, transparent 1px)', backgroundSize: '10% 100%' }}></div>

                  {/* LAYER 1: BASE SEGMENTS */}
                  {layoutSegments.filter(s => s.track === trackId).map((seg) => {
                    const isSelected = selectedSegmentIds.includes(seg.id);
                    const duration = seg.endTime - seg.startTime;

                    return (
                      <div
                        key={seg.id}
                        onMouseDown={(e) => startDrag(e, seg, 'move')}
                        className={`absolute top-2 bottom-2 rounded-md border overflow-hidden shadow-sm cursor-move transition-all hover:brightness-110 ${isSelected ? 'border-white ring-1 ring-white z-20' : 'border-black/20 z-10'}`}
                        style={{
                          left: `${seg.leftPercent}%`,
                          width: `${seg.widthPercent}%`,
                          backgroundColor: seg.color
                        }}
                      >
                        {/* Audio Waveform Shim or Blank Card pattern */}
                        {seg.type === 'blank' ? (
                          <div className="absolute inset-0 pointer-events-none opacity-10 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCI+CjxwYXRoIGQ9Ik0wIDIwTDIwIDBaIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMSIvPgo8L3N2Zz4=')] bg-repeat" />
                        ) : (
                          <div className="absolute bottom-0 left-0 right-0 h-full opacity-[0.03] bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+PHBhdGggZD0iTTAgNWw1LTUgNSA1di01SDB6IiBmaWxsPSIjZmZmIi8+PC9zdmc+')]" />
                        )}

                        {/* Transition Overlays */}
                        {seg.transitionIn && (
                          <div
                            className="absolute top-0 bottom-0 left-0 z-10 pointer-events-none"
                            style={{
                              width: `${Math.min(100, (seg.transitionIn.duration / duration) * 100)}%`,
                              background: getSegmentGradient(seg.transitionIn, true)
                            }}
                          />
                        )}

                        {seg.transitionOut && (
                          <div
                            className="absolute top-0 bottom-0 right-0 z-10 pointer-events-none"
                            style={{
                              width: `${Math.min(100, (seg.transitionOut.duration / duration) * 100)}%`,
                              background: getSegmentGradient(seg.transitionOut, false)
                            }}
                          />
                        )}

                        {/* Tracking data indicator bar */}
                        {seg.trackingData && seg.trackingData.length > 0 && (() => {
                          const segDuration = seg.endTime - seg.startTime;
                          if (segDuration <= 0) return null;
                          const firstT = seg.trackingData![0].time - seg.startTime;
                          const lastT = seg.trackingData![seg.trackingData!.length - 1].time - seg.startTime;
                          const leftPct = Math.max(0, (firstT / segDuration) * 100);
                          const widthPct = Math.min(100 - leftPct, ((lastT - firstT) / segDuration) * 100);
                          return (
                            <div
                              className="absolute top-0 h-[3px] bg-blue-400 rounded-b z-20 pointer-events-none"
                              style={{ left: `${leftPct}%`, width: `${Math.max(2, widthPct)}%` }}
                              title={`Tracking data: ${seg.trackingData!.length} frames`}
                            />
                          );
                        })()}

                        <div className="w-full h-full flex items-center px-2 pointer-events-none relative z-20 flex-col justify-center items-start">
                          {seg.type === 'blank' ? (
                            <>
                              <span className="text-[10px] font-bold text-white/50 truncate drop-shadow-md w-full">[ BLANK ]</span>
                              {seg.customText && (
                                <span className="text-[12px] font-bold text-white truncate drop-shadow-md w-full italic mt-1">{seg.customText}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-[10px] font-bold text-white truncate drop-shadow-md w-full">{seg.description}</span>
                          )}
                          <span className="text-[8px] text-white/60 truncate w-full font-mono mt-auto pb-1">{(seg.endTime - seg.startTime).toFixed(1)}s</span>
                        </div>

                        {/* Drag Triggers */}
                        <div className="absolute inset-y-0 left-0 w-4 cursor-col-resize z-30 hover:bg-white/10" onMouseDown={(e) => startDrag(e, seg, 'leftTrim')} />
                        <div className="absolute inset-y-0 right-0 w-4 cursor-col-resize z-30 hover:bg-white/10" onMouseDown={(e) => startDrag(e, seg, 'rightTrim')} />
                      </div>
                    );
                  })}

                  {/* LAYER 2: OVERLAP ZONES */}
                  {overlapZones.filter(z => z.track === trackId).map((zone, i) => {
                    const def = zone.transition ? getTransitionDef(zone.transition.type) : null;
                    const catColor = def ? TRANSITION_CATEGORY_COLORS[def.category] : '#3b82f6';
                    let bgStyle = 'repeating-linear-gradient(45deg, #00000088, #00000088 10px, #ffffff22 10px, #ffffff22 20px)';
                    let borderStyle = '2px solid rgba(255,255,255,0.3)';
                    let label = '';
                    if (zone.transition) {
                      label = `${zone.transition.duration.toFixed(1)}s`;
                      bgStyle = `linear-gradient(90deg, ${catColor}15, ${catColor}50, ${catColor}15)`;
                      borderStyle = `2px solid ${catColor}`;
                    }

                    return (
                      <div
                        key={`overlap-${i}`}
                        className="absolute top-2 bottom-2 z-20 flex items-center justify-center cursor-pointer group/zone transition-all duration-200"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditTransition(zone.leftSegId, 'out', e.clientX, e.clientY);
                        }}
                        style={{
                          left: `${zone.left}%`,
                          width: `${zone.width}%`,
                          background: bgStyle,
                          borderTop: borderStyle,
                          borderBottom: borderStyle,
                          borderRadius: 4
                        }}
                        title={zone.transition ? `${def?.name || zone.transition.type} (${label})` : "Edit Transition"}
                      >
                        <div className="bg-black/80 rounded-full px-1.5 py-0.5 border border-white/30 shadow-lg transform transition-transform group-hover/zone:scale-110 flex items-center gap-1">
                          <span className="text-[9px] text-white">{def?.icon || '⇄'}</span>
                          {zone.transition && <span className="text-[8px] text-white/60">{label}</span>}
                        </div>
                      </div>
                    );
                  })}

                  {/* LAYER 3: HANDLES */}
                  {layoutSegments.filter(s => s.track === trackId).map((seg) => {
                    const segData = segments.find(s => s.id === seg.id);
                    const hasTransIn = !!segData?.transitionIn;
                    const hasTransOut = !!segData?.transitionOut;
                    return (
                    <React.Fragment key={`handles-${seg.id}`}>
                      {!hiddenHandles.has(`${seg.id}-in`) && (
                        <button
                          className={`absolute top-1 w-3.5 h-3.5 border shadow-md z-30 transform -translate-x-1/2 rotate-45 flex items-center justify-center cursor-pointer transition-all ${
                            hasTransIn
                              ? 'bg-cyan-400 border-cyan-600 opacity-90 hover:opacity-100 hover:scale-125'
                              : 'bg-white/70 border-gray-500 opacity-40 hover:opacity-100 hover:bg-blue-400 hover:border-blue-600 hover:scale-125'
                          }`}
                          style={{ left: `${seg.leftPercent}%` }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); onEditTransition(seg.id, 'in', e.clientX, e.clientY); }}
                          title={hasTransIn ? `Intro: ${segData?.transitionIn?.type}` : 'Add intro transition'}
                        >
                          <div className={`w-1 h-1 rounded-full ${hasTransIn ? 'bg-white' : 'bg-black/50'}`} />
                        </button>
                      )}
                      {!hiddenHandles.has(`${seg.id}-out`) && (
                        <button
                          className={`absolute top-1 w-3.5 h-3.5 border shadow-md z-30 transform -translate-x-1/2 rotate-45 flex items-center justify-center cursor-pointer transition-all ${
                            hasTransOut
                              ? 'bg-cyan-400 border-cyan-600 opacity-90 hover:opacity-100 hover:scale-125'
                              : 'bg-white/70 border-gray-500 opacity-40 hover:opacity-100 hover:bg-blue-400 hover:border-blue-600 hover:scale-125'
                          }`}
                          style={{ left: `${seg.leftPercent + seg.widthPercent}%` }}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); onEditTransition(seg.id, 'out', e.clientX, e.clientY); }}
                          title={hasTransOut ? `Outro: ${segData?.transitionOut?.type}` : 'Add outro transition'}
                        >
                          <div className={`w-1 h-1 rounded-full ${hasTransOut ? 'bg-white' : 'bg-black/50'}`} />
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteSegment(seg.id); }}
                        className="absolute top-2 w-4 h-4 bg-red-600/80 hover:bg-red-600 rounded flex items-center justify-center z-30 text-white shadow-sm opacity-0 hover:opacity-100 transition-opacity"
                        style={{ left: `calc(${seg.leftPercent + seg.widthPercent}% - 18px)` }}
                      >
                        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    </React.Fragment>
                  );
                  })}
                </div>
              </div>

              {/* AUDIO TRACK (Linked to Video Track) */}
              <div className="h-16 relative w-full flex bg-[#111111]">
                <div className="sticky left-0 w-12 min-w-[3rem] h-full bg-[#181818] border-r border-[#333] flex items-center justify-center text-[9px] font-bold text-green-500 z-50 shadow-[2px_0_5px_rgba(0,0,0,0.2)]">A{trackId + 1}</div>
                <div className="relative flex-1 h-full pointer-events-none">
                  {/* Base Track Layout lines */}
                  <div className="absolute inset-x-0 top-1/2 h-[1px] bg-white/5" />

                  {layoutSegments.filter(s => s.track === trackId).map((seg) => {
                    const isSelected = selectedSegmentIds.includes(seg.id);

                    return (
                      <div
                        key={`a1-${seg.id}`}
                        className={`absolute top-1 bottom-1 ${seg.type === 'blank' ? 'bg-[#222222] border-[#333]' : 'bg-green-900/30 border-green-500/30'} border rounded overflow-hidden flex items-center justify-center`}
                        style={{ left: `${seg.leftPercent}%`, width: `${seg.widthPercent}%` }}
                      >
                        {/* Audio Waveform */}
                        {seg.type !== 'blank' && mediaFiles?.get(seg.mediaId) && (
                          <WaveformCanvas
                            mediaId={seg.mediaId}
                            file={mediaFiles.get(seg.mediaId)!}
                            startTime={seg.startTime}
                            endTime={seg.endTime}
                          />
                        )}
                        {seg.type !== 'blank' && !mediaFiles?.get(seg.mediaId) && (
                          <div className="absolute inset-0 opacity-40 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+PHBhdGggZD0iTTAgNWw1LTUgNSA1di01SDB6IiBmaWxsPSIjZmZmIi8+PC9zdmc+')]" style={{ backgroundSize: '10px 100%' }} />
                        )}
                        <span className="text-[10px] text-white/50 relative z-10">{seg.type === 'blank' ? 'No Audio' : seg.description}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

            </div>
          ))}

          {/* PLAYHEAD */}
          <div className="absolute top-0 bottom-0 w-[2px] bg-red-500 z-[80] pointer-events-none shadow-[0_0_10px_rgba(239,68,68,0.8)]" style={{ left: `calc(3rem + (100% - 3rem) * ${(currentTime / (duration || 1))})` }}>
            <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-red-500 absolute -top-0 left-1/2 transform -translate-x-1/2" />
            <div className="absolute top-2 left-2 text-[10px] bg-red-500 text-white px-1 rounded font-mono font-bold opacity-0 group-hover:opacity-100 transition-opacity">{currentTime.toFixed(2)}s</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Timeline;