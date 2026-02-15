import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Segment, VideoAnalysis, Transition, TitleLayer } from '../types';

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
  onUpdateSegment: (segment: Segment) => void;
  onDeleteSegment: (id: string) => void;
  onToggleRipple: () => void;
  onToggleSnapping: () => void;
  onEditTransition: (segId: string, side: 'in' | 'out', x: number, y: number) => void;
  onDialogueSelect: (mediaId: string, eventIndex: number) => void;
  selectedDialogue?: { mediaId: string; index: number } | null;
  onUpdateDialogue?: (mediaId: string, index: number, newEvent: import('../types').AnalysisEvent) => void;
  onDeleteDialogue?: (mediaId: string, index: number) => void;
  onTitleSelect?: (title: TitleLayer) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

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
  onUpdateSegment,
  onDeleteSegment,
  onToggleRipple,
  onToggleSnapping,
  onEditTransition,
  onDialogueSelect,
  selectedDialogue,
  onUpdateDialogue,
  onDeleteDialogue,
  onTitleSelect,
  zoom,
  onZoomChange
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

    const isMulti = e.ctrlKey || e.metaKey;
    onSegmentSelect(seg, isMulti);

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
    onDialogueSelect(evt.mediaId, evt.originalIndex);

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

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isSeeking) {
        onSeek(calculateTime(e));
        return;
      }

      const rect = containerRef.current.getBoundingClientRect();
      const deltaX = e.clientX - ((dragState?.initialX || dialogueDragState?.initialX) ?? 0);
      const SIDEBAR_WIDTH = 48;
      const deltaTime = (deltaX / (rect.width - SIDEBAR_WIDTH)) * duration;

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

          onUpdateSegment({ ...seg, timelineStart: Math.max(0, newStart) });

        } else if (dragState.type === 'leftTrim') {
          const maxShift = dragState.initialEndTime - dragState.initialStartTime - 0.5;
          const requestedShift = Math.max(-dragState.initialStartTime, Math.min(maxShift, deltaTime));
          onUpdateSegment({
            ...seg,
            startTime: dragState.initialStartTime + requestedShift,
            timelineStart: dragState.initialTimelineStart + requestedShift
          });
        } else if (dragState.type === 'rightTrim') {
          const requestedShift = Math.max(-(dragState.initialEndTime - dragState.initialStartTime - 0.5), deltaTime);
          onUpdateSegment({ ...seg, endTime: dragState.initialEndTime + requestedShift });
        }
      }
    };

    const handleGlobalMouseUp = () => {
      setIsSeeking(false);
      setIsSeeking(false);
      setDragState(null);
      setDialogueDragState(null);
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isSeeking, dragState, dialogueDragState, duration, segments, snappingEnabled, onUpdateDialogue]);

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

  // Helper to generate gradients for clips
  const getSegmentGradient = (t: Transition, isStart: boolean) => {
    let color = 'rgba(0,0,0,0.5)';
    if (t.type === 'FADE' || t.type === 'CROSSFADE') {
      color = 'rgba(59,130,246,0.6)';
    } else if (t.type === 'WASH_BLACK') {
      color = '#000000';
    } else if (t.type === 'WASH_WHITE') {
      color = '#ffffff';
    } else if (t.type === 'WASH_COLOR') {
      color = t.color || '#ff0000';
    }
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

            <div className="w-px h-4 bg-[#333] mx-1"></div>
            <button onClick={() => onSplit(currentTime)} className="px-3 py-1 bg-[#333] hover:bg-[#444] rounded text-[9px] font-bold text-gray-200 flex items-center gap-1 transition-colors">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758L5 19m0-14l4.121 4.121" /></svg> RAZOR
            </button>
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
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    if (onTitleSelect) onTitleSelect(titleLayer);
                  }}
                  title={titleLayer.text}
                >
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
                const isSelected = selectedDialogue?.mediaId === evt.mediaId && selectedDialogue?.index === evt.originalIndex;

                return (
                  <div
                    key={`${evt.mediaId}-${idx}`}
                    className={`absolute top-1 bottom-1 rounded-sm cursor-pointer flex items-center px-1 overflow-visible group transition-colors ${isSelected
                      ? 'bg-purple-600 border-2 border-yellow-400 z-50'
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

          {/* TRACKS (Stacked) */}
          {tracks.slice().reverse().map(trackId => (
            <div key={trackId} className="h-32 relative w-full border-b border-[#333] flex bg-[#151515]">
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
                      {/* Audio Waveform Shim (Fake) */}
                      <div className="absolute bottom-0 left-0 right-0 h-1/2 opacity-20 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+PHBhdGggZD0iTTAgNWw1LTUgNSA1di01SDB6IiBmaWxsPSIjZmZmIi8+PC9zdmc+')]"></div>

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

                      <div className="w-full h-full flex items-center px-2 pointer-events-none relative z-20 flex-col justify-center items-start">
                        <span className="text-[10px] font-bold text-white truncate drop-shadow-md w-full">{seg.description}</span>
                        <span className="text-[8px] text-white/60 truncate w-full font-mono">{(seg.endTime - seg.startTime).toFixed(1)}s</span>
                      </div>

                      {/* Drag Triggers */}
                      <div className="absolute inset-y-0 left-0 w-4 cursor-col-resize z-30 hover:bg-white/10" onMouseDown={(e) => startDrag(e, seg, 'leftTrim')} />
                      <div className="absolute inset-y-0 right-0 w-4 cursor-col-resize z-30 hover:bg-white/10" onMouseDown={(e) => startDrag(e, seg, 'rightTrim')} />
                    </div>
                  );
                })}

                {/* LAYER 2: OVERLAP ZONES */}
                {overlapZones.filter(z => z.track === trackId).map((zone, i) => {
                  // ... rendering logic same ...
                  let bgStyle = 'repeating-linear-gradient(45deg, #00000088, #00000088 10px, #ffffff22 10px, #ffffff22 20px)';
                  let borderStyle = '2px solid rgba(255,255,255,0.3)';
                  let label = '';
                  if (zone.transition) {
                    const t = zone.transition;
                    label = `${t.duration.toFixed(1)}s`;
                    if (t.type === 'WASH_BLACK') {
                      bgStyle = 'linear-gradient(90deg, transparent, #000000, transparent)';
                      borderStyle = '2px solid #000';
                    } else if (t.type === 'WASH_WHITE') {
                      bgStyle = 'linear-gradient(90deg, transparent, #ffffff, transparent)';
                      borderStyle = '2px solid #fff';
                    } else if (t.type === 'WASH_COLOR') {
                      const c = t.color || '#ff0000';
                      bgStyle = `linear-gradient(90deg, transparent, ${c}, transparent)`;
                      borderStyle = `2px solid ${c}`;
                    } else if (t.type === 'CROSSFADE' || t.type === 'FADE') {
                      bgStyle = 'linear-gradient(90deg, rgba(59,130,246,0.1), rgba(59,130,246,0.4), rgba(59,130,246,0.1))';
                      borderStyle = '2px solid #3b82f6';
                    }
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
                      title={zone.transition ? `${zone.transition.type}` : "Edit Transition"}
                    >
                      <div className="bg-black/80 rounded-full p-1 border border-white/30 shadow-lg transform transition-transform group-hover/zone:scale-110">
                        <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                      </div>
                    </div>
                  );
                })}

                {/* LAYER 3: HANDLES */}
                {layoutSegments.filter(s => s.track === trackId).map((seg) => (
                  <React.Fragment key={`handles-${seg.id}`}>
                    {!hiddenHandles.has(`${seg.id}-in`) && (
                      <button
                        className="absolute top-1 w-3 h-3 bg-white hover:bg-blue-400 border border-black shadow-md z-30 transform -translate-x-1/2 rotate-45 flex items-center justify-center cursor-pointer opacity-0 hover:opacity-100 transition-opacity"
                        style={{ left: `${seg.leftPercent}%` }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onEditTransition(seg.id, 'in', e.clientX, e.clientY); }}
                      >
                        <div className="w-1 h-1 bg-black rounded-full" />
                      </button>
                    )}
                    {!hiddenHandles.has(`${seg.id}-out`) && (
                      <button
                        className="absolute top-1 w-3 h-3 bg-white hover:bg-blue-400 border border-black shadow-md z-30 transform -translate-x-1/2 rotate-45 flex items-center justify-center cursor-pointer opacity-0 hover:opacity-100 transition-opacity"
                        style={{ left: `${seg.leftPercent + seg.widthPercent}%` }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onEditTransition(seg.id, 'out', e.clientX, e.clientY); }}
                      >
                        <div className="w-1 h-1 bg-black rounded-full" />
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
                ))}
              </div>
            </div>
          ))}

          {/* AUDIO MIX TRACK */}
          <div className="h-24 relative w-full border-b border-[#333] flex bg-[#151515]">
            <div className="sticky left-0 w-12 min-w-[3rem] h-full bg-[#202020] border-r border-[#333] flex items-center justify-center text-[9px] font-bold text-green-500 z-50 shadow-[2px_0_5px_rgba(0,0,0,0.2)]">A(Mix)</div>
            <div className="relative flex-1 h-full pointer-events-none">
              {layoutSegments.map((seg) => (
                <div key={`a1-${seg.id}`} className="absolute top-2 bottom-2 bg-green-900/20 border border-green-500/10 rounded" style={{ left: `${seg.leftPercent}%`, width: `${seg.widthPercent}%` }} />
              ))}
            </div>
          </div>

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