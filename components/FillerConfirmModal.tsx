import React, { useState } from 'react';
import { FillerDetection } from '../services/geminiService';

export interface FillerDetectionWithMedia extends FillerDetection {
  mediaId: string;
  mediaName?: string;
}

interface FillerConfirmModalProps {
  detections: FillerDetectionWithMedia[];
  onConfirm: (selected: FillerDetectionWithMedia[]) => void;
  onRedetect: () => void;
  onCancel: () => void;
  hasCachedData?: boolean;
}

const FillerConfirmModal: React.FC<FillerConfirmModalProps> = ({
  detections, onConfirm, onRedetect, onCancel, hasCachedData
}) => {
  const [selected, setSelected] = useState<Set<number>>(
    new Set(detections.map((_, i) => i))
  );

  const toggleAll = (on: boolean) => {
    setSelected(on ? new Set(detections.map((_, i) => i)) : new Set());
  };

  const toggle = (idx: number) => {
    const next = new Set(selected);
    next.has(idx) ? next.delete(idx) : next.add(idx);
    setSelected(next);
  };

  const totalRemoved = detections
    .filter((_, i) => selected.has(i))
    .reduce((sum, d) => sum + (d.endTime - d.startTime), 0);

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2);
    return `${m}:${s.padStart(5, '0')}`;
  };

  const typeBadgeColors: Record<string, string> = {
    filler: 'bg-yellow-600',
    repeated: 'bg-orange-600',
    stammer: 'bg-red-600',
  };

  // Group detections by media for display
  const mediaNames = [...new Set(detections.map(d => d.mediaName || d.mediaId))];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-[#1e1e1e] border border-[#333] rounded-xl w-[580px] max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#333] flex justify-between items-center">
          <div>
            <h2 className="text-lg font-bold text-white">Detected Filler Words</h2>
            {hasCachedData && (
              <span className="text-[10px] text-blue-400">Loaded from cache — re-analyze to find more</span>
            )}
          </div>
          <button onClick={onCancel} className="text-gray-500 hover:text-white text-lg leading-none">&times;</button>
        </div>

        {/* Summary bar */}
        <div className="px-5 py-2 bg-[#252525] border-b border-[#333] flex justify-between items-center text-xs text-gray-400">
          <span>{selected.size} of {detections.length} selected</span>
          <span className="text-amber-400 font-mono">-{totalRemoved.toFixed(2)}s</span>
          <div className="flex gap-2">
            <button onClick={() => toggleAll(true)} className="text-blue-400 hover:underline">All</button>
            <button onClick={() => toggleAll(false)} className="text-blue-400 hover:underline">None</button>
          </div>
        </div>

        {/* Detection list */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5 min-h-0">
          {mediaNames.length > 1 && detections.map((d, i) => {
            // Show media name header when it changes
            const prev = i > 0 ? detections[i - 1] : null;
            const showHeader = !prev || prev.mediaId !== d.mediaId;
            return (
              <React.Fragment key={i}>
                {showHeader && (
                  <div className="text-[9px] text-gray-500 uppercase tracking-wider font-bold mt-2 mb-1 px-2">
                    {d.mediaName || d.mediaId}
                  </div>
                )}
                <FillerRow d={d} i={i} selected={selected} toggle={toggle} formatTime={formatTime} typeBadgeColors={typeBadgeColors} />
              </React.Fragment>
            );
          })}
          {mediaNames.length <= 1 && detections.map((d, i) => (
            <FillerRow key={i} d={d} i={i} selected={selected} toggle={toggle} formatTime={formatTime} typeBadgeColors={typeBadgeColors} />
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#333] flex justify-between items-center">
          <button
            onClick={onRedetect}
            className="px-3 py-2 text-xs bg-[#333] text-blue-400 rounded hover:bg-[#444] hover:text-blue-300 transition-colors font-medium"
            title="Run a second AI pass looking for fillers that were missed"
          >
            Re-analyze for Missed
          </button>
          <div className="flex gap-3">
            <button onClick={onCancel} className="px-4 py-2 text-xs bg-[#333] text-gray-300 rounded hover:bg-[#444] transition-colors">
              Cancel
            </button>
            <button
              onClick={() => onConfirm(detections.filter((_, i) => selected.has(i)))}
              disabled={selected.size === 0}
              className="px-4 py-2 text-xs bg-amber-600 text-white font-bold rounded hover:bg-amber-500 disabled:opacity-50 transition-colors"
            >
              Remove {selected.size} Filler{selected.size !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Individual filler detection row */
const FillerRow: React.FC<{
  d: FillerDetectionWithMedia; i: number;
  selected: Set<number>; toggle: (i: number) => void;
  formatTime: (t: number) => string;
  typeBadgeColors: Record<string, string>;
}> = ({ d, i, selected, toggle, formatTime, typeBadgeColors }) => (
  <label className={`flex items-center gap-3 px-2 py-1.5 rounded cursor-pointer transition-colors ${selected.has(i) ? 'bg-[#2a2a2a] hover:bg-[#333]' : 'opacity-50 hover:opacity-75'}`}>
    <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)}
      className="accent-amber-500 shrink-0" />
    <span className="text-[10px] text-gray-500 font-mono w-28 shrink-0">
      {formatTime(d.startTime)} - {formatTime(d.endTime)}
    </span>
    <span className={`text-[9px] px-1.5 py-0.5 rounded text-white font-bold uppercase shrink-0 ${typeBadgeColors[d.type] || 'bg-gray-600'}`}>
      {d.type}
    </span>
    <span className="text-xs text-gray-300 truncate">"{d.text}"</span>
    <span className="text-[9px] text-gray-600 ml-auto shrink-0">{(d.endTime - d.startTime).toFixed(2)}s</span>
  </label>
);

export default FillerConfirmModal;
