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
import { getActiveWordInfo, getWordFlightProgress, lerp, easeOutCubic, lerpColor, type WordTiming } from './wordHighlightUtils';

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

/**
 * Word-wrap a single line of text at word boundaries to fit within maxWidth.
 * Returns an array of wrapped lines.
 */
function wrapLine(ctx: CanvasRenderingContext2D, line: string, maxWidth: number): string[] {
    if (maxWidth <= 0 || !line) return [line];
    const measured = ctx.measureText(line).width;
    if (measured <= maxWidth) return [line];

    const words = line.split(/(\s+)/);
    const result: string[] = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine + word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine.length > 0) {
            result.push(currentLine);
            // If the word is whitespace, don't start a new line with it
            currentLine = /^\s+$/.test(word) ? '' : word;
        } else {
            currentLine = testLine;
        }
    }
    if (currentLine) result.push(currentLine);
    return result.length > 0 ? result : [line];
}

/**
 * Split text into visual lines: first by explicit \n, then word-wrap each.
 */
function splitAndWrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const explicitLines = text.split('\n');
    const result: string[] = [];
    for (const line of explicitLines) {
        const wrapped = wrapLine(ctx, line, maxWidth);
        result.push(...wrapped);
    }
    return result;
}

/**
 * Post-process a split(/(\s+)/) array so that \n characters are always
 * isolated as their own tokens. Without this, " \n" or "\n " get grouped
 * as a single whitespace token and newline detection fails.
 */
function splitNewlinesFromWhitespace(tokens: string[]): string[] {
    const result: string[] = [];
    for (const token of tokens) {
        if (/^\s+$/.test(token) && token.includes('\n')) {
            const parts = token.split('\n');
            for (let i = 0; i < parts.length; i++) {
                if (parts[i]) result.push(parts[i]);
                if (i < parts.length - 1) result.push('\n');
            }
        } else {
            result.push(token);
        }
    }
    return result;
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
        const tokens = splitNewlinesFromWhitespace(text.split(/(\s+)/));
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
    else elements = splitNewlinesFromWhitespace(text.split(/(\s+)/)); // word scope

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
    /** If provided, positions text from top instead of bottom (for titles) */
    topOffset?: number;
    /** Global opacity multiplier (0-1), for fade-in/fade-out effects */
    globalOpacity?: number;
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
    const maxTextWidth = outputWidth * 0.9 - textPaddingH * 2;
    const textLines = splitAndWrapText(ctx, text, maxTextWidth);
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
    frame: number,
    fps: number,
    animStagger: number,
    animDuration: number,
    wordEmphases?: KeywordEmphasis[],
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

    // In-flight fields
    const flightColorEnabled = !!style.wordHighlightFlightColorEnabled;
    const flightColor = style.wordHighlightFlightColor ?? '#FFFFFF';
    const flightColorOpacity = style.wordHighlightFlightColorOpacity ?? 1.0;
    const flightGlowEnabled = !!style.wordHighlightFlightGlowEnabled;
    const flightGlowColor = style.wordHighlightFlightGlowColor ?? hlColor;
    const flightGlowBlurFlight = (style.wordHighlightFlightGlowBlur ?? 20) * scaleFactor;
    const flightScaleEnabled = !!style.wordHighlightFlightScaleEnabled;
    const flightScale = style.wordHighlightFlightScale ?? 1.25;

    const align = style.textAlign || 'center';
    const wordRects = computeWordCanvasRects(text, ctx, fontSize, lineHeight, align, outputWidth, textPaddingH);
    if (wordRects.length === 0) return;

    const info = getActiveWordInfo(wordTimings, eventStartTime, eventEndTime, text, sourceTime);
    let activeIdx = Math.max(0, Math.min(info.activeIndex, wordRects.length - 1));

    // Skip keyword-emphasized words if enabled
    if (style.wordHighlightSkipKeywords && wordEmphases && wordEmphases.length > 0) {
        const kwSet = new Set(wordEmphases.filter(kw => kw.enabled).map(kw => kw.wordIndex));
        if (kwSet.has(activeIdx)) {
            let idx = activeIdx;
            while (idx >= 0 && kwSet.has(idx)) idx--;
            if (idx < 0) { idx = activeIdx; while (idx < wordRects.length && kwSet.has(idx)) idx++; }
            if (idx >= wordRects.length) return; // all words are keywords — nothing to highlight
            activeIdx = idx;
        }
    }

    // Compute in-flight progress based on speech timing (when word starts being spoken)
    const effectDur = animDuration > 0 ? animDuration : 0.3;
    const rawProgress = getWordFlightProgress(
        activeIdx, wordTimings, text,
        eventStartTime, eventEndTime,
        frame, fps, effectDur,
    );
    const isInFlight = rawProgress < 1;
    const easedP = easeOutCubic(rawProgress);

    // Check if active word is a keyword — keyword effects replace normal in-flight
    const kwSet = new Set((wordEmphases ?? []).filter(kw => kw.enabled).map(kw => kw.wordIndex));
    const isKeywordActive = kwSet.has(activeIdx);

    let currentHlColor: string;
    let currentHlOpacity: number;
    let currentGlowBlur: number;
    let currentGlowColor: string | null;
    let currentScale: number;

    if (isKeywordActive) {
        const kwInvert = !!style.wordHighlightKwInvertEnabled;
        const kwGlowEnabled = !!style.wordHighlightKwGlowEnabled;
        const kwEntry = (wordEmphases ?? []).find(kw => kw.enabled && kw.wordIndex === activeIdx);
        const kwColor = kwEntry?.color || '#FFD700';
        const kwGlowColor = style.wordHighlightKwGlowColor ?? kwColor;
        const kwGlowBlurVal = (style.wordHighlightKwGlowBlur ?? 30) * scaleFactor;
        const kwScaleEnabled = !!style.wordHighlightKwScaleEnabled;
        const kwScaleVal = style.wordHighlightKwScale ?? 1.4;

        if (kwInvert && isInFlight) {
            const textColor = style.wordHighlightActiveColor || '#FFFFFF';
            currentHlColor = lerpColor(textColor, hlColor, easedP);
        } else {
            currentHlColor = hlColor;
        }
        currentHlOpacity = hlOpacity;
        currentGlowBlur = (kwGlowEnabled && isInFlight) ? lerp(kwGlowBlurVal, glowBlur, easedP) : glowBlur;
        currentGlowColor = (kwGlowEnabled && isInFlight) ? kwGlowColor : (style.wordHighlightGlowColor ?? null);
        currentScale = (kwScaleEnabled && isInFlight) ? lerp(hlScale * kwScaleVal, hlScale, easedP) : hlScale;
    } else {
        currentHlColor = (flightColorEnabled && isInFlight) ? lerpColor(flightColor, hlColor, easedP) : hlColor;
        currentHlOpacity = (flightColorEnabled && isInFlight) ? lerp(flightColorOpacity, hlOpacity, easedP) : hlOpacity;
        currentGlowBlur = (flightGlowEnabled && isInFlight) ? lerp(flightGlowBlurFlight, glowBlur, easedP) : glowBlur;
        currentGlowColor = (flightGlowEnabled && isInFlight) ? flightGlowColor : (style.wordHighlightGlowColor ?? null);
        currentScale = (flightScaleEnabled && isInFlight) ? lerp(hlScale * flightScale, hlScale, easedP) : hlScale;
    }

    const activeRect = wordRects[activeIdx];

    // Smooth slide transition between words.
    // The viewport uses CSS `transition: left 150ms` for smooth movement.
    // We replicate this by lerping from the previous word's position when
    // we're at the start of a new word (within transitionMs of its start).
    const transitionMs = style.wordHighlightTransitionMs ?? 150;
    const transitionSec = transitionMs / 1000;
    let finalRect = { ...activeRect };

    if (info.gapProgress > 0 && info.nextIndex >= 0 && info.nextIndex < wordRects.length) {
        // In the gap between words — lerp toward next word
        const nextRect = wordRects[info.nextIndex];
        const t = easeOutCubic(info.gapProgress);
        finalRect = {
            x: lerp(activeRect.x, nextRect.x, t),
            y: lerp(activeRect.y, nextRect.y, t),
            width: lerp(activeRect.width, nextRect.width, t),
            height: lerp(activeRect.height, nextRect.height, t),
        };
    } else if (activeIdx > 0 && info.progress < 1) {
        // At the start of a new word — slide from previous word over transitionSec.
        // Use the word timing to compute how far into the transition we are.
        const timings = wordTimings && wordTimings.length > 0 ? wordTimings : null;
        if (timings && activeIdx < timings.length) {
            const wordStart = timings[activeIdx].start;
            const elapsed = sourceTime - wordStart;
            if (elapsed >= 0 && elapsed < transitionSec) {
                const prevRect = wordRects[activeIdx - 1];
                const t = easeOutCubic(elapsed / transitionSec);
                finalRect = {
                    x: lerp(prevRect.x, activeRect.x, t),
                    y: lerp(prevRect.y, activeRect.y, t),
                    width: lerp(prevRect.width, activeRect.width, t),
                    height: lerp(prevRect.height, activeRect.height, t),
                };
            }
        }
    }

    // Apply padding, scale, and manual offsets
    const hlOffsetX = (style.wordHighlightOffsetX ?? 0) * scaleFactor;
    const hlOffsetY = (style.wordHighlightOffsetY ?? 0) * scaleFactor;
    const baseW = finalRect.width + 2 * paddingH;
    const baseH = finalRect.height + 2 * paddingV;
    const scaledW = baseW * currentScale;
    const scaledH = baseH * currentScale;
    const bx = finalRect.x - paddingH - (scaledW - baseW) / 2 + hlOffsetX;
    const by = finalRect.y - paddingV - (scaledH - baseH) / 2 + hlOffsetY;

    // Parse current color to RGBA (handles both hex and rgb() from lerpColor)
    let r = 0, g = 0, b = 0;
    if (currentHlColor.startsWith('rgb(')) {
        const m = currentHlColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) { r = parseInt(m[1]); g = parseInt(m[2]); b = parseInt(m[3]); }
    } else {
        const clean = (currentHlColor.startsWith('#') ? currentHlColor.slice(1) : currentHlColor);
        r = parseInt(clean.slice(0, 2), 16) || 0;
        g = parseInt(clean.slice(2, 4), 16) || 0;
        b = parseInt(clean.slice(4, 6), 16) || 0;
    }

    ctx.save();
    ctx.globalCompositeOperation = toCompositeOp(hlBlendMode);

    // Glow
    if (currentGlowColor && currentGlowBlur > 0) {
        ctx.save();
        ctx.shadowColor = currentGlowColor;
        ctx.shadowBlur = currentGlowBlur;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = `rgba(${r},${g},${b},${currentHlOpacity})`;
        if (ctx.roundRect && hlRadius > 0) {
            ctx.beginPath();
            ctx.roundRect(bx, by, scaledW, scaledH, hlRadius);
            ctx.fill();
        } else {
            ctx.fillRect(bx, by, scaledW, scaledH);
        }
        ctx.shadowBlur = currentGlowBlur * 1.5;
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

    ctx.fillStyle = `rgba(${r},${g},${b},${currentHlOpacity})`;
    if (ctx.roundRect && hlRadius > 0) {
        ctx.beginPath();
        ctx.roundRect(bx, by, scaledW, scaledH, hlRadius);
        ctx.fill();
    } else {
        ctx.fillRect(bx, by, scaledW, scaledH);
    }

    // ── Keyword shimmer (gradient sweep across box) ──
    if (isKeywordActive && isInFlight && !!style.wordHighlightKwShimmerEnabled) {
        const shimmerColor = style.wordHighlightKwShimmerColor ?? '#FFFFFF';
        // Sweep position: -100% → 200% of box width over the effect duration
        const sweepPos = lerp(-1, 2, rawProgress);
        const sweepX = bx + scaledW * sweepPos;
        const bandWidth = scaledW * 0.3; // shimmer band is 30% of box width

        ctx.save();
        // Clip to box shape
        ctx.beginPath();
        if (ctx.roundRect && hlRadius > 0) {
            ctx.roundRect(bx, by, scaledW, scaledH, hlRadius);
        } else {
            ctx.rect(bx, by, scaledW, scaledH);
        }
        ctx.clip();

        const grad = ctx.createLinearGradient(sweepX - bandWidth, by, sweepX + bandWidth, by);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(0.5, shimmerColor);
        grad.addColorStop(1, 'transparent');
        ctx.globalAlpha = lerp(0.5, 0, easeOutCubic(rawProgress));
        ctx.fillStyle = grad;
        ctx.fillRect(bx, by, scaledW, scaledH);
        ctx.restore();
    }

    // ── Keyword particles (sparkle dots emanating from box center) ──
    if (isKeywordActive && isInFlight && !!style.wordHighlightKwParticlesEnabled) {
        const particleCount = style.wordHighlightKwParticleCount ?? 6;
        const particleColor = style.wordHighlightKwParticleColor ?? '#FFD700';
        const cx = bx + scaledW / 2;
        const cy = by + scaledH / 2;
        const maxDist = 30 * scaleFactor;

        ctx.save();
        for (let i = 0; i < particleCount; i++) {
            const angle = (i / particleCount) * Math.PI * 2 + 0.3;
            const dist = lerp(0, maxDist, rawProgress);
            const dx = Math.cos(angle) * dist;
            const dy = Math.sin(angle) * dist - lerp(0, 15 * scaleFactor, rawProgress); // float upward
            const size = lerp(4 * scaleFactor, 1 * scaleFactor, rawProgress);
            const opacity = lerp(1, 0, easeOutCubic(rawProgress));

            ctx.globalAlpha = opacity;
            ctx.fillStyle = particleColor;
            ctx.shadowColor = particleColor;
            ctx.shadowBlur = size;
            ctx.beginPath();
            ctx.arc(cx + dx, cy + dy, size / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
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

    // Scale factor: maps canonical 1080px reference to export canvas pixels.
    // Both viewport (sz.h / 1080) and export (outputHeight / 1080) use the same
    // 1080px base so font sizes are consistent at any window size or resolution.
    const scaleFactor = outputHeight / 1080;
    const rawFontSize = style.fontSize || 16;
    const fontSize = rawFontSize * scaleFactor;

    // Padding: viewport uses '8px 16px' CSS padding on text element
    // Scale that to canvas space
    const textPaddingV = 8 * scaleFactor;
    const textPaddingH = 16 * scaleFactor;

    // Calculate base position
    // Viewport: `bottom: ${bottomOffset}%` inside a safe zone of height sz.h
    // Canvas equivalent: y from top = outputHeight * (1 - bottomOffset/100)
    let yBase: number;
    if (opts.topOffset != null) {
        // Title positioning: from top
        yBase = outputHeight * (opts.topOffset / 100) + fontSize;
    } else {
        const bottomOffset = style.bottomOffset ?? 10;
        yBase = outputHeight * (1 - bottomOffset / 100);
    }
    const xBase = outputWidth / 2;

    ctx.save();

    // Global opacity multiplier for title fade-in/fade-out.
    // Set it here for background/glow/shadow sections that inherit from this context.
    // Inner text drawing code that sets its own globalAlpha multiplies by this value.
    const globalOpacity = opts.globalOpacity ?? 1;
    ctx.globalAlpha = globalOpacity;

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
            wordTimings, sourceTime, eventStartTime, eventEndTime,
            frame, fps, 0, animation?.duration ?? 0, globalOpacity);
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

    // Measure all elements (skip newline markers)
    const elementWidths = elements.map((el: ElementAnimValues) => {
        if (el.text === '\n') return 0;
        return ctx.measureText(el.text).width;
    });

    // Compute per-line layout: break on explicit \n AND word-wrap at max width
    // This matches the viewport's whiteSpace: 'pre-wrap' + flexWrap: 'wrap'
    const maxTextWidth = outputWidth * 0.9 - textPaddingH * 2;
    const lineHeight = fontSize * 1.4;
    let lines: { startIdx: number; endIdx: number; width: number }[] = [];
    {
        let lineStart = 0;
        let lineW = 0;
        for (let i = 0; i < elements.length; i++) {
            if (elements[i].text === '\n') {
                // Explicit newline: finish current line
                lines.push({ startIdx: lineStart, endIdx: i, width: lineW });
                lineStart = i + 1;
                lineW = 0;
            } else {
                const elW = elementWidths[i];
                const isWhitespace = /^\s+$/.test(elements[i].text);
                // Word-wrap: if adding this non-whitespace element would exceed max width,
                // start a new line (always allow at least one word per line)
                if (maxTextWidth > 0 && !isWhitespace && lineW + elW > maxTextWidth && lineW > 0) {
                    // Trim trailing whitespace from the line we're closing
                    let endIdx = i;
                    let trimmedW = lineW;
                    while (endIdx > lineStart && /^\s+$/.test(elements[endIdx - 1].text)) {
                        trimmedW -= elementWidths[endIdx - 1];
                        endIdx--;
                    }
                    lines.push({ startIdx: lineStart, endIdx, width: trimmedW });
                    // This word starts the new line
                    lineStart = i;
                    lineW = elW;
                } else {
                    lineW += elW;
                }
            }
        }
        // Last line
        lines.push({ startIdx: lineStart, endIdx: elements.length, width: lineW });
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
            frame, fps,
            0, effectiveAnimation.duration,
            wordEmphases,
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

        // Check if this element starts a new wrapped line
        // (lines created by word-wrapping, not explicit \n)
        while (currentLineIdx < lines.length - 1 && i >= lines[currentLineIdx].endIdx) {
            currentLineIdx++;
            xOffset = computeLineXOffset(lines[currentLineIdx].width);
            yOffset = lineYStart + currentLineIdx * lineHeight;
        }

        // Skip elements outside current line range (trimmed whitespace)
        if (i < lines[currentLineIdx].startIdx) continue;

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

        ctx.globalAlpha = (isIdleWord ? el.opacity * hlIdleOpacity : el.opacity) * globalOpacity;

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
    frame?: number,
    fps?: number,
    animStagger?: number,
    animDuration?: number,
    globalOpacity?: number,
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

    // Handle multi-line text: split on \n AND word-wrap to match viewport's pre-wrap
    const maxTextWidth = outputWidth * 0.9 - textPaddingH * 2;
    const lines = splitAndWrapText(ctx, text, maxTextWidth);
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
            frame ?? 0, fps ?? 30, animStagger ?? 0, animDuration ?? 0,
            wordEmphases,
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
    ctx.globalAlpha = globalOpacity ?? 1;
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

                // Apply idle word opacity (multiplied by globalOpacity for title fades)
                const go = globalOpacity ?? 1;
                if (isIdleToken) {
                    ctx.globalAlpha = ptHlIdleOpacity * go;
                } else {
                    ctx.globalAlpha = go;
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
        ctx.globalAlpha = globalOpacity ?? 1; // restore
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
