import type { Transition, TransitionType, TransitionEasing } from '../types';

// ============ TYPES ============
export interface TransitionRenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  outFrame: CanvasImageSource | null;  // outgoing clip (null = black)
  inFrame: CanvasImageSource | null;   // incoming clip (null = black)
  progress: number;                     // 0.0 → 1.0
  transition: Transition;
}

type RenderFn = (rc: TransitionRenderContext) => void;

// ============ EASING ============
export function applyEasing(t: number, easing?: TransitionEasing): number {
  if (!easing || easing === 'linear') return t;
  switch (easing) {
    case 'easeIn': return t * t * t;
    case 'easeOut': return 1 - Math.pow(1 - t, 3);
    case 'easeInOut': return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case 'bounce': {
      const n = 7.5625, d = 2.75;
      let p = 1 - t;
      let v: number;
      if (p < 1 / d) v = n * p * p;
      else if (p < 2 / d) v = n * (p -= 1.5 / d) * p + 0.75;
      else if (p < 2.5 / d) v = n * (p -= 2.25 / d) * p + 0.9375;
      else v = n * (p -= 2.625 / d) * p + 0.984375;
      return 1 - v;
    }
    default: return t;
  }
}

// ============ OFFSCREEN CANVAS POOL ============
const pool: HTMLCanvasElement[] = [];

function getPooledCanvas(w: number, h: number): HTMLCanvasElement {
  let c = pool.pop();
  if (!c) c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function returnPooledCanvas(c: HTMLCanvasElement): void {
  pool.push(c);
}

// ============ DRAWING HELPERS ============
function drawFrame(ctx: CanvasRenderingContext2D, frame: CanvasImageSource | null, w: number, h: number, color?: string) {
  if (frame) {
    ctx.drawImage(frame, 0, 0, w, h);
  } else {
    ctx.fillStyle = color || '#000000';
    ctx.fillRect(0, 0, w, h);
  }
}

function drawFrameScaled(ctx: CanvasRenderingContext2D, frame: CanvasImageSource | null, w: number, h: number,
  scale: number, rotation: number = 0, ox: number = w / 2, oy: number = h / 2, color?: string) {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  if (rotation) ctx.rotate(rotation);
  ctx.translate(-ox, -oy);
  drawFrame(ctx, frame, w, h, color);
  ctx.restore();
}

// ============ SHAPE PATH HELPERS ============
function drawStarPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outerR: number, points: number) {
  const innerR = outerR * 0.4;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (Math.PI * i) / points - Math.PI / 2;
    if (i === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
}

function drawHeartPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.beginPath();
  const topY = cy - size * 0.35;
  ctx.moveTo(cx, cy + size * 0.6);
  // Left curve
  ctx.bezierCurveTo(cx - size * 0.7, cy + size * 0.15, cx - size * 0.7, topY - size * 0.15, cx - size * 0.35, topY);
  ctx.bezierCurveTo(cx - size * 0.1, topY - size * 0.25, cx, topY, cx, topY + size * 0.15);
  // Right curve
  ctx.bezierCurveTo(cx, topY, cx + size * 0.1, topY - size * 0.25, cx + size * 0.35, topY);
  ctx.bezierCurveTo(cx + size * 0.7, topY - size * 0.15, cx + size * 0.7, cy + size * 0.15, cx, cy + size * 0.6);
  ctx.closePath();
}

function drawHexagonPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 - Math.PI / 6;
    if (i === 0) ctx.moveTo(cx + size * Math.cos(a), cy + size * Math.sin(a));
    else ctx.lineTo(cx + size * Math.cos(a), cy + size * Math.sin(a));
  }
  ctx.closePath();
}

function drawTrianglePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const a = (Math.PI * 2 * i) / 3 - Math.PI / 2;
    if (i === 0) ctx.moveTo(cx + size * Math.cos(a), cy + size * Math.sin(a));
    else ctx.lineTo(cx + size * Math.cos(a), cy + size * Math.sin(a));
  }
  ctx.closePath();
}

function drawDiamondPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx + size, cy);
  ctx.lineTo(cx, cy + size);
  ctx.lineTo(cx - size, cy);
  ctx.closePath();
}

// ============ GRADIENT MASK HELPER ============
// Creates a soft-edge reveal by drawing the incoming frame through a gradient mask
function drawWithGradientMask(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  frame: CanvasImageSource | null, color: string | undefined,
  clipFn: (maskCtx: CanvasRenderingContext2D, progress: number) => void,
  progress: number, softness: number
) {
  if (softness <= 0) {
    // Hard edge — just clip directly
    ctx.save();
    clipFn(ctx, progress);
    ctx.clip();
    drawFrame(ctx, frame, w, h, color);
    ctx.restore();
    return;
  }

  // Soft edge via offscreen canvas
  const offscreen = getPooledCanvas(w, h);
  const offCtx = offscreen.getContext('2d')!;
  offCtx.clearRect(0, 0, w, h);

  // Draw the incoming frame
  drawFrame(offCtx, frame, w, h, color);

  // Create mask: draw white shape, then use destination-in
  const mask = getPooledCanvas(w, h);
  const maskCtx = mask.getContext('2d')!;
  maskCtx.clearRect(0, 0, w, h);

  // For softness, we draw the shape slightly larger and apply a gradient edge
  // Simple approach: draw shape filled, then blur
  maskCtx.fillStyle = '#fff';
  clipFn(maskCtx, progress);
  maskCtx.fill();

  // Apply softness via filter blur on the mask
  if (softness > 0) {
    const blurPx = (softness / 100) * Math.max(w, h) * 0.15;
    const blurCanvas = getPooledCanvas(w, h);
    const blurCtx = blurCanvas.getContext('2d')!;
    blurCtx.clearRect(0, 0, w, h);
    blurCtx.filter = `blur(${blurPx}px)`;
    blurCtx.drawImage(mask, 0, 0);
    blurCtx.filter = 'none';

    // Copy blurred mask back
    maskCtx.clearRect(0, 0, w, h);
    maskCtx.drawImage(blurCanvas, 0, 0);
    returnPooledCanvas(blurCanvas);
  }

  // Apply mask to frame via destination-in
  offCtx.globalCompositeOperation = 'destination-in';
  offCtx.drawImage(mask, 0, 0);
  offCtx.globalCompositeOperation = 'source-over';

  // Draw the masked result on the main canvas
  ctx.drawImage(offscreen, 0, 0);

  returnPooledCanvas(offscreen);
  returnPooledCanvas(mask);
}

// ============ INDIVIDUAL RENDERERS ============

// --- BASIC ---
function renderFade(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
  ctx.clearRect(0, 0, w, h);
  ctx.globalAlpha = 1 - progress;
  drawFrame(ctx, outFrame, w, h);
  ctx.globalAlpha = progress;
  drawFrame(ctx, inFrame, w, h);
  ctx.globalAlpha = 1;
}

function renderCrossfade(rc: TransitionRenderContext) {
  renderFade(rc); // Same rendering, just different defaults
}

function renderFadeBlack(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);
  if (progress < 0.5) {
    ctx.globalAlpha = 1 - progress * 2;
    drawFrame(ctx, outFrame, w, h);
  } else {
    ctx.globalAlpha = (progress - 0.5) * 2;
    drawFrame(ctx, inFrame, w, h);
  }
  ctx.globalAlpha = 1;
}

function renderFadeWhite(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (progress < 0.5) {
    ctx.globalAlpha = 1 - progress * 2;
    drawFrame(ctx, outFrame, w, h);
  } else {
    ctx.globalAlpha = (progress - 0.5) * 2;
    drawFrame(ctx, inFrame, w, h);
  }
  ctx.globalAlpha = 1;
}

function renderDipToColor(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const color = transition.color || '#000000';
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  if (progress < 0.5) {
    ctx.globalAlpha = 1 - progress * 2;
    drawFrame(ctx, outFrame, w, h);
  } else {
    ctx.globalAlpha = (progress - 0.5) * 2;
    drawFrame(ctx, inFrame, w, h);
  }
  ctx.globalAlpha = 1;
}

// --- WIPES ---
function makeLinearWipeClip(direction: string) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
    const softness = transition.softness ?? 10;
    ctx.clearRect(0, 0, w, h);
    drawFrame(ctx, outFrame, w, h);

    const clipFn = (maskCtx: CanvasRenderingContext2D, p: number) => {
      maskCtx.beginPath();
      switch (direction) {
        case 'left':   maskCtx.rect(w * (1 - p), 0, w * p, h); break;
        case 'right':  maskCtx.rect(0, 0, w * p, h); break;
        case 'up':     maskCtx.rect(0, h * (1 - p), w, h * p); break;
        case 'down':   maskCtx.rect(0, 0, w, h * p); break;
      }
    };

    drawWithGradientMask(ctx, w, h, inFrame, transition.color, clipFn, progress, softness);
  };
}

function makeDiagonalWipeClip(from: string) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
    const softness = transition.softness ?? 15;
    ctx.clearRect(0, 0, w, h);
    drawFrame(ctx, outFrame, w, h);

    const clipFn = (maskCtx: CanvasRenderingContext2D, p: number) => {
      const d = Math.sqrt(w * w + h * h);
      const ext = d * p * 2;
      maskCtx.beginPath();
      switch (from) {
        case 'tl':
          maskCtx.moveTo(-d + ext, 0);
          maskCtx.lineTo(ext, 0);
          maskCtx.lineTo(0, ext);
          maskCtx.lineTo(0, -d + ext);
          break;
        case 'tr':
          maskCtx.moveTo(w + d - ext, 0);
          maskCtx.lineTo(w - ext, 0);
          maskCtx.lineTo(w, ext);
          maskCtx.lineTo(w, -d + ext);
          break;
        case 'bl':
          maskCtx.moveTo(-d + ext, h);
          maskCtx.lineTo(ext, h);
          maskCtx.lineTo(0, h - ext);
          maskCtx.lineTo(0, h + d - ext);
          break;
        case 'br':
          maskCtx.moveTo(w + d - ext, h);
          maskCtx.lineTo(w - ext, h);
          maskCtx.lineTo(w, h - ext);
          maskCtx.lineTo(w, h + d - ext);
          break;
      }
      maskCtx.closePath();
    };

    drawWithGradientMask(ctx, w, h, inFrame, transition.color, clipFn, progress, softness);
  };
}

function renderRadialWipe(clockwise: boolean) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
    const softness = transition.softness ?? 5;
    const cx = (transition.centerX ?? 0.5) * w;
    const cy = (transition.centerY ?? 0.5) * h;
    ctx.clearRect(0, 0, w, h);
    drawFrame(ctx, outFrame, w, h);

    const maxR = Math.sqrt(w * w + h * h);
    const sweepAngle = progress * Math.PI * 2;
    const startAngle = -Math.PI / 2;

    const clipFn = (maskCtx: CanvasRenderingContext2D) => {
      maskCtx.beginPath();
      maskCtx.moveTo(cx, cy);
      if (clockwise) {
        maskCtx.arc(cx, cy, maxR, startAngle, startAngle + sweepAngle, false);
      } else {
        maskCtx.arc(cx, cy, maxR, startAngle, startAngle - sweepAngle, true);
      }
      maskCtx.closePath();
    };

    drawWithGradientMask(ctx, w, h, inFrame, transition.color, clipFn, progress, softness);
  };
}

function renderClockWipe(rc: TransitionRenderContext) {
  renderRadialWipe(true)(rc);
}

// --- SHAPES ---
function makeShapeReveal(drawShapeFn: (ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, segments?: number) => void) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
    const softness = transition.softness ?? 10;
    const cx = (transition.centerX ?? 0.5) * w;
    const cy = (transition.centerY ?? 0.5) * h;
    const maxSize = Math.sqrt(w * w + h * h);

    ctx.clearRect(0, 0, w, h);
    drawFrame(ctx, outFrame, w, h);

    const clipFn = (maskCtx: CanvasRenderingContext2D) => {
      drawShapeFn(maskCtx, cx, cy, maxSize * progress, transition.segments);
    };

    drawWithGradientMask(ctx, w, h, inFrame, transition.color, clipFn, progress, softness);
  };
}

function renderIrisOpen(rc: TransitionRenderContext) {
  makeShapeReveal((ctx, cx, cy, size) => {
    ctx.beginPath();
    ctx.arc(cx, cy, size, 0, Math.PI * 2);
    ctx.closePath();
  })(rc);
}

function renderIrisClose(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const softness = transition.softness ?? 20;
  const cx = (transition.centerX ?? 0.5) * w;
  const cy = (transition.centerY ?? 0.5) * h;
  const maxSize = Math.sqrt(w * w + h * h);

  ctx.clearRect(0, 0, w, h);

  if (progress < 0.5) {
    // Close: outgoing shrinks
    const p = 1 - progress * 2;
    drawFrame(ctx, inFrame, w, h);
    const clipFn = (maskCtx: CanvasRenderingContext2D) => {
      maskCtx.beginPath();
      maskCtx.arc(cx, cy, maxSize * p, 0, Math.PI * 2);
      maskCtx.closePath();
    };
    drawWithGradientMask(ctx, w, h, outFrame, transition.color, clipFn, p, softness);
  } else {
    // Open: incoming grows
    const p = (progress - 0.5) * 2;
    drawFrame(ctx, outFrame, w, h);
    const clipFn = (maskCtx: CanvasRenderingContext2D) => {
      maskCtx.beginPath();
      maskCtx.arc(cx, cy, maxSize * p, 0, Math.PI * 2);
      maskCtx.closePath();
    };
    drawWithGradientMask(ctx, w, h, inFrame, transition.color, clipFn, p, softness);
  }
}

// --- SLIDE / PUSH ---
function makeSlide(dx: number, dy: number) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
    ctx.clearRect(0, 0, w, h);
    // Outgoing stays
    drawFrame(ctx, outFrame, w, h);
    // Incoming slides in
    ctx.save();
    ctx.translate(w * dx * (1 - progress), h * dy * (1 - progress));
    drawFrame(ctx, inFrame, w, h);
    ctx.restore();
  };
}

function makePush(dx: number, dy: number) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
    ctx.clearRect(0, 0, w, h);
    // Outgoing pushes off
    ctx.save();
    ctx.translate(-w * dx * progress, -h * dy * progress);
    drawFrame(ctx, outFrame, w, h);
    ctx.restore();
    // Incoming slides in
    ctx.save();
    ctx.translate(w * dx * (1 - progress), h * dy * (1 - progress));
    drawFrame(ctx, inFrame, w, h);
    ctx.restore();
  };
}

// --- EFFECTS ---
function renderZoomIn(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const maxZoom = 1 + (transition.intensity ?? 50) / 50;
  ctx.clearRect(0, 0, w, h);

  if (progress < 0.5) {
    const p = progress * 2;
    const scale = 1 + (maxZoom - 1) * p;
    drawFrameScaled(ctx, outFrame, w, h, scale);
    ctx.globalAlpha = p;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  } else {
    const p = (progress - 0.5) * 2;
    const scale = maxZoom - (maxZoom - 1) * p;
    ctx.globalAlpha = p;
    drawFrameScaled(ctx, inFrame, w, h, scale);
    ctx.globalAlpha = 1;
  }
}

function renderZoomOut(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const minScale = 1 - (transition.intensity ?? 50) / 100;
  ctx.clearRect(0, 0, w, h);

  if (progress < 0.5) {
    const p = progress * 2;
    const scale = 1 - (1 - minScale) * p;
    ctx.globalAlpha = 1 - p;
    drawFrameScaled(ctx, outFrame, w, h, scale);
    ctx.globalAlpha = 1;
  } else {
    const p = (progress - 0.5) * 2;
    const scale = minScale + (1 - minScale) * p;
    drawFrameScaled(ctx, inFrame, w, h, scale);
  }
}

function renderZoomRotate(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const maxZoom = 1 + (transition.intensity ?? 50) / 50;
  const maxAngle = ((transition.angle ?? 90) * Math.PI) / 180;
  ctx.clearRect(0, 0, w, h);

  if (progress < 0.5) {
    const p = progress * 2;
    const scale = 1 + (maxZoom - 1) * p;
    const rot = maxAngle * p;
    drawFrameScaled(ctx, outFrame, w, h, scale, rot);
    ctx.globalAlpha = p * 0.7;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  } else {
    const p = (progress - 0.5) * 2;
    const scale = maxZoom - (maxZoom - 1) * p;
    const rot = maxAngle * (1 - p);
    drawFrameScaled(ctx, inFrame, w, h, scale, -rot);
  }
}

function renderBlur(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const maxBlur = (transition.intensity ?? 60) / 5;
  ctx.clearRect(0, 0, w, h);

  if (progress < 0.5) {
    const p = progress * 2;
    ctx.filter = `blur(${maxBlur * p}px)`;
    ctx.globalAlpha = 1 - p;
    drawFrame(ctx, outFrame, w, h);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
  } else {
    const p = (progress - 0.5) * 2;
    ctx.filter = `blur(${maxBlur * (1 - p)}px)`;
    ctx.globalAlpha = p;
    drawFrame(ctx, inFrame, w, h);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
  }
}

function renderBlurDirectional(rc: TransitionRenderContext) {
  // Canvas 2D doesn't support directional blur, so we simulate with regular blur + slide
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const maxBlur = (transition.intensity ?? 50) / 5;
  const dir = transition.direction ?? 'right';
  const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
  const maxOffset = Math.max(w, h) * 0.05;

  ctx.clearRect(0, 0, w, h);

  if (progress < 0.5) {
    const p = progress * 2;
    ctx.filter = `blur(${maxBlur * p}px)`;
    ctx.save();
    ctx.translate(dx * maxOffset * p, dy * maxOffset * p);
    drawFrame(ctx, outFrame, w, h);
    ctx.restore();
    ctx.filter = 'none';
  } else {
    const p = (progress - 0.5) * 2;
    ctx.filter = `blur(${maxBlur * (1 - p)}px)`;
    ctx.save();
    ctx.translate(-dx * maxOffset * (1 - p), -dy * maxOffset * (1 - p));
    drawFrame(ctx, inFrame, w, h);
    ctx.restore();
    ctx.filter = 'none';
  }
}

function makeSpin(clockwise: boolean) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
    const speed = (transition.intensity ?? 50) / 50;
    const maxAngle = Math.PI * speed * (clockwise ? 1 : -1);
    ctx.clearRect(0, 0, w, h);

    if (progress < 0.5) {
      const p = progress * 2;
      const scale = 1 - p * 0.3;
      drawFrameScaled(ctx, outFrame, w, h, scale, maxAngle * p);
    } else {
      const p = (progress - 0.5) * 2;
      const scale = 0.7 + p * 0.3;
      drawFrameScaled(ctx, inFrame, w, h, scale, -maxAngle * (1 - p));
    }
  };
}

function renderGlitch(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const intensity = (transition.intensity ?? 60) / 100;
  ctx.clearRect(0, 0, w, h);

  // Base crossfade
  ctx.globalAlpha = 1 - progress;
  drawFrame(ctx, outFrame, w, h);
  ctx.globalAlpha = progress;
  drawFrame(ctx, inFrame, w, h);
  ctx.globalAlpha = 1;

  // Glitch slices — more intense in the middle
  const glitchAmount = Math.sin(progress * Math.PI) * intensity;
  if (glitchAmount > 0.05) {
    const numSlices = Math.floor(5 + glitchAmount * 15);
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    for (let s = 0; s < numSlices; s++) {
      const y = Math.floor(Math.random() * h);
      const sliceH = Math.floor(2 + Math.random() * h * 0.05 * glitchAmount);
      const offset = Math.floor((Math.random() - 0.5) * w * 0.2 * glitchAmount);

      for (let row = y; row < Math.min(y + sliceH, h); row++) {
        for (let x = 0; x < w; x++) {
          const srcX = Math.max(0, Math.min(w - 1, x - offset));
          const dstIdx = (row * w + x) * 4;
          const srcIdx = (row * w + srcX) * 4;
          data[dstIdx] = data[srcIdx];
          data[dstIdx + 1] = data[srcIdx + 1];
          data[dstIdx + 2] = data[srcIdx + 2];
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // RGB shift
    if (glitchAmount > 0.2) {
      const shiftAmt = Math.floor(glitchAmount * 8);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = glitchAmount * 0.3;
      ctx.drawImage(ctx.canvas, shiftAmt, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
  }
}

function renderSplitH(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
  ctx.clearRect(0, 0, w, h);
  drawFrame(ctx, inFrame, w, h);

  // Top half moves up, bottom half moves down
  const offset = h / 2 * progress;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h / 2);
  ctx.clip();
  ctx.translate(0, -offset);
  drawFrame(ctx, outFrame, w, h);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, h / 2, w, h / 2);
  ctx.clip();
  ctx.translate(0, offset);
  drawFrame(ctx, outFrame, w, h);
  ctx.restore();
}

function renderSplitV(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
  ctx.clearRect(0, 0, w, h);
  drawFrame(ctx, inFrame, w, h);

  // Left half moves left, right half moves right
  const offset = w / 2 * progress;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w / 2, h);
  ctx.clip();
  ctx.translate(-offset, 0);
  drawFrame(ctx, outFrame, w, h);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(w / 2, 0, w / 2, h);
  ctx.clip();
  ctx.translate(offset, 0);
  drawFrame(ctx, outFrame, w, h);
  ctx.restore();
}

// --- BLEND DISSOLVES ---
function makeBlendDissolve(blendMode: GlobalCompositeOperation) {
  return (rc: TransitionRenderContext) => {
    const { ctx, width: w, height: h, outFrame, inFrame, progress } = rc;
    ctx.clearRect(0, 0, w, h);
    // Draw outgoing
    ctx.globalAlpha = 1;
    drawFrame(ctx, outFrame, w, h);
    // Draw incoming with blend mode
    ctx.globalCompositeOperation = blendMode;
    ctx.globalAlpha = progress;
    drawFrame(ctx, inFrame, w, h);
    ctx.globalCompositeOperation = 'source-over';
    // Add a straight crossfade on top for smooth transition
    ctx.globalAlpha = progress * progress; // ease in the direct replacement
    drawFrame(ctx, inFrame, w, h);
    ctx.globalAlpha = 1;
  };
}

// --- CREATIVE ---
function renderPixelate(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const maxBlockSize = transition.segments ?? 20;
  ctx.clearRect(0, 0, w, h);

  const pixelAmount = Math.sin(progress * Math.PI); // peaks in middle
  const blockSize = Math.max(1, Math.floor(maxBlockSize * pixelAmount));

  if (blockSize <= 1) {
    // No pixelation — just crossfade
    ctx.globalAlpha = 1 - progress;
    drawFrame(ctx, outFrame, w, h);
    ctx.globalAlpha = progress;
    drawFrame(ctx, inFrame, w, h);
    ctx.globalAlpha = 1;
    return;
  }

  // Draw the appropriate frame
  const frame = progress < 0.5 ? outFrame : inFrame;

  // Draw to small canvas, then scale up with no smoothing
  const smallW = Math.max(1, Math.ceil(w / blockSize));
  const smallH = Math.max(1, Math.ceil(h / blockSize));
  const small = getPooledCanvas(smallW, smallH);
  const sCtx = small.getContext('2d')!;
  sCtx.clearRect(0, 0, smallW, smallH);
  drawFrame(sCtx, frame, smallW, smallH);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, smallW, smallH, 0, 0, w, h);
  ctx.imageSmoothingEnabled = true;

  returnPooledCanvas(small);
}

function renderMosaic(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const gridSize = transition.segments ?? 8;
  const tileW = w / gridSize;
  const tileH = h / gridSize;

  ctx.clearRect(0, 0, w, h);

  // Draw outgoing as base
  drawFrame(ctx, outFrame, w, h);

  // Reveal tiles of incoming based on progress
  // Tiles reveal in a random but deterministic order based on position
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const tileProgress = ((row * 7 + col * 13) % (gridSize * gridSize)) / (gridSize * gridSize);
      if (tileProgress < progress) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(col * tileW, row * tileH, tileW + 1, tileH + 1);
        ctx.clip();
        drawFrame(ctx, inFrame, w, h);
        ctx.restore();
      }
    }
  }
}

function renderFilmBurn(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const color = transition.color || '#ff6600';
  const intensity = (transition.intensity ?? 70) / 100;
  ctx.clearRect(0, 0, w, h);

  // Base crossfade
  ctx.globalAlpha = 1 - progress;
  drawFrame(ctx, outFrame, w, h);
  ctx.globalAlpha = progress;
  drawFrame(ctx, inFrame, w, h);
  ctx.globalAlpha = 1;

  // Film burn overlay — peaks in the middle
  const burnAmount = Math.sin(progress * Math.PI) * intensity;
  if (burnAmount > 0) {
    // Radial gradient for burn effect
    const grd = ctx.createRadialGradient(
      w * (0.3 + progress * 0.4), h * 0.4, 0,
      w * 0.5, h * 0.5, Math.max(w, h) * 0.8
    );
    grd.addColorStop(0, color);
    grd.addColorStop(0.4, color + '80');
    grd.addColorStop(1, 'transparent');

    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = burnAmount;
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Add brightness flash
    ctx.globalAlpha = burnAmount * 0.3;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

function renderLightLeak(rc: TransitionRenderContext) {
  const { ctx, width: w, height: h, outFrame, inFrame, progress, transition } = rc;
  const color = transition.color || '#ffcc00';
  const intensity = (transition.intensity ?? 50) / 100;
  ctx.clearRect(0, 0, w, h);

  // Base crossfade
  ctx.globalAlpha = 1 - progress;
  drawFrame(ctx, outFrame, w, h);
  ctx.globalAlpha = progress;
  drawFrame(ctx, inFrame, w, h);
  ctx.globalAlpha = 1;

  // Light leak effect — sweeps across
  const leakAmount = Math.sin(progress * Math.PI) * intensity;
  if (leakAmount > 0) {
    const leakX = w * progress;
    const grd = ctx.createRadialGradient(
      leakX, h * 0.3, 0,
      leakX, h * 0.5, Math.max(w, h) * 0.6
    );
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.2, color + 'cc');
    grd.addColorStop(0.6, color + '40');
    grd.addColorStop(1, 'transparent');

    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = leakAmount;
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

// ============ RENDERER DISPATCH MAP ============
const TRANSITION_RENDERERS: Record<string, RenderFn> = {
  // Basic
  FADE: renderFade,
  CROSSFADE: renderCrossfade,
  FADE_BLACK: renderFadeBlack,
  FADE_WHITE: renderFadeWhite,
  DIP_TO_BLACK: renderDipToColor,
  DIP_TO_WHITE: renderDipToColor,
  // Wipes
  WIPE_LEFT: makeLinearWipeClip('left'),
  WIPE_RIGHT: makeLinearWipeClip('right'),
  WIPE_UP: makeLinearWipeClip('up'),
  WIPE_DOWN: makeLinearWipeClip('down'),
  WIPE_DIAGONAL_TL: makeDiagonalWipeClip('tl'),
  WIPE_DIAGONAL_TR: makeDiagonalWipeClip('tr'),
  WIPE_DIAGONAL_BL: makeDiagonalWipeClip('bl'),
  WIPE_DIAGONAL_BR: makeDiagonalWipeClip('br'),
  WIPE_RADIAL_CW: renderRadialWipe(true),
  WIPE_RADIAL_CCW: renderRadialWipe(false),
  WIPE_CLOCK: renderClockWipe,
  // Shapes
  SHAPE_CIRCLE: makeShapeReveal((ctx, cx, cy, size) => {
    ctx.beginPath(); ctx.arc(cx, cy, size, 0, Math.PI * 2); ctx.closePath();
  }),
  SHAPE_DIAMOND: makeShapeReveal(drawDiamondPath),
  SHAPE_STAR: makeShapeReveal((ctx, cx, cy, size, segments) => drawStarPath(ctx, cx, cy, size, segments ?? 5)),
  SHAPE_HEART: makeShapeReveal(drawHeartPath),
  SHAPE_HEXAGON: makeShapeReveal(drawHexagonPath),
  SHAPE_TRIANGLE: makeShapeReveal(drawTrianglePath),
  IRIS_OPEN: renderIrisOpen,
  IRIS_CLOSE: renderIrisClose,
  // Slide / Push
  SLIDE_LEFT: makeSlide(-1, 0),
  SLIDE_RIGHT: makeSlide(1, 0),
  SLIDE_UP: makeSlide(0, -1),
  SLIDE_DOWN: makeSlide(0, 1),
  PUSH_LEFT: makePush(1, 0),
  PUSH_RIGHT: makePush(-1, 0),
  PUSH_UP: makePush(0, 1),
  PUSH_DOWN: makePush(0, -1),
  // Effects
  ZOOM_IN: renderZoomIn,
  ZOOM_OUT: renderZoomOut,
  ZOOM_ROTATE: renderZoomRotate,
  BLUR: renderBlur,
  BLUR_DIRECTIONAL: renderBlurDirectional,
  SPIN_CW: makeSpin(true),
  SPIN_CCW: makeSpin(false),
  GLITCH: renderGlitch,
  SPLIT_HORIZONTAL: renderSplitH,
  SPLIT_VERTICAL: renderSplitV,
  // Blend dissolves
  DISSOLVE_MULTIPLY: makeBlendDissolve('multiply'),
  DISSOLVE_SCREEN: makeBlendDissolve('screen'),
  DISSOLVE_OVERLAY: makeBlendDissolve('overlay'),
  DISSOLVE_LUMINOSITY: makeBlendDissolve('luminosity'),
  // Creative
  PIXELATE: renderPixelate,
  MOSAIC: renderMosaic,
  FILM_BURN: renderFilmBurn,
  LIGHT_LEAK: renderLightLeak,
};

// ============ MAIN ENTRY POINT ============
export function renderTransition(rc: TransitionRenderContext): void {
  const { transition, progress } = rc;
  if (!transition || transition.type === 'NONE') {
    // No transition — just show whichever frame is appropriate
    const { ctx, width: w, height: h, outFrame, inFrame } = rc;
    ctx.clearRect(0, 0, w, h);
    drawFrame(ctx, progress < 0.5 ? outFrame : inFrame, w, h);
    return;
  }

  // Apply easing
  const easedProgress = applyEasing(Math.max(0, Math.min(1, progress)), transition.easing);
  const easedRc: TransitionRenderContext = { ...rc, progress: easedProgress };

  const renderer = TRANSITION_RENDERERS[transition.type];
  if (renderer) {
    renderer(easedRc);
  } else {
    // Unknown type — fallback to crossfade
    renderCrossfade(easedRc);
  }
}
