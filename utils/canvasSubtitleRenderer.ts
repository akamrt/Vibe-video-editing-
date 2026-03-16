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
import { getActiveWordInfo, lerp, type WordTiming } from './wordHighlightUtils';

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

// ─── Template Style Merge ─────────────────────────────────────────────────────

/**
 * Merges template CSS properties as fallback values for the SubtitleStyle.
 * Mirrors the viewport logic: `{ ...templateStyleNoSize, ...styles.text }`
 * Template fontSize is excluded (viewport strips it too).
 */
function mergeTemplateStyle(style: SubtitleStyle, tplStyle: Record<string, any>): SubtitleStyle {
    const merged = { ...style };
    // Font family: use template if base doesn't have one
    if (!merged.fontFamily && tplStyle.fontFamily) merged.fontFamily = tplStyle.fontFamily;
    // Color: use template if base doesn't have one
    if (!merged.color && tplStyle.color) merged.color = tplStyle.color;
    // Bold: template fontWeight as fallback
    if (merged.bold === undefined && tplStyle.fontWeight) merged.bold = tplStyle.fontWeight === 'bold';
    // Italic: template fontStyle as fallback
    if (merged.italic === undefined && tplStyle.fontStyle) merged.italic = tplStyle.fontStyle === 'italic';
    // Text align: use template as fallback
    if (!merged.textAlign && tplStyle.textAlign) merged.textAlign = tplStyle.textAlign;
    return merged;
}

// ─── Text Transform Helper (canvas doesn't support CSS textTransform) ────────

function applyTextTransform(text: string, transform?: string): string {
    if (!transform || transform === 'none') return text;
    if (transform === 'uppercase') return text.toUpperCase();
    if (transform === 'lowercase') return text.toLowerCase();
    if (transform === 'capitalize') return text.replace(/\b\w/g, c => c.toUpperCase());
    return text;
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
    wordEmphases?: KeywordEmphasis[],
    keywordAnimation?: TextAnimation | null
): ElementAnimValues[] {
    // Build emphasis map (always word-indexed)
    const emphasisMap = new Map<number, KeywordEmphasis>();
    if (wordEmphases) {
        for (const kw of wordEmphases) {
            if (kw.enabled) emphasisMap.set(kw.wordIndex, kw);
        }
    }

    // For 'line' scope: split on \n, each line gets its own stagger delay
    // This matches AnimatedText which renders each line as a separate flex item
    if (animation.scope === 'line') {
        const lines = text.split('\n');
        const result: ElementAnimValues[] = [];
        let globalWordIdx = 0;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            // Each line has its own stagger delay
            const delaySec = lineIdx * (animation.stagger ?? 0);
            const delayFrames = delaySec * fps;
            const elmLocalFrame = frame - delayFrames;

            let baseOpacity = 1, baseScale = 1, baseTx = 0, baseTy = 0;
            let baseRotate = 0, baseBlur = 0, baseLs = 0;

            for (const effect of animation.effects) {
                const val = computeEffectValue(effect, elmLocalFrame, animation.duration, fps);
                switch (effect.type) {
                    case 'opacity': baseOpacity *= val; break;
                    case 'scale': baseScale *= val; break;
                    case 'translateX': baseTx += val; break;
                    case 'translateY': baseTy += val; break;
                    case 'rotate': baseRotate += val; break;
                    case 'blur': baseBlur = Math.max(0, baseBlur + val); break;
                    case 'letterSpacing': baseLs += val; break;
                }
            }
            baseOpacity = Math.max(0, Math.min(1, baseOpacity));

            // Split line into words for keyword coloring
            const tokens = lines[lineIdx].split(/(\s+)/);
            for (const token of tokens) {
                if (/^\s+$/.test(token)) {
                    result.push({
                        text: token, opacity: baseOpacity, scaleVal: baseScale,
                        translateX: baseTx, translateY: baseTy, rotate: baseRotate,
                        blur: baseBlur, letterSpacing: baseLs,
                        isKeyword: false, keywordColor: null,
                    });
                    continue;
                }
                const kwEntry = emphasisMap.get(globalWordIdx);
                const isKw = !!kwEntry;

                // Apply keyword animation on top of base line animation
                let finalOpacity = baseOpacity, finalScale = baseScale, finalTx = baseTx, finalTy = baseTy;
                let finalRotate = baseRotate, finalBlur = baseBlur, finalLs = baseLs;
                if (isKw && keywordAnimation) {
                    const kwDelay = globalWordIdx * (keywordAnimation.stagger ?? 0) * fps;
                    const kwFrame = frame - kwDelay;
                    let kwOp = 1, kwSc = 1, kwTx = 0, kwTy = 0, kwRot = 0, kwBl = 0, kwLs = 0;
                    for (const effect of keywordAnimation.effects) {
                        const val = computeEffectValue(effect, kwFrame, keywordAnimation.duration, fps);
                        switch (effect.type) {
                            case 'opacity': kwOp *= val; break;
                            case 'scale': kwSc *= val; break;
                            case 'translateX': kwTx += val; break;
                            case 'translateY': kwTy += val; break;
                            case 'rotate': kwRot += val; break;
                            case 'blur': kwBl = Math.max(0, kwBl + val); break;
                            case 'letterSpacing': kwLs += val; break;
                        }
                    }
                    kwOp = Math.max(0, Math.min(1, kwOp));
                    finalOpacity = baseOpacity * kwOp;
                    finalScale = baseScale * kwSc;
                    finalTx = baseTx + kwTx;
                    finalTy = baseTy + kwTy;
                    finalRotate = baseRotate + kwRot;
                    finalBlur = Math.max(0, baseBlur + kwBl);
                    finalLs = baseLs + kwLs;
                }

                result.push({
                    text: token, opacity: finalOpacity, scaleVal: finalScale,
                    translateX: finalTx, translateY: finalTy, rotate: finalRotate,
                    blur: finalBlur, letterSpacing: finalLs,
                    isKeyword: isKw,
                    keywordColor: isKw ? (kwEntry!.color || '#FFD700') : null,
                });
                globalWordIdx++;
            }

            // Add a newline marker between lines (except after last)
            if (lineIdx < lines.length - 1) {
                result.push({
                    text: '\n', opacity: 1, scaleVal: 1,
                    translateX: 0, translateY: 0, rotate: 0,
                    blur: 0, letterSpacing: 0,
                    isKeyword: false, keywordColor: null,
                });
            }
        }
        return result;
    }

    // For 'element' scope: animate as a single block, split into words for keyword coloring
    if (animation.scope !== 'word' && animation.scope !== 'character') {
        // Compute the element-level animation (for the whole block)
        const delaySec = 0 * (animation.stagger ?? 0);
        const delayFrames = delaySec * fps;
        const elmLocalFrame = frame - delayFrames;

        let baseOpacity = 1, baseScale = 1, baseTx = 0, baseTy = 0;
        let baseRotate = 0, baseBlur = 0, baseLs = 0;

        for (const effect of animation.effects) {
            const val = computeEffectValue(effect, elmLocalFrame, animation.duration, fps);
            switch (effect.type) {
                case 'opacity': baseOpacity *= val; break;
                case 'scale': baseScale *= val; break;
                case 'translateX': baseTx += val; break;
                case 'translateY': baseTy += val; break;
                case 'rotate': baseRotate += val; break;
                case 'blur': baseBlur = Math.max(0, baseBlur + val); break;
                case 'letterSpacing': baseLs += val; break;
            }
        }
        baseOpacity = Math.max(0, Math.min(1, baseOpacity));

        // Now split the text into individual words/spaces for per-word keyword coloring
        const tokens = text.split(/(\s+)/);
        let globalWordIdx = 0;
        return tokens.map((token: string) => {
            if (/^\s+$/.test(token)) {
                return {
                    text: token, opacity: baseOpacity, scaleVal: baseScale,
                    translateX: baseTx, translateY: baseTy, rotate: baseRotate,
                    blur: baseBlur, letterSpacing: baseLs,
                    isKeyword: false, keywordColor: null,
                };
            }
            const kwEntry = emphasisMap.get(globalWordIdx);
            const isKw = !!kwEntry;

            // If keyword has a dedicated animation, apply it on top
            let kwOpacity = baseOpacity, kwScale = baseScale, kwTx = baseTx, kwTy = baseTy;
            let kwRotate = baseRotate, kwBlur = baseBlur, kwLs = baseLs;
            if (isKw && keywordAnimation) {
                const kwDelay = globalWordIdx * (keywordAnimation.stagger ?? 0) * fps;
                const kwFrame = frame - kwDelay;
                // Reset to defaults and apply keyword animation
                kwOpacity = 1; kwScale = 1; kwTx = 0; kwTy = 0;
                kwRotate = 0; kwBlur = 0; kwLs = 0;
                for (const effect of keywordAnimation.effects) {
                    const val = computeEffectValue(effect, kwFrame, keywordAnimation.duration, fps);
                    switch (effect.type) {
                        case 'opacity': kwOpacity *= val; break;
                        case 'scale': kwScale *= val; break;
                        case 'translateX': kwTx += val; break;
                        case 'translateY': kwTy += val; break;
                        case 'rotate': kwRotate += val; break;
                        case 'blur': kwBlur = Math.max(0, kwBlur + val); break;
                        case 'letterSpacing': kwLs += val; break;
                    }
                }
                kwOpacity = Math.max(0, Math.min(1, kwOpacity));
                // Combine: base line animation + keyword animation
                kwOpacity *= baseOpacity;
                kwScale *= baseScale;
                kwTx += baseTx;
                kwTy += baseTy;
                kwRotate += baseRotate;
            }

            const result: ElementAnimValues = {
                text: token,
                opacity: isKw && keywordAnimation ? kwOpacity : baseOpacity,
                scaleVal: isKw && keywordAnimation ? kwScale : baseScale,
                translateX: isKw && keywordAnimation ? kwTx : baseTx,
                translateY: isKw && keywordAnimation ? kwTy : baseTy,
                rotate: isKw && keywordAnimation ? kwRotate : baseRotate,
                blur: isKw && keywordAnimation ? kwBlur : baseBlur,
                letterSpacing: isKw && keywordAnimation ? kwLs : baseLs,
                isKeyword: isKw,
                keywordColor: isKw ? (kwEntry!.color || '#FFD700') : null,
            };
            globalWordIdx++;
            return result;
        });
    }

    // --- Word scope (or character scope) ---
    let elements: string[];
    if (animation.scope === 'character') elements = text.split('');
    else elements = text.split(/(\s+)/); // word scope

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

        // Determine effective animation: keyword words use keywordAnimation if available
        const isKw = emphasisMap.has(staggerIndex);
        const useKwAnim = keywordAnimation && animation.scope === 'word' && isKw;
        const effectiveAnim = useKwAnim ? keywordAnimation! : animation;

        const delaySec = staggerIndex * (effectiveAnim.stagger ?? 0);
        const delayFrames = delaySec * fps;
        const elmLocalFrame = frame - delayFrames;

        let opacity = 1;
        let scaleVal = 1;
        let translateX = 0;
        let translateY = 0;
        let rotate = 0;
        let blur = 0;
        let letterSpacing = 0;

        for (const effect of effectiveAnim.effects) {
            if (effect.wordTarget && emphasisMap.size > 0 && effectiveAnim.scope === 'word') {
                const isKeyword = emphasisMap.has(staggerIndex);
                if (effect.wordTarget.mode === 'keywords' && !isKeyword) continue;
                if (effect.wordTarget.mode === 'non-keywords' && isKeyword) continue;
                if (effect.wordTarget.mode === 'indices' &&
                    !effect.wordTarget.indices.includes(staggerIndex)) continue;
            }
            const val = computeEffectValue(effect, elmLocalFrame, effectiveAnim.duration, fps);

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

        const keywordColor = isKw ? (emphasisMap.get(staggerIndex)!.color || '#FFD700') : null;

        return { text: el, opacity, scaleVal, translateX, translateY, rotate, blur, letterSpacing, isKeyword: isKw, keywordColor };
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
    /** Separate animation applied only to keyword words (overrides main animation for those words) */
    keywordAnimation?: TextAnimation | null;
    // ── Word highlight box (karaoke) ──
    wordTimings?: WordTiming[];
    sourceTime?: number;
    eventStartTime?: number;
    eventEndTime?: number;
}

// ─── Word Highlight Box Helpers ───────────────────────────────────────────────

interface CanvasWordRect {
    x: number;  // left edge (canvas-local coords)
    y: number;  // approximate top edge
    width: number;
    height: number;
}

/**
 * Compute per-word bounding boxes in canvas-local coordinates (after subtitle center transforms).
 * This is used for the karaoke highlight box and works independently of animation scope.
 */
function computeWordCanvasRects(
    text: string,
    ctx: CanvasRenderingContext2D,
    fontSize: number,
    lineHeight: number,
    textAlign: string,
    outputWidth: number,
    textPaddingH: number,
): CanvasWordRect[] {
    const textLines = text.split('\n');
    const result: CanvasWordRect[] = [];
    const numLines = textLines.length;
    const lineYStart = numLines > 1 ? -((numLines * lineHeight) - lineHeight) / 2 : 0;

    for (let li = 0; li < textLines.length; li++) {
        const line = textLines[li];
        const lineWidth = ctx.measureText(line).width;
        const lineY = lineYStart + li * lineHeight;

        let lineStartX: number;
        if (textAlign === 'left') {
            lineStartX = -(outputWidth * 0.45) + textPaddingH;
        } else if (textAlign === 'right') {
            lineStartX = (outputWidth * 0.45) - lineWidth - textPaddingH;
        } else {
            lineStartX = -(lineWidth / 2);
        }

        const tokens = line.split(/(\s+)/);
        let xPos = lineStartX;
        for (const token of tokens) {
            const tokenWidth = ctx.measureText(token).width;
            if (!/^\s+$/.test(token)) {
                result.push({
                    x: xPos,
                    y: lineY - fontSize * 1.1,
                    width: tokenWidth,
                    height: fontSize * 1.3,
                });
            }
            xPos += tokenWidth;
        }
    }
    return result;
}

/**
 * Draw the karaoke word highlight box for the active (currently-spoken) word.
 * Uses stateless position interpolation so it works frame-by-frame in canvas export.
 */
function drawWordHighlightBox(
    ctx: CanvasRenderingContext2D,
    text: string,
    style: SubtitleStyle,
    scaleFactor: number,
    fontSize: number,
    lineHeight: number,
    textPaddingH: number,
    outputWidth: number,
    wordTimings: WordTiming[] | undefined,
    eventStartTime: number,
    eventEndTime: number,
    sourceTime: number,
): void {
    const hlColor = style.wordHighlightColor ?? '#FFD700';
    const hlOpacity = style.wordHighlightOpacity ?? 0.85;
    const paddingH = (style.wordHighlightPaddingH ?? 4) * scaleFactor;
    const paddingV = (style.wordHighlightPaddingV ?? 2) * scaleFactor;
    const hlRadius = (style.wordHighlightBorderRadius ?? 4) * scaleFactor;
    const hlScale = style.wordHighlightScale ?? 1.0;
    const hlBlendMode = style.wordHighlightBlendMode ?? 'normal';
    const shadowColor = style.wordHighlightShadowColor;
    const shadowBlur = (style.wordHighlightShadowBlur ?? 0) * scaleFactor;
    const shadowX = (style.wordHighlightShadowOffsetX ?? 0) * scaleFactor;
    const shadowY = (style.wordHighlightShadowOffsetY ?? 0) * scaleFactor;
    const glowColor = style.wordHighlightGlowColor;
    const glowBlur = (style.wordHighlightGlowBlur ?? 0) * scaleFactor;

    const align = style.textAlign || 'center';
    const wordRects = computeWordCanvasRects(text, ctx, fontSize, lineHeight, align, outputWidth, textPaddingH);
    if (wordRects.length === 0) return;

    const info = getActiveWordInfo(wordTimings, eventStartTime, eventEndTime, text, sourceTime);
    const activeIdx = Math.max(0, Math.min(info.activeIndex, wordRects.length - 1));
    const activeRect = wordRects[activeIdx];

    // Interpolate toward next word during gap between words
    let finalRect = { ...activeRect };
    if (info.gapProgress > 0 && info.nextIndex >= 0 && info.nextIndex < wordRects.length) {
        const nextRect = wordRects[info.nextIndex];
        const t = info.gapProgress;
        finalRect = {
            x: lerp(activeRect.x, nextRect.x, t),
            y: lerp(activeRect.y, nextRect.y, t),
            width: lerp(activeRect.width, nextRect.width, t),
            height: lerp(activeRect.height, nextRect.height, t),
        };
    }

    // Apply padding and scale
    const baseW = finalRect.width + 2 * paddingH;
    const baseH = finalRect.height + 2 * paddingV;
    const scaledW = baseW * hlScale;
    const scaledH = baseH * hlScale;
    const bx = finalRect.x - paddingH - (scaledW - baseW) / 2;
    const by = finalRect.y - paddingV - (scaledH - baseH) / 2;

    // Parse hex color to RGBA
    const clean = (hlColor.startsWith('#') ? hlColor.slice(1) : hlColor);
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;

    ctx.save();
    ctx.globalCompositeOperation = toCompositeOp(hlBlendMode);

    // Glow
    if (glowColor && glowBlur > 0) {
        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = `rgba(${r},${g},${b},${hlOpacity})`;
        if (ctx.roundRect && hlRadius > 0) {
            ctx.beginPath();
            ctx.roundRect(bx, by, scaledW, scaledH, hlRadius);
            ctx.fill();
        } else {
            ctx.fillRect(bx, by, scaledW, scaledH);
        }
        ctx.shadowBlur = glowBlur * 1.5;
        if (ctx.roundRect && hlRadius > 0) {
            ctx.beginPath();
            ctx.roundRect(bx, by, scaledW, scaledH, hlRadius);
            ctx.fill();
        } else {
            ctx.fillRect(bx, by, scaledW, scaledH);
        }
        ctx.restore();
    }

    // Shadow
    if (shadowColor && (shadowBlur > 0 || shadowX !== 0 || shadowY !== 0)) {
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = shadowBlur;
        ctx.shadowOffsetX = shadowX;
        ctx.shadowOffsetY = shadowY;
    } else {
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    }

    ctx.fillStyle = `rgba(${r},${g},${b},${hlOpacity})`;
    if (ctx.roundRect && hlRadius > 0) {
        ctx.beginPath();
        ctx.roundRect(bx, by, scaledW, scaledH, hlRadius);
        ctx.fill();
    } else {
        ctx.fillRect(bx, by, scaledW, scaledH);
    }

    ctx.restore();
}

/**
 * Draws a subtitle on a canvas, with full animation support matching the viewport.
 *
 * The scaleFactor is `outputHeight / viewportSafeZoneHeight`, which ensures that
 * a 16px font in a 360px viewport becomes 48px in a 1080p export (same visual ratio).
 */
export function drawSubtitleOnCanvas(opts: DrawSubtitleOptions): void {
    const {
        ctx, text: rawText, style: rawStyle, templateStyle, animation,
        frame, fps, outputWidth, outputHeight,
        viewportSafeZoneHeight,
        totalTx, totalTy, totalScale, totalRotation,
        wordEmphases, keywordAnimation,
        wordTimings, sourceTime, eventStartTime, eventEndTime,
    } = opts;

    // Merge templateStyle into the effective style (template is fallback, style wins)
    // This mirrors the viewport logic: { ...templateStyleNoSize, ...styles.text }
    const style = templateStyle
        ? mergeTemplateStyle(rawStyle, templateStyle)
        : rawStyle;

    // Apply text transform (canvas doesn't support CSS textTransform)
    const text = applyTextTransform(rawText, (style as any).textTransform);

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

    // If no animation or empty effects AND no keyword animation, draw plain text (simple path)
    if ((!animation || animation.effects.length === 0) && !keywordAnimation) {
        drawPlainText(ctx, text, style, fontSize, scaleFactor, textPaddingV, textPaddingH, outputWidth, wordEmphases,
            wordTimings, sourceTime, eventStartTime, eventEndTime);
        ctx.restore();
        return;
    }

    // If we have a keyword animation but no base animation, synthesize a no-op word-scope
    // animation so keywords still get their animation effects computed and rendered
    const effectiveAnimation: TextAnimation = (animation && animation.effects.length > 0)
        ? animation
        : { id: '', name: '', effects: [], duration: keywordAnimation!.duration, scope: 'word', stagger: 0 };

    // Compute per-element animation values
    const elements = computeElementAnimations(text, effectiveAnimation, frame, fps, wordEmphases, keywordAnimation);

    // Check if we have multi-line content (line-scope or text with \n)
    const hasNewlines = elements.some(el => el.text === '\n');

    // Measure all elements (skip newline markers)
    const elementWidths = elements.map((el: ElementAnimValues) => {
        if (el.text === '\n') return 0;
        return ctx.measureText(el.text).width;
    });

    // For multi-line: compute per-line widths and layout
    const lineHeight = fontSize * 1.4;
    let lines: { startIdx: number; endIdx: number; width: number }[] = [];
    if (hasNewlines) {
        let lineStart = 0;
        let lineW = 0;
        for (let i = 0; i < elements.length; i++) {
            if (elements[i].text === '\n') {
                lines.push({ startIdx: lineStart, endIdx: i, width: lineW });
                lineStart = i + 1;
                lineW = 0;
            } else {
                lineW += elementWidths[i];
            }
        }
        // Last line
        lines.push({ startIdx: lineStart, endIdx: elements.length, width: lineW });
    } else {
        const totalWidth = elementWidths.reduce((sum: number, w: number) => sum + w, 0);
        lines = [{ startIdx: 0, endIdx: elements.length, width: totalWidth }];
    }

    const totalWidth = Math.max(...lines.map(l => l.width));
    const totalTextHeight = lines.length * lineHeight;
    const lineYStart = lines.length > 1 ? -(totalTextHeight - lineHeight) / 2 : 0;

    // Compute xOffset for each line based on alignment
    const align = style.textAlign || 'center';
    function computeLineXOffset(lineWidth: number): number {
        if (align === 'left') {
            return -(outputWidth * 0.45) + textPaddingH;
        } else if (align === 'right') {
            return (outputWidth * 0.45) - lineWidth - textPaddingH;
        } else {
            return -lineWidth / 2;
        }
    }

    // Draw background behind the full text block
    if (style.backgroundType === 'box' || style.backgroundType === 'rounded') {
        const bgX = -(totalWidth / 2) - textPaddingH;
        const bgY = lineYStart - (fontSize * 1.2 + textPaddingV); // Account for line height ~1.2 + padding top
        const bgW = totalWidth + textPaddingH * 2;
        const bgH = totalTextHeight + textPaddingV * 2;

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

    // Draw word highlight box (karaoke) — after backgrounds, before text
    if (style.wordHighlightEnabled && sourceTime != null) {
        drawWordHighlightBox(
            ctx, text, style, scaleFactor, fontSize, lineHeight,
            textPaddingH, outputWidth,
            wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, sourceTime,
        );
    }

    // Compute active word index for idle-opacity and active-color in element loop
    const hlActiveIdx = (style.wordHighlightEnabled && sourceTime != null)
        ? getActiveWordInfo(wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, text, sourceTime).activeIndex
        : -1;
    const hlIdleOpacity = style.wordHighlightIdleOpacity ?? 1.0;
    const hlActiveColor = style.wordHighlightActiveColor || null;
    const applyHl = hlActiveIdx >= 0 && (hlIdleOpacity < 1 || hlActiveColor);

    // Draw each element with its animation applied
    // Track current line for multi-line vertical positioning
    let currentLineIdx = 0;
    let xOffset = computeLineXOffset(lines[0].width);
    let yOffset = lineYStart;
    // Track global word index for highlight (same counting as getActiveWordInfo)
    let hlWordIdx = 0;

    for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const elWidth = elementWidths[i];

        // Handle newline markers: move to next line
        if (el.text === '\n') {
            currentLineIdx++;
            if (currentLineIdx < lines.length) {
                xOffset = computeLineXOffset(lines[currentLineIdx].width);
                yOffset = lineYStart + currentLineIdx * lineHeight;
            }
            continue;
        }

        if (el.opacity <= 0.01) {
            if (!/^\s+$/.test(el.text)) hlWordIdx++;
            xOffset += elWidth;
            continue;
        }

        // Determine highlight state for this word element
        const elIsWhitespace = /^\s+$/.test(el.text);
        const elWordIdx = elIsWhitespace ? -1 : hlWordIdx;
        if (!elIsWhitespace) hlWordIdx++;
        const isActiveWord = applyHl && elWordIdx === hlActiveIdx;
        const isIdleWord = applyHl && !isActiveWord && elWordIdx >= 0 && hlIdleOpacity < 1;

        ctx.save();

        // Move to this element's position (center of element)
        ctx.translate(xOffset + elWidth / 2, yOffset);

        // Apply per-element animation transforms
        // AnimatedText uses raw px for translate values, scale to canvas
        ctx.translate(el.translateX * scaleFactor, el.translateY * scaleFactor);
        if (el.rotate !== 0) ctx.rotate(el.rotate * Math.PI / 180);
        if (el.scaleVal !== 1) ctx.scale(el.scaleVal, el.scaleVal);

        ctx.globalAlpha = isIdleWord ? el.opacity * hlIdleOpacity : el.opacity;

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
            ctx.fillStyle = isActiveWord && hlActiveColor
                ? hlActiveColor
                : el.isKeyword && el.keywordColor ? el.keywordColor : (style.color || '#ffffff');
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
            ctx.fillStyle = isActiveWord && hlActiveColor
                ? hlActiveColor
                : el.isKeyword && el.keywordColor ? el.keywordColor : (style.color || '#ffffff');
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
            ctx.fillStyle = isActiveWord && hlActiveColor
                ? hlActiveColor
                : el.isKeyword && el.keywordColor ? el.keywordColor : (style.color || '#ffffff');
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
    outputWidth: number,
    wordEmphases?: KeywordEmphasis[],
    wordTimings?: WordTiming[],
    sourceTime?: number,
    eventStartTime?: number,
    eventEndTime?: number,
): void {
    ctx.textAlign = (style.textAlign as CanvasTextAlign) || 'center';
    ctx.textBaseline = 'alphabetic';

    // Build keyword emphasis map for per-word coloring
    const emphasisMap = new Map<number, KeywordEmphasis>();
    if (wordEmphases) {
        for (const kw of wordEmphases) {
            if (kw.enabled) emphasisMap.set(kw.wordIndex, kw);
        }
    }

    // Handle multi-line text: split on \n, draw each line with proper spacing
    const lines = text.split('\n');
    const lineHeight = fontSize * 1.4;
    const totalTextHeight = lines.length * lineHeight;
    // Offset to center all lines vertically around the baseline position (y=0)
    const lineYStart = lines.length > 1 ? -(totalTextHeight - lineHeight) / 2 : 0;

    // Background
    if (style.backgroundType === 'box' || style.backgroundType === 'rounded') {
        // For multi-line, measure the widest line for background width
        const maxLineWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
        const w = maxLineWidth + textPaddingH * 2;
        const h = totalTextHeight + textPaddingV * 2;
        const bx = -(w / 2);
        const by = lineYStart - (fontSize * 1.2 + textPaddingV);

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
        // Outline each line
        for (let li = 0; li < lines.length; li++) {
            ctx.strokeText(lines[li], 0, lineYStart + li * lineHeight);
        }
    }

    // Draw word highlight box (karaoke) — after background, before text
    if (style.wordHighlightEnabled && sourceTime != null) {
        drawWordHighlightBox(
            ctx, text, style, scaleFactor, fontSize, lineHeight,
            textPaddingH, outputWidth,
            wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, sourceTime,
        );
    }

    // Compute active word index for per-word coloring
    const ptHlActiveIdx = (style.wordHighlightEnabled && sourceTime != null)
        ? getActiveWordInfo(wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, text, sourceTime).activeIndex
        : -1;
    const ptHlIdleOpacity = style.wordHighlightIdleOpacity ?? 1.0;
    const ptHlActiveColor = style.wordHighlightActiveColor || null;
    const ptApplyHl = ptHlActiveIdx >= 0 && (ptHlIdleOpacity < 1 || ptHlActiveColor);

    // Text glow (separate blend mode)
    if (style.glowBlur && style.glowBlur > 0) {
        ctx.save();
        ctx.globalCompositeOperation = toCompositeOp(style.glowBlendMode);
        ctx.shadowColor = style.glowColor || '#00ff00';
        ctx.shadowBlur = style.glowBlur * scaleFactor;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = style.color || '#ffffff';
        for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], 0, lineYStart + li * lineHeight);
        }
        ctx.shadowBlur = (style.glowBlur * 1.5) * scaleFactor;
        for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], 0, lineYStart + li * lineHeight);
        }
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
        for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], 0, lineYStart + li * lineHeight);
        }
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

    // Text fill with blend mode — with per-word keyword coloring
    ctx.save();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    const plainTextOp = toCompositeOp(style.textBlendMode);
    const plainGradStops = resolveGradientStops(style);
    const hasGradient = style.gradientType && style.gradientType !== 'none' && plainGradStops;
    const hasKeywords = emphasisMap.size > 0;

    if (hasKeywords || ptApplyHl) {
        // Per-word rendering for keyword coloring + word highlight styling
        ctx.textAlign = 'left';
        let globalWordIdx = 0;

        for (let li = 0; li < lines.length; li++) {
            const lineY = lineYStart + li * lineHeight;
            const tokens = lines[li].split(/(\s+)/);
            const lineWidth = ctx.measureText(lines[li]).width;

            // Calculate starting X for alignment
            let xPos: number;
            const align = style.textAlign || 'center';
            if (align === 'left') {
                xPos = -(lineWidth / 2);
            } else if (align === 'right') {
                xPos = lineWidth / 2 - lineWidth;
            } else {
                xPos = -(lineWidth / 2);
            }

            for (const token of tokens) {
                const tokenWidth = ctx.measureText(token).width;
                if (/^\s+$/.test(token)) {
                    // Whitespace — just advance position
                    xPos += tokenWidth;
                    continue;
                }

                const kwEntry = emphasisMap.get(globalWordIdx);
                const isActiveToken = ptApplyHl && globalWordIdx === ptHlActiveIdx;
                const isIdleToken = ptApplyHl && !isActiveToken && ptHlIdleOpacity < 1;

                // Apply idle word opacity
                if (isIdleToken) {
                    ctx.globalAlpha = ptHlIdleOpacity;
                } else {
                    ctx.globalAlpha = 1;
                }

                if (isActiveToken && ptHlActiveColor) {
                    // Active word with highlight color override
                    ctx.globalCompositeOperation = plainTextOp;
                    ctx.fillStyle = ptHlActiveColor;
                    ctx.fillText(token, xPos, lineY);
                } else if (kwEntry) {
                    // Keyword: draw with keyword color
                    ctx.globalCompositeOperation = plainTextOp;
                    ctx.fillStyle = kwEntry.color || '#FFD700';
                    ctx.fillText(token, xPos, lineY);

                    // Underline (matching viewport)
                    const underlineY = lineY + 2 * scaleFactor;
                    ctx.strokeStyle = kwEntry.color || '#FFD700';
                    ctx.lineWidth = 1 * scaleFactor;
                    ctx.beginPath();
                    ctx.moveTo(xPos, underlineY);
                    ctx.lineTo(xPos + tokenWidth, underlineY);
                    ctx.stroke();
                } else if (hasGradient) {
                    // Non-keyword with gradient
                    const hw = tokenWidth / 2;
                    const hh = fontSize / 2;
                    const gradOp = toCompositeOp(style.gradientBlendMode);
                    ctx.globalCompositeOperation = gradOp !== 'source-over' ? gradOp : plainTextOp;
                    let gradient: CanvasGradient;
                    if (style.gradientType === 'radial') {
                        gradient = ctx.createRadialGradient(xPos + hw, lineY - hh, 0, xPos + hw, lineY - hh, Math.max(hw, hh));
                    } else {
                        const angle = (style.gradientAngle || 0) * Math.PI / 180;
                        gradient = ctx.createLinearGradient(
                            xPos + hw + Math.cos(angle + Math.PI) * hw,
                            lineY - hh + Math.sin(angle + Math.PI) * hh,
                            xPos + hw + Math.cos(angle) * hw,
                            lineY - hh + Math.sin(angle) * hh
                        );
                    }
                    applyStopsToCanvasGradient(gradient, plainGradStops!);
                    ctx.fillStyle = gradient;
                    ctx.fillText(token, xPos, lineY);
                } else {
                    // Non-keyword, no gradient
                    ctx.globalCompositeOperation = plainTextOp;
                    ctx.fillStyle = style.color || '#ffffff';
                    ctx.fillText(token, xPos, lineY);
                }

                globalWordIdx++;
                xPos += tokenWidth;
            }
        }
        ctx.globalAlpha = 1; // restore
    } else if (hasGradient) {
        // No keywords, but has gradient — draw all lines with gradient
        ctx.globalCompositeOperation = toCompositeOp(style.gradientBlendMode) !== 'source-over'
            ? toCompositeOp(style.gradientBlendMode) : plainTextOp;
        for (let li = 0; li < lines.length; li++) {
            const lineText = lines[li];
            const lineY = lineYStart + li * lineHeight;
            const textWidth = ctx.measureText(lineText).width;
            const hw = textWidth / 2;
            const hh = fontSize / 2;
            let gradient: CanvasGradient;
            if (style.gradientType === 'radial') {
                gradient = ctx.createRadialGradient(0, lineY - hh, 0, 0, lineY - hh, Math.max(hw, hh));
            } else {
                const angle = (style.gradientAngle || 0) * Math.PI / 180;
                gradient = ctx.createLinearGradient(
                    Math.cos(angle + Math.PI) * hw,
                    lineY - hh + Math.sin(angle + Math.PI) * hh,
                    Math.cos(angle) * hw,
                    lineY - hh + Math.sin(angle) * hh
                );
            }
            applyStopsToCanvasGradient(gradient, plainGradStops!);
            ctx.fillStyle = gradient;
            ctx.fillText(lineText, 0, lineY);
        }
    } else {
        // Simple: no keywords, no gradient — just draw each line
        ctx.globalCompositeOperation = plainTextOp;
        ctx.fillStyle = style.color || '#ffffff';
        for (let li = 0; li < lines.length; li++) {
            ctx.fillText(lines[li], 0, lineYStart + li * lineHeight);
        }
    }

    ctx.restore();
}
