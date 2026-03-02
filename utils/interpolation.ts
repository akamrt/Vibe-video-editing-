/**
 * Keyframe Interpolation Utilities
 * Adapted from tracker_v2 for video clip transform animation
 */

import { ClipKeyframe, KeyframeConfig } from '../types';

// ============ BEZIER MATH ============

/**
 * Solves B_x(t) = targetX for t using Newton-Raphson
 * P0=0, P3=1. P1, P2 are X-coordinates of control points
 */
export const solveBezierT = (xTarget: number, x1: number, x2: number): number => {
    let t = xTarget;
    // Newton iterations
    for (let i = 0; i < 5; i++) {
        const invT = 1 - t;
        const xEst = 3 * invT * invT * t * x1 + 3 * invT * t * t * x2 + t * t * t;
        if (Math.abs(xEst - xTarget) < 0.001) return t;

        // Derivative using generic formula for cubic bezier
        const A = 1 - 3 * x2 + 3 * x1;
        const B = 3 * x2 - 6 * x1;
        const C = 3 * x1;
        const slope = 3 * A * t * t + 2 * B * t + C;
        if (Math.abs(slope) < 0.0001) break;
        t -= (xEst - xTarget) / slope;
    }
    return Math.max(0, Math.min(1, t));
};

/**
 * Interpolate value between two keyframes using Bezier curves
 */
export const bezierInterp = (
    v0: number, v1: number,
    t0: number, t1: number,
    currentT: number,
    config0?: KeyframeConfig, config1?: KeyframeConfig
): number => {
    const dt = t1 - t0;
    if (dt <= 0) return v1;
    const progress = (currentT - t0) / dt;

    // Default Linear Tangents
    let p1x = 1 / 3;
    let p2x = 2 / 3;

    // Calculate P1y and P2y for Bezier
    let P1y = v0 + (v1 - v0) * (1 / 3);
    if (config0?.outTangent) {
        p1x = config0.outTangent.x / dt;
        P1y = v0 + config0.outTangent.y;
    }

    let P2y = v0 + (v1 - v0) * (2 / 3);
    if (config1?.inTangent) {
        p2x = 1 + config1.inTangent.x / dt;
        P2y = v1 + config1.inTangent.y;
    }

    // Solve t param
    const tParam = solveBezierT(progress, p1x, p2x);

    // Calc Y using cubic Bezier formula
    const invT = 1 - tParam;
    return (invT * invT * invT * v0) +
        (3 * invT * invT * tParam * P1y) +
        (3 * invT * tParam * tParam * P2y) +
        (tParam * tParam * tParam * v1);
};

// ============ TRANSFORM INTERPOLATION ============

export interface ClipTransform {
    translateX: number;
    translateY: number;
    scale: number;
    rotation: number;
    volume: number;
}

/**
 * Get interpolated transform at a specific time within a clip
 * @param keyframes Array of keyframes for the clip
 * @param clipTime Time relative to clip start (seconds)
 * @returns Interpolated transform values
 */
export const getInterpolatedTransform = (
    keyframes: ClipKeyframe[] | undefined,
    clipTime: number
): ClipTransform => {
    // Default transform (no change)
    const defaultTransform: ClipTransform = {
        translateX: 0,
        translateY: 0,
        scale: 1,
        rotation: 0,
        volume: 1
    };

    if (!keyframes || keyframes.length === 0) {
        return defaultTransform;
    }

    // Sort keyframes by time
    const sorted = [...keyframes].sort((a, b) => a.time - b.time);

    // If before first keyframe, return first keyframe values
    if (clipTime <= sorted[0].time) {
        return {
            translateX: sorted[0].translateX,
            translateY: sorted[0].translateY,
            scale: sorted[0].scale,
            rotation: sorted[0].rotation,
            volume: sorted[0].volume ?? 1
        };
    }

    // If after last keyframe, return last keyframe values
    if (clipTime >= sorted[sorted.length - 1].time) {
        const last = sorted[sorted.length - 1];
        return {
            translateX: last.translateX,
            translateY: last.translateY,
            scale: last.scale,
            rotation: last.rotation,
            volume: last.volume ?? 1
        };
    }

    // Find prev and next keyframes
    let prev = sorted[0];
    let next = sorted[1];
    for (let i = 0; i < sorted.length - 1; i++) {
        if (clipTime >= sorted[i].time && clipTime < sorted[i + 1].time) {
            prev = sorted[i];
            next = sorted[i + 1];
            break;
        }
    }

    // Interpolate each property
    const props: (keyof ClipTransform)[] = ['translateX', 'translateY', 'scale', 'rotation', 'volume'];
    const result: ClipTransform = { ...defaultTransform };

    props.forEach(prop => {
        // volume is optional on ClipKeyframe — default to 1 when absent
        const v0 = prop === 'volume' ? (prev.volume ?? 1) : prev[prop] as number;
        const v1 = prop === 'volume' ? (next.volume ?? 1) : next[prop] as number;
        const t0 = prev.time;
        const t1 = next.time;
        const cfg0 = prev.keyframeConfig?.[prop];
        const cfg1 = next.keyframeConfig?.[prop];

        result[prop] = bezierInterp(v0, v1, t0, t1, clipTime, cfg0, cfg1);
    });

    return result;
};

// ============ ASPECT RATIO HELPERS ============

export interface AspectRatioInfo {
    ratio: number; // width / height
    width: number;
    height: number;
}

export const ASPECT_RATIO_PRESETS: Record<string, AspectRatioInfo> = {
    '16:9': { ratio: 16 / 9, width: 1920, height: 1080 },
    '9:16': { ratio: 9 / 16, width: 1080, height: 1920 },
    '1:1': { ratio: 1, width: 1080, height: 1080 },
    '4:5': { ratio: 4 / 5, width: 1080, height: 1350 }
};

/**
 * Calculate the crop region for a target aspect ratio within a container
 */
export const calculateCropRegion = (
    containerWidth: number,
    containerHeight: number,
    targetRatio: number
): { x: number; y: number; width: number; height: number } => {
    const containerRatio = containerWidth / containerHeight;

    if (containerRatio > targetRatio) {
        // Container is wider than target - pillarbox (black bars on sides)
        const newWidth = containerHeight * targetRatio;
        return {
            x: (containerWidth - newWidth) / 2,
            y: 0,
            width: newWidth,
            height: containerHeight
        };
    } else {
        // Container is taller than target - letterbox (black bars top/bottom)
        const newHeight = containerWidth / targetRatio;
        return {
            x: 0,
            y: (containerHeight - newHeight) / 2,
            width: containerWidth,
            height: newHeight
        };
    }
};

/**
 * Generate CSS transform string from ClipTransform
 */
export const transformToCss = (transform: ClipTransform): string => {
    const parts: string[] = [];

    if (transform.translateX !== 0 || transform.translateY !== 0) {
        parts.push(`translate(${transform.translateX}%, ${transform.translateY}%)`);
    }

    if (transform.scale !== 1) {
        parts.push(`scale(${transform.scale})`);
    }

    if (transform.rotation !== 0) {
        parts.push(`rotate(${transform.rotation}deg)`);
    }

    return parts.length > 0 ? parts.join(' ') : 'none';
};
