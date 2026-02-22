import type { GradientStop, SubtitleStyle, TitleStyle } from '../types';

/** Convert legacy 2-color gradientColors array to GradientStop[] */
export function migrateGradientColors(colors: string[]): GradientStop[] {
  return colors.map((c, i) => ({
    color: c,
    position: Math.round((i / Math.max(1, colors.length - 1)) * 100),
    opacity: 1,
  }));
}

/** Resolve gradient stops: prefer gradientStops, fall back to gradientColors */
export function resolveGradientStops(s: SubtitleStyle | TitleStyle): GradientStop[] | null {
  if (s.gradientStops && s.gradientStops.length >= 2) return s.gradientStops;
  if (s.gradientColors && s.gradientColors.length >= 2) return migrateGradientColors(s.gradientColors);
  return null;
}

/** Convert a hex color + opacity to an rgba() string */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Build a CSS gradient string from stops */
export function buildGradientCSS(
  type: 'linear' | 'radial',
  stops: GradientStop[],
  angle?: number
): string {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const stopStr = sorted
    .map(s => {
      const alpha = s.opacity ?? 1;
      const colorVal = alpha < 1 ? hexToRgba(s.color, alpha) : s.color;
      return `${colorVal} ${s.position}%`;
    })
    .join(', ');

  if (type === 'linear') return `linear-gradient(${angle || 0}deg, ${stopStr})`;
  return `radial-gradient(circle, ${stopStr})`;
}

/** Apply gradient stops to a canvas gradient object */
export function applyStopsToCanvasGradient(
  gradient: CanvasGradient,
  stops: GradientStop[]
): void {
  const sorted = [...stops].sort((a, b) => a.position - b.position);
  for (const stop of sorted) {
    const alpha = stop.opacity ?? 1;
    const colorVal = alpha < 1 ? hexToRgba(stop.color, alpha) : stop.color;
    gradient.addColorStop(stop.position / 100, colorVal);
  }
}
