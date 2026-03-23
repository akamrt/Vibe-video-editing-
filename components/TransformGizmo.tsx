/**
 * TransformGizmo — SVG overlay for subtitle/title transform editing.
 *
 * Each interactive handle uses setPointerCapture so that pointermove/pointerup
 * are always delivered to the capturing element, even when the pointer moves
 * over video elements (which would otherwise steal or cancel the drag).
 */
import React, { useCallback, useRef } from 'react';

export interface TransformGizmoProps {
  safeZoneRef: React.RefObject<HTMLDivElement | null>;
  elementRef: React.RefObject<HTMLDivElement | null>;
  translateX: number;
  translateY: number;
  scale: number;
  rotation: number;     // degrees
  pivotX: number | null;  // safe-zone % or null = element center
  pivotY: number | null;
  onTranslateChange: (tx: number, ty: number, commit: boolean) => void;
  onScaleChange: (scale: number, commit: boolean) => void;
  onRotationChange: (rotation: number, commit: boolean) => void;
  onPivotChange: (px: number, py: number) => void;
  visible: boolean;
}

const HANDLE_SIZE = 10;
const ROTATE_OFFSET = 32;

type DragType = 'translate' | 'scale' | 'rotate' | 'pivot';

interface DragState {
  type: DragType;
  startClientX: number;
  startClientY: number;
  startTx: number;
  startTy: number;
  startScale: number;
  startDistFromPivot: number;
  startAngle: number;
  // pivot in CLIENT (viewport) coords for correct distance/angle math
  pivotClient: { x: number; y: number };
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
  const drag = useRef<DragState | null>(null);

  // ── Coordinate helpers ──────────────────────────────────────────────────────

  const getSafeZoneRect = useCallback(() =>
    safeZoneRef.current?.getBoundingClientRect() ?? null
  , [safeZoneRef]);

  /** Pivot in SAFE-ZONE-RELATIVE px — used for SVG rendering */
  const getPivotSZ = useCallback((): { x: number; y: number } => {
    const sz = safeZoneRef.current;
    if (!sz) return { x: 0, y: 0 };
    const w = sz.clientWidth;
    const h = sz.clientHeight;
    if (pivotX !== null && pivotY !== null) {
      return { x: (pivotX / 100) * w, y: (pivotY / 100) * h };
    }
    const el = elementRef.current;
    if (el) {
      const sr = sz.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return { x: er.left - sr.left + er.width / 2, y: er.top - sr.top + er.height / 2 };
    }
    return { x: w / 2, y: h * 0.85 };
  }, [pivotX, pivotY, safeZoneRef, elementRef]);

  /** Pivot in CLIENT (viewport) px — used for drag math against e.clientX/Y */
  const getPivotClient = useCallback((): { x: number; y: number } => {
    const sr = safeZoneRef.current?.getBoundingClientRect();
    const pSZ = getPivotSZ();
    return sr ? { x: sr.left + pSZ.x, y: sr.top + pSZ.y } : pSZ;
  }, [safeZoneRef, getPivotSZ]);

  // ── Shared drag helpers ─────────────────────────────────────────────────────

  const beginDrag = useCallback((e: React.PointerEvent, type: DragType) => {
    e.stopPropagation();
    e.preventDefault();
    // Capture so pointermove/up always reach this element
    (e.currentTarget as Element).setPointerCapture(e.pointerId);

    const pc = getPivotClient();
    const dx = e.clientX - pc.x;
    const dy = e.clientY - pc.y;

    drag.current = {
      type,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: translateX,
      startTy: translateY,
      startScale: scale,
      startDistFromPivot: Math.sqrt(dx * dx + dy * dy),
      startAngle: Math.atan2(dy, dx) * 180 / Math.PI - rotation,
      pivotClient: pc,
    };
  }, [getPivotClient, translateX, translateY, scale, rotation]);

  const moveDrag = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.preventDefault();

    const sr = safeZoneRef.current;
    if (!sr) return;
    const szW = sr.clientWidth || 1;
    const szH = sr.clientHeight || 1;

    if (d.type === 'translate') {
      const ddx = (e.clientX - d.startClientX) / szW * 100;
      const ddy = (e.clientY - d.startClientY) / szH * 100;
      onTranslateChange(d.startTx + ddx, d.startTy + ddy, false);

    } else if (d.type === 'rotate') {
      const dx = e.clientX - d.pivotClient.x;
      const dy = e.clientY - d.pivotClient.y;
      onRotationChange(Math.atan2(dy, dx) * 180 / Math.PI - d.startAngle, false);

    } else if (d.type === 'scale') {
      const dx = e.clientX - d.pivotClient.x;
      const dy = e.clientY - d.pivotClient.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (d.startDistFromPivot > 2) {
        onScaleChange(Math.max(0.05, d.startScale * dist / d.startDistFromPivot), false);
      }

    } else if (d.type === 'pivot') {
      const srBcr = sr.getBoundingClientRect();
      onPivotChange(
        Math.max(-50, Math.min(150, (e.clientX - srBcr.left) / srBcr.width * 100)),
        Math.max(-50, Math.min(150, (e.clientY - srBcr.top) / srBcr.height * 100)),
      );
    }
  }, [safeZoneRef, onTranslateChange, onRotationChange, onScaleChange, onPivotChange]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    drag.current = null;

    const sr = safeZoneRef.current;
    if (!sr) return;
    const szW = sr.clientWidth || 1;
    const szH = sr.clientHeight || 1;

    if (d.type === 'translate') {
      const ddx = (e.clientX - d.startClientX) / szW * 100;
      const ddy = (e.clientY - d.startClientY) / szH * 100;
      onTranslateChange(d.startTx + ddx, d.startTy + ddy, true);

    } else if (d.type === 'rotate') {
      const dx = e.clientX - d.pivotClient.x;
      const dy = e.clientY - d.pivotClient.y;
      onRotationChange(Math.atan2(dy, dx) * 180 / Math.PI - d.startAngle, true);

    } else if (d.type === 'scale') {
      const dx = e.clientX - d.pivotClient.x;
      const dy = e.clientY - d.pivotClient.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (d.startDistFromPivot > 2) {
        onScaleChange(Math.max(0.05, d.startScale * dist / d.startDistFromPivot), true);
      }
    }
  }, [safeZoneRef, onTranslateChange, onRotationChange, onScaleChange]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!visible) return null;

  const safeEl = safeZoneRef.current;
  const elemEl = elementRef.current;
  if (!safeEl || !elemEl) return null;

  const szW = safeEl.clientWidth;
  const szH = safeEl.clientHeight;
  const sr = safeEl.getBoundingClientRect();
  const er = elemEl.getBoundingClientRect();

  // Element rect in safe-zone-relative coords
  const rect = {
    left: er.left - sr.left,
    top: er.top - sr.top,
    width: er.width,
    height: er.height,
  };

  const { x: px, y: py } = getPivotSZ();
  const rotRad = rotation * Math.PI / 180;

  const rot = (x: number, y: number) => {
    const dx = x - px, dy = y - py;
    return {
      x: px + dx * Math.cos(rotRad) - dy * Math.sin(rotRad),
      y: py + dx * Math.sin(rotRad) + dy * Math.cos(rotRad),
    };
  };

  const cx = rect.left + rect.width / 2;
  const corners = [
    rot(rect.left,              rect.top),
    rot(rect.left + rect.width, rect.top),
    rot(rect.left + rect.width, rect.top + rect.height),
    rot(rect.left,              rect.top + rect.height),
  ];
  const boxPath = corners.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') + ' Z';

  const rotHandle = rot(cx, rect.top - ROTATE_OFFSET);
  const rotHandleBase = rot(cx, rect.top);

  const D = 7;
  const pivotPath = `M${px},${(py-D).toFixed(1)} L${(px+D).toFixed(1)},${py} L${px},${(py+D).toFixed(1)} L${(px-D).toFixed(1)},${py} Z`;

  const dragProps = (type: DragType, cursor: string) => ({
    style: { pointerEvents: 'auto' as const, cursor },
    onPointerDown: (e: React.PointerEvent) => beginDrag(e, type),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: (e: React.PointerEvent) => {
      drag.current = null;
      try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {}
    },
  });

  return (
    <svg
      style={{
        position: 'absolute', left: 0, top: 0,
        width: szW, height: szH,
        overflow: 'visible', pointerEvents: 'none', zIndex: 9999,
      }}
    >
      <defs>
        <filter id="gz-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#000" floodOpacity="0.9" />
        </filter>
      </defs>

      {/* Bounding box */}
      <path d={boxPath} fill="none" stroke="#00d4ff" strokeWidth={1.5} strokeDasharray="5 3" opacity={0.9} />

      {/* Move zone (filled box) */}
      <path d={boxPath} fill="rgba(0,212,255,0.04)" {...dragProps('translate', 'move')} />

      {/* Rotation stem */}
      <line x1={rotHandleBase.x.toFixed(1)} y1={rotHandleBase.y.toFixed(1)}
            x2={rotHandle.x.toFixed(1)} y2={rotHandle.y.toFixed(1)}
            stroke="#00d4ff" strokeWidth={1} opacity={0.5} style={{ pointerEvents: 'none' }} />

      {/* Rotation handle — large hit area (r=14 transparent, r=9 visible) */}
      <circle cx={rotHandle.x} cy={rotHandle.y} r={14}
        fill="transparent" {...dragProps('rotate', 'crosshair')} />
      <circle cx={rotHandle.x} cy={rotHandle.y} r={9}
        fill="#111827" stroke="#00d4ff" strokeWidth={2} filter="url(#gz-shadow)"
        style={{ pointerEvents: 'none' }} />
      {/* Arc icon */}
      <path d={`M${(rotHandle.x-4).toFixed(1)},${(rotHandle.y+2).toFixed(1)} A5,5 0 1,1 ${(rotHandle.x+4).toFixed(1)},${(rotHandle.y+2).toFixed(1)}`}
        fill="none" stroke="#00d4ff" strokeWidth={1.5} strokeLinecap="round" style={{ pointerEvents: 'none' }} />
      <polygon
        points={`${(rotHandle.x+4).toFixed(1)},${(rotHandle.y-1).toFixed(1)} ${(rotHandle.x+4).toFixed(1)},${(rotHandle.y+4).toFixed(1)} ${(rotHandle.x+8).toFixed(1)},${(rotHandle.y+2).toFixed(1)}`}
        fill="#00d4ff" style={{ pointerEvents: 'none' }} />

      {/* Corner scale handles — large transparent hit area + small visible square */}
      {corners.map((c, i) => (
        <g key={i}>
          <rect x={c.x - 14} y={c.y - 14} width={28} height={28}
            fill="transparent" {...dragProps('scale', 'nwse-resize')} />
          <rect x={c.x - HANDLE_SIZE/2} y={c.y - HANDLE_SIZE/2}
            width={HANDLE_SIZE} height={HANDLE_SIZE} rx={1}
            fill="#111827" stroke="#00d4ff" strokeWidth={2} filter="url(#gz-shadow)"
            style={{ pointerEvents: 'none' }} />
        </g>
      ))}

      {/* Pivot crosshair */}
      <line x1={px-16} y1={py} x2={px+16} y2={py} stroke="#ff9500" strokeWidth={1} opacity={0.7} style={{ pointerEvents: 'none' }} />
      <line x1={px} y1={py-16} x2={px} y2={py+16} stroke="#ff9500" strokeWidth={1} opacity={0.7} style={{ pointerEvents: 'none' }} />

      {/* Pivot diamond (large hit area + small visual) */}
      <circle cx={px} cy={py} r={16} fill="transparent" {...dragProps('pivot', 'grab')} />
      <path d={pivotPath} fill="#111827" stroke="#ff9500" strokeWidth={2} filter="url(#gz-shadow)"
        style={{ pointerEvents: 'none' }} />
      <circle cx={px} cy={py} r={2.5} fill="#ff9500" style={{ pointerEvents: 'none' }} />

      {/* Info labels */}
      {scale !== 1 && (
        <text x={corners[1].x + 10} y={corners[1].y - 4} fontSize={10} fill="#00d4ff"
          filter="url(#gz-shadow)" style={{ pointerEvents: 'none', userSelect: 'none' }}>
          {(scale * 100).toFixed(0)}%
        </text>
      )}
      {Math.abs(rotation) > 0.3 && (
        <text x={rotHandle.x + 14} y={rotHandle.y + 4} fontSize={10} fill="#00d4ff"
          filter="url(#gz-shadow)" style={{ pointerEvents: 'none', userSelect: 'none' }}>
          {rotation.toFixed(1)}°
        </text>
      )}
      {pivotX !== null && pivotY !== null && (
        <text x={px + 12} y={py - 12} fontSize={8} fill="#ff9500" opacity={0.8}
          filter="url(#gz-shadow)" style={{ pointerEvents: 'none', userSelect: 'none' }}>
          {pivotX.toFixed(0)},{pivotY.toFixed(0)}
        </text>
      )}
    </svg>
  );
};

export default TransformGizmo;
