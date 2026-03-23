/**
 * TransformGizmo — SVG overlay for subtitle/title transform editing.
 *
 * Shows:
 *  - Dashed selection bounding box (rotated with element)
 *  - 4 corner scale handles
 *  - Rotation handle (circle above top-center, connected by line)
 *  - Pivot indicator (orange diamond, draggable anywhere in safe zone)
 *
 * All screen coordinates are in safe-zone pixel space (0,0 = top-left of safeZoneRef).
 * Pivot is stored/emitted in safe-zone % (0–100 for both axes).
 */
import React, { useCallback, useRef } from 'react';

export interface TransformGizmoProps {
  safeZoneRef: React.RefObject<HTMLDivElement | null>;
  elementRef: React.RefObject<HTMLDivElement | null>;
  // Current transform values
  translateX: number;   // safe-zone % (informational, not used for positioning here)
  translateY: number;   // safe-zone %
  scale: number;
  rotation: number;     // degrees
  // Pivot in safe-zone % — null means "element center" (default CSS behavior)
  pivotX: number | null;
  pivotY: number | null;
  // Callbacks — emit new values
  onTranslateChange: (tx: number, ty: number, commit: boolean) => void;
  onScaleChange: (scale: number, commit: boolean) => void;
  onRotationChange: (rotation: number, commit: boolean) => void;
  onPivotChange: (px: number, py: number) => void;
  visible: boolean;
}

const HANDLE_SIZE = 8;    // corner handle square half-size px
const ROTATE_OFFSET = 30; // px above element top-center for rotation handle

type DragType = 'translate' | 'scale' | 'rotate' | 'pivot';

interface DragState {
  type: DragType;
  startClientX: number;
  startClientY: number;
  startTx: number;
  startTy: number;
  startScale: number;
  startRotation: number;
  startDistFromPivot: number;
  startAngle: number;  // angle at drag start minus current rotation
}

export const TransformGizmo: React.FC<TransformGizmoProps> = ({
  safeZoneRef,
  elementRef,
  translateX,
  translateY,
  scale,
  rotation,
  pivotX,
  pivotY,
  onTranslateChange,
  onScaleChange,
  onRotationChange,
  onPivotChange,
  visible,
}) => {
  const dragState = useRef<DragState | null>(null);

  // ---- Coordinate helpers ----

  const getSafeZoneSize = useCallback((): { width: number; height: number } => {
    const el = safeZoneRef.current;
    if (!el) return { width: 1, height: 1 };
    return { width: el.clientWidth || 1, height: el.clientHeight || 1 };
  }, [safeZoneRef]);

  /** Element bounding rect in safe-zone pixel coordinates */
  const getElemRect = useCallback(() => {
    const safeEl = safeZoneRef.current;
    const elemEl = elementRef.current;
    if (!safeEl || !elemEl) return null;
    const sr = safeEl.getBoundingClientRect();
    const er = elemEl.getBoundingClientRect();
    return {
      left: er.left - sr.left,
      top: er.top - sr.top,
      width: er.width,
      height: er.height,
    };
  }, [safeZoneRef, elementRef]);

  /** Current pivot in safe-zone pixels */
  const getPivotPx = useCallback((): { x: number; y: number } => {
    const sz = getSafeZoneSize();
    if (pivotX !== null && pivotY !== null) {
      return { x: (pivotX / 100) * sz.width, y: (pivotY / 100) * sz.height };
    }
    // Default: element center
    const rect = getElemRect();
    if (rect) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return { x: sz.width / 2, y: sz.height * 0.85 };
  }, [pivotX, pivotY, getSafeZoneSize, getElemRect]);

  // ---- Drag handlers ----

  const startDrag = useCallback((
    e: React.PointerEvent,
    type: DragType,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    const pivot = getPivotPx();
    const dx = e.clientX - pivot.x;
    const dy = e.clientY - pivot.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    dragState.current = {
      type,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: translateX,
      startTy: translateY,
      startScale: scale,
      startRotation: rotation,
      startDistFromPivot: dist,
      startAngle: angle - rotation,
    };
  }, [getPivotPx, translateX, translateY, scale, rotation]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds) return;
    e.preventDefault();

    const sz = getSafeZoneSize();

    if (ds.type === 'translate') {
      const dx = (e.clientX - ds.startClientX) / sz.width * 100;
      const dy = (e.clientY - ds.startClientY) / sz.height * 100;
      onTranslateChange(ds.startTx + dx, ds.startTy + dy, false);

    } else if (ds.type === 'rotate') {
      const pivot = getPivotPx();
      const dx = e.clientX - pivot.x;
      const dy = e.clientY - pivot.y;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      onRotationChange(angle - ds.startAngle, false);

    } else if (ds.type === 'scale') {
      const pivot = getPivotPx();
      const dx = e.clientX - pivot.x;
      const dy = e.clientY - pivot.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (ds.startDistFromPivot > 2) {
        onScaleChange(Math.max(0.05, ds.startScale * (dist / ds.startDistFromPivot)), false);
      }

    } else if (ds.type === 'pivot') {
      const safeEl = safeZoneRef.current;
      if (!safeEl) return;
      const sr = safeEl.getBoundingClientRect();
      const px = ((e.clientX - sr.left) / sr.width) * 100;
      const py = ((e.clientY - sr.top) / sr.height) * 100;
      // Allow pivot outside element bounds but clamp to reasonable range
      onPivotChange(
        Math.max(-50, Math.min(150, px)),
        Math.max(-50, Math.min(150, py)),
      );
    }
  }, [getSafeZoneSize, getPivotPx, onTranslateChange, onRotationChange, onScaleChange, onPivotChange, safeZoneRef]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const ds = dragState.current;
    if (!ds) return;
    dragState.current = null;

    const sz = getSafeZoneSize();

    if (ds.type === 'translate') {
      const dx = (e.clientX - ds.startClientX) / sz.width * 100;
      const dy = (e.clientY - ds.startClientY) / sz.height * 100;
      onTranslateChange(ds.startTx + dx, ds.startTy + dy, true);
    } else if (ds.type === 'rotate') {
      const pivot = getPivotPx();
      const dx = e.clientX - pivot.x;
      const dy = e.clientY - pivot.y;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      onRotationChange(angle - ds.startAngle, true);
    } else if (ds.type === 'scale') {
      const pivot = getPivotPx();
      const dx = e.clientX - pivot.x;
      const dy = e.clientY - pivot.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (ds.startDistFromPivot > 2) {
        onScaleChange(Math.max(0.05, ds.startScale * (dist / ds.startDistFromPivot)), true);
      }
    }
  }, [getSafeZoneSize, getPivotPx, onTranslateChange, onRotationChange, onScaleChange]);

  if (!visible) return null;

  const rect = getElemRect();
  if (!rect) return null;

  const sz = getSafeZoneSize();
  const pivotPx = getPivotPx();
  const rotRad = (rotation * Math.PI) / 180;

  // Rotate a point around the pivot
  const rotateAround = (x: number, y: number) => {
    const dx = x - pivotPx.x;
    const dy = y - pivotPx.y;
    return {
      x: pivotPx.x + dx * Math.cos(rotRad) - dy * Math.sin(rotRad),
      y: pivotPx.y + dx * Math.sin(rotRad) + dy * Math.cos(rotRad),
    };
  };

  // Element center (unrotated)
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // Rotation handle: above top-center of element, then rotated
  const topCenter = rotateAround(cx, rect.top - ROTATE_OFFSET);
  const topCenterOnBox = rotateAround(cx, rect.top);

  // Corners rotated around pivot
  const corners = [
    rotateAround(rect.left, rect.top),
    rotateAround(rect.left + rect.width, rect.top),
    rotateAround(rect.left + rect.width, rect.top + rect.height),
    rotateAround(rect.left, rect.top + rect.height),
  ];

  const cornerPath = corners.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') + ' Z';

  // Pivot diamond
  const { x: px, y: py } = pivotPx;
  const D = 7;
  const diamondPath = `M${px},${(py - D).toFixed(1)} L${(px + D).toFixed(1)},${py} L${px},${(py + D).toFixed(1)} L${(px - D).toFixed(1)},${py} Z`;

  return (
    <svg
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: sz.width,
        height: sz.height,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <defs>
        <filter id="gizmo-dropshadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="1.5" floodColor="#000" floodOpacity="0.8" />
        </filter>
      </defs>

      {/* ── Bounding box (dashed, rotated) ── */}
      <path
        d={cornerPath}
        fill="none"
        stroke="#00d4ff"
        strokeWidth={1.5}
        strokeDasharray="5 3"
        opacity={0.9}
      />

      {/* Invisible fill for move dragging */}
      <path
        d={cornerPath}
        fill="transparent"
        style={{ pointerEvents: 'auto', cursor: 'move' }}
        onPointerDown={(e) => startDrag(e, 'translate')}
      />

      {/* ── Rotation line: from box top-center to rotation handle ── */}
      <line
        x1={topCenterOnBox.x.toFixed(1)}
        y1={topCenterOnBox.y.toFixed(1)}
        x2={topCenter.x.toFixed(1)}
        y2={topCenter.y.toFixed(1)}
        stroke="#00d4ff"
        strokeWidth={1}
        opacity={0.5}
      />

      {/* ── Rotation handle ── */}
      <circle
        cx={topCenter.x}
        cy={topCenter.y}
        r={9}
        fill="#111827"
        stroke="#00d4ff"
        strokeWidth={1.5}
        filter="url(#gizmo-dropshadow)"
        style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
        onPointerDown={(e) => startDrag(e, 'rotate')}
      />
      {/* Rotation arc icon */}
      <path
        d={`M${(topCenter.x - 4).toFixed(1)},${(topCenter.y + 2).toFixed(1)} A5,5 0 1,1 ${(topCenter.x + 4).toFixed(1)},${(topCenter.y + 2).toFixed(1)}`}
        fill="none"
        stroke="#00d4ff"
        strokeWidth={1.5}
        strokeLinecap="round"
        style={{ pointerEvents: 'none' }}
      />
      <polygon
        points={`${(topCenter.x + 4).toFixed(1)},${(topCenter.y - 1).toFixed(1)} ${(topCenter.x + 4).toFixed(1)},${(topCenter.y + 4).toFixed(1)} ${(topCenter.x + 8).toFixed(1)},${(topCenter.y + 2).toFixed(1)}`}
        fill="#00d4ff"
        style={{ pointerEvents: 'none' }}
      />

      {/* ── Corner scale handles ── */}
      {corners.map((c, i) => (
        <rect
          key={i}
          x={c.x - HANDLE_SIZE / 2}
          y={c.y - HANDLE_SIZE / 2}
          width={HANDLE_SIZE}
          height={HANDLE_SIZE}
          rx={1}
          fill="#111827"
          stroke="#00d4ff"
          strokeWidth={1.5}
          filter="url(#gizmo-dropshadow)"
          style={{ pointerEvents: 'auto', cursor: 'nwse-resize' }}
          onPointerDown={(e) => startDrag(e, 'scale')}
        />
      ))}

      {/* ── Pivot indicator (orange diamond) ── */}
      {/* Cross-hair lines */}
      <line x1={px - 14} y1={py} x2={px + 14} y2={py} stroke="#ff9500" strokeWidth={1} opacity={0.6} />
      <line x1={px} y1={py - 14} x2={px} y2={py + 14} stroke="#ff9500" strokeWidth={1} opacity={0.6} />
      {/* Diamond */}
      <path
        d={diamondPath}
        fill="#111827"
        stroke="#ff9500"
        strokeWidth={1.5}
        filter="url(#gizmo-dropshadow)"
        style={{ pointerEvents: 'auto', cursor: 'grab' }}
        onPointerDown={(e) => startDrag(e, 'pivot')}
      />
      {/* Dot at center */}
      <circle cx={px} cy={py} r={2} fill="#ff9500" style={{ pointerEvents: 'none' }} />

      {/* ── Info labels ── */}
      {scale !== 1 && (
        <text
          x={corners[1].x + 8}
          y={corners[1].y - 2}
          fontSize={9}
          fill="#00d4ff"
          filter="url(#gizmo-dropshadow)"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {(scale * 100).toFixed(0)}%
        </text>
      )}
      {Math.abs(rotation) > 0.3 && (
        <text
          x={topCenter.x + 13}
          y={topCenter.y + 4}
          fontSize={9}
          fill="#00d4ff"
          filter="url(#gizmo-dropshadow)"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {rotation.toFixed(1)}°
        </text>
      )}
      {/* Pivot % coords label */}
      {(pivotX !== null && pivotY !== null) && (
        <text
          x={px + 10}
          y={py - 10}
          fontSize={8}
          fill="#ff9500"
          opacity={0.8}
          filter="url(#gizmo-dropshadow)"
          style={{ pointerEvents: 'none', userSelect: 'none' }}
        >
          {pivotX.toFixed(0)},{pivotY.toFixed(0)}
        </text>
      )}
    </svg>
  );
};

export default TransformGizmo;
