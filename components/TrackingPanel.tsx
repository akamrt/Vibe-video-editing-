import React, { useState } from 'react';
import { Segment, VibeCutTracker, TrackingMode } from '../types';

const TRACKER_COLORS = ['#00ff00', '#00ffff', '#ff00ff', '#ffff00', '#ff9900', '#adff2f', '#00bfff'];

interface TrackingPanelProps {
  selectedSegment: Segment | null;
  trackingMode: TrackingMode;
  onSetTrackingMode: (mode: TrackingMode) => void;
  selectedTrackerId: string | null;
  onSelectTracker: (id: string | null) => void;
  onUpdateTracker: (segmentId: string, trackerId: string, updates: Partial<VibeCutTracker>) => void;
  onDeleteTracker: (segmentId: string, trackerId: string) => void;
  onStartTracking: (segmentId: string) => void;
  onStopTracking: () => void;
  onApplyStabilization: (segmentId: string, channels?: Set<string>) => void;
  onApplyToSegment: (segmentId: string, trackerId: string, channels?: Set<string>) => void;
  onApplyToTitle: (segmentId: string, trackerId: string, channels?: Set<string>) => void;
  onClearTracking: (segmentId: string) => void;
  onClearTrackingData: (segmentId: string) => void;
  trackingProgress: { progress: number; label: string } | null;
  // Head pivot tracking
  onTrackHeadPivot: (segmentId: string, applyToAll: boolean) => void;
  pivotTrackingProgress: { progress: number; label: string } | null;
}

export const TrackingPanel: React.FC<TrackingPanelProps> = ({
  selectedSegment,
  trackingMode,
  onSetTrackingMode,
  selectedTrackerId,
  onSelectTracker,
  onUpdateTracker,
  onDeleteTracker,
  onStartTracking,
  onStopTracking,
  onApplyStabilization,
  onApplyToSegment,
  onApplyToTitle,
  onClearTracking,
  onClearTrackingData,
  trackingProgress,
  onTrackHeadPivot,
  pivotTrackingProgress,
}) => {
  const trackers = selectedSegment?.trackers || [];
  const hasTrackingData = (selectedSegment?.trackingData?.length || 0) > 0;
  const selectedTracker = trackers.find(t => t.id === selectedTrackerId);
  const hasStabilizers = trackers.some(t => t.type === 'stabilizer');
  const hasParents = trackers.some(t => t.type === 'parent');
  const [bakeChannels, setBakeChannels] = useState<Set<string>>(new Set(['translateX', 'translateY']));

  const toggleBakeChannel = (ch: string) => {
    const next = new Set(bakeChannels);
    if (next.has(ch)) next.delete(ch); else next.add(ch);
    setBakeChannels(next);
  };

  if (!selectedSegment) {
    return (
      <div className="p-4 text-center text-gray-500 text-sm">
        <div className="text-2xl mb-2">+</div>
        Select a clip on the timeline to begin tracking.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full text-xs overflow-y-auto">
      {/* Placement Buttons */}
      <div className="p-3 border-b border-[#333] flex gap-2">
        <button
          onClick={() => onSetTrackingMode(trackingMode === 'placing-stabilizer' ? 'idle' : 'placing-stabilizer')}
          className={`flex-1 py-1.5 rounded text-xs font-medium border transition-colors ${
            trackingMode === 'placing-stabilizer'
              ? 'bg-green-600/30 text-green-400 border-green-500'
              : 'bg-[#2a2a2a] text-gray-300 border-[#444] hover:border-green-500/50'
          }`}
        >
          + Stabilizer
        </button>
        <button
          onClick={() => onSetTrackingMode(trackingMode === 'placing-parent' ? 'idle' : 'placing-parent')}
          className={`flex-1 py-1.5 rounded text-xs font-medium border transition-colors ${
            trackingMode === 'placing-parent'
              ? 'bg-purple-600/30 text-purple-400 border-purple-500'
              : 'bg-[#2a2a2a] text-gray-300 border-[#444] hover:border-purple-500/50'
          }`}
        >
          + Parent / Null
        </button>
      </div>

      {/* Placement hint */}
      {(trackingMode === 'placing-stabilizer' || trackingMode === 'placing-parent') && (
        <div className="px-3 py-2 bg-blue-600/10 border-b border-blue-600/30 text-blue-300 text-[10px]">
          Click on the video to place a {trackingMode === 'placing-stabilizer' ? 'stabilizer' : 'parent'} tracker. Press Escape to cancel.
        </div>
      )}

      {/* Tracker List */}
      <div className="p-3 border-b border-[#333]">
        <label className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 block">Trackers ({trackers.length})</label>
        {trackers.length === 0 ? (
          <div className="text-gray-600 text-[10px] py-2">No trackers placed. Use the buttons above to add trackers.</div>
        ) : (
          <div className="space-y-1">
            {trackers.map(tracker => (
              <div
                key={tracker.id}
                onClick={() => onSelectTracker(tracker.id === selectedTrackerId ? null : tracker.id)}
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                  tracker.id === selectedTrackerId
                    ? 'bg-[#333] border border-[#555]'
                    : 'hover:bg-[#2a2a2a] border border-transparent'
                }`}
              >
                {/* Color dot */}
                <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tracker.color }} />

                {/* Name & type */}
                <div className="flex-1 min-w-0">
                  <span className="text-gray-200 truncate block">{tracker.id.split('_').slice(0, 2).join('_')}</span>
                </div>

                {/* Type badge */}
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                  tracker.type === 'stabilizer'
                    ? 'bg-green-600/20 text-green-400'
                    : 'bg-purple-600/20 text-purple-400'
                }`}>
                  {tracker.type === 'stabilizer' ? 'STAB' : 'NULL'}
                </span>

                {/* Match score (if tracked) */}
                {tracker.matchScore !== undefined && (
                  <span className={`text-[9px] font-mono ${
                    tracker.matchScore > 80 ? 'text-green-400' : tracker.matchScore > 50 ? 'text-yellow-400' : 'text-red-400'
                  }`}>
                    {Math.round(tracker.matchScore)}%
                  </span>
                )}

                {/* Active toggle */}
                <button
                  onClick={(e) => { e.stopPropagation(); onUpdateTracker(selectedSegment.id, tracker.id, { isActive: !tracker.isActive }); }}
                  className={`text-sm ${tracker.isActive ? 'text-gray-300' : 'text-gray-600'}`}
                  title={tracker.isActive ? 'Active' : 'Inactive'}
                >
                  {tracker.isActive ? '\u25C9' : '\u25CB'}
                </button>

                {/* Delete */}
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteTracker(selectedSegment.id, tracker.id); }}
                  className="text-gray-500 hover:text-red-400 text-sm"
                  title="Delete tracker"
                >
                  \u2715
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Selected Tracker Settings */}
      {selectedTracker && (
        <div className="p-3 border-b border-[#333] space-y-3">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block">Tracker Settings</label>

          <div>
            <div className="flex justify-between text-gray-400 mb-1">
              <span>Patch Size</span>
              <span className="font-mono">{selectedTracker.patchSize}px</span>
            </div>
            <input
              type="range" min={16} max={128} step={8}
              value={selectedTracker.patchSize}
              onChange={e => onUpdateTracker(selectedSegment.id, selectedTracker.id, { patchSize: Number(e.target.value) })}
              className="w-full h-1 accent-green-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-gray-400 mb-1">
              <span>Search Window</span>
              <span className="font-mono">{selectedTracker.searchWindow}px</span>
            </div>
            <input
              type="range" min={20} max={200} step={10}
              value={selectedTracker.searchWindow}
              onChange={e => onUpdateTracker(selectedSegment.id, selectedTracker.id, { searchWindow: Number(e.target.value) })}
              className="w-full h-1 accent-green-500"
            />
          </div>

          <div>
            <div className="flex justify-between text-gray-400 mb-1">
              <span>Sensitivity</span>
              <span className="font-mono">{selectedTracker.sensitivity}%</span>
            </div>
            <input
              type="range" min={0} max={100} step={5}
              value={selectedTracker.sensitivity}
              onChange={e => onUpdateTracker(selectedSegment.id, selectedTracker.id, { sensitivity: Number(e.target.value) })}
              className="w-full h-1 accent-green-500"
            />
          </div>
        </div>
      )}

      {/* Tracking Controls */}
      {trackers.length > 0 && (
        <div className="p-3 border-b border-[#333] space-y-2">
          <button
            onClick={() => trackingMode === 'tracking' ? onStopTracking() : onStartTracking(selectedSegment.id)}
            disabled={trackingMode !== 'tracking' && trackers.filter(t => t.isActive).length === 0}
            className={`w-full py-2 border rounded text-xs font-medium disabled:opacity-50 flex items-center justify-center gap-2 ${
              trackingMode === 'tracking'
                ? 'bg-red-600/20 text-red-400 border-red-600/50 hover:bg-red-600/30'
                : 'bg-green-600/20 text-green-400 border-green-600/50 hover:bg-green-600/30'
            }`}
          >
            {trackingMode === 'tracking' ? 'Stop Tracking' : hasTrackingData ? `Continue (${trackers.filter(t => t.isActive).length} active)` : `Track All (${trackers.filter(t => t.isActive).length} active)`}
          </button>

          {trackingProgress && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-gray-400">
                <span>{trackingProgress.label}</span>
                <span>{Math.round(trackingProgress.progress * 100)}%</span>
              </div>
              <div className="h-1 bg-[#333] rounded-full overflow-hidden">
                <div
                  style={{ width: `${trackingProgress.progress * 100}%` }}
                  className="h-full bg-green-500 transition-all duration-300"
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Head Pivot Tracking */}
      <div className="p-3 border-b border-[#333] space-y-2">
        <label className="text-[10px] text-gray-500 uppercase tracking-wider block">Head Pivot</label>
        <p className="text-[10px] text-gray-400 leading-tight">
          Tracks the person's head using MediaPipe and bakes pivot keyframes so that rotations &amp; scales happen around their face.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => selectedSegment && onTrackHeadPivot(selectedSegment.id, false)}
            disabled={pivotTrackingProgress !== null || !selectedSegment}
            className="flex-1 py-1.5 bg-orange-600/20 text-orange-400 border border-orange-600/50 rounded hover:bg-orange-600/30 text-xs font-medium disabled:opacity-50"
          >
            This Clip
          </button>
          <button
            onClick={() => selectedSegment && onTrackHeadPivot(selectedSegment.id, true)}
            disabled={pivotTrackingProgress !== null || !selectedSegment}
            className="flex-1 py-1.5 bg-orange-600/10 text-orange-300 border border-orange-600/30 rounded hover:bg-orange-600/20 text-xs font-medium disabled:opacity-50"
          >
            All Selected
          </button>
        </div>
        {pivotTrackingProgress && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-gray-400">
              <span>{pivotTrackingProgress.label}</span>
              <span>{Math.round(pivotTrackingProgress.progress * 100)}%</span>
            </div>
            <div className="h-1 bg-[#333] rounded-full overflow-hidden">
              <div
                style={{ width: `${pivotTrackingProgress.progress * 100}%` }}
                className="h-full bg-orange-500 transition-all duration-300"
              />
            </div>
          </div>
        )}
      </div>

      {/* Results / Apply Actions */}
      {hasTrackingData && (
        <div className="p-3 space-y-2">
          <label className="text-[10px] text-gray-500 uppercase tracking-wider block">Apply Results</label>

          {/* Bake channel filter */}
          <div className="flex gap-1 flex-wrap">
            {([
              ['translateX', 'X Pos', '#ff4444'],
              ['translateY', 'Y Pos', '#44ff44'],
              ['scale', 'Scale', '#3b82f6'],
              ['rotation', 'Rot', '#f97316'],
            ] as [string, string, string][]).map(([ch, label, color]) => (
              <button
                key={ch}
                onClick={() => toggleBakeChannel(ch)}
                className="px-2 py-0.5 rounded text-[10px] font-medium border transition-colors"
                style={{
                  backgroundColor: bakeChannels.has(ch) ? color + '30' : 'transparent',
                  color: bakeChannels.has(ch) ? color : '#666',
                  borderColor: bakeChannels.has(ch) ? color + '60' : '#444',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {hasStabilizers && (
            <button
              onClick={() => onApplyStabilization(selectedSegment.id, bakeChannels)}
              disabled={bakeChannels.size === 0}
              className="w-full py-1.5 bg-blue-600/20 text-blue-400 border border-blue-600/50 rounded hover:bg-blue-600/30 text-xs font-medium disabled:opacity-50"
            >
              Apply Stabilization
            </button>
          )}

          {hasParents && selectedTracker?.type === 'parent' && (
            <>
              <button
                onClick={() => onApplyToSegment(selectedSegment.id, selectedTracker.id, bakeChannels)}
                disabled={bakeChannels.size === 0}
                className="w-full py-1.5 bg-purple-600/20 text-purple-400 border border-purple-600/50 rounded hover:bg-purple-600/30 text-xs font-medium disabled:opacity-50"
              >
                Apply to Segment
              </button>
              <button
                onClick={() => onApplyToTitle(selectedSegment.id, selectedTracker.id, bakeChannels)}
                disabled={bakeChannels.size === 0}
                className="w-full py-1.5 bg-purple-600/20 text-purple-400 border border-purple-600/50 rounded hover:bg-purple-600/30 text-xs font-medium disabled:opacity-50"
              >
                Apply to Title
              </button>
            </>
          )}

          <button
            onClick={() => onClearTrackingData(selectedSegment.id)}
            className="w-full py-1.5 bg-yellow-600/10 text-yellow-400 border border-yellow-600/30 rounded hover:bg-yellow-600/20 text-xs font-medium mt-3"
          >
            Clear Tracking Data
          </button>
          <button
            onClick={() => onClearTracking(selectedSegment.id)}
            className="w-full py-1.5 bg-red-600/10 text-red-400 border border-red-600/30 rounded hover:bg-red-600/20 text-xs font-medium"
          >
            Clear All Trackers
          </button>
        </div>
      )}
    </div>
  );
};

export default TrackingPanel;
