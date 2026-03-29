/**
 * JavaScript replication of the WebGL color grading shader math,
 * used for the export pipeline (no WebGL context needed).
 */
import type { ColorGrading, CurvePoint } from '../types';
import { generateCurveLUT, generateHSLCurveLUT, applyCurveLUT } from './curveUtils';
import { isGradingDefault } from './colorGradingDefaults';

/** Apply all color grading to a pixel RGBA buffer in-place */
export function applyColorGradingToImageData(imageData: ImageData, g: ColorGrading): void {
  if (isGradingDefault(g)) return;

  // Pre-generate LUTs
  const masterLUT = generateCurveLUT(g.curveMaster);
  const redLUT = generateCurveLUT(g.curveRed);
  const greenLUT = generateCurveLUT(g.curveGreen);
  const blueLUT = generateCurveLUT(g.curveBlue);

  const hueVsHueLUT = generateHSLCurveLUT(g.hueVsHue);
  const hueVsSatLUT = generateHSLCurveLUT(g.hueVsSat);
  const hueVsLumLUT = generateHSLCurveLUT(g.hueVsLum);
  const lumVsSatLUT = generateHSLCurveLUT(g.lumVsSat);
  const satVsSatLUT = generateHSLCurveLUT(g.satVsSat);

  // Precompute uniform-equivalent values
  const brightness = g.brightness / 100;
  const contrast = g.contrast / 100;
  const saturation = g.saturation / 100;
  const exposure = g.exposure / 200;
  const temperature = g.temperature / 333;
  const tint = g.tint / 333;
  const highlights = g.highlights / 200;
  const shadows = g.shadows / 500;
  const hueRotate = g.hueRotate * Math.PI / 180;
  const gamma = g.gamma;
  const gammaExp = 1 / Math.max(0.1, gamma);

  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let gr = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    // Stage 1: Basic corrections
    // Exposure
    const expMult = Math.pow(2, exposure);
    r *= expMult; gr *= expMult; b *= expMult;

    // Brightness
    r *= brightness; gr *= brightness; b *= brightness;

    // Contrast
    r = (r - 0.5) * contrast + 0.5;
    gr = (gr - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;

    // Temperature
    r *= 1 + temperature;
    b *= 1 - temperature;

    // Tint
    gr *= 1 + tint;

    // Gamma
    r = Math.pow(Math.max(0, r), gammaExp);
    gr = Math.pow(Math.max(0, gr), gammaExp);
    b = Math.pow(Math.max(0, b), gammaExp);

    // Highlights/Shadows
    const lum1 = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    const highlightMask = smoothstep(0.3, 0.8, lum1);
    const shadowMask = 1 - smoothstep(0.2, 0.7, lum1);
    r += r * highlights * highlightMask;
    gr += gr * highlights * highlightMask;
    b += b * highlights * highlightMask;
    r += shadows * shadowMask;
    gr += shadows * shadowMask;
    b += shadows * shadowMask;

    // Saturation
    const gray1 = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    r = gray1 + (r - gray1) * saturation;
    gr = gray1 + (gr - gray1) * saturation;
    b = gray1 + (b - gray1) * saturation;

    // Hue rotation (Rodrigues' rotation around (1,1,1)/sqrt(3))
    if (Math.abs(hueRotate) > 0.001) {
      const cosA = Math.cos(hueRotate);
      const sinA = Math.sin(hueRotate);
      const k = 0.57735;
      const dot = k * (r + gr + b);
      const cx = gr * k - b * k;
      const cy = b * k - r * k;
      const cz = r * k - gr * k;
      r = r * cosA + cx * sinA + k * dot * (1 - cosA);
      gr = gr * cosA + cy * sinA + k * dot * (1 - cosA);
      b = b * cosA + cz * sinA + k * dot * (1 - cosA);
    }

    r = clamp01(r); gr = clamp01(gr); b = clamp01(b);

    // Stage 2: Lift/Gamma/Gain/Offset
    // Gain
    r = r * (1 + g.gain.r);
    gr = gr * (1 + g.gain.g);
    b = b * (1 + g.gain.b);

    // Lift
    r = r + g.lift.r * (1 - r);
    gr = gr + g.lift.g * (1 - gr);
    b = b + g.lift.b * (1 - b);

    // Gamma wheel
    r = Math.pow(Math.max(0, r), Math.max(0.01, 1 - g.gammaWheel.r));
    gr = Math.pow(Math.max(0, gr), Math.max(0.01, 1 - g.gammaWheel.g));
    b = Math.pow(Math.max(0, b), Math.max(0.01, 1 - g.gammaWheel.b));

    // Offset
    r += g.offset.r;
    gr += g.offset.g;
    b += g.offset.b;

    // Y adjustments
    const yAdj = g.lift.y + g.gammaWheel.y + g.gain.y + g.offset.y;
    r *= 1 + yAdj;
    gr *= 1 + yAdj;
    b *= 1 + yAdj;

    r = clamp01(r); gr = clamp01(gr); b = clamp01(b);

    // Stage 3: RGB Curves (via LUTs)
    let ri = Math.round(r * 255);
    let gi = Math.round(gr * 255);
    let bi = Math.round(b * 255);

    // Master curve
    ri = applyCurveLUT(ri, masterLUT);
    gi = applyCurveLUT(gi, masterLUT);
    bi = applyCurveLUT(bi, masterLUT);

    // Per-channel
    ri = applyCurveLUT(ri, redLUT);
    gi = applyCurveLUT(gi, greenLUT);
    bi = applyCurveLUT(bi, blueLUT);

    // Stage 4: HSL Curves
    if (hueVsHueLUT || hueVsSatLUT || hueVsLumLUT || lumVsSatLUT || satVsSatLUT) {
      let [h, s, l] = rgb2hsl(ri / 255, gi / 255, bi / 255);

      if (hueVsHueLUT) {
        const idx = Math.round(h * 255);
        const shift = hueVsHueLUT[Math.max(0, Math.min(255, idx))] - 0.5;
        h = ((h + shift) % 1 + 1) % 1;
      }
      if (hueVsSatLUT) {
        const idx = Math.round(h * 255);
        s *= hueVsSatLUT[Math.max(0, Math.min(255, idx))] * 2;
      }
      if (hueVsLumLUT) {
        const idx = Math.round(h * 255);
        const adj = (hueVsLumLUT[Math.max(0, Math.min(255, idx))] - 0.5) * 2;
        l = clamp01(l + adj * 0.5);
      }
      if (lumVsSatLUT) {
        const idx = Math.round(l * 255);
        s *= lumVsSatLUT[Math.max(0, Math.min(255, idx))] * 2;
      }
      if (satVsSatLUT) {
        const idx = Math.round(Math.min(s, 1) * 255);
        s *= satVsSatLUT[Math.max(0, Math.min(255, idx))] * 2;
      }

      s = clamp01(s);
      const [nr, ng, nb] = hsl2rgb(h, s, l);
      ri = Math.round(nr * 255);
      gi = Math.round(ng * 255);
      bi = Math.round(nb * 255);
    }

    data[i] = Math.max(0, Math.min(255, ri));
    data[i + 1] = Math.max(0, Math.min(255, gi));
    data[i + 2] = Math.max(0, Math.min(255, bi));
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const l = (maxC + minC) / 2;

  if (maxC === minC) return [0, 0, l];

  const d = maxC - minC;
  const s = l > 0.5 ? d / (2 - maxC - minC) : d / (maxC + minC);
  let h: number;

  if (maxC === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (maxC === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hue2rgb(p, q, h + 1 / 3),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1 / 3),
  ];
}
