import React, { useState, useCallback } from 'react';
import type { ColorGrading, ColorWheelValue, CurvePoint, HSLQualifier as HSLQualifierType } from '../types';
import { DEFAULT_COLOR_GRADING, IDENTITY_CURVE, FLAT_CURVE, DEFAULT_QUALIFIER, isGradingDefault } from '../utils/colorGradingDefaults';
import ColorWheel from './ColorWheel';
import CurveEditor from './CurveEditor';
import HSLQualifier from './HSLQualifier';

type Tab = 'basic' | 'wheels' | 'curves' | 'hslCurves' | 'qualifier';

const HSL_CURVE_TYPES = [
  { key: 'hueVsHue' as const, label: 'Hue vs Hue' },
  { key: 'hueVsSat' as const, label: 'Hue vs Sat' },
  { key: 'hueVsLum' as const, label: 'Hue vs Lum' },
  { key: 'lumVsSat' as const, label: 'Lum vs Sat' },
  { key: 'satVsSat' as const, label: 'Sat vs Sat' },
] as const;

const RGB_CHANNELS = [
  { key: 'curveMaster' as const, label: 'Master', channel: 'master' as const },
  { key: 'curveRed' as const, label: 'Red', channel: 'red' as const },
  { key: 'curveGreen' as const, label: 'Green', channel: 'green' as const },
  { key: 'curveBlue' as const, label: 'Blue', channel: 'blue' as const },
] as const;

interface Props {
  grading: ColorGrading;
  onChange: (grading: ColorGrading) => void;
  onReset: () => void;
  mattePreviewing?: boolean;
  onMattePreview?: (enabled: boolean) => void;
}

/** Slider row for basic corrections */
function Slider({ label, value, defaultValue, min, max, step, onChange, unit, gradient }: {
  label: string; value: number; defaultValue: number; min: number; max: number; step: number;
  onChange: (v: number) => void; unit?: string; gradient?: string;
}) {
  const isModified = Math.abs(value - defaultValue) > 0.001;
  return (
    <div className="flex items-center gap-2 group">
      <span className={`text-[10px] w-20 ${isModified ? 'text-indigo-300' : 'text-gray-400'}`}>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        onDoubleClick={() => onChange(defaultValue)}
        className="flex-1 h-1 accent-indigo-400"
        style={gradient ? { background: gradient } : undefined}
      />
      <span className="text-[9px] text-gray-500 w-10 text-right">{value}{unit}</span>
    </div>
  );
}

export default function ColorGradingPanel({ grading, onChange, onReset, mattePreviewing, onMattePreview }: Props) {
  const [tab, setTab] = useState<Tab>('basic');
  const [rgbChannel, setRgbChannel] = useState<typeof RGB_CHANNELS[number]['key']>('curveMaster');
  const [hslCurveType, setHslCurveType] = useState<typeof HSL_CURVE_TYPES[number]['key']>('hueVsHue');

  const update = useCallback(<K extends keyof ColorGrading>(key: K, value: ColorGrading[K]) => {
    onChange({ ...grading, [key]: value });
  }, [grading, onChange]);

  const updateWheel = useCallback((key: 'lift' | 'gammaWheel' | 'gain' | 'offset', value: ColorWheelValue) => {
    onChange({ ...grading, [key]: value });
  }, [grading, onChange]);

  const updateCurve = useCallback((key: keyof ColorGrading, points: CurvePoint[]) => {
    onChange({ ...grading, [key]: points });
  }, [grading, onChange]);

  const updateQualifier = useCallback((q: HSLQualifierType) => {
    onChange({ ...grading, qualifier: q });
  }, [grading, onChange]);

  const isDefault = isGradingDefault(grading);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'basic', label: 'Basic' },
    { key: 'wheels', label: 'Wheels' },
    { key: 'curves', label: 'Curves' },
    { key: 'hslCurves', label: 'HSL' },
    { key: 'qualifier', label: 'Qualifier' },
  ];

  return (
    <div className="space-y-2">
      {/* Tab bar */}
      <div className="flex gap-0.5 bg-gray-800 rounded p-0.5">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`flex-1 px-1 py-1 text-[10px] rounded transition-colors ${
              tab === t.key ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Reset button */}
      {!isDefault && (
        <button
          onClick={onReset}
          className="w-full text-[10px] text-red-400 hover:text-red-300 py-0.5"
        >
          Reset All Color Grading
        </button>
      )}

      {/* Basic tab */}
      {tab === 'basic' && (
        <div className="space-y-1">
          <Slider label="Exposure" value={grading.exposure} defaultValue={0} min={-100} max={100} step={1} onChange={v => update('exposure', v)} />
          <Slider label="Brightness" value={grading.brightness} defaultValue={100} min={0} max={200} step={1} onChange={v => update('brightness', v)} unit="%" />
          <Slider label="Contrast" value={grading.contrast} defaultValue={100} min={0} max={200} step={1} onChange={v => update('contrast', v)} unit="%" />
          <Slider label="Highlights" value={grading.highlights} defaultValue={0} min={-100} max={100} step={1} onChange={v => update('highlights', v)} />
          <Slider label="Shadows" value={grading.shadows} defaultValue={0} min={-100} max={100} step={1} onChange={v => update('shadows', v)} />
          <Slider label="Saturation" value={grading.saturation} defaultValue={100} min={0} max={200} step={1} onChange={v => update('saturation', v)} unit="%" />
          <Slider
            label="Temperature"
            value={grading.temperature} defaultValue={0} min={-100} max={100} step={1}
            onChange={v => update('temperature', v)}
            gradient="linear-gradient(to right, #4488ff, #888, #ff8844)"
          />
          <Slider
            label="Tint"
            value={grading.tint} defaultValue={0} min={-100} max={100} step={1}
            onChange={v => update('tint', v)}
            gradient="linear-gradient(to right, #44ff88, #888, #ff44ff)"
          />
          <Slider label="Hue Rotate" value={grading.hueRotate} defaultValue={0} min={-180} max={180} step={1} onChange={v => update('hueRotate', v)} unit="°" />
          <Slider label="Gamma" value={grading.gamma} defaultValue={1} min={0.1} max={3} step={0.01} onChange={v => update('gamma', v)} />
        </div>
      )}

      {/* Wheels tab */}
      {tab === 'wheels' && (
        <div className="grid grid-cols-2 gap-2">
          <ColorWheel label="Lift" value={grading.lift} onChange={v => updateWheel('lift', v)} />
          <ColorWheel label="Gamma" value={grading.gammaWheel} onChange={v => updateWheel('gammaWheel', v)} />
          <ColorWheel label="Gain" value={grading.gain} onChange={v => updateWheel('gain', v)} />
          <ColorWheel label="Offset" value={grading.offset} onChange={v => updateWheel('offset', v)} />
        </div>
      )}

      {/* RGB Curves tab */}
      {tab === 'curves' && (
        <div className="space-y-2">
          {/* Channel selector */}
          <div className="flex gap-1">
            {RGB_CHANNELS.map(ch => (
              <button
                key={ch.key}
                className={`flex-1 px-1 py-0.5 text-[10px] rounded ${
                  rgbChannel === ch.key
                    ? ch.channel === 'master' ? 'bg-gray-600 text-white'
                    : ch.channel === 'red' ? 'bg-red-900 text-red-200'
                    : ch.channel === 'green' ? 'bg-green-900 text-green-200'
                    : 'bg-blue-900 text-blue-200'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
                onClick={() => setRgbChannel(ch.key)}
              >
                {ch.label}
              </button>
            ))}
          </div>
          {/* Curve editor */}
          {RGB_CHANNELS.map(ch => ch.key === rgbChannel && (
            <CurveEditor
              key={ch.key}
              points={grading[ch.key] as CurvePoint[]}
              onChange={pts => updateCurve(ch.key, pts)}
              channel={ch.channel}
              width={220}
              height={220}
            />
          ))}
          {/* Reset channel */}
          <button
            onClick={() => updateCurve(rgbChannel, [...IDENTITY_CURVE])}
            className="text-[10px] text-gray-500 hover:text-gray-300"
          >
            Reset {RGB_CHANNELS.find(c => c.key === rgbChannel)?.label} Curve
          </button>
        </div>
      )}

      {/* HSL Curves tab */}
      {tab === 'hslCurves' && (
        <div className="space-y-2">
          {/* Type selector */}
          <select
            value={hslCurveType}
            onChange={e => setHslCurveType(e.target.value as typeof hslCurveType)}
            className="w-full bg-gray-800 text-gray-300 text-[11px] rounded px-2 py-1 border border-gray-700"
          >
            {HSL_CURVE_TYPES.map(t => (
              <option key={t.key} value={t.key}>{t.label}</option>
            ))}
          </select>
          {/* Curve editor with hue rainbow background for hue-based curves */}
          <CurveEditor
            points={grading[hslCurveType] as CurvePoint[]}
            onChange={pts => updateCurve(hslCurveType, pts)}
            channel="hsl"
            centeredBaseline
            backgroundGradient={
              hslCurveType.startsWith('hue')
                ? 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)'
                : hslCurveType === 'lumVsSat'
                ? 'linear-gradient(to right, #000000, #ffffff)'
                : 'linear-gradient(to right, #808080, #ff4444)'
            }
            width={220}
            height={180}
          />
          {/* Reset */}
          <button
            onClick={() => updateCurve(hslCurveType, [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }])}
            className="text-[10px] text-gray-500 hover:text-gray-300"
          >
            Reset {HSL_CURVE_TYPES.find(t => t.key === hslCurveType)?.label} Curve
          </button>
        </div>
      )}

      {/* Qualifier tab */}
      {tab === 'qualifier' && (
        <HSLQualifier
          qualifier={grading.qualifier ?? DEFAULT_QUALIFIER}
          onChange={updateQualifier}
          mattePreviewing={mattePreviewing}
          onMattePreview={onMattePreview}
        />
      )}
    </div>
  );
}
