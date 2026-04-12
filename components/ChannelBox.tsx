import React, { useState, useRef, useCallback } from 'react';
import { ClipKeyframe, Segment } from '../types';
import { getInterpolatedTransform } from '../utils/interpolation';

// Mirror graph editor colors/labels
const CHANNEL_COLORS: Record<ChannelType, string> = {
  translateX: '#ff4444',
  translateY: '#44ff44',
  scale: '#3b82f6',
  rotation: '#f97316',
  volume: '#fbbf24',
  pivotX: '#06b6d4',
  pivotY: '#8b5cf6',
};

const CHANNEL_LABELS: Record<ChannelType, string> = {
  translateX: 'Translate X',
  translateY: 'Translate Y',
  scale: 'Scale',
  rotation: 'Rotation',
  volume: 'Volume',
  pivotX: 'Pivot X',
  pivotY: 'Pivot Y',
};

const CHANNEL_UNITS: Record<ChannelType, string> = {
  translateX: '%',
  translateY: '%',
  scale: 'x',
  rotation: '°',
  volume: '',
  pivotX: '%',
  pivotY: '%',
};

const CHANNEL_DEFAULTS: Record<ChannelType, number> = {
  translateX: 0, translateY: 0, scale: 1, rotation: 0, volume: 1, pivotX: 50, pivotY: 50,
};

const CHANNEL_STEP: Record<ChannelType, number> = {
  translateX: 0.1,
  translateY: 0.1,
  scale: 0.01,
  rotation: 0.1,
  volume: 0.01,
  pivotX: 0.5,
  pivotY: 0.5,
};

type ChannelType = 'translateX' | 'translateY' | 'scale' | 'rotation' | 'volume' | 'pivotX' | 'pivotY';
const ALL_CHANNELS: ChannelType[] = ['translateX', 'translateY', 'scale', 'rotation', 'volume', 'pivotX', 'pivotY'];

// Channel groupings for visual organization
const CHANNEL_GROUPS: { label: string; channels: ChannelType[] }[] = [
  { label: 'Position', channels: ['translateX', 'translateY'] },
  { label: 'Transform', channels: ['scale', 'rotation'] },
  { label: 'Pivot', channels: ['pivotX', 'pivotY'] },
  { label: 'Audio', channels: ['volume'] },
];

interface ChannelBoxProps {
  currentTime: number;
  keyframes: ClipKeyframe[] | undefined;
  targetLabel: string;
  onUpdateKeyframes: (keyframes: ClipKeyframe[]) => void;
  onSeek?: (time: number) => void;
}

const kfVal = (kf: ClipKeyframe, ch: ChannelType): number =>
  ch === 'volume' ? (kf.volume ?? 1)
    : ch === 'pivotX' ? (kf.pivotX ?? 50)
      : ch === 'pivotY' ? (kf.pivotY ?? 50)
        : kf[ch] as number;

const ChannelBox: React.FC<ChannelBoxProps> = ({
  currentTime,
  keyframes,
  targetLabel,
  onUpdateKeyframes,
  onSeek,
}) => {
  const [selectedChannels, setSelectedChannels] = useState<Set<ChannelType>>(new Set());
  const [editingChannel, setEditingChannel] = useState<ChannelType | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const kfs = keyframes || [];
  const interp = getInterpolatedTransform(kfs, currentTime);

  // Check if a keyframe exists at current time
  const existingKf = kfs.find(kf => Math.abs(kf.time - currentTime) < 0.01);

  // Check which channels are explicitly keyed at current time (only via keyframeConfig)
  const isChannelKeyed = (ch: ChannelType): boolean => {
    if (!existingKf) return false;
    return existingKf.keyframeConfig?.[ch] !== undefined;
  };

  const getValue = (ch: ChannelType): number => {
    return (interp as any)[ch] ?? CHANNEL_DEFAULTS[ch];
  };

  const formatValue = (ch: ChannelType, val: number): string => {
    if (ch === 'scale') return val.toFixed(3);
    if (ch === 'volume') return (val * 100).toFixed(1);
    if (ch === 'rotation') return val.toFixed(2);
    return val.toFixed(2);
  };

  const parseInput = (ch: ChannelType, input: string): number | null => {
    const num = parseFloat(input);
    if (isNaN(num)) return null;
    if (ch === 'volume') return num / 100; // Input as percentage
    return num;
  };

  const toggleChannelSelection = (ch: ChannelType, e: React.MouseEvent) => {
    setSelectedChannels(prev => {
      const next = new Set(prev);
      if (e.ctrlKey || e.metaKey) {
        if (next.has(ch)) next.delete(ch); else next.add(ch);
      } else if (e.shiftKey && prev.size > 0) {
        // Range select
        const allFlat = CHANNEL_GROUPS.flatMap(g => g.channels);
        const lastSelected = allFlat.find(c => prev.has(c));
        if (lastSelected) {
          const from = allFlat.indexOf(lastSelected);
          const to = allFlat.indexOf(ch);
          const [start, end] = from < to ? [from, to] : [to, from];
          for (let i = start; i <= end; i++) next.add(allFlat[i]);
        }
      } else {
        if (next.size === 1 && next.has(ch)) {
          next.clear();
        } else {
          next.clear();
          next.add(ch);
        }
      }
      return next;
    });
  };

  // Set a channel value at current time (upsert keyframe)
  const setChannelValue = useCallback((ch: ChannelType, value: number) => {
    const existing = kfs.find(kf => Math.abs(kf.time - currentTime) < 0.01);
    const base: ClipKeyframe = existing
      ? { ...existing }
      : {
        time: currentTime,
        translateX: interp.translateX,
        translateY: interp.translateY,
        scale: interp.scale,
        rotation: interp.rotation,
        volume: interp.volume,
        pivotX: interp.pivotX ?? 50,
        pivotY: interp.pivotY ?? 50,
      };

    // Update the specific channel
    if (ch === 'volume') base.volume = value;
    else if (ch === 'pivotX') base.pivotX = value;
    else if (ch === 'pivotY') base.pivotY = value;
    else (base as any)[ch] = value;

    // Add tangent config so the keyframe shows in graph editor
    base.keyframeConfig = {
      ...base.keyframeConfig,
      [ch]: base.keyframeConfig?.[ch] || {
        inTangent: { x: -0.3, y: 0 },
        outTangent: { x: 0.3, y: 0 },
      },
    };

    base.time = currentTime;

    if (existing) {
      onUpdateKeyframes(kfs.map(kf => Math.abs(kf.time - currentTime) < 0.01 ? base : kf));
    } else {
      onUpdateKeyframes([...kfs, base].sort((a, b) => a.time - b.time));
    }
  }, [kfs, currentTime, interp, onUpdateKeyframes]);

  // Insert keyframe at current time for selected channels (or all if none selected)
  const handleInsertKey = useCallback(() => {
    const channels = selectedChannels.size > 0 ? Array.from(selectedChannels) : ALL_CHANNELS;
    const existing = kfs.find(kf => Math.abs(kf.time - currentTime) < 0.01);
    const base: ClipKeyframe = existing
      ? { ...existing }
      : {
        time: currentTime,
        translateX: interp.translateX,
        translateY: interp.translateY,
        scale: interp.scale,
        rotation: interp.rotation,
        volume: interp.volume,
        pivotX: interp.pivotX ?? 50,
        pivotY: interp.pivotY ?? 50,
      };

    base.time = currentTime;
    const config = { ...base.keyframeConfig };
    channels.forEach(ch => {
      if (!config[ch]) {
        config[ch] = { inTangent: { x: -0.3, y: 0 }, outTangent: { x: 0.3, y: 0 } };
      }
    });
    base.keyframeConfig = config;

    if (existing) {
      onUpdateKeyframes(kfs.map(kf => Math.abs(kf.time - currentTime) < 0.01 ? base : kf));
    } else {
      onUpdateKeyframes([...kfs, base].sort((a, b) => a.time - b.time));
    }
  }, [kfs, currentTime, interp, selectedChannels, onUpdateKeyframes]);

  // Reset selected channels (or all) to defaults at current time
  const handleResetToDefault = useCallback(() => {
    const channels = selectedChannels.size > 0 ? Array.from(selectedChannels) : ALL_CHANNELS;
    const existing = kfs.find(kf => Math.abs(kf.time - currentTime) < 0.01);
    const base: ClipKeyframe = existing
      ? { ...existing }
      : {
        time: currentTime,
        translateX: interp.translateX,
        translateY: interp.translateY,
        scale: interp.scale,
        rotation: interp.rotation,
        volume: interp.volume,
        pivotX: interp.pivotX ?? 50,
        pivotY: interp.pivotY ?? 50,
      };

    base.time = currentTime;
    channels.forEach(ch => {
      const def = CHANNEL_DEFAULTS[ch];
      if (ch === 'volume') base.volume = def;
      else if (ch === 'pivotX') base.pivotX = def;
      else if (ch === 'pivotY') base.pivotY = def;
      else (base as any)[ch] = def;
    });

    // Add config so it shows in graph
    const config = { ...base.keyframeConfig };
    channels.forEach(ch => {
      if (!config[ch]) {
        config[ch] = { inTangent: { x: -0.3, y: 0 }, outTangent: { x: 0.3, y: 0 } };
      }
    });
    base.keyframeConfig = config;

    if (existing) {
      onUpdateKeyframes(kfs.map(kf => Math.abs(kf.time - currentTime) < 0.01 ? base : kf));
    } else {
      onUpdateKeyframes([...kfs, base].sort((a, b) => a.time - b.time));
    }
  }, [kfs, currentTime, interp, selectedChannels, onUpdateKeyframes]);

  // Delete keyframe at current time for selected channels
  const handleDeleteKey = useCallback(() => {
    if (!existingKf) return;
    const channels = selectedChannels.size > 0 ? Array.from(selectedChannels) : ALL_CHANNELS;

    if (channels.length === ALL_CHANNELS.length) {
      // Delete entire keyframe
      onUpdateKeyframes(kfs.filter(kf => Math.abs(kf.time - currentTime) >= 0.01));
    } else {
      // Reset selected channels to default and remove their config
      const updated = { ...existingKf };
      const config = { ...updated.keyframeConfig };
      channels.forEach(ch => {
        const def = CHANNEL_DEFAULTS[ch];
        if (ch === 'volume') updated.volume = def;
        else if (ch === 'pivotX') updated.pivotX = def;
        else if (ch === 'pivotY') updated.pivotY = def;
        else (updated as any)[ch] = def;
        delete config[ch];
      });
      updated.keyframeConfig = config;
      onUpdateKeyframes(kfs.map(kf => Math.abs(kf.time - currentTime) < 0.01 ? updated : kf));
    }
  }, [kfs, currentTime, existingKf, selectedChannels, onUpdateKeyframes]);

  // Toggle keyframe on a single channel at current time
  const toggleChannelKey = useCallback((ch: ChannelType) => {
    const existing = kfs.find(kf => Math.abs(kf.time - currentTime) < 0.01);

    if (existing && isChannelKeyed(ch)) {
      // Remove this channel's config from the keyframe
      const updated = { ...existing };
      const config = { ...updated.keyframeConfig };
      delete config[ch];
      // Reset channel to default
      const def = CHANNEL_DEFAULTS[ch];
      if (ch === 'volume') updated.volume = def;
      else if (ch === 'pivotX') updated.pivotX = def;
      else if (ch === 'pivotY') updated.pivotY = def;
      else (updated as any)[ch] = def;
      updated.keyframeConfig = config;

      // If ALL channels are now at default with no config, remove the entire keyframe
      const hasAnyConfig = Object.keys(config).length > 0;
      const allDefault = updated.translateX === 0 && updated.translateY === 0 &&
        updated.scale === 1 && updated.rotation === 0 &&
        (updated.volume ?? 1) === 1 && (updated.pivotX ?? 50) === 50 && (updated.pivotY ?? 50) === 50;

      if (!hasAnyConfig && allDefault) {
        onUpdateKeyframes(kfs.filter(kf => Math.abs(kf.time - currentTime) >= 0.01));
      } else {
        onUpdateKeyframes(kfs.map(kf => Math.abs(kf.time - currentTime) < 0.01 ? updated : kf));
      }
    } else {
      // Insert/key this channel
      const base: ClipKeyframe = existing
        ? { ...existing }
        : {
          time: currentTime,
          translateX: interp.translateX,
          translateY: interp.translateY,
          scale: interp.scale,
          rotation: interp.rotation,
          volume: interp.volume,
          pivotX: interp.pivotX ?? 50,
          pivotY: interp.pivotY ?? 50,
        };
      base.time = currentTime;
      base.keyframeConfig = {
        ...base.keyframeConfig,
        [ch]: base.keyframeConfig?.[ch] || {
          inTangent: { x: -0.3, y: 0 },
          outTangent: { x: 0.3, y: 0 },
        },
      };
      if (existing) {
        onUpdateKeyframes(kfs.map(kf => Math.abs(kf.time - currentTime) < 0.01 ? base : kf));
      } else {
        onUpdateKeyframes([...kfs, base].sort((a, b) => a.time - b.time));
      }
    }
  }, [kfs, currentTime, interp, onUpdateKeyframes]);

  // Navigate to prev/next keyframe
  const handlePrevKey = useCallback(() => {
    if (!onSeek || kfs.length === 0) return;
    const sorted = [...kfs].sort((a, b) => a.time - b.time);
    const prev = [...sorted].reverse().find(kf => kf.time < currentTime - 0.01);
    if (prev) onSeek(prev.time);
  }, [kfs, currentTime, onSeek]);

  const handleNextKey = useCallback(() => {
    if (!onSeek || kfs.length === 0) return;
    const sorted = [...kfs].sort((a, b) => a.time - b.time);
    const next = sorted.find(kf => kf.time > currentTime + 0.01);
    if (next) onSeek(next.time);
  }, [kfs, currentTime, onSeek]);

  const startEditing = (ch: ChannelType) => {
    setEditingChannel(ch);
    const val = getValue(ch);
    setEditValue(ch === 'volume' ? (val * 100).toFixed(1) : formatValue(ch, val));
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEdit = (ch: ChannelType) => {
    const parsed = parseInput(ch, editValue);
    if (parsed !== null) {
      setChannelValue(ch, parsed);
    }
    setEditingChannel(null);
  };

  // Scrub value with mouse drag on the value field
  const handleScrub = (ch: ChannelType, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startVal = getValue(ch);
    const step = CHANNEL_STEP[ch];
    const multiplier = e.shiftKey ? 0.1 : 1;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const delta = dx * step * multiplier;
      setChannelValue(ch, startVal + delta);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="flex flex-col h-full bg-[#1a1a1a] text-gray-200 select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#222] border-b border-[#333]">
        <div className="text-[11px] font-bold text-gray-300 uppercase tracking-wider truncate flex-1">
          {targetLabel}
        </div>
        <div className="text-[9px] text-gray-500 font-mono ml-2">
          t={currentTime.toFixed(3)}s
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-[#1e1e1e] border-b border-[#333]">
        <button
          onClick={handleInsertKey}
          title="Insert keyframe at current time (selected channels or all)"
          className="px-2 py-1 text-[10px] font-bold bg-green-900/40 text-green-400 border border-green-700/50 rounded hover:bg-green-800/50 transition-colors"
        >
          + Key
        </button>
        <button
          onClick={handleDeleteKey}
          disabled={!existingKf}
          title="Delete keyframe at current time (selected channels or all)"
          className="px-2 py-1 text-[10px] font-bold bg-red-900/30 text-red-400 border border-red-700/50 rounded hover:bg-red-800/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          − Key
        </button>
        <button
          onClick={handleResetToDefault}
          title="Reset selected channels to default values"
          className="px-2 py-1 text-[10px] font-bold bg-gray-700/40 text-gray-300 border border-gray-600/50 rounded hover:bg-gray-600/50 transition-colors"
        >
          Reset
        </button>
        <div className="flex-1" />
        <button
          onClick={handlePrevKey}
          disabled={kfs.length === 0}
          title="Previous keyframe"
          className="px-1.5 py-1 text-[10px] text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ◀
        </button>
        <div
          className={`w-2 h-2 rotate-45 border ${existingKf ? 'bg-yellow-400 border-yellow-500' : 'bg-transparent border-gray-500'}`}
          title={existingKf ? 'Keyframe exists at current time' : 'No keyframe at current time'}
        />
        <button
          onClick={handleNextKey}
          disabled={kfs.length === 0}
          title="Next keyframe"
          className="px-1.5 py-1 text-[10px] text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ▶
        </button>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto">
        {CHANNEL_GROUPS.map(group => (
          <div key={group.label}>
            {/* Group header */}
            <div className="px-3 py-1 bg-[#222] border-b border-[#2a2a2a]">
              <span className="text-[9px] font-bold text-gray-500 uppercase tracking-widest">{group.label}</span>
            </div>

            {/* Channel rows */}
            {group.channels.map(ch => {
              const val = getValue(ch);
              const keyed = isChannelKeyed(ch);
              const isSelected = selectedChannels.has(ch);
              const isEditing = editingChannel === ch;
              const color = CHANNEL_COLORS[ch];
              const isDefault = Math.abs(val - CHANNEL_DEFAULTS[ch]) < 0.0001;

              return (
                <div
                  key={ch}
                  className={`flex items-center h-[28px] border-b border-[#2a2a2a] cursor-pointer transition-colors ${
                    isSelected ? 'bg-[#2a3a4a]' : 'hover:bg-[#252525]'
                  }`}
                  onClick={(e) => toggleChannelSelection(ch, e)}
                >
                  {/* Keyed indicator — click to toggle key on this channel */}
                  <button
                    className="w-5 flex items-center justify-center flex-shrink-0 hover:bg-[#333] transition-colors"
                    onClick={(e) => { e.stopPropagation(); toggleChannelKey(ch); }}
                    title={keyed ? `Remove ${CHANNEL_LABELS[ch]} keyframe` : `Add ${CHANNEL_LABELS[ch]} keyframe`}
                  >
                    <div
                      className="w-[7px] h-[7px] rotate-45 border"
                      style={{
                        backgroundColor: keyed ? color : 'transparent',
                        borderColor: keyed ? color : '#555',
                      }}
                    />
                  </button>

                  {/* Channel color bar */}
                  <div
                    className="w-[3px] h-full flex-shrink-0"
                    style={{ backgroundColor: color, opacity: 0.7 }}
                  />

                  {/* Label */}
                  <div
                    className="flex-1 px-2 text-[11px] font-medium truncate"
                    style={{ color: isSelected ? color : '#ccc' }}
                  >
                    {CHANNEL_LABELS[ch]}
                  </div>

                  {/* Value */}
                  <div
                    className="w-24 px-2 text-right font-mono text-[11px] flex-shrink-0"
                    onDoubleClick={(e) => { e.stopPropagation(); startEditing(ch); }}
                    onMouseDown={(e) => {
                      if (e.detail >= 2) return; // Skip double-click
                      handleScrub(ch, e);
                    }}
                    style={{
                      color: isDefault ? '#777' : color,
                      cursor: 'ew-resize',
                    }}
                    title="Drag to scrub value, double-click to type"
                  >
                    {isEditing ? (
                      <input
                        ref={inputRef}
                        type="text"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => commitEdit(ch)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit(ch);
                          if (e.key === 'Escape') setEditingChannel(null);
                          e.stopPropagation();
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full bg-[#111] border border-[#555] rounded px-1 py-0 text-[11px] text-right font-mono outline-none focus:border-blue-500"
                        style={{ color }}
                        autoFocus
                      />
                    ) : (
                      <>
                        {ch === 'volume' ? `${(val * 100).toFixed(1)}%` : `${formatValue(ch, val)}${CHANNEL_UNITS[ch]}`}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Footer: keyframe count */}
      <div className="px-3 py-1.5 bg-[#222] border-t border-[#333] flex items-center justify-between">
        <span className="text-[9px] text-gray-500">
          {kfs.length} keyframe{kfs.length !== 1 ? 's' : ''}
        </span>
        {selectedChannels.size > 0 && (
          <span className="text-[9px] text-blue-400">
            {selectedChannels.size} selected
          </span>
        )}
      </div>
    </div>
  );
};

export default React.memo(ChannelBox);
