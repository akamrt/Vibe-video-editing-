import React, { useState, useRef, useEffect, useMemo } from 'react';
import Timeline from './components/Timeline';
import ChatPanel from './components/ChatPanel';
import TranscriptPanel from './components/TranscriptPanel';
import PropertiesPanel from './components/PropertiesPanel';
import MediaBin from './components/MediaBin';
import { ProjectState, Segment, ChatMessage, ProcessingStatus, MediaItem, TransitionType, Transition, SubtitleStyle, AnalysisEvent } from './types';
import { analyzeVideoContent, generateVibeEdit, chatWithVideoContext, transcribeAudio, performDeepAnalysis } from './services/geminiService';

const INITIAL_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Arial',
  fontSize: 24,
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

const INITIAL_STATE: ProjectState = {
  library: [],
  segments: [],
  currentTime: 0,
  isPlaying: false,
  activeSegmentIndex: 0,
  loopMode: false,
  subtitleStyle: INITIAL_SUBTITLE_STYLE
};

function App() {
  const [project, setProject] = useState<ProjectState>(INITIAL_STATE);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);

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

  const [isCaching, setIsCaching] = useState(false);
  const [rippleMode, setRippleMode] = useState(true);
  const [snappingEnabled, setSnappingEnabled] = useState(true);

  // We now manage a map of video refs for multi-track playback
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const overlayRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Computed Sequence Info
  const contentDuration = useMemo(() => {
    if (project.segments.length === 0) return 0;
    return Math.max(...project.segments.map(s => s.timelineStart + (s.endTime - s.startTime)));
  }, [project.segments]);

  const timelineViewDuration = useMemo(() => {
    return Math.max(contentDuration + 5, 30); // Min 30s view, always some padding
  }, [contentDuration]);

  // Identify active segments at the current time
  const activeSegments = useMemo(() => {
    return project.segments.filter(s => 
      project.currentTime >= s.timelineStart && 
      project.currentTime < (s.timelineStart + (s.endTime - s.startTime))
    ).sort((a, b) => a.track - b.track); // Sort by track (0 is bottom, higher is top)
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

    return currentTopMedia.analysis.events.find(e => 
      e.type === 'dialogue' && sourceTime >= e.startTime && sourceTime <= e.endTime
    );
  }, [currentTopMedia, project.currentTime, activeSegments]);

  // Get the specific selected dialogue event object for Properties
  const selectedDialogueEvent = useMemo(() => {
      if (!selectedDialogue) return null;
      const media = project.library.find(m => m.id === selectedDialogue.mediaId);
      return media?.analysis?.events[selectedDialogue.index] || null;
  }, [selectedDialogue, project.library]);

  // Effective Subtitle Style for the Properties Panel and selected item
  const effectiveSubtitleStyle = useMemo(() => {
      return selectedDialogueEvent?.styleOverride || project.subtitleStyle;
  }, [selectedDialogueEvent, project.subtitleStyle]);

  const isSubtitleUnlinked = !!selectedDialogueEvent?.styleOverride;


  // Playback Engine
  useEffect(() => {
    let animationFrameId: number;
    const engineLoop = () => {
      const p = projectRef.current;
      if (!p.isPlaying) return;

      const nextTime = p.currentTime + (1/60);
      
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
        animationFrameId = requestAnimationFrame(engineLoop);
    }
    
    return () => cancelAnimationFrame(animationFrameId);
  }, [project.isPlaying]);

  // Sync Video Elements & Handle Transitions
  useEffect(() => {
    activeSegments.forEach(seg => {
      const videoEl = videoRefs.current.get(seg.id);
      const overlayEl = overlayRefs.current.get(seg.id);
      const media = project.library.find(m => m.id === seg.mediaId);
      
      if (videoEl && media) {
        const sourceTime = seg.startTime + (project.currentTime - seg.timelineStart);
        
        if (videoEl.src !== media.url) {
           videoEl.src = media.url;
        }

        if (Math.abs(videoEl.currentTime - sourceTime) > 0.15) {
          videoEl.currentTime = sourceTime;
        }

        if (project.isPlaying && videoEl.paused) {
           videoEl.play().catch(() => {});
        } else if (!project.isPlaying && !videoEl.paused) {
           videoEl.pause();
        }

        // --- Transition Logic ---
        let opacity = 1;
        let overlayOpacity = 0;
        let overlayColor = 'white'; 
        let videoBlendMode = 'normal'; // Blend mode for the video itself (Photoshop mode)
        let overlayBlendMode = 'normal'; // Blend mode for the solid color wash
        
        const relTime = project.currentTime - seg.timelineStart;
        const duration = seg.endTime - seg.startTime;

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
  }, [project.currentTime, activeSegments, project.isPlaying, project.library]);

  // Clean up refs
  useEffect(() => {
    const currentIds = new Set(activeSegments.map(s => s.id));
    for (const [id] of videoRefs.current) {
      if (!currentIds.has(id)) videoRefs.current.delete(id);
    }
    for (const [id] of overlayRefs.current) {
      if (!currentIds.has(id)) overlayRefs.current.delete(id);
    }
  }, [activeSegments]);

  // Keyboard Listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (selectedSegmentIds.length > 0) {
        if (e.key === 'Delete') performDelete(selectedSegmentIds, false);
        else if (e.key === 'Backspace') performDelete(selectedSegmentIds, true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSegmentIds]);


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
        duration: video.duration,
        name: file.name,
        analysis: null
      });
    }
    setProject(prev => ({ ...prev, library: [...prev.library, ...newItems] }));
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
    setProject(prev => ({ ...prev, segments: [...prev.segments, newSeg] }));
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
    setSelectedTransition({ segId, side });
    setActiveRightTab('properties');
  };

  const handleDialogueSelect = (mediaId: string, index: number) => {
      setSelectedSegmentIds([]); // Deselect clips
      setSelectedTransition(null);
      setSelectedDialogue({ mediaId, index });
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
          const sorted = Array.from(points).sort((a,b) => a-b);
          let target = direction === 'next' ? sorted.find(t => t > p.currentTime + 0.01) : [...sorted].reverse().find(t => t < p.currentTime - 0.01);
          return { ...p, isPlaying: false, currentTime: target ?? (direction === 'next' ? contentDuration : 0) };
      });
  };

  const handleDeepAnalyze = async (mediaId: string, customPrompt: string = "") => {
    const media = project.library.find(m => m.id === mediaId);
    if (!media) return;
    setStatus(ProcessingStatus.DEEP_ANALYZING);
    try {
        const analysis = await performDeepAnalysis(media.file, media.duration, customPrompt, media.analysis);
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

  const hexToRgba = (hex: string, alpha: number) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Resolve style for the currently displayed subtitle
  const displayStyle = activeSubtitleEvent?.styleOverride || project.subtitleStyle;
  const styles = getSubtitleStyles(displayStyle);

  return (
    <div className="flex h-screen w-screen bg-[#121212] text-gray-200 overflow-hidden relative font-sans">
      
      {/* LEFT: Media Bin */}
      <div className="w-64 flex-shrink-0">
        <MediaBin 
          items={project.library} 
          onUpload={handleUpload} 
          onAddToTimeline={handleAddToTimeline} 
          onSelect={m => setSelectedMediaId(m.id)}
        />
      </div>

      {/* MIDDLE: Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 flex min-h-0">
          
          {/* Program Monitor */}
          <div className="flex-1 bg-black flex flex-col relative overflow-hidden">
            <div className="flex-1 relative overflow-hidden group flex items-center justify-center">
              {activeSegments.length > 0 ? (
                activeSegments.map((seg, index) => (
                    <div key={seg.id} className="absolute inset-0 w-full h-full" style={{ zIndex: seg.track * 10 }}>
                        <video
                            ref={el => { if (el) videoRefs.current.set(seg.id, el); }}
                            src={project.library.find(m => m.id === seg.mediaId)?.url}
                            className="w-full h-full object-contain pointer-events-none"
                            muted={false} 
                        />
                        {/* Dynamic Wash Overlay */}
                        <div 
                            ref={el => { if (el) overlayRefs.current.set(seg.id, el); }}
                            className="absolute inset-0 pointer-events-none opacity-0"
                            style={{ backgroundColor: 'white' }}
                        />
                  </div>
                ))
              ) : (
                 <div className="text-gray-600 text-sm">No Active Clip</div>
              )}

              {activeSubtitleEvent && (
                <div style={styles.container}>
                  <div style={styles.text}>
                    {activeSubtitleEvent.details}
                  </div>
                </div>
              )}
            </div>
            
            {/* TRANSPORT CONTROLS */}
            <div className="h-14 border-t border-[#333] bg-[#1e1e1e] flex flex-col items-center justify-center gap-1 z-[1000]">
                <div className="flex items-center gap-4">
                    {/* Previous */}
                    <div className="flex items-center gap-1">
                        <button onClick={() => jumpClip('prev')} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>
                        <button onClick={() => jumpFrame(-1)} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M11 16.07V7.93l-6 4.14zm5-8.14v8.14l-6-4.14z"/></svg></button>
                    </div>

                    {/* Play/Stop */}
                    <button onClick={handlePlayPause} className="w-10 h-10 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center shadow-lg transition-transform active:scale-95">
                        {project.isPlaying ? 
                            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> : 
                            <svg className="w-5 h-5 text-white pl-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        }
                    </button>

                    {/* Next */}
                    <div className="flex items-center gap-1">
                        <button onClick={() => jumpFrame(1)} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M13 7.93v8.14l6-4.14zm-5 8.14V7.93l6 4.14z"/></svg></button>
                        <button onClick={() => jumpClip('next')} className="p-1 text-gray-400 hover:text-white"><svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>
                    </div>
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
                />
              </div>

              {/* Bottom Half: Tabs */}
              <div className="flex-1 flex flex-col min-h-0">
                  <div className="flex border-b border-[#333] bg-[#252525]">
                      <button onClick={() => setActiveRightTab('chat')} className={`flex-1 py-2 text-xs font-bold ${activeRightTab === 'chat' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>CHAT</button>
                      <button onClick={() => setActiveRightTab('transcript')} className={`flex-1 py-2 text-xs font-bold ${activeRightTab === 'transcript' ? 'bg-[#333] text-blue-400 border-b-2 border-blue-400' : 'text-gray-400'}`}>TRANSCRIPT</button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                      {activeRightTab === 'chat' && <ChatPanel messages={messages} onSendMessage={(txt) => chatWithVideoContext([], txt, null)} isLoading={false} />}
                      {activeRightTab === 'transcript' && <TranscriptPanel analysis={currentTopMedia?.analysis || null} currentTime={project.currentTime} onSeek={(t) => setProject(p => ({...p, currentTime: t}))} />}
                  </div>
              </div>
          </div>
        </div>

        {/* Timeline Section */}
        <div className="h-64 flex flex-col">
          <div className="h-10 bg-[#252525] border-y border-[#333] flex items-center px-4 gap-4">
             <div className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">AI Vibe Editor</div>
             <input value={editPrompt} onChange={e => setEditPrompt(e.target.value)} placeholder="E.g. 'Shorten the video to highlights'" className="flex-1 bg-[#121212] border border-[#333] rounded px-3 py-1 text-xs text-white focus:border-blue-500 outline-none" />
             <button onClick={handleVibeEdit} disabled={status !== ProcessingStatus.IDLE} className="px-3 py-1 bg-blue-600 rounded text-xs font-bold hover:bg-blue-500 disabled:opacity-50">Generate Sequence</button>
          </div>
          <div className="flex-1 overflow-hidden">
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
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;