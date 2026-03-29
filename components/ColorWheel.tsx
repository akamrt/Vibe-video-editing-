import React, { useRef, useEffect, useCallback } from 'react';
import type { ColorWheelValue } from '../types';

interface Props {
  label: string;
  value: ColorWheelValue;
  onChange: (value: ColorWheelValue) => void;
}

const WHEEL_SIZE = 120;
const RADIUS = WHEEL_SIZE / 2 - 8;
const CENTER = WHEEL_SIZE / 2;

/**
 * Interactive color wheel for Lift/Gamma/Gain/Offset.
 * Circular hue/sat gradient, drag center dot to offset RGB, luminance slider below.
 */
export default function ColorWheel({ label, value, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  // Draw the wheel
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WHEEL_SIZE * dpr;
    canvas.height = WHEEL_SIZE * dpr;
    ctx.scale(dpr, dpr);

    // Draw circular hue/saturation gradient
    for (let y = 0; y < WHEEL_SIZE; y++) {
      for (let x = 0; x < WHEEL_SIZE; x++) {
        const dx = x - CENTER;
        const dy = y - CENTER;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > RADIUS + 1) continue;

        const angle = Math.atan2(dy, dx);
        const hue = ((angle * 180 / Math.PI) + 360) % 360;
        const sat = Math.min(dist / RADIUS, 1) * 100;
        const alpha = dist > RADIUS ? Math.max(0, 1 - (dist - RADIUS)) : 1;

        ctx.fillStyle = `hsla(${hue}, ${sat}%, 50%, ${alpha})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // Darken overlay to match DaVinci style
    ctx.globalCompositeOperation = 'multiply';
    const grad = ctx.createRadialGradient(CENTER, CENTER, 0, CENTER, CENTER, RADIUS);
    grad.addColorStop(0, 'rgba(80,80,80,1)');
    grad.addColorStop(1, 'rgba(40,40,40,1)');
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // Draw ring border
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(CENTER, CENTER, RADIUS, 0, Math.PI * 2);
    ctx.stroke();

    // Crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(CENTER - RADIUS, CENTER);
    ctx.lineTo(CENTER + RADIUS, CENTER);
    ctx.moveTo(CENTER, CENTER - RADIUS);
    ctx.lineTo(CENTER, CENTER + RADIUS);
    ctx.stroke();

    // Draw indicator dot
    const dotX = CENTER + value.r * RADIUS;
    const dotY = CENTER - value.g * RADIUS; // Invert Y: green = up
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [value.r, value.g, value.b]);

  const handlePointer = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = WHEEL_SIZE / rect.width;
    const scaleY = WHEEL_SIZE / rect.height;
    const dx = (x * scaleX - CENTER) / RADIUS;
    const dy = -(y * scaleY - CENTER) / RADIUS; // Invert Y
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(dist, 1);
    const angle = Math.atan2(dy, dx);
    const r = Math.cos(angle) * clampedDist;
    const g = Math.sin(angle) * clampedDist;
    // Derive blue as complement: blue is roughly opposite to the RG vector
    const b = -r * 0.5 - g * 0.5;

    onChange({ r: parseFloat(r.toFixed(3)), g: parseFloat(g.toFixed(3)), b: parseFloat(b.toFixed(3)), y: value.y });
  }, [onChange, value.y]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    handlePointer(e);
  }, [handlePointer]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    handlePointer(e);
  }, [handlePointer]);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const onDoubleClick = useCallback(() => {
    onChange({ r: 0, g: 0, b: 0, y: 0 });
  }, [onChange]);

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] text-gray-400 uppercase tracking-wider">{label}</span>
      <canvas
        ref={canvasRef}
        style={{ width: WHEEL_SIZE, height: WHEEL_SIZE, cursor: 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
      />
      {/* Luminance (Y) slider */}
      <div className="flex items-center gap-1 w-full px-1">
        <span className="text-[9px] text-gray-500 w-3">Y</span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={value.y}
          onChange={e => onChange({ ...value, y: parseFloat(e.target.value) })}
          onDoubleClick={() => onChange({ ...value, y: 0 })}
          className="flex-1 h-1 accent-white"
        />
        <span className="text-[9px] text-gray-400 w-7 text-right">{value.y.toFixed(2)}</span>
      </div>
      {/* YRGB readouts */}
      <div className="flex gap-1 text-[8px] text-gray-500">
        <span className="text-red-400">R{value.r.toFixed(2)}</span>
        <span className="text-green-400">G{value.g.toFixed(2)}</span>
        <span className="text-blue-400">B{value.b.toFixed(2)}</span>
      </div>
    </div>
  );
}
