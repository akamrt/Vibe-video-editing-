import type { ColorCorrection } from '../types';

export const DEFAULT_COLOR_CORRECTION: ColorCorrection = {
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
};

/** Check if a color correction is all defaults (no changes) */
export function isDefaultCC(cc: ColorCorrection): boolean {
  return (
    cc.brightness === 100 &&
    cc.contrast === 100 &&
    cc.saturation === 100 &&
    cc.exposure === 0 &&
    cc.temperature === 0 &&
    cc.tint === 0 &&
    cc.highlights === 0 &&
    cc.shadows === 0 &&
    cc.hueRotate === 0 &&
    cc.gamma === 1.0
  );
}

/**
 * Build a CSS filter string for the subset of corrections that CSS filters support natively.
 * Brightness, contrast, saturate, hue-rotate are GPU-accelerated.
 * Exposure is folded into brightness. Temperature/tint/gamma/highlights/shadows
 * use the SVG filter referenced via url().
 */
export function buildCSSFilter(cc: ColorCorrection, svgFilterId?: string): string {
  const parts: string[] = [];

  // Exposure shifts brightness: exposure 0 = no change, ±100 maps to ±0.5 brightness offset
  const effectiveBrightness = (cc.brightness / 100) + (cc.exposure / 200);
  if (effectiveBrightness !== 1) {
    parts.push(`brightness(${Math.max(0, effectiveBrightness).toFixed(3)})`);
  }
  if (cc.contrast !== 100) {
    parts.push(`contrast(${(cc.contrast / 100).toFixed(3)})`);
  }
  if (cc.saturation !== 100) {
    parts.push(`saturate(${(cc.saturation / 100).toFixed(3)})`);
  }
  if (cc.hueRotate !== 0) {
    parts.push(`hue-rotate(${cc.hueRotate}deg)`);
  }

  // If we have advanced corrections that need the SVG filter, prepend it
  const needsSVG = cc.temperature !== 0 || cc.tint !== 0 || cc.gamma !== 1.0 ||
                   cc.highlights !== 0 || cc.shadows !== 0;
  if (needsSVG && svgFilterId) {
    parts.unshift(`url(#${svgFilterId})`);
  }

  return parts.length > 0 ? parts.join(' ') : 'none';
}

/**
 * Build a CSS filter string for canvas export (no SVG filter support).
 * Only includes the CSS-native filters. Advanced corrections are applied
 * separately via pixel manipulation.
 */
export function buildCanvasFilter(cc: ColorCorrection): string {
  const parts: string[] = [];
  const effectiveBrightness = (cc.brightness / 100) + (cc.exposure / 200);
  if (effectiveBrightness !== 1) {
    parts.push(`brightness(${Math.max(0, effectiveBrightness).toFixed(3)})`);
  }
  if (cc.contrast !== 100) {
    parts.push(`contrast(${(cc.contrast / 100).toFixed(3)})`);
  }
  if (cc.saturation !== 100) {
    parts.push(`saturate(${(cc.saturation / 100).toFixed(3)})`);
  }
  if (cc.hueRotate !== 0) {
    parts.push(`hue-rotate(${cc.hueRotate}deg)`);
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** Check if advanced (non-CSS-filter) corrections are active */
export function needsAdvancedCorrection(cc: ColorCorrection): boolean {
  return cc.temperature !== 0 || cc.tint !== 0 || cc.gamma !== 1.0 ||
         cc.highlights !== 0 || cc.shadows !== 0;
}

/**
 * Build an SVG <filter> element string for temperature, tint, gamma, highlights/shadows.
 * This is rendered as a hidden SVG in the DOM and referenced via CSS filter: url(#id).
 */
export function buildSVGFilterMarkup(cc: ColorCorrection, filterId: string): string {
  const primitives: string[] = [];

  // Temperature: shift R/B channels. Warm = +R -B, Cool = -R +B
  // Tint: shift G channel. Magenta = -G, Green = +G
  if (cc.temperature !== 0 || cc.tint !== 0) {
    // Temperature: ±100 maps to ±0.3 shift in R and B
    const tempShift = cc.temperature / 333;  // ±0.3 at extremes
    const tintShift = cc.tint / 333;

    // feColorMatrix type="matrix": [R_from_R, R_from_G, R_from_B, R_from_A, R_offset, ...]
    const r = (1 + tempShift).toFixed(4);
    const g = (1 + tintShift).toFixed(4);
    const b = (1 - tempShift).toFixed(4);
    primitives.push(
      `<feColorMatrix type="matrix" values="${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0"/>`
    );
  }

  // Gamma via feComponentTransfer
  if (cc.gamma !== 1.0 || cc.highlights !== 0 || cc.shadows !== 0) {
    // Gamma: inverse exponent (gamma 2.0 = exponent 0.5 = brighter midtones)
    const gammaExp = 1 / Math.max(0.1, cc.gamma);

    // Highlights affect the upper end of the tone curve (amplitude)
    // Shadows affect the lower end (offset)
    const highlightAmp = 1 + (cc.highlights / 200);  // ±0.5 at extremes
    const shadowOffset = cc.shadows / 500;            // ±0.2 at extremes

    primitives.push(
      `<feComponentTransfer>` +
      `<feFuncR type="gamma" amplitude="${highlightAmp.toFixed(4)}" exponent="${gammaExp.toFixed(4)}" offset="${shadowOffset.toFixed(4)}"/>` +
      `<feFuncG type="gamma" amplitude="${highlightAmp.toFixed(4)}" exponent="${gammaExp.toFixed(4)}" offset="${shadowOffset.toFixed(4)}"/>` +
      `<feFuncB type="gamma" amplitude="${highlightAmp.toFixed(4)}" exponent="${gammaExp.toFixed(4)}" offset="${shadowOffset.toFixed(4)}"/>` +
      `</feComponentTransfer>`
    );
  }

  if (primitives.length === 0) return '';

  return `<filter id="${filterId}" color-interpolation-filters="sRGB">${primitives.join('')}</filter>`;
}

/**
 * Apply advanced color corrections (temperature, tint, gamma, highlights, shadows)
 * directly to canvas ImageData pixels. Used during export where SVG filters aren't available.
 */
export function applyAdvancedCorrection(imageData: ImageData, cc: ColorCorrection): void {
  if (!needsAdvancedCorrection(cc)) return;

  const data = imageData.data;
  const len = data.length;

  // Pre-compute temperature/tint multipliers
  const tempShift = cc.temperature / 333;
  const tintShift = cc.tint / 333;
  const rMul = 1 + tempShift;
  const gMul = 1 + tintShift;
  const bMul = 1 - tempShift;

  // Gamma
  const gammaExp = 1 / Math.max(0.1, cc.gamma);
  const highlightAmp = 1 + (cc.highlights / 200);
  const shadowOffset = cc.shadows / 500;

  // Build lookup tables for performance (256 entries per channel)
  const rLUT = new Uint8Array(256);
  const gLUT = new Uint8Array(256);
  const bLUT = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    const norm = i / 255;

    let r = norm * rMul;
    let g = norm * gMul;
    let b = norm * bMul;

    // Apply gamma + highlights/shadows
    if (cc.gamma !== 1.0 || cc.highlights !== 0 || cc.shadows !== 0) {
      r = highlightAmp * Math.pow(Math.max(0, r), gammaExp) + shadowOffset;
      g = highlightAmp * Math.pow(Math.max(0, g), gammaExp) + shadowOffset;
      b = highlightAmp * Math.pow(Math.max(0, b), gammaExp) + shadowOffset;
    }

    rLUT[i] = Math.max(0, Math.min(255, Math.round(r * 255)));
    gLUT[i] = Math.max(0, Math.min(255, Math.round(g * 255)));
    bLUT[i] = Math.max(0, Math.min(255, Math.round(b * 255)));
  }

  // Apply LUTs
  for (let i = 0; i < len; i += 4) {
    data[i]     = rLUT[data[i]];
    data[i + 1] = gLUT[data[i + 1]];
    data[i + 2] = bLUT[data[i + 2]];
    // Alpha unchanged
  }
}
