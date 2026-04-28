import React from 'react';
import type { GraphicLayer } from '../types';

interface Props {
  layer: GraphicLayer;
  onUpdate: (patch: Partial<GraphicLayer>) => void;
  onDelete: () => void;
}

function Slider({
  label, value, min, max, step, unit, onChange, onReset,
}: {
  label: string; value: number; min: number; max: number; step: number;
  unit?: string; onChange: (v: number) => void; onReset?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={parseFloat(value.toFixed(2))}
            step={step}
            className="w-16 bg-[#2a2a2a] text-[10px] text-gray-200 text-right px-1 py-0.5 rounded border border-[#444] focus:outline-none focus:border-violet-500"
            onChange={e => onChange(parseFloat(e.target.value) || 0)}
          />
          {unit && <span className="text-[9px] text-gray-500">{unit}</span>}
          {onReset && (
            <button
              onClick={onReset}
              className="text-[9px] text-gray-600 hover:text-gray-300 px-1"
              title="Reset"
            >↺</button>
          )}
        </div>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-violet-500 h-1.5"
      />
    </div>
  );
}

export default function GraphicLayerPanel({ layer, onUpdate, onDelete }: Props) {
  const tx     = layer.translateX ?? 0;
  const ty     = layer.translateY ?? 0;
  const scale  = layer.scale ?? 1;
  const rot    = layer.rotation ?? 0;
  const opacity = layer.opacity ?? 1;
  const fadeIn  = layer.fadeInDuration ?? 0;
  const fadeOut = layer.fadeOutDuration ?? 0;

  return (
    <div className="flex flex-col gap-0 text-xs select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2a2a]">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold text-violet-400 uppercase tracking-widest">✦ Graphic</span>
          <span className="text-[10px] text-gray-300 font-medium truncate max-w-[100px]">{layer.name}</span>
        </div>
        <button
          onClick={onDelete}
          className="text-[9px] text-red-500/60 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-red-900/20 transition-colors"
        >Delete</button>
      </div>

      <div className="px-3 py-3 flex flex-col gap-4">
        {/* Visibility */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wide">Visible</span>
          <button
            onClick={() => onUpdate({ visible: !(layer.visible !== false) })}
            className={`w-8 h-4 rounded-full transition-colors relative ${layer.visible !== false ? 'bg-violet-600' : 'bg-[#444]'}`}
          >
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${layer.visible !== false ? 'left-4' : 'left-0.5'}`} />
          </button>
        </div>

        {/* Position */}
        <div className="flex flex-col gap-3">
          <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">Position</span>
          <Slider
            label="X" value={tx} min={-1920} max={1920} step={1} unit="px"
            onChange={v => onUpdate({ translateX: v })}
            onReset={() => onUpdate({ translateX: 0 })}
          />
          <Slider
            label="Y" value={ty} min={-1080} max={1080} step={1} unit="px"
            onChange={v => onUpdate({ translateY: v })}
            onReset={() => onUpdate({ translateY: 0 })}
          />
        </div>

        {/* Scale */}
        <div className="flex flex-col gap-3">
          <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">Transform</span>
          <Slider
            label="Scale" value={scale} min={0.05} max={4} step={0.01} unit="×"
            onChange={v => onUpdate({ scale: v })}
            onReset={() => onUpdate({ scale: 1 })}
          />
          <Slider
            label="Rotation" value={rot} min={-180} max={180} step={0.5} unit="°"
            onChange={v => onUpdate({ rotation: v })}
            onReset={() => onUpdate({ rotation: 0 })}
          />
        </div>

        {/* Opacity & Fade */}
        <div className="flex flex-col gap-3">
          <span className="text-[9px] font-semibold text-gray-500 uppercase tracking-widest">Opacity & Fade</span>
          <Slider
            label="Opacity" value={opacity} min={0} max={1} step={0.01}
            onChange={v => onUpdate({ opacity: v })}
            onReset={() => onUpdate({ opacity: 1 })}
          />
          <Slider
            label="Fade In" value={fadeIn} min={0} max={3} step={0.05} unit="s"
            onChange={v => onUpdate({ fadeInDuration: v })}
            onReset={() => onUpdate({ fadeInDuration: 0 })}
          />
          <Slider
            label="Fade Out" value={fadeOut} min={0} max={3} step={0.05} unit="s"
            onChange={v => onUpdate({ fadeOutDuration: v })}
            onReset={() => onUpdate({ fadeOutDuration: 0 })}
          />
        </div>

        {/* Reset All */}
        <button
          onClick={() => onUpdate({ translateX: 0, translateY: 0, scale: 1, rotation: 0, opacity: 1, fadeInDuration: 0, fadeOutDuration: 0 })}
          className="w-full py-1.5 rounded bg-[#2a2a2a] hover:bg-[#333] text-[10px] text-gray-400 hover:text-gray-200 transition-colors border border-[#3a3a3a]"
        >
          Reset All Transforms
        </button>
      </div>
    </div>
  );
}
