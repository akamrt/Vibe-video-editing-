import type { CurvePoint } from '../types';

/**
 * Monotone cubic spline interpolation (Fritsch-Carlson).
 * Returns a function f(x) → y that smoothly interpolates through the sorted points.
 */
function buildMonotoneCubic(points: CurvePoint[]): (x: number) => number {
  const n = points.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => points[0].y;

  // Sort by x
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xs = sorted.map(p => p.x);
  const ys = sorted.map(p => p.y);

  // Compute slopes
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

  // First pass: assign initial tangent values
  const c1s = [ms[0]];
  for (let i = 0; i < dxs.length - 1; i++) {
    const m0 = ms[i];
    const m1 = ms[i + 1];
    if (m0 * m1 <= 0) {
      c1s.push(0);
    } else {
      const dx0 = dxs[i];
      const dx1 = dxs[i + 1];
      const common = dx0 + dx1;
      c1s.push(3 * common / ((common + dx1) / m0 + (common + dx0) / m1));
    }
  }
  c1s.push(ms[ms.length - 1]);

  // Compute c2 and c3 coefficients
  const c2s: number[] = [];
  const c3s: number[] = [];
  for (let i = 0; i < c1s.length - 1; i++) {
    const c1 = c1s[i];
    const m = ms[i];
    const invDx = 1 / dxs[i];
    const common = c1 + c1s[i + 1] - m * 2;
    c2s.push((m - c1 - common) * invDx);
    c3s.push(common * invDx * invDx);
  }

  return (x: number): number => {
    // Clamp to range
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    // Binary search for interval
    let lo = 0;
    let hi = c3s.length - 1;
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

/**
 * Generate a 256-entry LUT from curve control points.
 * For identity curves (2 points at (0,0) and (1,1)), returns null to skip the LUT.
 */
export function generateCurveLUT(points: CurvePoint[]): Uint8Array | null {
  if (points.length < 2) return null;

  // Check for identity
  if (
    points.length === 2 &&
    Math.abs(points[0].x) < 0.001 && Math.abs(points[0].y) < 0.001 &&
    Math.abs(points[1].x - 1) < 0.001 && Math.abs(points[1].y - 1) < 0.001
  ) {
    return null; // Identity — no LUT needed
  }

  const interp = buildMonotoneCubic(points);
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const y = Math.max(0, Math.min(1, interp(x)));
    lut[i] = Math.round(y * 255);
  }
  return lut;
}

/**
 * Generate a 256-entry LUT for HSL curves where y=0.5 means no change.
 * Returns float values: y < 0.5 means decrease, y > 0.5 means increase.
 * For flat curves (all y=0.5), returns null.
 */
export function generateHSLCurveLUT(points: CurvePoint[]): Float32Array | null {
  if (points.length < 2) return null;

  // Check for flat
  if (points.every(p => Math.abs(p.y - 0.5) < 0.001)) return null;

  const interp = buildMonotoneCubic(points);
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    lut[i] = Math.max(0, Math.min(1, interp(x)));
  }
  return lut;
}

/**
 * Apply a curve LUT to a single channel value (0-255).
 * Used by the export pipeline (JS-side replication of shader math).
 */
export function applyCurveLUT(value: number, lut: Uint8Array | null): number {
  if (!lut) return value;
  return lut[Math.max(0, Math.min(255, Math.round(value)))];
}
