import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Segment, Transition, TransitionCategory, TransitionType, TransitionDefinition } from '../types';
import { TRANSITION_CATALOG, TRANSITION_CATEGORIES, TRANSITION_CATEGORY_COLORS, getTransitionDef } from '../utils/transitionCatalog';
import { renderTransition } from '../utils/transitionRenderer';

// ============ PREVIEW CANVAS ============
const TransitionPreviewCanvas: React.FC<{
  definition: TransitionDefinition;
  size?: number;
  animate?: boolean;
}> = React.memo(({ definition, size = 80, animate = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const [hovering, setHovering] = useState(false);

  const shouldAnimate = animate || hovering;

  // Create offscreen color canvases for preview
  const framesRef = useRef<{ out: HTMLCanvasElement; in: HTMLCanvasElement } | null>(null);

  const getFrames = useCallback((w: number, h: number) => {
    if (!framesRef.current || framesRef.current.out.width !== w) {
      const outCanvas = document.createElement('canvas');
      outCanvas.width = w;
      outCanvas.height = h;
      const outCtx = outCanvas.getContext('2d')!;
      // Blue/purple gradient for outgoing
      const grd1 = outCtx.createLinearGradient(0, 0, w, h);
      grd1.addColorStop(0, '#4f46e5');
      grd1.addColorStop(1, '#7c3aed');
      outCtx.fillStyle = grd1;
      outCtx.fillRect(0, 0, w, h);
      // Add "A" text
      outCtx.fillStyle = '#ffffff60';
      outCtx.font = `bold ${Math.floor(h * 0.4)}px sans-serif`;
      outCtx.textAlign = 'center';
      outCtx.textBaseline = 'middle';
      outCtx.fillText('A', w / 2, h / 2);

      const inCanvas = document.createElement('canvas');
      inCanvas.width = w;
      inCanvas.height = h;
      const inCtx = inCanvas.getContext('2d')!;
      // Orange/amber gradient for incoming
      const grd2 = inCtx.createLinearGradient(0, 0, w, h);
      grd2.addColorStop(0, '#f97316');
      grd2.addColorStop(1, '#eab308');
      inCtx.fillStyle = grd2;
      inCtx.fillRect(0, 0, w, h);
      // Add "B" text
      inCtx.fillStyle = '#ffffff60';
      inCtx.font = `bold ${Math.floor(h * 0.4)}px sans-serif`;
      inCtx.textAlign = 'center';
      inCtx.textBaseline = 'middle';
      inCtx.fillText('B', w / 2, h / 2);

      framesRef.current = { out: outCanvas, in: inCanvas };
    }
    return framesRef.current;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const frames = getFrames(w, h);

    const transition: Transition = {
      type: definition.id,
      duration: definition.defaultParams.duration ?? 0.5,
      ...definition.defaultParams,
    };

    if (!shouldAnimate) {
      // Static frame at 50% progress
      renderTransition({ ctx, width: w, height: h, outFrame: frames.out, inFrame: frames.in, progress: 0.5, transition });
      return;
    }

    // Animate
    startTimeRef.current = performance.now();
    const LOOP_DURATION = 1500; // ms
    const PAUSE = 300; // ms pause at start/end

    const loop = (now: number) => {
      const elapsed = (now - startTimeRef.current) % (LOOP_DURATION + PAUSE * 2);
      let progress: number;
      if (elapsed < PAUSE) progress = 0;
      else if (elapsed > PAUSE + LOOP_DURATION) progress = 1;
      else progress = (elapsed - PAUSE) / LOOP_DURATION;
      progress = Math.max(0, Math.min(1, progress));

      renderTransition({ ctx, width: w, height: h, outFrame: frames.out, inFrame: frames.in, progress, transition });
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [shouldAnimate, definition, getFrames]);

  const aspectH = Math.round(size * 9 / 16);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={aspectH}
      className="rounded-sm"
      style={{ width: size, height: aspectH }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    />
  );
});

// ============ TRANSITION PANEL ============
interface TransitionPanelProps {
  selectedSegment: Segment | null;
  selectedTransition: { segId: string; side: 'in' | 'out' } | null;
  segments: Segment[];
  onApplyTransition: (segId: string, side: 'in' | 'out', transition: Transition) => void;
  onRemoveTransition: (segId: string, side: 'in' | 'out') => void;
  onSelectTransitionEdge?: (segId: string, side: 'in' | 'out') => void;
}

const TransitionPanel: React.FC<TransitionPanelProps> = ({
  selectedSegment,
  selectedTransition,
  segments,
  onApplyTransition,
  onRemoveTransition,
  onSelectTransitionEdge,
}) => {
  const [activeCategory, setActiveCategory] = useState<TransitionCategory | 'All'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [localSide, setLocalSide] = useState<'in' | 'out'>('out');

  // Effective selection: use explicit selectedTransition if available,
  // otherwise auto-derive from selected segment
  const effectiveSelection = useMemo(() => {
    if (selectedTransition) return selectedTransition;
    if (selectedSegment) return { segId: selectedSegment.id, side: localSide };
    return null;
  }, [selectedTransition, selectedSegment, localSide]);

  // Sync localSide when selectedTransition changes explicitly (e.g., from diamond handle click)
  useEffect(() => {
    if (selectedTransition) {
      setLocalSide(selectedTransition.side);
    }
  }, [selectedTransition]);

  // Get current transition if one is selected
  const currentTransition = useMemo(() => {
    if (!effectiveSelection) return null;
    const seg = segments.find(s => s.id === effectiveSelection.segId);
    if (!seg) return null;
    return effectiveSelection.side === 'in' ? seg.transitionIn : seg.transitionOut;
  }, [effectiveSelection, segments]);

  // Get segment name for display
  const selectedSegName = useMemo(() => {
    if (!effectiveSelection) return '';
    const seg = segments.find(s => s.id === effectiveSelection.segId);
    return seg?.description || 'Clip';
  }, [effectiveSelection, segments]);

  // Filter catalog
  const filteredTransitions = useMemo(() => {
    let items = TRANSITION_CATALOG;
    if (activeCategory !== 'All') {
      items = items.filter(t => t.category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    }
    return items;
  }, [activeCategory, searchQuery]);

  const handleApply = useCallback((def: TransitionDefinition) => {
    if (!effectiveSelection) return;
    const transition: Transition = {
      type: def.id,
      duration: def.defaultParams.duration ?? 0.5,
      ...def.defaultParams,
    };
    onApplyTransition(effectiveSelection.segId, effectiveSelection.side, transition);
    // Also notify parent of edge selection if it wasn't already set
    if (!selectedTransition && onSelectTransitionEdge) {
      onSelectTransitionEdge(effectiveSelection.segId, effectiveSelection.side);
    }
  }, [effectiveSelection, selectedTransition, onApplyTransition, onSelectTransitionEdge]);

  const handleRemove = useCallback(() => {
    if (!effectiveSelection) return;
    onRemoveTransition(effectiveSelection.segId, effectiveSelection.side);
  }, [effectiveSelection, onRemoveTransition]);

  const handleSideChange = useCallback((side: 'in' | 'out') => {
    setLocalSide(side);
    if (effectiveSelection && onSelectTransitionEdge) {
      onSelectTransitionEdge(effectiveSelection.segId, side);
    }
  }, [effectiveSelection, onSelectTransitionEdge]);

  // Check what transitions exist on current segment for the in/out indicators
  const segTransitionIn = useMemo(() => {
    if (!effectiveSelection) return null;
    const seg = segments.find(s => s.id === effectiveSelection.segId);
    return seg?.transitionIn || null;
  }, [effectiveSelection, segments]);

  const segTransitionOut = useMemo(() => {
    if (!effectiveSelection) return null;
    const seg = segments.find(s => s.id === effectiveSelection.segId);
    return seg?.transitionOut || null;
  }, [effectiveSelection, segments]);

  const canApply = !!effectiveSelection;

  // Detect if the selected segment is audio-only
  const isAudioSegment = useMemo(() => {
    if (!effectiveSelection) return false;
    const seg = segments.find(s => s.id === effectiveSelection.segId);
    return seg?.type === 'audio';
  }, [effectiveSelection, segments]);

  // Audio fade presets
  const audioFadeIn: Transition = { type: 'FADE' as TransitionType, duration: 0.5 };
  const audioFadeOut: Transition = { type: 'FADE' as TransitionType, duration: 0.5 };

  return (
    <div className="flex flex-col h-full overflow-hidden text-gray-200">
      {/* HEADER */}
      <div className="px-3 pt-3 pb-2">
        <h3 className="text-[11px] font-bold tracking-widest uppercase text-gray-400 mb-2">
          {isAudioSegment ? '🔊 Audio Transitions' : 'Transitions'}
        </h3>

        {/* EDGE SELECTOR — shown when a segment is selected */}
        {effectiveSelection && (
          <div className="mb-2">
            <div className="text-[10px] text-gray-500 mb-1 truncate">
              Clip: <span className="text-gray-300">{selectedSegName}</span>
            </div>
            <div className="flex rounded-md overflow-hidden border border-[#444]">
              <button
                onClick={() => handleSideChange('in')}
                className={`flex-1 px-3 py-1.5 text-[10px] font-medium transition-colors flex items-center justify-center gap-1.5 ${
                  effectiveSelection.side === 'in'
                    ? 'bg-cyan-600/30 text-cyan-300 border-r border-cyan-500/50'
                    : 'bg-[#1a1a1a] text-gray-500 hover:text-gray-300 hover:bg-[#222] border-r border-[#444]'
                }`}
              >
                <span className="text-[12px]">◇</span>
                Intro
                {segTransitionIn && (
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 flex-shrink-0" />
                )}
              </button>
              <button
                onClick={() => handleSideChange('out')}
                className={`flex-1 px-3 py-1.5 text-[10px] font-medium transition-colors flex items-center justify-center gap-1.5 ${
                  effectiveSelection.side === 'out'
                    ? 'bg-cyan-600/30 text-cyan-300'
                    : 'bg-[#1a1a1a] text-gray-500 hover:text-gray-300 hover:bg-[#222]'
                }`}
              >
                Outro
                <span className="text-[12px]">◇</span>
                {segTransitionOut && (
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 flex-shrink-0" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* AUDIO SEGMENT: Simplified fade controls */}
        {isAudioSegment && effectiveSelection && (
          <div className="mt-2 space-y-2">
            <div className="text-[10px] text-gray-500">Audio fades control volume envelope</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onApplyTransition(effectiveSelection.segId, 'in', audioFadeIn)}
                className={`p-3 rounded-lg border text-center transition-all ${
                  segTransitionIn
                    ? 'border-green-500 bg-green-500/10'
                    : 'border-[#333] hover:border-green-500/50 bg-[#1a1a1a] hover:bg-[#222]'
                }`}
              >
                <div className="text-lg mb-1">📈</div>
                <div className="text-[10px] text-gray-300">Fade In</div>
                {segTransitionIn && (
                  <div className="text-[9px] text-green-400 mt-0.5">{segTransitionIn.duration.toFixed(1)}s</div>
                )}
              </button>
              <button
                onClick={() => onApplyTransition(effectiveSelection.segId, 'out', audioFadeOut)}
                className={`p-3 rounded-lg border text-center transition-all ${
                  segTransitionOut
                    ? 'border-green-500 bg-green-500/10'
                    : 'border-[#333] hover:border-green-500/50 bg-[#1a1a1a] hover:bg-[#222]'
                }`}
              >
                <div className="text-lg mb-1">📉</div>
                <div className="text-[10px] text-gray-300">Fade Out</div>
                {segTransitionOut && (
                  <div className="text-[9px] text-green-400 mt-0.5">{segTransitionOut.duration.toFixed(1)}s</div>
                )}
              </button>
            </div>
            {/* Duration slider for active audio fade */}
            {currentTransition && (
              <div className="mt-3 px-1">
                <label className="text-[10px] text-gray-400 block mb-1">
                  Duration: {currentTransition.duration.toFixed(1)}s
                </label>
                <input
                  type="range"
                  min="0.1"
                  max="5"
                  step="0.1"
                  value={currentTransition.duration}
                  onChange={(e) => {
                    const newDur = parseFloat(e.target.value);
                    const updated: Transition = { ...currentTransition, duration: newDur };
                    onApplyTransition(effectiveSelection.segId, effectiveSelection.side, updated);
                  }}
                  className="w-full accent-green-500"
                />
              </div>
            )}

            {/* Crossfade curve selector — shown when audio segments overlap */}
            {(() => {
              if (!effectiveSelection) return null;
              const seg = segments.find(s => s.id === effectiveSelection.segId);
              if (!seg) return null;
              const segEnd = seg.timelineStart + (seg.endTime - seg.startTime);

              // Check for overlapping audio on the same track
              const overlapsNext = segments.find(s =>
                s.id !== seg.id && s.type === 'audio' &&
                (s.track || 0) === (seg.track || 0) &&
                s.timelineStart > seg.timelineStart && s.timelineStart < segEnd
              );
              const overlapsPrev = segments.find(s =>
                s.id !== seg.id && s.type === 'audio' &&
                (s.track || 0) === (seg.track || 0) &&
                s.timelineStart < seg.timelineStart &&
                (s.timelineStart + (s.endTime - s.startTime)) > seg.timelineStart
              );

              if (!overlapsNext && !overlapsPrev) return null;

              // The curve is controlled by the outgoing (left) segment's transitionOut
              const controlSeg = overlapsNext ? seg : overlapsPrev!;
              const activeCurve = controlSeg.transitionOut?.audioCurve || 'linear';

              const setCurve = (curve: 'linear' | 'equalPower') => {
                const existing = controlSeg.transitionOut || { type: 'FADE' as TransitionType, duration: 0.5 };
                onApplyTransition(controlSeg.id, 'out', { ...existing, audioCurve: curve });
              };

              return (
                <div className="mt-3 px-1">
                  <label className="text-[10px] text-gray-400 block mb-1.5">
                    Crossfade Curve
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setCurve('linear')}
                      className={`p-2 rounded-lg border text-center transition-all text-[10px] ${
                        activeCurve === 'linear'
                          ? 'border-green-500 bg-green-500/10 text-green-300'
                          : 'border-[#333] bg-[#1a1a1a] text-gray-400 hover:border-green-500/50'
                      }`}
                    >
                      〰 Linear
                      <div className="text-[8px] text-gray-500 mt-0.5">Constant energy</div>
                    </button>
                    <button
                      onClick={() => setCurve('equalPower')}
                      className={`p-2 rounded-lg border text-center transition-all text-[10px] ${
                        activeCurve === 'equalPower'
                          ? 'border-green-500 bg-green-500/10 text-green-300'
                          : 'border-[#333] bg-[#1a1a1a] text-gray-400 hover:border-green-500/50'
                      }`}
                    >
                      ⚡ Equal Power
                      <div className="text-[8px] text-gray-500 mt-0.5">Louder midpoint</div>
                    </button>
                  </div>
                  <div className="text-[9px] text-gray-600 mt-1">
                    Overlap duration controls crossfade length
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* SEARCH (video transitions only) */}
        {!isAudioSegment && (
          <>
            <div className="relative mb-2">
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search transitions..."
                className="w-full bg-[#1a1a1a] border border-[#333] rounded-md px-3 py-1.5 text-[11px] text-gray-200 placeholder-gray-600 focus:border-cyan-500/50 focus:outline-none"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-xs">✕</button>
              )}
            </div>

            {/* CATEGORY TABS */}
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setActiveCategory('All')}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                  activeCategory === 'All'
                    ? 'bg-white/15 text-white'
                    : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                }`}
              >
                All
              </button>
              {TRANSITION_CATEGORIES.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                    activeCategory === cat
                      ? 'text-white'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                  }`}
                  style={activeCategory === cat ? { backgroundColor: TRANSITION_CATEGORY_COLORS[cat] + '40' } : undefined}
                >
                  {cat}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* GRID (video transitions only) */}
      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {!effectiveSelection && (
          <div className="text-center py-6 text-gray-500 text-[11px] border border-dashed border-[#333] rounded-lg mt-2 mx-1">
            <div className="text-lg mb-1">◇</div>
            Select a clip on the timeline to apply transitions
          </div>
        )}
        {!isAudioSegment && (
          <div className="grid grid-cols-2 gap-2 mt-1">
            {filteredTransitions.map(def => {
              const isActive = currentTransition?.type === def.id;
              return (
                <button
                  key={def.id}
                  onClick={() => handleApply(def)}
                  disabled={!canApply}
                  className={`group relative flex flex-col items-center p-2 rounded-lg border transition-all ${
                    isActive
                      ? 'border-cyan-500 bg-cyan-500/10'
                      : canApply
                        ? 'border-[#333] hover:border-[#555] bg-[#1a1a1a] hover:bg-[#222] cursor-pointer'
                        : 'border-[#333] bg-[#1a1a1a] opacity-50 cursor-not-allowed'
                  }`}
                  title={def.description}
                >
                  <TransitionPreviewCanvas definition={def} size={76} />
                  <div className="flex items-center gap-1 mt-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: TRANSITION_CATEGORY_COLORS[def.category] }}
                    />
                    <span className="text-[10px] text-gray-300 truncate">{def.name}</span>
                  </div>
                  {isActive && (
                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-cyan-500 rounded-full flex items-center justify-center">
                      <span className="text-[8px] text-white font-bold">✓</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!isAudioSegment && filteredTransitions.length === 0 && (
          <div className="text-center py-8 text-gray-600 text-[11px]">
            No transitions match your search
          </div>
        )}
      </div>

      {/* FOOTER: STATUS / ACTIVE TRANSITION */}
      <div className="border-t border-[#333] px-3 py-2.5">
        {effectiveSelection && currentTransition ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-gray-400">
                {effectiveSelection.side === 'in' ? 'Intro' : 'Outro'}:
              </span>
              <span className="text-[11px] text-cyan-400 font-medium">
                {getTransitionDef(currentTransition.type)?.name || currentTransition.type}
              </span>
              <span className="text-[10px] text-gray-500">
                ({currentTransition.duration.toFixed(1)}s)
              </span>
            </div>
            <button
              onClick={handleRemove}
              className="px-2 py-0.5 text-[10px] text-red-400 border border-red-900/50 rounded hover:bg-red-900/20 transition-colors"
            >
              Remove
            </button>
          </div>
        ) : effectiveSelection ? (
          <div className="text-center text-[11px] text-gray-500">
            Click a transition above to apply to {effectiveSelection.side === 'in' ? 'intro' : 'outro'}
          </div>
        ) : (
          <div className="text-center text-[11px] text-gray-600">
            Select a clip on the timeline
          </div>
        )}
      </div>
    </div>
  );
};

export default TransitionPanel;
