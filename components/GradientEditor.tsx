import React, { useState, useRef, useCallback, useMemo } from 'react';
import type { GradientStop } from '../types';
import { buildGradientCSS } from '../utils/gradientUtils';

// ─── Gradient Presets ────────────────────────────────────────────────────────

const GRADIENT_PRESETS: { name: string; stops: GradientStop[] }[] = [
  { name: 'Sunset', stops: [{ color: '#ff512f', position: 0 }, { color: '#f09819', position: 100 }] },
  { name: 'Ocean', stops: [{ color: '#2193b0', position: 0 }, { color: '#6dd5ed', position: 100 }] },
  { name: 'Fire', stops: [{ color: '#f12711', position: 0 }, { color: '#f5af19', position: 50 }, { color: '#f12711', position: 100 }] },
  { name: 'Gold', stops: [{ color: '#BF953F', position: 0 }, { color: '#FCF6BA', position: 50 }, { color: '#B38728', position: 100 }] },
  { name: 'Neon', stops: [{ color: '#00ff87', position: 0 }, { color: '#60efff', position: 100 }] },
  { name: 'Berry', stops: [{ color: '#8E2DE2', position: 0 }, { color: '#4A00E0', position: 100 }] },
  { name: 'Rainbow', stops: [
    { color: '#ff0000', position: 0 },
    { color: '#ff8800', position: 17 },
    { color: '#ffff00', position: 33 },
    { color: '#00ff00', position: 50 },
    { color: '#0088ff', position: 67 },
    { color: '#8800ff', position: 83 },
    { color: '#ff00ff', position: 100 },
  ]},
  { name: 'Mono', stops: [{ color: '#434343', position: 0 }, { color: '#000000', position: 100 }] },
];

// ─── Color Picker (inline) ──────────────────────────────────────────────────

const InlineColorPicker: React.FC<{ value: string; onChange: (c: string) => void }> = ({ value, onChange }) => (
  <input
    type="color"
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="w-6 h-6 rounded cursor-pointer border border-[#444] bg-transparent p-0"
    style={{ WebkitAppearance: 'none', MozAppearance: 'none' }}
  />
);

// ─── Main Component ─────────────────────────────────────────────────────────

interface GradientEditorProps {
  stops: GradientStop[];
  type: 'linear' | 'radial';
  angle: number;
  onChange: (stops: GradientStop[]) => void;
  onTypeChange: (type: 'linear' | 'radial') => void;
  onAngleChange: (angle: number) => void;
}

const GradientEditor: React.FC<GradientEditorProps> = ({
  stops, type, angle, onChange, onTypeChange, onAngleChange,
}) => {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<number | null>(null);

  const sorted = useMemo(() =>
    [...stops].map((s, i) => ({ ...s, _origIdx: i })).sort((a, b) => a.position - b.position),
    [stops]
  );

  const gradientCSS = useMemo(() =>
    buildGradientCSS('linear', stops, 90), // Always show left-to-right in bar
    [stops]
  );

  const getPositionFromEvent = useCallback((e: React.PointerEvent | PointerEvent) => {
    if (!barRef.current) return 0;
    const rect = barRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.round(Math.max(0, Math.min(100, (x / rect.width) * 100)));
  }, []);

  const handleBarClick = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Don't add stop if clicking on an existing handle
    if ((e.target as HTMLElement).dataset.stopHandle) return;
    const pos = getPositionFromEvent(e);
    // Interpolate color at this position from existing stops
    const sortedStops = [...stops].sort((a, b) => a.position - b.position);
    let color = '#ffffff';
    for (let i = 0; i < sortedStops.length - 1; i++) {
      if (pos >= sortedStops[i].position && pos <= sortedStops[i + 1].position) {
        // Simple: use the closer stop's color
        const mid = (sortedStops[i].position + sortedStops[i + 1].position) / 2;
        color = pos < mid ? sortedStops[i].color : sortedStops[i + 1].color;
        break;
      }
    }
    const newStops = [...stops, { color, position: pos, opacity: 1 }];
    setSelectedIdx(newStops.length - 1);
    onChange(newStops);
  }, [stops, onChange, getPositionFromEvent]);

  const handleStopPointerDown = useCallback((e: React.PointerEvent, idx: number) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedIdx(idx);
    draggingRef.current = idx;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (draggingRef.current === null) return;
    const pos = getPositionFromEvent(e);
    const newStops = [...stops];
    newStops[draggingRef.current] = { ...newStops[draggingRef.current], position: pos };
    onChange(newStops);
  }, [stops, onChange, getPositionFromEvent]);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = null;
  }, []);

  const handleDeleteStop = useCallback(() => {
    if (stops.length <= 2) return;
    const newStops = stops.filter((_, i) => i !== selectedIdx);
    setSelectedIdx(Math.min(selectedIdx, newStops.length - 1));
    onChange(newStops);
  }, [stops, selectedIdx, onChange]);

  const updateSelectedStop = useCallback((updates: Partial<GradientStop>) => {
    const newStops = [...stops];
    newStops[selectedIdx] = { ...newStops[selectedIdx], ...updates };
    onChange(newStops);
  }, [stops, selectedIdx, onChange]);

  const selectedStop = stops[selectedIdx] || stops[0];

  return (
    <div className="space-y-3">
      {/* Type + Angle row */}
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => onTypeChange(e.target.value as 'linear' | 'radial')}
          className="bg-[#1a1a1a] text-gray-300 text-xs border border-[#333] rounded px-2 py-1"
        >
          <option value="linear">Linear</option>
          <option value="radial">Radial</option>
        </select>
        {type === 'linear' && (
          <div className="flex items-center gap-1 flex-1">
            <span className="text-[10px] text-gray-500">Angle</span>
            <input
              type="range" min="0" max="360" step="1"
              value={angle}
              onChange={(e) => onAngleChange(parseInt(e.target.value))}
              className="flex-1 h-1 accent-indigo-500"
            />
            <span className="text-[10px] text-gray-400 w-8 text-right">{angle}°</span>
          </div>
        )}
      </div>

      {/* Gradient bar */}
      <div
        ref={barRef}
        className="relative h-6 rounded cursor-crosshair border border-[#444]"
        style={{ background: gradientCSS }}
        onPointerDown={handleBarClick}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Stop handles */}
        {stops.map((stop, i) => (
          <div
            key={i}
            data-stop-handle="true"
            onPointerDown={(e) => handleStopPointerDown(e, i)}
            className={`absolute top-full -translate-x-1/2 cursor-grab active:cursor-grabbing ${
              i === selectedIdx ? 'z-10' : 'z-0'
            }`}
            style={{ left: `${stop.position}%` }}
          >
            {/* Triangle pointer */}
            <div
              data-stop-handle="true"
              className={`w-0 h-0 border-l-[5px] border-r-[5px] border-b-[5px] border-l-transparent border-r-transparent ${
                i === selectedIdx ? 'border-b-white' : 'border-b-gray-500'
              }`}
            />
            {/* Color swatch */}
            <div
              data-stop-handle="true"
              className={`w-[10px] h-[10px] rounded-sm border ${
                i === selectedIdx ? 'border-white' : 'border-gray-600'
              }`}
              style={{ backgroundColor: stop.color, marginLeft: '-0px' }}
            />
          </div>
        ))}
      </div>

      {/* Selected stop controls */}
      <div className="flex items-center gap-2 pt-1">
        <InlineColorPicker
          value={selectedStop.color}
          onChange={(c) => updateSelectedStop({ color: c })}
        />
        <div className="flex items-center gap-1 flex-1">
          <span className="text-[10px] text-gray-500">Pos</span>
          <input
            type="number" min="0" max="100" step="1"
            value={selectedStop.position}
            onChange={(e) => updateSelectedStop({ position: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) })}
            className="w-12 bg-[#1a1a1a] text-gray-300 text-xs border border-[#333] rounded px-1 py-0.5 text-center"
          />
          <span className="text-[10px] text-gray-500">%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-gray-500">Opacity</span>
          <input
            type="range" min="0" max="100" step="1"
            value={Math.round((selectedStop.opacity ?? 1) * 100)}
            onChange={(e) => updateSelectedStop({ opacity: parseInt(e.target.value) / 100 })}
            className="w-16 h-1 accent-indigo-500"
          />
          <span className="text-[10px] text-gray-400 w-8 text-right">{Math.round((selectedStop.opacity ?? 1) * 100)}%</span>
        </div>
        {stops.length > 2 && (
          <button
            onClick={handleDeleteStop}
            className="text-red-400 hover:text-red-300 text-xs px-1"
            title="Delete selected stop"
          >
            ×
          </button>
        )}
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-1">
        {GRADIENT_PRESETS.map((preset) => (
          <button
            key={preset.name}
            onClick={() => {
              onChange(preset.stops.map(s => ({ ...s })));
              setSelectedIdx(0);
            }}
            className="h-4 w-8 rounded-sm border border-[#444] hover:border-gray-300 transition-colors"
            style={{ background: buildGradientCSS('linear', preset.stops, 90) }}
            title={preset.name}
          />
        ))}
      </div>
    </div>
  );
};

export default GradientEditor;
