import React, { useState, useRef, useCallback } from 'react';
import type { TextAnimation, AnimationEffect, AnimationScope, EasingType } from '../types';

interface AnimationControlsProps {
  animation: TextAnimation;
  onChange: (anim: TextAnimation) => void;
}

const SCOPES: { value: AnimationScope; label: string }[] = [
  { value: 'element', label: 'Whole' },
  { value: 'line', label: 'Line' },
  { value: 'word', label: 'Word' },
  { value: 'character', label: 'Char' },
];

const EASINGS: { value: EasingType; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'easeIn', label: 'Ease In' },
  { value: 'easeOut', label: 'Ease Out' },
  { value: 'easeInOut', label: 'Ease In-Out' },
  { value: 'elastic', label: 'Elastic' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'spring', label: 'Spring' },
];

const EFFECT_TYPES: { value: AnimationEffect['type']; label: string; unit: string; range: [number, number] }[] = [
  { value: 'opacity', label: 'Opacity', unit: '', range: [0, 1] },
  { value: 'translateY', label: 'Slide Y', unit: 'px', range: [-200, 200] },
  { value: 'translateX', label: 'Slide X', unit: 'px', range: [-200, 200] },
  { value: 'scale', label: 'Scale', unit: 'x', range: [0, 3] },
  { value: 'rotate', label: 'Rotate', unit: 'deg', range: [-360, 360] },
  { value: 'blur', label: 'Blur', unit: 'px', range: [0, 30] },
  { value: 'letterSpacing', label: 'Tracking', unit: 'px', range: [-10, 30] },
];

// ───── Easing math for visual previews ─────
function sampleEasing(easing: EasingType, t: number): number {
  switch (easing) {
    case 'linear': return t;
    case 'easeIn': return t * t * t;
    case 'easeOut': { const u = 1 - t; return 1 - u * u * u; }
    case 'easeInOut': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'bounce': {
      const n1 = 7.5625, d1 = 2.75;
      let u = 1 - t;
      if (u < 1 / d1) return 1 - n1 * u * u;
      if (u < 2 / d1) return 1 - (n1 * (u -= 1.5 / d1) * u + 0.75);
      if (u < 2.5 / d1) return 1 - (n1 * (u -= 2.25 / d1) * u + 0.9375);
      return 1 - (n1 * (u -= 2.625 / d1) * u + 0.984375);
    }
    case 'elastic': {
      if (t === 0 || t === 1) return t;
      return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3)) + 1;
    }
    case 'spring': {
      const freq = 4.7, decay = 4;
      return 1 - Math.exp(-decay * t) * Math.cos(freq * Math.PI * t);
    }
    default: return t;
  }
}

// ───── Mini Curve Preview SVG ─────
const CurvePreview: React.FC<{ easing: EasingType; width?: number; height?: number }> = ({
  easing, width = 48, height = 32
}) => {
  const points: string[] = [];
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const val = sampleEasing(easing, t);
    const x = (t * (width - 4)) + 2;
    const y = height - 2 - (val * (height - 4));
    points.push(`${x},${y}`);
  }

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <rect width={width} height={height} fill="#121212" rx={3} />
      <line x1={2} y1={height - 2} x2={width - 2} y2={2} stroke="#333" strokeWidth={0.5} strokeDasharray="2,2" />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="#a78bfa"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

// ───── Draggable Timing Ramp ─────
const TimingRamp: React.FC<{
  startAt: number;
  endAt: number;
  easing: EasingType;
  effectFrom: number;
  effectTo: number;
  onChange: (startAt: number, endAt: number) => void;
}> = ({ startAt, endAt, easing, effectFrom, effectTo, onChange }) => {
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ handle: 'start' | 'end' | 'body'; offsetX: number } | null>(null);

  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  const getT = useCallback((clientX: number) => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width);
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent, handle: 'start' | 'end' | 'body') => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const t = getT(e.clientX);
    dragRef.current = { handle, offsetX: handle === 'body' ? t - startAt : 0 };
  }, [getT, startAt]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const t = getT(e.clientX);
    const { handle, offsetX } = dragRef.current;
    if (handle === 'start') {
      onChange(clamp(Math.min(t, endAt - 0.05)), endAt);
    } else if (handle === 'end') {
      onChange(startAt, clamp(Math.max(t, startAt + 0.05)));
    } else {
      const width = endAt - startAt;
      let newStart = clamp(t - offsetX);
      let newEnd = newStart + width;
      if (newEnd > 1) { newEnd = 1; newStart = 1 - width; }
      onChange(clamp(newStart), clamp(newEnd));
    }
  }, [getT, startAt, endAt, onChange]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Generate gradient showing the easing shape as opacity
  const gradientStops = (() => {
    const stops: string[] = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const val = sampleEasing(easing, t);
      const mapped = effectFrom + (effectTo - effectFrom) * val;
      const brightness = Math.max(0, Math.min(1, mapped));
      stops.push(`rgba(167,139,250,${(brightness * 0.8 + 0.1).toFixed(2)}) ${(t * 100).toFixed(1)}%`);
    }
    return stops.join(', ');
  })();

  return (
    <div
      ref={barRef}
      style={{
        position: 'relative',
        height: 20,
        background: '#121212',
        borderRadius: 4,
        userSelect: 'none',
        touchAction: 'none',
        border: '1px solid #333',
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {/* Active region with gradient */}
      <div
        style={{
          position: 'absolute', top: 1, bottom: 1,
          left: `${startAt * 100}%`,
          width: `${(endAt - startAt) * 100}%`,
          background: `linear-gradient(to right, ${gradientStops})`,
          borderRadius: 3,
          cursor: 'grab',
        }}
        onPointerDown={e => handlePointerDown(e, 'body')}
      />
      {/* Start handle */}
      <div
        style={{
          position: 'absolute', top: -1, bottom: -1,
          left: `${startAt * 100}%`, width: 6, marginLeft: -3,
          background: '#a78bfa', borderRadius: '3px 0 0 3px',
          cursor: 'ew-resize', zIndex: 2,
        }}
        onPointerDown={e => handlePointerDown(e, 'start')}
      />
      {/* End handle */}
      <div
        style={{
          position: 'absolute', top: -1, bottom: -1,
          left: `${endAt * 100}%`, width: 6, marginLeft: -3,
          background: '#a78bfa', borderRadius: '0 3px 3px 0',
          cursor: 'ew-resize', zIndex: 2,
        }}
        onPointerDown={e => handlePointerDown(e, 'end')}
      />
      {/* Labels */}
      <div style={{ position: 'absolute', bottom: -14, left: `${startAt * 100}%`, fontSize: 8, color: '#6b7280', transform: 'translateX(-50%)' }}>
        {(startAt * 100).toFixed(0)}%
      </div>
      <div style={{ position: 'absolute', bottom: -14, left: `${endAt * 100}%`, fontSize: 8, color: '#6b7280', transform: 'translateX(-50%)' }}>
        {(endAt * 100).toFixed(0)}%
      </div>
    </div>
  );
};

// ───── Value Ramp (From → To with gradient bar) ─────
const ValueRamp: React.FC<{
  from: number; to: number;
  range: [number, number]; unit: string;
  onChange: (from: number, to: number) => void;
}> = ({ from, to, range, unit, onChange }) => {
  const fromPct = ((from - range[0]) / (range[1] - range[0])) * 100;
  const toPct = ((to - range[0]) / (range[1] - range[0])) * 100;
  const minPct = Math.min(fromPct, toPct);
  const maxPct = Math.max(fromPct, toPct);
  const isFloat = range[1] <= 3;
  const step = isFloat ? 0.01 : 1;
  const fmt = (v: number) => isFloat ? v.toFixed(2) : v.toFixed(0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* Gradient bar */}
      <div style={{ position: 'relative', height: 8, background: '#121212', borderRadius: 4, border: '1px solid #333', overflow: 'hidden' }}>
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: `${minPct}%`, width: `${maxPct - minPct}%`,
          background: from < to
            ? 'linear-gradient(to right, rgba(139,92,246,0.3), rgba(139,92,246,0.9))'
            : 'linear-gradient(to right, rgba(139,92,246,0.9), rgba(139,92,246,0.3))',
          borderRadius: 3,
        }} />
        <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${fromPct}%`, width: 3, marginLeft: -1, background: '#60a5fa', borderRadius: 1 }} />
        <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${toPct}%`, width: 3, marginLeft: -1, background: '#34d399', borderRadius: 1 }} />
      </div>
      {/* Slider row */}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 8, color: '#60a5fa', fontWeight: 600, minWidth: 20 }}>FROM</span>
          <input type="range" min={range[0]} max={range[1]} step={step} value={from}
            onChange={e => onChange(parseFloat(e.target.value), to)}
            style={{ flex: 1, accentColor: '#60a5fa', height: 4 }} />
          <span style={{ fontSize: 9, color: '#9ca3af', minWidth: 30, textAlign: 'right', fontFamily: 'monospace' }}>{fmt(from)}{unit}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 8, color: '#34d399', fontWeight: 600, minWidth: 14 }}>TO</span>
          <input type="range" min={range[0]} max={range[1]} step={step} value={to}
            onChange={e => onChange(from, parseFloat(e.target.value))}
            style={{ flex: 1, accentColor: '#34d399', height: 4 }} />
          <span style={{ fontSize: 9, color: '#9ca3af', minWidth: 30, textAlign: 'right', fontFamily: 'monospace' }}>{fmt(to)}{unit}</span>
        </div>
      </div>
    </div>
  );
};

// ───── Main AnimationControls Component ─────
const AnimationControls: React.FC<AnimationControlsProps> = ({ animation, onChange }) => {
  const [expandedEffect, setExpandedEffect] = useState<string | null>(null);

  const updateField = (field: keyof TextAnimation, value: any) => {
    onChange({ ...animation, [field]: value });
  };

  const addEffect = (type: AnimationEffect['type'] = 'opacity') => {
    const newEffect: AnimationEffect = {
      id: `eff_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      type,
      from: type === 'opacity' ? 0 : type === 'scale' ? 0.3 : 0,
      to: type === 'opacity' ? 1 : type === 'scale' ? 1 : 0,
      startAt: 0,
      endAt: 1,
      easing: 'easeOut',
    };
    onChange({ ...animation, effects: [...animation.effects, newEffect] });
    setExpandedEffect(newEffect.id);
  };

  const updateEffect = (id: string, updates: Partial<AnimationEffect>) => {
    onChange({
      ...animation,
      effects: animation.effects.map(e => e.id === id ? { ...e, ...updates } : e)
    });
  };

  const removeEffect = (id: string) => {
    onChange({ ...animation, effects: animation.effects.filter(e => e.id !== id) });
    if (expandedEffect === id) setExpandedEffect(null);
  };

  const duplicateEffect = (effect: AnimationEffect) => {
    const dup: AnimationEffect = {
      ...effect,
      id: `eff_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    };
    onChange({ ...animation, effects: [...animation.effects, dup] });
    setExpandedEffect(dup.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Global Settings */}
      <div style={{ padding: 8, background: '#2a2a2a', borderRadius: 6, border: '1px solid #333' }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 6, letterSpacing: 1 }}>
          Timing & Scope
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label style={{ fontSize: 9, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Duration</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0.1} max={5} step={0.1} value={animation.duration}
                onChange={e => updateField('duration', parseFloat(e.target.value))}
                style={{ flex: 1, minWidth: 0, accentColor: '#a78bfa', height: 4 }} />
              <span style={{ fontSize: 10, color: '#e5e7eb', fontFamily: 'monospace', minWidth: 30, textAlign: 'right' }}>
                {animation.duration.toFixed(1)}s
              </span>
            </div>
          </div>
          <div>
            <label style={{ fontSize: 9, color: '#9ca3af', display: 'block', marginBottom: 2 }}>Stagger</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min={0} max={0.5} step={0.01} value={animation.stagger ?? 0}
                onChange={e => updateField('stagger', parseFloat(e.target.value))}
                style={{ flex: 1, minWidth: 0, accentColor: '#a78bfa', height: 4 }} />
              <span style={{ fontSize: 10, color: '#e5e7eb', fontFamily: 'monospace', minWidth: 30, textAlign: 'right' }}>
                {(animation.stagger ?? 0).toFixed(2)}s
              </span>
            </div>
          </div>
        </div>

        {/* Scope segmented buttons */}
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 9, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Animate per</label>
          <div style={{ display: 'flex', gap: 2, background: '#1e1e1e', borderRadius: 4, padding: 2 }}>
            {SCOPES.map(s => (
              <button
                key={s.value}
                onClick={() => updateField('scope', s.value)}
                style={{
                  flex: 1, padding: '3px 0', borderRadius: 3, border: 'none', fontSize: 10,
                  fontWeight: animation.scope === s.value ? 700 : 400,
                  background: animation.scope === s.value ? '#4f46e5' : 'transparent',
                  color: animation.scope === s.value ? '#fff' : '#6b7280',
                  cursor: 'pointer',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Effects Chain */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>
            Effects ({animation.effects.length})
          </span>
          <select
            value=""
            onChange={e => { if (e.target.value) addEffect(e.target.value as AnimationEffect['type']); }}
            style={{ background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 4, fontSize: 10, fontWeight: 600, padding: '3px 8px', cursor: 'pointer' }}
          >
            <option value="" disabled>+ Add Effect</option>
            {EFFECT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 400, overflowY: 'auto' }}>
          {animation.effects.length === 0 && (
            <div style={{ fontSize: 11, color: '#4b5563', textAlign: 'center', padding: 16 }}>
              No effects yet. Add one to start animating.
            </div>
          )}

          {animation.effects.map((effect) => {
            const meta = EFFECT_TYPES.find(t => t.value === effect.type) || EFFECT_TYPES[0];
            const isExpanded = expandedEffect === effect.id;
            const isFloat = meta.range[1] <= 3;

            return (
              <div key={effect.id} style={{
                background: '#1e1e1e',
                border: `1px solid ${isExpanded ? '#4f46e5' : '#333'}`,
                borderRadius: 6, overflow: 'hidden',
              }}>
                {/* Header — always visible */}
                <div
                  onClick={() => setExpandedEffect(isExpanded ? null : effect.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', cursor: 'pointer', userSelect: 'none' }}
                >
                  <span style={{ fontSize: 8, color: '#4f46e5', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                    &#9654;
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#e5e7eb', flex: 1 }}>{meta.label}</span>
                  <span style={{ fontSize: 9, color: '#6b7280', fontFamily: 'monospace' }}>
                    {isFloat ? effect.from.toFixed(1) : effect.from.toFixed(0)} &rarr; {isFloat ? effect.to.toFixed(1) : effect.to.toFixed(0)}
                  </span>
                  <CurvePreview easing={effect.easing} width={32} height={18} />
                  <button onClick={e => { e.stopPropagation(); duplicateEffect(effect); }} title="Duplicate"
                    style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}>
                    &#x2398;
                  </button>
                  <button onClick={e => { e.stopPropagation(); removeEffect(effect.id); }} title="Remove"
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}>
                    &times;
                  </button>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={{ padding: '4px 8px 10px', borderTop: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Type + Easing */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 2 }}>Type</label>
                        <select value={effect.type} onChange={e => updateEffect(effect.id, { type: e.target.value as any })}
                          style={{ width: '100%', background: '#2a2a2a', border: '1px solid #333', borderRadius: 4, padding: '3px 4px', fontSize: 10, color: '#e5e7eb' }}>
                          {EFFECT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 2 }}>Easing</label>
                        <select value={effect.easing} onChange={e => updateEffect(effect.id, { easing: e.target.value as EasingType })}
                          style={{ width: '100%', background: '#2a2a2a', border: '1px solid #333', borderRadius: 4, padding: '3px 4px', fontSize: 10, color: '#e5e7eb' }}>
                          {EASINGS.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
                        </select>
                      </div>
                    </div>

                    {/* Curve preview */}
                    <div>
                      <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 3 }}>Curve</label>
                      <CurvePreview easing={effect.easing} width={200} height={60} />
                    </div>

                    {/* Value ramp */}
                    <div>
                      <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 3 }}>Value Range</label>
                      <ValueRamp from={effect.from} to={effect.to} range={meta.range} unit={meta.unit}
                        onChange={(from, to) => updateEffect(effect.id, { from, to })} />
                    </div>

                    {/* Timing ramp */}
                    <div>
                      <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 3 }}>Timing</label>
                      <div style={{ paddingBottom: 16 }}>
                        <TimingRamp
                          startAt={effect.startAt} endAt={effect.endAt} easing={effect.easing}
                          effectFrom={isFloat ? effect.from : effect.from / meta.range[1]}
                          effectTo={isFloat ? effect.to : effect.to / meta.range[1]}
                          onChange={(s, e) => updateEffect(effect.id, { startAt: s, endAt: e })} />
                      </div>
                    </div>

                    {/* Spring/Elastic config */}
                    {(effect.easing === 'spring' || effect.easing === 'elastic') && (
                      <div style={{ borderTop: '1px solid #333', paddingTop: 8, display: 'flex', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 2 }}>Stiffness</label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="range" min={10} max={500} step={10} value={effect.stiffness ?? 100}
                              onChange={e => updateEffect(effect.id, { stiffness: parseInt(e.target.value) })}
                              style={{ flex: 1, accentColor: '#f59e0b', height: 4 }} />
                            <span style={{ fontSize: 9, color: '#9ca3af', fontFamily: 'monospace', minWidth: 24 }}>{effect.stiffness ?? 100}</span>
                          </div>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 2 }}>
                            {effect.easing === 'elastic' ? 'Elasticity' : 'Bounciness'}
                          </label>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="range" min={0} max={20} step={1} value={effect.bounciness ?? 10}
                              onChange={e => updateEffect(effect.id, { bounciness: parseInt(e.target.value) })}
                              style={{ flex: 1, accentColor: '#f59e0b', height: 4 }} />
                            <span style={{ fontSize: 9, color: '#9ca3af', fontFamily: 'monospace', minWidth: 16 }}>{effect.bounciness ?? 10}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Word Target — only shown when scope is 'word' */}
                    {animation.scope === 'word' && (
                      <div style={{ borderTop: '1px solid #333', paddingTop: 8 }}>
                        <label style={{ fontSize: 8, color: '#6b7280', display: 'block', marginBottom: 2 }}>
                          Apply To
                        </label>
                        <select
                          value={effect.wordTarget?.mode || 'all'}
                          onChange={e => {
                            const mode = e.target.value;
                            updateEffect(effect.id, {
                              wordTarget: mode === 'all' ? undefined
                                : mode === 'indices' ? { mode: 'indices' as const, indices: [] }
                                  : { mode } as any
                            });
                          }}
                          style={{
                            width: '100%', background: '#2a2a2a', border: '1px solid #333',
                            borderRadius: 4, padding: '3px 4px', fontSize: 10, color: '#e5e7eb'
                          }}
                        >
                          <option value="all">All Words</option>
                          <option value="keywords">Keywords Only</option>
                          <option value="non-keywords">Non-Keywords Only</option>
                          <option value="indices">Specific Indices</option>
                        </select>
                        {effect.wordTarget?.mode === 'indices' && (
                          <input type="text" placeholder="e.g. 0,2,5"
                            value={(effect.wordTarget as any).indices?.join(',') || ''}
                            onChange={e => {
                              const indices = e.target.value.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                              updateEffect(effect.id, { wordTarget: { mode: 'indices' as const, indices } });
                            }}
                            style={{
                              width: '100%', marginTop: 4, background: '#2a2a2a', border: '1px solid #333',
                              borderRadius: 4, padding: '3px 6px', fontSize: 10, color: '#e5e7eb'
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default AnimationControls;
