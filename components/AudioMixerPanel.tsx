import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { AudioMixerState, AudioEffects, Segment } from '../types';
import { createDefaultAudioMixer, AUDIO_PRESETS, DEFAULT_EQ_BANDS } from '../utils/audioMixerDefaults';
import { getPeakLevel, getRMSLevel } from '../utils/audioProcessingChain';
import type { AudioChain } from '../utils/audioProcessingChain';
import type { EQBand } from '../types';

interface AudioMixerPanelProps {
  audioMixer: AudioMixerState;
  onUpdate: (mixer: AudioMixerState) => void;
  segments: Segment[];
  isPlaying: boolean;
  analyserNode: AnalyserNode | null;
}

// ── Reusable UI Components ──────────────────────────────────────────────────

const Toggle: React.FC<{ label: string; enabled: boolean; onChange: (v: boolean) => void }> = ({ label, enabled, onChange }) => (
  <button
    onClick={() => onChange(!enabled)}
    className={`flex items-center gap-2 w-full py-1.5 px-2 rounded text-xs font-medium border transition-colors ${
      enabled
        ? 'bg-pink-600/20 text-pink-400 border-pink-500/50'
        : 'bg-[#2a2a2a] text-gray-400 border-[#444] hover:border-gray-500'
    }`}
  >
    <span className={`w-3 h-3 rounded-full border-2 transition-colors ${enabled ? 'bg-pink-400 border-pink-400' : 'border-gray-500'}`} />
    {label}
  </button>
);

const Slider: React.FC<{
  label: string; value: number; min: number; max: number; step?: number;
  onChange: (v: number) => void; suffix?: string; displayValue?: string;
}> = ({ label, value, min, max, step = 0.01, onChange, suffix = '', displayValue }) => (
  <div className="flex items-center gap-2 py-1">
    <span className="text-gray-400 text-[10px] w-16 shrink-0">{label}</span>
    <input
      type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(parseFloat(e.target.value))}
      className="flex-1 h-1 accent-pink-400"
    />
    <span className="text-gray-300 text-[10px] w-12 text-right font-mono">
      {displayValue ?? `${typeof value === 'number' ? (Number.isInteger(step) ? value : value.toFixed(1)) : value}${suffix}`}
    </span>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode; defaultOpen?: boolean }> = ({ title, children, defaultOpen = true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[#333]">
      <button onClick={() => setOpen(!open)} className="flex items-center w-full px-3 py-2 text-[10px] font-bold text-gray-300 uppercase tracking-wider hover:bg-[#2a2a2a]">
        <span className={`mr-1.5 transition-transform ${open ? 'rotate-90' : ''}`}>&#9656;</span>
        {title}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
};

// ── Level Meter ─────────────────────────────────────────────────────────────

const LevelMeter: React.FC<{ analyserNode: AnalyserNode | null; isPlaying: boolean }> = ({ analyserNode, isPlaying }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const peakHoldRef = useRef(-Infinity);
  const peakDecayRef = useRef(-Infinity);

  useEffect(() => {
    if (!analyserNode || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;

    const draw = () => {
      animRef.current = requestAnimationFrame(draw);
      const peak = getPeakLevel(analyserNode);
      const rms = getRMSLevel(analyserNode);

      // Peak hold with slow decay
      if (peak > peakHoldRef.current) peakHoldRef.current = peak;
      else peakHoldRef.current -= 0.3; // decay rate dB/frame

      if (peak > peakDecayRef.current) peakDecayRef.current = peak;
      else peakDecayRef.current -= 1.5;

      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, W, H);

      // Map dB to pixel position (-60dB to 0dB range)
      const dbToX = (db: number) => Math.max(0, Math.min(W, ((db + 60) / 60) * W));

      // RMS bar
      const rmsX = dbToX(rms);
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#22c55e');
      grad.addColorStop(0.7, '#eab308');
      grad.addColorStop(0.9, '#ef4444');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 2, rmsX, H / 2 - 3);

      // Peak bar (thinner)
      const peakX = dbToX(peakDecayRef.current);
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(0, H / 2 + 1, peakX, H / 2 - 3);

      // Peak hold indicator
      const holdX = dbToX(peakHoldRef.current);
      ctx.fillStyle = peakHoldRef.current > -1 ? '#ef4444' : '#ffffff';
      ctx.fillRect(holdX - 1, 0, 2, H);

      // Scale marks at -48, -36, -24, -12, -6, 0
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      for (const db of [-48, -36, -24, -12, -6, 0]) {
        const x = dbToX(db);
        ctx.fillRect(x, 0, 1, H);
      }
    };

    if (isPlaying) {
      draw();
    } else {
      // Clear when not playing
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, W, H);
      peakHoldRef.current = -Infinity;
      peakDecayRef.current = -Infinity;
    }

    return () => cancelAnimationFrame(animRef.current);
  }, [analyserNode, isPlaying]);

  return (
    <div>
      <canvas ref={canvasRef} width={240} height={20} className="w-full h-5 rounded bg-[#1a1a1a]" />
      <div className="flex justify-between text-[8px] text-gray-500 mt-0.5 px-0.5">
        <span>-60</span><span>-48</span><span>-36</span><span>-24</span><span>-12</span><span>-6</span><span>0</span>
      </div>
    </div>
  );
};

// ── Main Component ──────────────────────────────────────────────────────────

export const AudioMixerPanel: React.FC<AudioMixerPanelProps> = ({
  audioMixer,
  onUpdate,
  segments,
  isPlaying,
  analyserNode,
}) => {
  const mixer = audioMixer || createDefaultAudioMixer();
  const fx = mixer.effects;

  const updateEffects = useCallback((partial: Partial<AudioEffects>) => {
    onUpdate({ ...mixer, effects: { ...fx, ...partial } });
  }, [mixer, fx, onUpdate]);

  const updateEQBand = useCallback((index: number, updates: Partial<EQBand>) => {
    const bands = [...fx.eqBands] as [EQBand, EQBand, EQBand];
    bands[index] = { ...bands[index], ...updates };
    updateEffects({ eqBands: bands });
  }, [fx.eqBands, updateEffects]);

  const activeSegments = segments.filter(s => s.type !== 'blank');

  return (
    <div className="flex flex-col h-full text-xs overflow-y-auto">
      {/* Master Output */}
      <Section title="Master Output">
        <Slider
          label="Volume"
          value={mixer.masterVolume}
          min={0} max={2} step={0.01}
          onChange={v => onUpdate({ ...mixer, masterVolume: v })}
          displayValue={`${Math.round(mixer.masterVolume * 100)}%`}
        />
        <div className="mt-2">
          <LevelMeter analyserNode={analyserNode} isPlaying={isPlaying} />
        </div>
        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-gray-500">
          <span>RMS</span>
          <span className="flex-1" />
          <span>Peak</span>
        </div>
      </Section>

      {/* Presets */}
      <Section title="Presets">
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(AUDIO_PRESETS).map(([key, preset]) => (
            <button
              key={key}
              onClick={() => onUpdate(preset.apply(mixer))}
              className="py-1.5 px-2 rounded text-[10px] font-medium bg-[#2a2a2a] border border-[#444] text-gray-300 hover:bg-[#333] hover:text-white hover:border-pink-500/50 transition-colors"
              title={preset.description}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Section>

      {/* Noise Reduction */}
      <Section title="Noise Reduction">
        <Toggle
          label="Enable RNNoise"
          enabled={fx.noiseReduction}
          onChange={v => updateEffects({ noiseReduction: v })}
        />
        <p className="text-[10px] text-gray-500 mt-1.5">
          ML-based noise suppression. Removes background noise, hum, and hiss. Applied during export.
        </p>
      </Section>

      {/* EQ */}
      <Section title="Equalizer">
        <Toggle
          label="Enable EQ"
          enabled={fx.eqEnabled}
          onChange={v => updateEffects({ eqEnabled: v })}
        />
        {fx.eqEnabled && (
          <div className="mt-2 space-y-1">
            <Slider
              label="Bass"
              value={fx.eqBands[0].gain}
              min={-12} max={12} step={0.5}
              onChange={v => updateEQBand(0, { gain: v })}
              suffix=" dB"
            />
            <Slider
              label="Mid"
              value={fx.eqBands[1].gain}
              min={-12} max={12} step={0.5}
              onChange={v => updateEQBand(1, { gain: v })}
              suffix=" dB"
            />
            <Slider
              label="Treble"
              value={fx.eqBands[2].gain}
              min={-12} max={12} step={0.5}
              onChange={v => updateEQBand(2, { gain: v })}
              suffix=" dB"
            />
            <button
              onClick={() => updateEffects({ eqBands: [...DEFAULT_EQ_BANDS] as [EQBand, EQBand, EQBand] })}
              className="text-[10px] text-gray-500 hover:text-gray-300 mt-1"
            >
              Reset EQ
            </button>
          </div>
        )}
      </Section>

      {/* Compressor */}
      <Section title="Compressor" defaultOpen={false}>
        <Toggle
          label="Enable Compressor"
          enabled={fx.compressorEnabled}
          onChange={v => updateEffects({ compressorEnabled: v })}
        />
        {fx.compressorEnabled && (
          <div className="mt-2 space-y-1">
            <Slider
              label="Threshold"
              value={fx.compressorThreshold}
              min={-60} max={0} step={1}
              onChange={v => updateEffects({ compressorThreshold: v })}
              suffix=" dB"
            />
            <Slider
              label="Ratio"
              value={fx.compressorRatio}
              min={1} max={20} step={0.5}
              onChange={v => updateEffects({ compressorRatio: v })}
              displayValue={`${fx.compressorRatio.toFixed(1)}:1`}
            />
            <Slider
              label="Knee"
              value={fx.compressorKnee}
              min={0} max={40} step={1}
              onChange={v => updateEffects({ compressorKnee: v })}
              suffix=" dB"
            />
            <Slider
              label="Attack"
              value={fx.compressorAttack}
              min={0} max={0.5} step={0.001}
              onChange={v => updateEffects({ compressorAttack: v })}
              displayValue={`${(fx.compressorAttack * 1000).toFixed(0)} ms`}
            />
            <Slider
              label="Release"
              value={fx.compressorRelease}
              min={0.01} max={1} step={0.01}
              onChange={v => updateEffects({ compressorRelease: v })}
              displayValue={`${(fx.compressorRelease * 1000).toFixed(0)} ms`}
            />
          </div>
        )}
      </Section>

      {/* Limiter */}
      <Section title="Limiter" defaultOpen={false}>
        <Toggle
          label="Enable Limiter"
          enabled={fx.limiterEnabled}
          onChange={v => updateEffects({ limiterEnabled: v })}
        />
        {fx.limiterEnabled && (
          <div className="mt-2">
            <Slider
              label="Ceiling"
              value={fx.limiterThreshold}
              min={-12} max={0} step={0.1}
              onChange={v => updateEffects({ limiterThreshold: v })}
              suffix=" dB"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Prevents audio from exceeding the ceiling level.
            </p>
          </div>
        )}
      </Section>

      {/* Loudness Normalization */}
      <Section title="Loudness Normalization">
        <Toggle
          label="Enable Normalization"
          enabled={fx.normalizationEnabled}
          onChange={v => updateEffects({ normalizationEnabled: v })}
        />
        {fx.normalizationEnabled && (
          <div className="mt-2">
            <div className="flex items-center gap-2 py-1">
              <span className="text-gray-400 text-[10px] w-16 shrink-0">Target</span>
              <select
                value={fx.normalizationTarget}
                onChange={e => updateEffects({ normalizationTarget: parseFloat(e.target.value) })}
                className="flex-1 bg-[#2a2a2a] border border-[#444] rounded px-2 py-1 text-[10px] text-gray-300"
              >
                <option value={-14}>-14 LUFS (YouTube / Streaming)</option>
                <option value={-16}>-16 LUFS (Podcast)</option>
                <option value={-23}>-23 LUFS (Broadcast / EBU R128)</option>
                <option value={-11}>-11 LUFS (Loud / Social Media)</option>
              </select>
            </div>
            <p className="text-[10px] text-gray-500 mt-1">
              Adjusts overall loudness to match the target during export.
            </p>
          </div>
        )}
      </Section>

      {/* Segment volumes summary */}
      {activeSegments.length > 0 && (
        <Section title={`Clip Volumes (${activeSegments.length})`} defaultOpen={false}>
          <p className="text-[10px] text-gray-500 mb-2">
            Per-clip volume is controlled via keyframes in the Properties panel. Clips with volume keyframes are listed below.
          </p>
          {activeSegments.filter(s => s.keyframes?.some(k => k.volume !== undefined && k.volume !== 1.0)).length === 0 ? (
            <p className="text-[10px] text-gray-500 italic">All clips at default volume (100%)</p>
          ) : (
            <div className="space-y-1">
              {activeSegments
                .filter(s => s.keyframes?.some(k => k.volume !== undefined && k.volume !== 1.0))
                .map(seg => {
                  const minVol = Math.min(...(seg.keyframes?.map(k => k.volume ?? 1) ?? [1]));
                  const maxVol = Math.max(...(seg.keyframes?.map(k => k.volume ?? 1) ?? [1]));
                  return (
                    <div key={seg.id} className="flex items-center gap-2 py-0.5">
                      <span className="text-gray-400 truncate flex-1">
                        {seg.mediaId?.slice(0, 8)}... [{seg.startTime.toFixed(1)}s]
                      </span>
                      <span className="text-gray-300 font-mono text-[10px]">
                        {minVol === maxVol
                          ? `${Math.round(minVol * 100)}%`
                          : `${Math.round(minVol * 100)}-${Math.round(maxVol * 100)}%`}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </Section>
      )}

      {/* Reset */}
      <div className="p-3 border-t border-[#333] mt-auto">
        <button
          onClick={() => onUpdate(createDefaultAudioMixer())}
          className="w-full py-1.5 rounded text-[10px] font-medium bg-[#2a2a2a] border border-[#444] text-gray-400 hover:text-red-400 hover:border-red-500/50 transition-colors"
        >
          Reset All Audio Settings
        </button>
      </div>
    </div>
  );
};
