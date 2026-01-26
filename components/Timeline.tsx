import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Segment, VideoAnalysis, Transition } from '../types';

interface TimelineProps {
  duration: number;
  currentTime: number;
  segments: Segment[];
  analyses: Record<string, VideoAnalysis | null>;
  rippleMode: boolean;
  snappingEnabled: boolean;
  selectedSegmentIds: string[];
  onSeek: (time: number) => void;
  onSegmentSelect: (segment: Segment, isMulti: boolean) => void;
  onSplit: (time: number) => void;
  onUpdateSegment: (segment: Segment) => void;
  onDeleteSegment: (id: string) => void;
  onToggleRipple: () => void;
  onToggleSnapping: () => void;
  onEditTransition: (segId: string, side: 'in' | 'out', x: number, y: number) => void;
  onDialogueSelect: (mediaId: string, eventIndex: number) => void;
}

const Timeline: React.FC<TimelineProps> = ({ 
  duration, 
  currentTime, 
  segments,
  analyses,
  rippleMode,
  snappingEnabled,
  selectedSegmentIds,
  onSeek,
  onSegmentSelect,
  onSplit,
  onUpdateSegment,
  onDeleteSegment,
  onToggleRipple,
  onToggleSnapping,
  onEditTransition,
  onDialogueSelect
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0); // Track scroll for virtualization

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

  const maxTrack = useMemo(() => Math.max(0, ...segments.map(s => s.track || 0)), [segments]);
  const tracks = useMemo(() => Array.from({ length: maxTrack + 1 }, (_, i) => i), [maxTrack]);

  const calculateTime = (e: MouseEvent | React.MouseEvent) => {
    if (!containerRef.current || duration === 0) return 0;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
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

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isSeeking) {
        onSeek(calculateTime(e));
        return;
      }

      if (dragState && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const deltaX = e.clientX - dragState.initialX;
        const deltaTime = (deltaX / rect.width) * duration;
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
      setDragState(null);
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [isSeeking, dragState, duration, segments, snappingEnabled]);

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
  const visibleDialogEvents = useMemo(() => {
    const events: any[] = [];
    
    // Approximate visibility based on scroll (not implemented fully on container, assuming full width view for now)
    // But we can cull small items that are off-screen if we had zoom. 
    // Since this timeline fits to width (mostly), we just map them all but we optimize the map.
    
    layoutSegments.forEach(seg => {
      const analysis = analyses[seg.mediaId];
      if (!analysis) return;
      
      analysis.events.forEach((evt, idx) => {
        if (evt.type === 'dialogue') {
          const overlapStart = Math.max(evt.startTime, seg.startTime);
          const overlapEnd = Math.min(evt.endTime, seg.endTime);
          
          if (overlapStart < overlapEnd) {
            const seqStart = seg.timelineStart + (overlapStart - seg.startTime);
            const seqLen = overlapEnd - overlapStart;
            
            // Simple Optimization: Don't render events smaller than 0.2% width unless zoomed (future proofing)
            const widthPercent = (seqLen / (duration || 1)) * 100;
            
            events.push({
              ...evt,
              mediaId: seg.mediaId,
              originalIndex: idx,
              leftPercent: (seqStart / (duration || 1)) * 100,
              widthPercent: Math.max(widthPercent, 0.5) // Min width for visibility of short words
            });
          }
        }
      });
    });
    return events;
  }, [analyses, layoutSegments, duration]);

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
    <div className="w-full h-full bg-[#1e1e1e] flex flex-col select-none border-t border-[#333]">
      <div className="h-8 bg-[#252525] border-b border-[#333] flex items-center justify-between px-4 gap-4">
        <div className="flex items-center gap-4">
            <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Timeline</div>
            <label className="flex items-center gap-2 cursor-pointer group">
                <div className={`w-3 h-3 border rounded-sm flex items-center justify-center ${rippleMode ? 'bg-blue-600 border-blue-600' : 'border-gray-500'}`}>
                    {rippleMode && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M5 13l4 4L19 7" /></svg>}
                </div>
                <span className={`text-[10px] font-medium ${rippleMode ? 'text-blue-400' : 'text-gray-400'}`}>Ripple Delete</span>
                <input type="checkbox" className="hidden" checked={rippleMode} onChange={onToggleRipple} />
            </label>
            <label className="flex items-center gap-2 cursor-pointer group">
                <div className={`w-3 h-3 border rounded-sm flex items-center justify-center ${snappingEnabled ? 'bg-green-600 border-green-600' : 'border-gray-500'}`}>
                    {snappingEnabled && <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>}
                </div>
                <span className={`text-[10px] font-medium ${snappingEnabled ? 'text-green-400' : 'text-gray-400'}`}>Snap</span>
                <input type="checkbox" className="hidden" checked={snappingEnabled} onChange={onToggleSnapping} />
            </label>
        </div>
        <button onClick={() => onSplit(currentTime)} className="px-2 py-0.5 bg-[#333] hover:bg-[#444] rounded text-[9px] font-bold text-gray-300 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758L5 19m0-14l4.121 4.121" /></svg> RAZOR
        </button>
      </div>

      <div className="flex-1 relative flex overflow-y-auto">
        <div className="w-12 bg-[#252525] border-r border-[#333] flex flex-col pt-6 z-10 sticky left-0">
          <div className="h-8 flex items-center justify-center text-[9px] font-bold text-purple-500 border-b border-[#333] bg-[#252525]">DLG</div>
          {tracks.slice().reverse().map(trackId => (
             <div key={trackId} className="h-20 flex items-center justify-center text-[9px] font-bold text-blue-500 border-b border-[#333] bg-[#252525]">V{trackId + 1}</div>
          ))}
          <div className="h-20 flex items-center justify-center text-[9px] font-bold text-green-500 bg-[#252525]">A(Mix)</div>
        </div>

        <div ref={containerRef} className="flex-1 relative bg-[#121212] min-w-0" onMouseDown={handleContainerMouseDown}>
          <div className="h-6 w-full border-b border-[#333] relative pointer-events-none sticky top-0 bg-[#121212] z-20">
            {Array.from({ length: 40 }).map((_, i) => (
              <div key={i} className={`absolute h-full border-l ${i % 5 === 0 ? 'border-gray-500' : 'border-[#222]'}`} style={{ left: `${i * 2.5}%` }}>
                {i % 5 === 0 && <span className="text-[8px] text-gray-600 pl-1">{(duration * i / 40).toFixed(0)}s</span>}
              </div>
            ))}
          </div>

          <div className="h-8 relative w-full border-b border-[#333] bg-[#1a1a1a]">
            {visibleDialogEvents.map((evt, idx) => (
              <div 
                key={`${evt.mediaId}-${idx}`} 
                className="absolute top-1 bottom-1 bg-purple-900/60 border border-purple-500/40 rounded-sm hover:bg-purple-800/80 cursor-pointer flex items-center px-1 overflow-hidden group" 
                style={{ left: `${evt.leftPercent}%`, width: `${evt.widthPercent}%` }}
                onMouseDown={(e) => {
                    e.stopPropagation();
                    onDialogueSelect(evt.mediaId, evt.originalIndex);
                }}
                title={evt.details}
              >
                  <span className="text-[9px] text-white/90 truncate font-sans w-full block group-hover:text-white">{evt.details}</span>
              </div>
            ))}
          </div>

          {tracks.slice().reverse().map(trackId => (
            <div key={trackId} className="h-20 relative w-full border-b border-[#333]">
               
               {/* LAYER 1: BASE SEGMENTS */}
               {layoutSegments.filter(s => s.track === trackId).map((seg) => {
                  const isSelected = selectedSegmentIds.includes(seg.id);
                  const duration = seg.endTime - seg.startTime;

                  return (
                    <div
                      key={seg.id}
                      onMouseDown={(e) => startDrag(e, seg, 'move')}
                      className={`absolute top-1 bottom-1 rounded border overflow-hidden shadow-lg cursor-move transition-opacity ${isSelected ? 'border-white z-10' : 'border-white/20 z-0'}`}
                      style={{ 
                          left: `${seg.leftPercent}%`, 
                          width: `${seg.widthPercent}%`, 
                          backgroundColor: seg.color 
                      }}
                    >
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

                      <div className="w-full h-full flex items-center px-2 pointer-events-none relative z-20">
                        <span className="text-[10px] font-bold text-white truncate drop-shadow-md">{seg.description}</span>
                      </div>
                      
                      {/* Drag Triggers */}
                      <div className="absolute inset-y-0 left-0 w-3 cursor-col-resize z-30" onMouseDown={(e) => startDrag(e, seg, 'leftTrim')} />
                      <div className="absolute inset-y-0 right-0 w-3 cursor-col-resize z-30" onMouseDown={(e) => startDrag(e, seg, 'rightTrim')} />
                    </div>
                  );
               })}

               {/* LAYER 2: OVERLAP ZONES */}
               {overlapZones.filter(z => z.track === trackId).map((zone, i) => {
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
                      className="absolute top-1 bottom-1 z-20 flex items-center justify-center cursor-pointer group/zone transition-all duration-200"
                      onClick={(e) => {
                          e.stopPropagation();
                          onEditTransition(zone.leftSegId, 'out', e.clientX, e.clientY);
                      }}
                      style={{
                          left: `${zone.left}%`,
                          width: `${zone.width}%`,
                          background: bgStyle,
                          borderTop: borderStyle,
                          borderBottom: borderStyle
                      }}
                      title={zone.transition ? `${zone.transition.type} (${zone.transition.duration}s)` : "Click to edit transition"}
                   >
                       {zone.transition && (
                           <div className="absolute -top-4 bg-black/90 border border-white/20 text-[9px] text-white px-1.5 rounded shadow-xl opacity-0 group-hover/zone:opacity-100 transition-opacity whitespace-nowrap z-50 pointer-events-none">
                               {label}
                           </div>
                       )}

                       <div className="bg-black/80 rounded-full p-1 border border-white/30 shadow-lg transform transition-transform group-hover/zone:scale-110">
                           <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
                       </div>
                   </div>
                   );
               })}

               {/* LAYER 3: HANDLES */}
               {layoutSegments.filter(s => s.track === trackId).map((seg) => (
                   <React.Fragment key={`handles-${seg.id}`}>
                       {!hiddenHandles.has(`${seg.id}-in`) && (
                           <button 
                             className="absolute top-1 w-3 h-3 bg-white hover:bg-blue-400 border border-black shadow-md z-30 transform -translate-x-1/2 rotate-45 flex items-center justify-center cursor-pointer"
                             style={{ left: `${seg.leftPercent}%` }}
                             title="Edit Start Transition"
                             onMouseDown={(e) => e.stopPropagation()}
                             onClick={(e) => { e.stopPropagation(); onEditTransition(seg.id, 'in', e.clientX, e.clientY); }}
                           >
                               <div className="w-1 h-1 bg-black rounded-full" />
                           </button>
                       )}

                       {!hiddenHandles.has(`${seg.id}-out`) && (
                           <button 
                             className="absolute top-1 w-3 h-3 bg-white hover:bg-blue-400 border border-black shadow-md z-30 transform -translate-x-1/2 rotate-45 flex items-center justify-center cursor-pointer"
                             style={{ left: `${seg.leftPercent + seg.widthPercent}%` }}
                             title="Edit End Transition"
                             onMouseDown={(e) => e.stopPropagation()}
                             onClick={(e) => { e.stopPropagation(); onEditTransition(seg.id, 'out', e.clientX, e.clientY); }}
                           >
                                <div className="w-1 h-1 bg-black rounded-full" />
                           </button>
                       )}

                       <button 
                        onClick={(e) => { e.stopPropagation(); onDeleteSegment(seg.id); }} 
                        className="absolute top-2 w-4 h-4 bg-red-600/80 hover:bg-red-600 rounded flex items-center justify-center z-30 text-white shadow-sm"
                        style={{ left: `calc(${seg.leftPercent + seg.widthPercent}% - 18px)` }}
                       >
                         <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12" /></svg>
                       </button>
                   </React.Fragment>
               ))}
            </div>
          ))}

          <div className="h-20 relative w-full pointer-events-none">
            {layoutSegments.map((seg) => (
              <div key={`a1-${seg.id}`} className="absolute top-2 bottom-2 bg-green-900/20 border border-green-500/10 rounded" style={{ left: `${seg.leftPercent}%`, width: `${seg.widthPercent}%` }} />
            ))}
          </div>

          <div className="absolute top-0 bottom-0 w-[2px] bg-blue-400 z-50 pointer-events-none shadow-[0_0_10px_rgba(96,165,250,1)]" style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}>
            <div className="w-4 h-4 bg-blue-500 absolute -top-1.5 left-1/2 transform -translate-x-1/2 rotate-45 border border-white/20" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Timeline;