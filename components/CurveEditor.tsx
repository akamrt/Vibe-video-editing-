import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { CurvePoint } from '../types';

interface Props {
  points: CurvePoint[];
  onChange: (points: CurvePoint[]) => void;
  channel: 'master' | 'red' | 'green' | 'blue' | 'hsl';
  /** Optional background gradient (e.g., hue rainbow for HSL curves) */
  backgroundGradient?: string;
  /** If true, y=0.5 is the baseline (for HSL curves) */
  centeredBaseline?: boolean;
  width?: number;
  height?: number;
}

const POINT_RADIUS = 5;
const SNAP_DISTANCE = 12;

const CHANNEL_COLORS: Record<string, string> = {
  master: '#ffffff',
  red: '#ff4444',
  green: '#44ff44',
  blue: '#4488ff',
  hsl: '#ffaa00',
};

/**
 * Interactive cubic curve editor with draggable control points.
 * Click to add points, right-click to delete, drag to move.
 */
export default function CurveEditor({
  points,
  onChange,
  channel,
  backgroundGradient,
  centeredBaseline = false,
  width = 200,
  height = 200,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const sorted = [...points].sort((a, b) => a.x - b.x);

  // Convert canvas coords to normalized [0,1]
  const canvasToNorm = useCallback((cx: number, cy: number): { x: number; y: number } => {
    return { x: cx / width, y: 1 - cy / height };
  }, [width, height]);

  const normToCanvas = useCallback((nx: number, ny: number): { x: number; y: number } => {
    return { x: nx * width, y: (1 - ny) * height };
  }, [width, height]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Optional background gradient
    if (backgroundGradient) {
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = backgroundGradient;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = 1;
    }

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
      const pos = (i / 4) * width;
      ctx.beginPath();
      ctx.moveTo(pos, 0); ctx.lineTo(pos, height);
      ctx.moveTo(0, pos); ctx.lineTo(width, pos);
      ctx.stroke();
    }

    // Baseline (identity or center)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    if (centeredBaseline) {
      // Horizontal center line at y=0.5
      const cy = height / 2;
      ctx.moveTo(0, cy); ctx.lineTo(width, cy);
    } else {
      // Diagonal identity line
      ctx.moveTo(0, height); ctx.lineTo(width, 0);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Build cubic interpolation and draw curve
    const curveColor = CHANNEL_COLORS[channel] || '#ffffff';
    ctx.strokeStyle = curveColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    // Simple monotone cubic drawing: evaluate at each pixel
    const interp = buildSimpleInterp(sorted);
    for (let px = 0; px <= width; px++) {
      const nx = px / width;
      const ny = Math.max(0, Math.min(1, interp(nx)));
      const cy = (1 - ny) * height;
      if (px === 0) ctx.moveTo(px, cy);
      else ctx.lineTo(px, cy);
    }
    ctx.stroke();

    // Draw control points
    for (let i = 0; i < sorted.length; i++) {
      const pt = normToCanvas(sorted[i].x, sorted[i].y);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = i === draggingIdx || i === hoveredIdx ? '#fff' : '#aaa';
      ctx.fill();
      ctx.strokeStyle = curveColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [sorted, channel, width, height, draggingIdx, hoveredIdx, backgroundGradient, centeredBaseline, normToCanvas]);

  const findClosestPoint = useCallback((cx: number, cy: number): number | null => {
    let best = -1;
    let bestDist = SNAP_DISTANCE;
    for (let i = 0; i < sorted.length; i++) {
      const pt = normToCanvas(sorted[i].x, sorted[i].y);
      const d = Math.sqrt((pt.x - cx) ** 2 + (pt.y - cy) ** 2);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }, [sorted, normToCanvas]);

  const getCanvasCoords = useCallback((e: React.MouseEvent): { cx: number; cy: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      cx: (e.clientX - rect.left) * (width / rect.width),
      cy: (e.clientY - rect.top) * (height / rect.height),
    };
  }, [width, height]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { cx, cy } = getCanvasCoords(e);

    // Right click — delete point (but not endpoints)
    if (e.button === 2) {
      const idx = findClosestPoint(cx, cy);
      if (idx !== null && idx > 0 && idx < sorted.length - 1) {
        // Find original index in points array
        const pt = sorted[idx];
        const origIdx = points.findIndex(p => p.x === pt.x && p.y === pt.y);
        if (origIdx >= 0) {
          const newPoints = [...points];
          newPoints.splice(origIdx, 1);
          onChange(newPoints);
        }
      }
      return;
    }

    // Left click — drag existing or add new
    const idx = findClosestPoint(cx, cy);
    if (idx !== null) {
      setDraggingIdx(idx);
    } else {
      // Add new point
      const norm = canvasToNorm(cx, cy);
      const newPoints = [...points, { x: parseFloat(norm.x.toFixed(4)), y: parseFloat(norm.y.toFixed(4)) }];
      onChange(newPoints);
      // Find the new point's sorted index
      const newSorted = [...newPoints].sort((a, b) => a.x - b.x);
      const newIdx = newSorted.findIndex(p => Math.abs(p.x - norm.x) < 0.001 && Math.abs(p.y - norm.y) < 0.001);
      setDraggingIdx(newIdx >= 0 ? newIdx : null);
    }
  }, [getCanvasCoords, findClosestPoint, sorted, points, onChange, canvasToNorm]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const { cx, cy } = getCanvasCoords(e);

    if (draggingIdx !== null) {
      const norm = canvasToNorm(cx, cy);
      const pt = sorted[draggingIdx];
      // Don't move endpoints' x
      const newX = (draggingIdx === 0 || draggingIdx === sorted.length - 1) ? pt.x : Math.max(0, Math.min(1, norm.x));
      const newY = Math.max(0, Math.min(1, norm.y));

      const origIdx = points.findIndex(p => p.x === pt.x && p.y === pt.y);
      if (origIdx >= 0) {
        const newPoints = [...points];
        newPoints[origIdx] = { x: parseFloat(newX.toFixed(4)), y: parseFloat(newY.toFixed(4)) };
        onChange(newPoints);
      }
    } else {
      setHoveredIdx(findClosestPoint(cx, cy));
    }
  }, [draggingIdx, sorted, points, onChange, getCanvasCoords, canvasToNorm, findClosestPoint]);

  const handleMouseUp = useCallback(() => {
    setDraggingIdx(null);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); // Prevent browser context menu
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, cursor: draggingIdx !== null ? 'grabbing' : 'crosshair' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
    />
  );
}

/** Simple linear interpolation for curve drawing (monotone cubic is in curveUtils) */
function buildSimpleInterp(sorted: CurvePoint[]): (x: number) => number {
  if (sorted.length === 0) return () => 0;
  if (sorted.length === 1) return () => sorted[0].y;

  const n = sorted.length;
  const xs = sorted.map(p => p.x);
  const ys = sorted.map(p => p.y);

  // Monotone cubic (simplified Fritsch-Carlson)
  const dxs: number[] = [];
  const dys: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    const dy = ys[i + 1] - ys[i];
    dxs.push(dx);
    dys.push(dy);
    ms.push(dx === 0 ? 0 : dy / dx);
  }

  const c1s = [ms[0]];
  for (let i = 0; i < dxs.length - 1; i++) {
    const m0 = ms[i], m1 = ms[i + 1];
    if (m0 * m1 <= 0) {
      c1s.push(0);
    } else {
      const dx0 = dxs[i], dx1 = dxs[i + 1];
      const common = dx0 + dx1;
      c1s.push(3 * common / ((common + dx1) / m0 + (common + dx0) / m1));
    }
  }
  c1s.push(ms[ms.length - 1]);

  const c2s: number[] = [];
  const c3s: number[] = [];
  for (let i = 0; i < c1s.length - 1; i++) {
    const c1 = c1s[i];
    const m = ms[i];
    const invDx = dxs[i] === 0 ? 0 : 1 / dxs[i];
    const common = c1 + c1s[i + 1] - m * 2;
    c2s.push((m - c1 - common) * invDx);
    c3s.push(common * invDx * invDx);
  }

  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    let lo = 0, hi = c3s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid - 1;
    }
    const i = Math.max(0, lo - 1);
    const diff = x - xs[i];
    return ys[i] + c1s[i] * diff + c2s[i] * diff * diff + c3s[i] * diff * diff * diff;
  };
}
