/**
 * Canvas Subtitle Renderer
 * 
 * Replicates the AnimatedText component's per-word/character animation
 * effects for the canvas-based export path. This ensures subtitle animations
 * from templates are properly rendered during export.
 * 
 * SCALING MODEL:
 * The viewport uses raw CSS pixel font sizes (e.g. fontSize: 16px) inside
 * a safe-zone div whose height is `viewportSafeZoneHeight` pixels.
 * The export canvas has `outputHeight` pixels.
 * To match visual proportions: scaleFactor = outputHeight / viewportSafeZoneHeight
 * 
 * POSITIONING MODEL:
 * The viewport uses CSS `bottom: {bottomOffset}%` inside the safe zone.
 * The canvas equivalent is: yBase = outputHeight * (1 - bottomOffset/100)
 * Horizontal centering uses 5% padding on each side, matching the viewport's
 * paddingLeft/paddingRight of 5%.
 */

import { interpolate, Easing, spring } from 'remotion';
import type { TextAnimation, AnimationEffect, EasingType, SubtitleStyle, KeywordEmphasis } from '../types';
import { resolveGradientStops, applyStopsToCanvasGradient } from './gradientUtils';

// ─── Easing Mapping (mirrors AnimatedText.tsx) ────────────────────────────────

function mapEasing(easing: EasingType): ((t: number) => number) | null {
    switch (easing) {
        case 'linear': return Easing.linear;
        case 'easeIn': return Easing.in(Easing.cubic);
        case 'easeOut': return Easing.out(Easing.cubic);
        case 'easeInOut': return Easing.inOut(Easing.cubic);
        case 'bounce': return Easing.bounce;
        case 'elastic': return Easing.elastic(1);
        case 'spring': return null;
        default: return Easing.linear;
    }
}

// ─── Effect Value Computation (mirrors AnimatedText.tsx) ──────────────────────

function computeEffectValue(
    effect: AnimationEffect,
    elmLocalFrame: number,
    totalDurationSec: number,
    fps: number
): number {
    const effectStartFrame = totalDurationSec * effect.startAt * fps;
    const effectEndFrame = totalDurationSec * effect.endAt * fps;
    const effectDurationFrames = effectEndFrame - effectStartFrame;
    const effectFrame = elmLocalFrame - effectStartFrame;

    if (effect.easing === 'spring' || effect.easing === 'elastic') {
        const damping = effect.bounciness != null ? Math.max(1, 20 - effect.bounciness) : 10;
        const stiffness = effect.stiffness ?? 100;

        if (effect.easing === 'spring') {
            const spr = spring({
                frame: Math.max(0, effectFrame),
                fps,
                config: { damping, stiffness },
            });
            return interpolate(spr, [0, 1], [effect.from, effect.to]);
        }

        const easingFn = Easing.elastic(effect.bounciness != null ? effect.bounciness / 10 : 1);
        const t = interpolate(
            effectFrame,
            [0, Math.max(1, effectDurationFrames)],
            [0, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );
        return interpolate(easingFn(t), [0, 1], [effect.from, effect.to]);
    }

    const easingFn = mapEasing(effect.easing) || Easing.linear;
    const t = interpolate(
        effectFrame,
        [0, Math.max(1, effectDurationFrames)],
        [0, 1],
        { easing: easingFn, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
    );
    return interpolate(t, [0, 1], [effect.from, effect.to]);
}

// ─── Blend Mode Mapping ──────────────────────────────────────────────────────

/** Map CSS blend mode names to canvas globalCompositeOperation values */
function toCompositeOp(blendMode?: string): GlobalCompositeOperation {
    if (!blendMode || blendMode === 'normal') return 'source-over';
    // Canvas globalCompositeOperation supports these CSS blend mode names directly
    const validOps: Record<string, GlobalCompositeOperation> = {
        'multiply': 'multiply',
        'screen': 'screen',
        'overlay': 'overlay',
        'darken': 'darken',
        'lighten': 'lighten',
        'color-dodge': 'color-dodge',
        'color-burn': 'color-burn',
        'hard-light': 'hard-light',
        'soft-light': 'soft-light',
        'difference': 'difference',
        'exclusion': 'exclusion',
        'hue': 'hue',
        'saturation': 'saturation',
        'color': 'color',
        'luminosity': 'luminosity',
    };
    return validOps[blendMode] || 'source-over';
}

// ─── Per-element animation values ────────────────────────────────────────────

interface ElementAnimValues {
    text: string;
    opacity: number;
    scaleVal: number;
    translateX: number;
    translateY: number;
    rotate: number;
    blur: number;
    letterSpacing: number;
    isKeyword: boolean;
    keywordColor: string | null;
}

function computeElementAnimations(
    text: string,
    animation: TextAnimation,
    frame: number,
    fps: number,
    wordEmphases?: KeywordEmphasis[]
): ElementAnimValues[] {
    // Split text the same way AnimatedText does
    let elements: string[];
    if (animation.scope === 'character') elements = text.split('');
    else if (animation.scope === 'word') elements = text.split(/(\s+)/);
    else if (animation.scope === 'line') elements = text.split('\n');
    else elements = [text];

    // Build stagger indices (skip whitespace tokens for word scope)
    let animatableIndices: number[];
    if (animation.scope !== 'word') {
        animatableIndices = elements.map((_: string, i: number) => i);
    } else {
        let idx = 0;
        animatableIndices = elements.map((el: string) => {
            if (/^\s+$/.test(el)) return -1;
            return idx++;
        });
    }

    // Build emphasis map
    const emphasisMap = new Map<number, KeywordEmphasis>();
    if (wordEmphases) {
        for (const kw of wordEmphases) {
            if (kw.enabled) emphasisMap.set(kw.wordIndex, kw);
        }
    }

    return elements.map((el: string, rawIndex: number) => {
        const staggerIndex = animatableIndices[rawIndex];

        // Whitespace tokens: just pass through
        if (animation.scope === 'word' && staggerIndex === -1) {
            return {
                text: el,
                opacity: 1,
                scaleVal: 1,
                translateX: 0,
                translateY: 0,
                rotate: 0,
                blur: 0,
                letterSpacing: 0,
                isKeyword: false,
                keywordColor: null,
            };
        }

        const delaySec = staggerIndex * (animation.stagger ?? 0);
        const delayFrames = delaySec * fps;
        const elmLocalFrame = frame - delayFrames;

        let opacity = 1;
        let scaleVal = 1;
        let translateX = 0;
        let translateY = 0;
        let rotate = 0;
        let blur = 0;
        let letterSpacing = 0;

        for (const effect of animation.effects) {
            if (effect.wordTarget && emphasisMap.size > 0 && animation.scope === 'word') {
                const isKw = emphasisMap.has(staggerIndex);
                if (effect.wordTarget.mode === 'keywords' && !isKw) continue;
                if (effect.wordTarget.mode === 'non-keywords' && isKw) continue;
                if (effect.wordTarget.mode === 'indices' &&
                    !effect.wordTarget.indices.includes(staggerIndex)) continue;
            }
            const val = computeEffectValue(effect, elmLocalFrame, animation.duration, fps);

            switch (effect.type) {
                case 'opacity': opacity *= val; break;
                case 'scale': scaleVal *= val; break;
                case 'translateX': translateX += val; break;
                case 'translateY': translateY += val; break;
                case 'rotate': rotate += val; break;
                case 'blur': blur = Math.max(0, blur + val); break;
                case 'letterSpacing': letterSpacing += val; break;
            }
        }

        opacity = Math.max(0, Math.min(1, opacity));

        const isKeyword = emphasisMap.has(staggerIndex);
        const keywordColor = isKeyword ? (emphasisMap.get(staggerIndex)!.color || '#FFD700') : null;

        return { text: el, opacity, scaleVal, translateX, translateY, rotate, blur, letterSpacing, isKeyword, keywordColor };
    });
}

// ─── Canvas Drawing ──────────────────────────────────────────────────────────

interface DrawSubtitleOptions {
    ctx: CanvasRenderingContext2D;
    text: string;
    style: SubtitleStyle;
    templateStyle?: Record<string, any> | null;
    animation?: TextAnimation | null;
    frame: number;
    fps: number;
    outputWidth: number;
    outputHeight: number;
    /**
     * The height of the viewport safe zone at the time of export.
     * This is used as the reference for scaling so that font sizes
     * and positions match what the user sees in the viewport.
     * If not provided, falls back to outputHeight (no scaling).
     */
    viewportSafeZoneHeight: number;
    /** Total translate X as percentage (drag offset + keyframe offset) */
    totalTx: number;
    /** Total translate Y as percentage (drag offset + keyframe offset) */
    totalTy: number;
    totalScale: number;
    totalRotation: number;
    wordEmphases?: KeywordEmphasis[];
}

/**
 * Draws a subtitle on a canvas, with full animation support matching the viewport.
 * 
 * The scaleFactor is `outputHeight / viewportSafeZoneHeight`, which ensures that
 * a 16px font in a 360px viewport becomes 48px in a 1080p export (same visual ratio).
 */
export function drawSubtitleOnCanvas(opts: DrawSubtitleOptions): void {
    const {
        ctx, text, style, animation,
        frame, fps, outputWidth, outputHeight,
        viewportSafeZoneHeight,
        totalTx, totalTy, totalScale, totalRotation,
        wordEmphases,
    } = opts;

    // Scale factor: maps viewport CSS pixels to export canvas pixels
    // e.g. viewport is 360px tall, export is 1080px → scale = 3x
    const scaleFactor = outputHeight / viewportSafeZoneHeight;
    const rawFontSize = style.fontSize || 16;
    const fontSize = rawFontSize * scaleFactor;

    // Padding: viewport uses '8px 16px' CSS padding on text element
    // Scale that to canvas space
    const textPaddingV = 8 * scaleFactor;
    const textPaddingH = 16 * scaleFactor;

    // Calculate base position
    // Viewport: `bottom: ${bottomOffset}%` inside a safe zone of height sz.h
    // Canvas equivalent: y from top = outputHeight * (1 - bottomOffset/100)
    const bottomOffset = style.bottomOffset ?? 10;
    const yBase = outputHeight * (1 - bottomOffset / 100);
    const xBase = outputWidth / 2;

    ctx.save();

    // Apply global transforms (drag + keyframe position/scale/rotation)
    // Viewport: translate(${tx * sz.w / 100}px, ${ty * sz.h / 100}px)
    // Canvas: translate(tx * outputWidth / 100, ty * outputHeight / 100)
    ctx.translate(xBase, yBase);
    ctx.translate(totalTx * outputWidth / 100, totalTy * outputHeight / 100);
    if (totalRotation !== 0) ctx.rotate(totalRotation * Math.PI / 180);
    if (totalScale !== 1) ctx.scale(totalScale, totalScale);

    // Set up font
    const fontFamily = style.fontFamily || 'Arial';
    const fontWeight = style.bold ? 'bold' : 'normal';
    const fontStyle = style.italic ? 'italic' : 'normal';
    const fontStr = `${fontStyle === 'italic' ? 'italic ' : ''}${fontWeight === 'bold' ? 'bold ' : ''}${fontSize}px ${fontFamily}`;
    ctx.font = fontStr;
    ctx.textBaseline = 'alphabetic';

    // If no animation or empty effects, draw plain text (simple path)
    if (!animation || animation.effects.length === 0) {
        drawPlainText(ctx, text, style, fontSize, scaleFactor, textPaddingV, textPaddingH);
        ctx.restore();
        return;
    }

    // Compute per-element animation values
    const elements = computeElementAnimations(text, animation, frame, fps, wordEmphases);

    // Measure all elements to compute total width for centering
    const elementWidths = elements.map((el: ElementAnimValues) => {
        return ctx.measureText(el.text).width;
    });
    const totalWidth = elementWidths.reduce((sum: number, w: number) => sum + w, 0);

    // Starting X position (centered by default)
    let xOffset: number;
    const align = style.textAlign || 'center';
    if (align === 'left') {
        // Left-aligned: start from left edge with 5% padding
        xOffset = -(outputWidth * 0.45) + textPaddingH; // -45% of width from center + padding
    } else if (align === 'right') {
        // Right-aligned: end at right edge with 5% padding
        xOffset = (outputWidth * 0.45) - totalWidth - textPaddingH;
    } else {
        // Center-aligned
        xOffset = -totalWidth / 2;
    }

    // Draw background behind the full text block
    if (style.backgroundType === 'box' || style.backgroundType === 'rounded') {
        const bgX = xOffset - textPaddingH;
        const bgY = -(fontSize * 1.2 + textPaddingV); // Account for line height ~1.2 + padding top
        const bgW = totalWidth + textPaddingH * 2;
        const bgH = fontSize * 1.4 + textPaddingV * 2; // line-height 1.4 like viewport

        const bgOpacity = style.backgroundOpacity ?? 0.8;
        const bgColor = style.backgroundColor || '#000000';
        const bgR = parseInt(bgColor.slice(1, 3), 16);
        const bgG = parseInt(bgColor.slice(3, 5), 16);
        const bgB = parseInt(bgColor.slice(5, 7), 16);
        ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},${bgOpacity})`;

        const borderRadius = (style.boxBorderRadius || 8) * scaleFactor;

        // Draw backdrop glow (separate blend mode)
        if (style.backdropGlowBlur && style.backdropGlowBlur > 0) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.backdropGlowBlendMode);
            ctx.shadowColor = style.backdropGlowColor || '#00ff00';
            ctx.shadowBlur = style.backdropGlowBlur * scaleFactor;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bgX, bgY, bgW, bgH, borderRadius);
                ctx.fill();
            } else {
                ctx.fillRect(bgX, bgY, bgW, bgH);
            }
            ctx.restore();
        }

        // Draw backdrop shadow (separate blend mode)
        if ((style.backdropShadowBlur && style.backdropShadowBlur > 0) || style.backdropShadowOffsetX || style.backdropShadowOffsetY) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.backdropShadowBlendMode);
            ctx.shadowColor = style.backdropShadowColor || '#000000';
            ctx.shadowBlur = (style.backdropShadowBlur || 0) * scaleFactor;
            ctx.shadowOffsetX = (style.backdropShadowOffsetX || 0) * scaleFactor;
            ctx.shadowOffsetY = (style.backdropShadowOffsetY || 0) * scaleFactor;
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bgX, bgY, bgW, bgH, borderRadius);
                ctx.fill();
            } else {
                ctx.fillRect(bgX, bgY, bgW, bgH);
            }
            ctx.restore();
        }

        // Draw the backdrop fill itself
        ctx.save();
        ctx.globalCompositeOperation = toCompositeOp(style.backdropBlendMode);
        ctx.shadowColor = 'transparent';
        if (style.backgroundType === 'rounded' && ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(bgX, bgY, bgW, bgH, borderRadius);
            ctx.fill();
        } else {
            ctx.fillRect(bgX, bgY, bgW, bgH);
        }
        ctx.restore();

        // Inner glow (clip to backdrop, stroke inside with blur)
        if (style.innerGlowBlur && style.innerGlowBlur > 0 && style.innerGlowColor) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.innerGlowBlendMode);
            ctx.beginPath();
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.roundRect(bgX, bgY, bgW, bgH, borderRadius);
            } else {
                ctx.rect(bgX, bgY, bgW, bgH);
            }
            ctx.clip();
            ctx.shadowColor = style.innerGlowColor;
            ctx.shadowBlur = style.innerGlowBlur * scaleFactor;
            ctx.lineWidth = style.innerGlowBlur * scaleFactor * 2;
            ctx.strokeStyle = style.innerGlowColor;
            ctx.beginPath();
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.roundRect(bgX, bgY, bgW, bgH, borderRadius);
            } else {
                ctx.rect(bgX, bgY, bgW, bgH);
            }
            ctx.stroke();
            ctx.restore();
        }

        // Border
        if (style.boxBorderWidth && style.boxBorderWidth > 0) {
            ctx.strokeStyle = style.boxBorderColor || '#ffffff';
            ctx.lineWidth = style.boxBorderWidth * scaleFactor;
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bgX, bgY, bgW, bgH, borderRadius);
                ctx.stroke();
            } else {
                ctx.strokeRect(bgX, bgY, bgW, bgH);
            }
        }
    }

    // Draw each element with its animation applied
    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const elWidth = elementWidths[i];

        if (el.opacity <= 0.01) {
            xOffset += elWidth;
            continue;
        }

        ctx.save();

        // Move to this element's position (center of element)
        ctx.translate(xOffset + elWidth / 2, 0);

        // Apply per-element animation transforms
        // AnimatedText uses raw px for translate values, scale to canvas
        ctx.translate(el.translateX * scaleFactor, el.translateY * scaleFactor);
        if (el.rotate !== 0) ctx.rotate(el.rotate * Math.PI / 180);
        if (el.scaleVal !== 1) ctx.scale(el.scaleVal, el.scaleVal);

        ctx.globalAlpha = el.opacity;

        // Set font again after transforms
        ctx.font = fontStr;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';

        // Draw outline if style is 'outline'
        if (style.backgroundType === 'outline') {
            ctx.strokeStyle = style.outlineColor || style.backgroundColor || '#000000';
            ctx.lineWidth = (style.outlineWidth || 2) * scaleFactor;
            ctx.lineJoin = 'round';
            ctx.strokeText(el.text, 0, 0);
        }

        // Text glow (separate blend mode)
        if (style.glowBlur && style.glowBlur > 0) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.glowBlendMode);
            ctx.shadowColor = style.glowColor || '#00ff00';
            ctx.shadowBlur = style.glowBlur * scaleFactor;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.fillStyle = el.isKeyword && el.keywordColor ? el.keywordColor : (style.color || '#ffffff');
            ctx.fillText(el.text, 0, 0);
            ctx.shadowBlur = (style.glowBlur * 1.5) * scaleFactor;
            ctx.fillText(el.text, 0, 0);
            ctx.restore();
        }

        // Text drop shadow (separate blend mode)
        if ((style.textShadowBlur && style.textShadowBlur > 0) || style.textShadowOffsetX || style.textShadowOffsetY) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.shadowBlendMode);
            ctx.shadowColor = style.textShadowColor || '#000000';
            ctx.shadowBlur = (style.textShadowBlur || 0) * scaleFactor;
            ctx.shadowOffsetX = (style.textShadowOffsetX || 0) * scaleFactor;
            ctx.shadowOffsetY = (style.textShadowOffsetY || 0) * scaleFactor;
            ctx.fillStyle = el.isKeyword && el.keywordColor ? el.keywordColor : (style.color || '#ffffff');
            ctx.fillText(el.text, 0, 0);
            ctx.restore();
        } else if (style.backgroundType !== 'box' && style.backgroundType !== 'rounded' && style.backgroundType !== 'outline' && style.backgroundType !== 'stripe') {
            // Drop shadow for plain text (no background)
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 4 * scaleFactor;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 2 * scaleFactor;
        } else {
            ctx.shadowColor = 'transparent';
        }

        // Text fill with blend mode
        ctx.save();
        const textOp = toCompositeOp(style.textBlendMode);
        const gradStops = resolveGradientStops(style);
        if (style.gradientType && style.gradientType !== 'none' && gradStops && (!el.isKeyword || !el.keywordColor)) {
            ctx.globalCompositeOperation = toCompositeOp(style.gradientBlendMode) !== 'source-over'
                ? toCompositeOp(style.gradientBlendMode) : textOp;
            const hw = elWidth / 2;
            const hh = fontSize / 2;
            let gradient: CanvasGradient;
            if (style.gradientType === 'radial') {
                gradient = ctx.createRadialGradient(0, -hh, 0, 0, -hh, Math.max(hw, hh));
            } else {
                const angle = (style.gradientAngle || 0) * Math.PI / 180;
                const centerX = hw;
                const centerY = -hh;
                gradient = ctx.createLinearGradient(
                    centerX + Math.cos(angle + Math.PI) * hw,
                    centerY + Math.sin(angle + Math.PI) * hh,
                    centerX + Math.cos(angle) * hw,
                    centerY + Math.sin(angle) * hh
                );
            }
            applyStopsToCanvasGradient(gradient, gradStops);
            ctx.fillStyle = gradient;
        } else {
            ctx.globalCompositeOperation = textOp;
            ctx.fillStyle = el.isKeyword && el.keywordColor ? el.keywordColor : (style.color || '#ffffff');
        }

        // Clear any lingering shadow from the non-background fallback path
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        ctx.fillText(el.text, 0, 0);
        ctx.restore();

        ctx.restore();

        xOffset += elWidth;
    }

    ctx.restore();
}

// ─── Fallback: plain text (no animation) ─────────────────────────────────────

function drawPlainText(
    ctx: CanvasRenderingContext2D,
    text: string,
    style: SubtitleStyle,
    fontSize: number,
    scaleFactor: number,
    textPaddingV: number,
    textPaddingH: number,
): void {
    ctx.textAlign = (style.textAlign as CanvasTextAlign) || 'center';
    ctx.textBaseline = 'alphabetic';

    // Background
    if (style.backgroundType === 'box' || style.backgroundType === 'rounded') {
        const metrics = ctx.measureText(text);
        const w = metrics.width + textPaddingH * 2;
        const h = fontSize * 1.4 + textPaddingV * 2;
        const bx = -(w / 2);
        const by = -(fontSize * 1.2 + textPaddingV);

        const bgOpacity = style.backgroundOpacity ?? 0.8;
        const bgColor = style.backgroundColor || '#000000';
        const bgR = parseInt(bgColor.slice(1, 3), 16);
        const bgG = parseInt(bgColor.slice(3, 5), 16);
        const bgB = parseInt(bgColor.slice(5, 7), 16);
        ctx.fillStyle = `rgba(${bgR},${bgG},${bgB},${bgOpacity})`;

        const borderRadius = (style.boxBorderRadius || 8) * scaleFactor;

        // Backdrop glow (separate blend mode)
        if (style.backdropGlowBlur && style.backdropGlowBlur > 0) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.backdropGlowBlendMode);
            ctx.shadowColor = style.backdropGlowColor || '#00ff00';
            ctx.shadowBlur = style.backdropGlowBlur * scaleFactor;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bx, by, w, h, borderRadius);
                ctx.fill();
            } else {
                ctx.fillRect(bx, by, w, h);
            }
            ctx.restore();
        }

        // Backdrop shadow (separate blend mode)
        if ((style.backdropShadowBlur && style.backdropShadowBlur > 0) || style.backdropShadowOffsetX || style.backdropShadowOffsetY) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.backdropShadowBlendMode);
            ctx.shadowColor = style.backdropShadowColor || '#000000';
            ctx.shadowBlur = (style.backdropShadowBlur || 0) * scaleFactor;
            ctx.shadowOffsetX = (style.backdropShadowOffsetX || 0) * scaleFactor;
            ctx.shadowOffsetY = (style.backdropShadowOffsetY || 0) * scaleFactor;
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bx, by, w, h, borderRadius);
                ctx.fill();
            } else {
                ctx.fillRect(bx, by, w, h);
            }
            ctx.restore();
        }

        // Backdrop fill (its own blend mode)
        ctx.save();
        ctx.globalCompositeOperation = toCompositeOp(style.backdropBlendMode);
        ctx.shadowColor = 'transparent';
        if (style.backgroundType === 'rounded' && ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(bx, by, w, h, borderRadius);
            ctx.fill();
        } else {
            ctx.fillRect(bx, by, w, h);
        }
        ctx.restore();

        // Inner glow (clip to backdrop, stroke inside with blur)
        if (style.innerGlowBlur && style.innerGlowBlur > 0 && style.innerGlowColor) {
            ctx.save();
            ctx.globalCompositeOperation = toCompositeOp(style.innerGlowBlendMode);
            ctx.beginPath();
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.roundRect(bx, by, w, h, borderRadius);
            } else {
                ctx.rect(bx, by, w, h);
            }
            ctx.clip();
            ctx.shadowColor = style.innerGlowColor;
            ctx.shadowBlur = style.innerGlowBlur * scaleFactor;
            ctx.lineWidth = style.innerGlowBlur * scaleFactor * 2;
            ctx.strokeStyle = style.innerGlowColor;
            ctx.beginPath();
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.roundRect(bx, by, w, h, borderRadius);
            } else {
                ctx.rect(bx, by, w, h);
            }
            ctx.stroke();
            ctx.restore();
        }

        // Border
        if (style.boxBorderWidth && style.boxBorderWidth > 0) {
            ctx.strokeStyle = style.boxBorderColor || '#ffffff';
            ctx.lineWidth = style.boxBorderWidth * scaleFactor;
            if (style.backgroundType === 'rounded' && ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(bx, by, w, h, borderRadius);
                ctx.stroke();
            } else {
                ctx.strokeRect(bx, by, w, h);
            }
        }
    } else if (style.backgroundType === 'outline') {
        ctx.strokeStyle = style.outlineColor || style.backgroundColor || '#000000';
        ctx.lineWidth = (style.outlineWidth || 2) * scaleFactor;
        ctx.lineJoin = 'round';
        ctx.strokeText(text, 0, 0);
    }

    // Text glow (separate blend mode)
    if (style.glowBlur && style.glowBlur > 0) {
        ctx.save();
        ctx.globalCompositeOperation = toCompositeOp(style.glowBlendMode);
        ctx.shadowColor = style.glowColor || '#00ff00';
        ctx.shadowBlur = style.glowBlur * scaleFactor;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = style.color || '#ffffff';
        ctx.fillText(text, 0, 0);
        ctx.shadowBlur = (style.glowBlur * 1.5) * scaleFactor;
        ctx.fillText(text, 0, 0);
        ctx.restore();
    }

    // Text drop shadow (separate blend mode)
    if ((style.textShadowBlur && style.textShadowBlur > 0) || style.textShadowOffsetX || style.textShadowOffsetY) {
        ctx.save();
        ctx.globalCompositeOperation = toCompositeOp(style.shadowBlendMode);
        ctx.shadowColor = style.textShadowColor || '#000000';
        ctx.shadowBlur = (style.textShadowBlur || 0) * scaleFactor;
        ctx.shadowOffsetX = (style.textShadowOffsetX || 0) * scaleFactor;
        ctx.shadowOffsetY = (style.textShadowOffsetY || 0) * scaleFactor;
        ctx.fillStyle = style.color || '#ffffff';
        ctx.fillText(text, 0, 0);
        ctx.restore();
    } else if (style.backgroundType !== 'box' && style.backgroundType !== 'rounded' && style.backgroundType !== 'outline' && style.backgroundType !== 'stripe') {
        // Drop shadow for plain text (no background)
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4 * scaleFactor;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2 * scaleFactor;
    } else {
        ctx.shadowColor = 'transparent';
    }

    // Text fill with blend mode
    ctx.save();
    const plainTextOp = toCompositeOp(style.textBlendMode);
    const plainGradStops = resolveGradientStops(style);
    if (style.gradientType && style.gradientType !== 'none' && plainGradStops) {
        ctx.globalCompositeOperation = toCompositeOp(style.gradientBlendMode) !== 'source-over'
            ? toCompositeOp(style.gradientBlendMode) : plainTextOp;
        const textWidth = ctx.measureText(text).width;
        const hw = textWidth / 2;
        const hh = fontSize / 2;
        let gradient: CanvasGradient;
        if (style.gradientType === 'radial') {
            gradient = ctx.createRadialGradient(0, -hh, 0, 0, -hh, Math.max(hw, hh));
        } else {
            const angle = (style.gradientAngle || 0) * Math.PI / 180;
            gradient = ctx.createLinearGradient(
                Math.cos(angle + Math.PI) * hw,
                -hh + Math.sin(angle + Math.PI) * hh,
                Math.cos(angle) * hw,
                -hh + Math.sin(angle) * hh
            );
        }
        applyStopsToCanvasGradient(gradient, plainGradStops);
        ctx.fillStyle = gradient;
    } else {
        ctx.globalCompositeOperation = plainTextOp;
        ctx.fillStyle = style.color || '#ffffff';
    }

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.fillText(text, 0, 0);
    ctx.restore();
}
