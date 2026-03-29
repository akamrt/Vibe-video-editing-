import React, { useCallback } from 'react';
import type { HSLQualifier as HSLQualifierType, QualifierRange } from '../types';

interface Props {
  qualifier: HSLQualifierType;
  onChange: (qualifier: HSLQualifierType) => void;
  onMattePreview?: (enabled: boolean) => void;
  mattePreviewing?: boolean;
}

interface RangeBarProps {
  label: string;
  range: QualifierRange;
  onChange: (range: QualifierRange) => void;
  gradient: string;
}

/** Individual H/S/L range bar with center, width, and softness controls */
function RangeBar({ label, range, onChange, gradient }: RangeBarProps) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-gray-400 uppercase">{label}</span>
        <span className="text-[9px] text-gray-500">
          C:{range.center.toFixed(2)} W:{range.width.toFixed(2)} S:{range.softness.toFixed(2)}
        </span>
      </div>
      {/* Visual bar with gradient background */}
      <div className="relative h-4 rounded" style={{ background: gradient }}>
        {/* Active range indicator */}
        <div
          className="absolute top-0 h-full rounded border border-white/40"
          style={{
            left: `${Math.max(0, (range.center - range.width / 2 - range.softness)) * 100}%`,
            right: `${Math.max(0, (1 - range.center - range.width / 2 - range.softness)) * 100}%`,
            background: 'rgba(255,255,255,0.15)',
          }}
        />
        {/* Center marker */}
        <div
          className="absolute top-0 h-full w-0.5 bg-white"
          style={{ left: `${range.center * 100}%` }}
        />
      </div>
      {/* Controls */}
      <div className="grid grid-cols-3 gap-1 mt-1">
        <label className="flex flex-col">
          <span className="text-[8px] text-gray-500">Center</span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={range.center}
            onChange={e => onChange({ ...range, center: parseFloat(e.target.value) })}
            className="h-1 accent-indigo-400"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-[8px] text-gray-500">Width</span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={range.width}
            onChange={e => onChange({ ...range, width: parseFloat(e.target.value) })}
            className="h-1 accent-indigo-400"
          />
        </label>
        <label className="flex flex-col">
          <span className="text-[8px] text-gray-500">Softness</span>
          <input
            type="range" min={0} max={0.5} step={0.01}
            value={range.softness}
            onChange={e => onChange({ ...range, softness: parseFloat(e.target.value) })}
            className="h-1 accent-indigo-400"
          />
        </label>
      </div>
    </div>
  );
}

/**
 * HSL Qualifier panel — select a color range in H/S/L space for secondary correction.
 */
export default function HSLQualifier({ qualifier, onChange, onMattePreview, mattePreviewing }: Props) {
  const updateHue = useCallback((hue: QualifierRange) => onChange({ ...qualifier, hue }), [qualifier, onChange]);
  const updateSat = useCallback((saturation: QualifierRange) => onChange({ ...qualifier, saturation }), [qualifier, onChange]);
  const updateLum = useCallback((luminance: QualifierRange) => onChange({ ...qualifier, luminance }), [qualifier, onChange]);

  return (
    <div className="space-y-2">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={qualifier.enabled}
            onChange={e => onChange({ ...qualifier, enabled: e.target.checked })}
            className="accent-indigo-500"
          />
          Enable Qualifier
        </label>
        <div className="flex gap-1">
          <button
            className={`px-2 py-0.5 text-[10px] rounded ${mattePreviewing ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            onClick={() => onMattePreview?.(!mattePreviewing)}
            disabled={!qualifier.enabled}
          >
            Matte
          </button>
          <button
            className={`px-2 py-0.5 text-[10px] rounded ${qualifier.invert ? 'bg-indigo-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            onClick={() => onChange({ ...qualifier, invert: !qualifier.invert })}
            disabled={!qualifier.enabled}
          >
            Invert
          </button>
        </div>
      </div>

      {qualifier.enabled && (
        <>
          <RangeBar
            label="Hue"
            range={qualifier.hue}
            onChange={updateHue}
            gradient="linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)"
          />
          <RangeBar
            label="Saturation"
            range={qualifier.saturation}
            onChange={updateSat}
            gradient="linear-gradient(to right, #808080, #ff4444)"
          />
          <RangeBar
            label="Luminance"
            range={qualifier.luminance}
            onChange={updateLum}
            gradient="linear-gradient(to right, #000000, #ffffff)"
          />

          {/* Blur radius */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400 w-16">Blur Radius</span>
            <input
              type="range" min={0} max={20} step={0.5}
              value={qualifier.blurRadius}
              onChange={e => onChange({ ...qualifier, blurRadius: parseFloat(e.target.value) })}
              className="flex-1 h-1 accent-indigo-400"
            />
            <span className="text-[9px] text-gray-500 w-6 text-right">{qualifier.blurRadius}</span>
          </div>
        </>
      )}
    </div>
  );
}
