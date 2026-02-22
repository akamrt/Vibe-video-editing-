import React, { useMemo, useRef, useCallback } from 'react';
import { VibeCutTracker, TrackedFrame, TrackingMode } from '../types';

interface TrackerOverlayProps {
  trackers: VibeCutTracker[];
  trackingData?: TrackedFrame[];
  currentTime: number;
  segmentStartTime: number;
  segmentTimelineStart: number;
  videoWidth: number;
  videoHeight: number;
  viewportSize: { width: number; height: number };
  selectedTrackerId: string | null;
  trackingMode: TrackingMode;
  onTrackerClick: (id: string) => void;
  onTrackerDrag: (trackerId: string, newVideoX: number, newVideoY: number) => void;
  onPlaceTracker: (videoX: number, videoY: number) => void;
  zoom?: number;
}

const TrackerOverlay: React.FC<TrackerOverlayProps> = ({
  trackers,
  trackingData,
  currentTime,
  segmentStartTime,
  segmentTimelineStart,
  videoWidth,
  videoHeight,
  viewportSize,
  selectedTrackerId,
  trackingMode,
  onTrackerClick,
  onTrackerDrag,
  onPlaceTracker,
  zoom = 1,
}) => {
  const dragRef = useRef<{ id: string; startScreenX: number; startScreenY: number; startVideoX: number; startVideoY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Compute the actual video display rect (object-contain area)
  // This gives us where the video pixels actually appear on screen,
  // NOT the crop safe zone. This ensures scaleX === scaleY (square patches).
  const videoDisplayRect = useMemo(() => {
    if (viewportSize.width === 0 || viewportSize.height === 0 || videoWidth === 0 || videoHeight === 0) {
      return { x: 0, y: 0, width: viewportSize.width, height: viewportSize.height };
    }
    const videoAR = videoWidth / videoHeight;
    const containerAR = viewportSize.width / viewportSize.height;
    if (containerAR > videoAR) {
      // Pillarbox: video fits height, black bars on sides
      const h = viewportSize.height;
      const w = h * videoAR;
      return { x: (viewportSize.width - w) / 2, y: 0, width: w, height: h };
    } else {
      // Letterbox: video fits width, black bars top/bottom
      const w = viewportSize.width;
      const h = w / videoAR;
      return { x: 0, y: (viewportSize.height - h) / 2, width: w, height: h };
    }
  }, [viewportSize, videoWidth, videoHeight]);

  // Scale factors — these are EQUAL because object-contain preserves native AR
  const scaleX = videoDisplayRect.width / videoWidth;
  const scaleY = videoDisplayRect.height / videoHeight;

  // Video pixel → screen pixel
  const videoToScreen = useCallback((vx: number, vy: number) => ({
    sx: videoDisplayRect.x + (vx / videoWidth) * videoDisplayRect.width,
    sy: videoDisplayRect.y + (vy / videoHeight) * videoDisplayRect.height,
  }), [videoDisplayRect, videoWidth, videoHeight]);

  // Screen pixel → video pixel
  const screenToVideo = useCallback((sx: number, sy: number) => ({
    vx: ((sx - videoDisplayRect.x) / videoDisplayRect.width) * videoWidth,
    vy: ((sy - videoDisplayRect.y) / videoDisplayRect.height) * videoHeight,
  }), [videoDisplayRect, videoWidth, videoHeight]);

  // Get tracked position for a tracker at the current time
  const getTrackedPosition = useCallback((trackerId: string): { x: number; y: number; matchScore: number } | null => {
    if (!trackingData || trackingData.length === 0) return null;

    // Current time relative to the segment's position on the timeline
    const clipTime = currentTime - segmentTimelineStart;
    const absoluteTime = segmentStartTime + clipTime;

    // Find the two bounding frames for interpolation
    let before: TrackedFrame | null = null;
    let after: TrackedFrame | null = null;
    for (let i = 0; i < trackingData.length; i++) {
      if (trackingData[i].time <= absoluteTime) before = trackingData[i];
      if (trackingData[i].time >= absoluteTime && !after) after = trackingData[i];
      if (before && after) break;
    }

    if (!before && !after) return null;
    if (!before) before = after;
    if (!after) after = before;

    const beforeTracker = before!.trackers.find(t => t.id === trackerId);
    const afterTracker = after!.trackers.find(t => t.id === trackerId);
    if (!beforeTracker) return afterTracker || null;
    if (!afterTracker) return beforeTracker;

    // Interpolate between frames
    const dt = after!.time - before!.time;
    if (dt < 0.001) return beforeTracker;
    const t = (absoluteTime - before!.time) / dt;
    return {
      x: beforeTracker.x + (afterTracker.x - beforeTracker.x) * t,
      y: beforeTracker.y + (afterTracker.y - beforeTracker.y) * t,
      matchScore: beforeTracker.matchScore + (afterTracker.matchScore - beforeTracker.matchScore) * t,
    };
  }, [trackingData, currentTime, segmentStartTime, segmentTimelineStart]);

  // Click handler for placement
  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (trackingMode !== 'placing-stabilizer' && trackingMode !== 'placing-parent') return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Adjust for zoom — the SVG is inside a scaled container
    const sx = (e.clientX - rect.left) / zoom;
    const sy = (e.clientY - rect.top) / zoom;
    const { vx, vy } = screenToVideo(sx, sy);
    // Only place if within video bounds
    if (vx >= 0 && vx <= videoWidth && vy >= 0 && vy <= videoHeight) {
      onPlaceTracker(vx, vy);
    }
  }, [trackingMode, screenToVideo, videoWidth, videoHeight, onPlaceTracker, zoom]);

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent, tracker: VibeCutTracker) => {
    if (trackingMode === 'placing-stabilizer' || trackingMode === 'placing-parent' || trackingMode === 'tracking') return;
    e.stopPropagation();
    onTrackerClick(tracker.id);

    const tracked = getTrackedPosition(tracker.id);
    const pos = tracked || { x: tracker.x, y: tracker.y };

    dragRef.current = {
      id: tracker.id,
      startScreenX: e.clientX,
      startScreenY: e.clientY,
      startVideoX: pos.x,
      startVideoY: pos.y,
    };

    const handleMouseMove = (me: MouseEvent) => {
      if (!dragRef.current) return;
      // Adjust drag delta for zoom — screen pixels need to be divided by zoom*scale
      const dx = (me.clientX - dragRef.current.startScreenX) / (scaleX * zoom);
      const dy = (me.clientY - dragRef.current.startScreenY) / (scaleY * zoom);
      const newVx = Math.max(0, Math.min(videoWidth, dragRef.current.startVideoX + dx));
      const newVy = Math.max(0, Math.min(videoHeight, dragRef.current.startVideoY + dy));
      onTrackerDrag(dragRef.current.id, newVx, newVy);
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [trackingMode, onTrackerClick, getTrackedPosition, scaleX, scaleY, videoWidth, videoHeight, onTrackerDrag, zoom]);

  const isPlacing = trackingMode === 'placing-stabilizer' || trackingMode === 'placing-parent';

  return (
    <svg
      ref={svgRef}
      className="absolute inset-0 w-full h-full"
      style={{
        pointerEvents: isPlacing ? 'auto' : 'none',
        cursor: isPlacing ? 'crosshair' : 'default',
        zIndex: 15,
      }}
      onClick={handleClick}
    >
      {trackers.map(tracker => {
        // Use tracked position if available, otherwise initial position
        const tracked = getTrackedPosition(tracker.id);
        const pos = tracked || { x: tracker.x, y: tracker.y, matchScore: undefined };
        const { sx, sy } = videoToScreen(pos.x, pos.y);
        const isSelected = tracker.id === selectedTrackerId;
        const color = tracker.color;
        // scaleX === scaleY now, so patches are always square
        const patchScreen = tracker.patchSize * scaleX;
        const searchScreen = tracker.searchWindow * scaleX * 2;
        const crossSize = Math.max(8, patchScreen * 0.6);
        const matchScore = tracked?.matchScore ?? tracker.matchScore;

        return (
          <g key={tracker.id} style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
            {/* Search window (dashed) */}
            {isSelected && (
              <rect
                x={sx - searchScreen / 2}
                y={sy - searchScreen / 2}
                width={searchScreen}
                height={searchScreen}
                fill="none"
                stroke={color}
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.4}
              />
            )}

            {/* Patch box (solid, always square) */}
            <rect
              x={sx - patchScreen / 2}
              y={sy - patchScreen / 2}
              width={patchScreen}
              height={patchScreen}
              fill={isSelected ? `${color}15` : 'none'}
              stroke={color}
              strokeWidth={isSelected ? 2 : 1}
              opacity={tracker.isActive ? 0.8 : 0.3}
            />

            {/* Crosshair */}
            <line x1={sx - crossSize} y1={sy} x2={sx + crossSize} y2={sy} stroke={color} strokeWidth={isSelected ? 2 : 1} opacity={tracker.isActive ? 1 : 0.4} />
            <line x1={sx} y1={sy - crossSize} x2={sx} y2={sy + crossSize} stroke={color} strokeWidth={isSelected ? 2 : 1} opacity={tracker.isActive ? 1 : 0.4} />

            {/* Center dot */}
            <circle cx={sx} cy={sy} r={2} fill={color} opacity={tracker.isActive ? 1 : 0.5} />

            {/* ID label */}
            <text
              x={sx + patchScreen / 2 + 4}
              y={sy - patchScreen / 2 + 10}
              fill={color}
              fontSize={9}
              fontFamily="monospace"
              opacity={0.8}
            >
              {tracker.type === 'stabilizer' ? 'S' : 'P'}{trackers.indexOf(tracker) + 1}
            </text>

            {/* Match score badge */}
            {matchScore !== undefined && (
              <text
                x={sx + patchScreen / 2 + 4}
                y={sy - patchScreen / 2 + 20}
                fill={matchScore > 80 ? '#4ade80' : matchScore > 50 ? '#facc15' : '#f87171'}
                fontSize={8}
                fontFamily="monospace"
              >
                {Math.round(matchScore)}%
              </text>
            )}

            {/* Hit area (invisible, larger than visual for easier clicking) */}
            <rect
              x={sx - Math.max(patchScreen, 20) / 2}
              y={sy - Math.max(patchScreen, 20) / 2}
              width={Math.max(patchScreen, 20)}
              height={Math.max(patchScreen, 20)}
              fill="transparent"
              onMouseDown={(e) => handleMouseDown(e, tracker)}
            />
          </g>
        );
      })}
    </svg>
  );
};

export default TrackerOverlay;
