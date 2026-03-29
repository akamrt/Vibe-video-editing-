import type { ColorGrading, ColorWheelValue, CurvePoint, HSLQualifier } from '../types';

export const DEFAULT_WHEEL: ColorWheelValue = { r: 0, g: 0, b: 0, y: 0 };

export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const FLAT_CURVE: CurvePoint[] = [
  { x: 0, y: 0.5 },
  { x: 1, y: 0.5 },
];

export const DEFAULT_QUALIFIER: HSLQualifier = {
  enabled: false,
  hue: { center: 0.5, width: 0.2, softness: 0.1 },
  saturation: { center: 0.5, width: 0.5, softness: 0.1 },
  luminance: { center: 0.5, width: 0.5, softness: 0.1 },
  blurRadius: 2,
  invert: false,
};

export const DEFAULT_COLOR_GRADING: ColorGrading = {
  // Basic corrections
  brightness: 100,
  contrast: 100,
  saturation: 100,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  hueRotate: 0,
  gamma: 1.0,

  // Color wheels
  lift: { ...DEFAULT_WHEEL },
  gammaWheel: { ...DEFAULT_WHEEL },
  gain: { ...DEFAULT_WHEEL },
  offset: { ...DEFAULT_WHEEL },

  // RGB Curves
  curveMaster: [...IDENTITY_CURVE],
  curveRed: [...IDENTITY_CURVE],
  curveGreen: [...IDENTITY_CURVE],
  curveBlue: [...IDENTITY_CURVE],

  // HSL Curves
  hueVsHue: [...FLAT_CURVE.map(p => ({ x: p.x, y: 0.5 }))],
  hueVsSat: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
  hueVsLum: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
  lumVsSat: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
  satVsSat: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }],
};

/** Check if a wheel has been modified from defaults */
export function isWheelDefault(w: ColorWheelValue): boolean {
  return w.r === 0 && w.g === 0 && w.b === 0 && w.y === 0;
}

/** Check if a curve is the identity (unmodified) */
export function isCurveIdentity(points: CurvePoint[]): boolean {
  if (points.length !== 2) return false;
  return points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1;
}

/** Check if an HSL curve is flat (unmodified — all y=0.5) */
export function isHSLCurveFlat(points: CurvePoint[]): boolean {
  return points.every(p => Math.abs(p.y - 0.5) < 0.001);
}

/** Check if grading has any non-default values */
export function isGradingDefault(g: ColorGrading): boolean {
  return (
    g.brightness === 100 && g.contrast === 100 && g.saturation === 100 &&
    g.exposure === 0 && g.temperature === 0 && g.tint === 0 &&
    g.highlights === 0 && g.shadows === 0 && g.hueRotate === 0 && g.gamma === 1.0 &&
    isWheelDefault(g.lift) && isWheelDefault(g.gammaWheel) &&
    isWheelDefault(g.gain) && isWheelDefault(g.offset) &&
    isCurveIdentity(g.curveMaster) && isCurveIdentity(g.curveRed) &&
    isCurveIdentity(g.curveGreen) && isCurveIdentity(g.curveBlue) &&
    isHSLCurveFlat(g.hueVsHue) && isHSLCurveFlat(g.hueVsSat) &&
    isHSLCurveFlat(g.hueVsLum) && isHSLCurveFlat(g.lumVsSat) &&
    isHSLCurveFlat(g.satVsSat) &&
    !g.qualifier?.enabled
  );
}

/** Migrate Phase 1 ColorCorrection to ColorGrading */
export function migrateColorCorrection(cc: import('../types').ColorCorrection): ColorGrading {
  return {
    ...DEFAULT_COLOR_GRADING,
    brightness: cc.brightness,
    contrast: cc.contrast,
    saturation: cc.saturation,
    exposure: cc.exposure,
    temperature: cc.temperature,
    tint: cc.tint,
    highlights: cc.highlights,
    shadows: cc.shadows,
    hueRotate: cc.hueRotate,
    gamma: cc.gamma,
  };
}
