/**
 * Template Matching Tracking Service
 * Ported from tracker_v2's VideoWorkspace.tsx — pure canvas pixel operations.
 * Uses coarse-to-fine SAD (Sum of Absolute Differences) template matching.
 * No ML models, no WASM, no visibility requirements.
 * Seek-based frame extraction: works on offscreen video elements.
 */

import { ClipKeyframe, VibeCutTracker, TrackedFrame } from "../types";

// --- Constants ---
const DEFAULT_PATCH_SIZE = 32;
const DEFAULT_SEARCH_WINDOW = 60;
const DEFAULT_SENSITIVITY = 50;
const SAMPLE_INTERVAL = 0.1; // 100ms between frame samples
const MAX_TRACKERS = 12;
const MIN_TRACKERS = 6;
const OUTLIER_THRESHOLD = 1.5; // px deviation from median motion before counting as bad
const BAD_FRAMES_BEFORE_DELETE = 3;
const ADAPTIVE_RECAPTURE_THRESHOLD = 95; // re-capture template below this matchScore
const DELETE_MATCH_THRESHOLD = 60; // delete tracker below this matchScore

// Portrait crop constants (9:16 from 16:9)
const PORTRAIT_WIDTH_PCT = 56.25; // 9/16 of source width
const PORTRAIT_CENTER = 50;

// --- Types ---
export interface TrackingSegment {
    startTime: number;
    endTime: number;
}

interface InternalTracker {
    id: string;
    x: number;
    y: number;
    patchSize: number;
    searchWindow: number;
    matchScore?: number;
}

interface MatchResult {
    point: InternalTracker;
    error: number;
}

interface TrackedPosition {
    time: number;
    medianX: number; // pixel X position (will be converted to percentage)
}

// --- Core Algorithms (ported from tracker_v2/components/VideoWorkspace.tsx) ---

/**
 * Capture a template patch around a tracker point.
 * Ported from VideoWorkspace.tsx lines 1831-1849.
 */
function captureTemplate(
    point: InternalTracker,
    ctx: CanvasRenderingContext2D,
    templates: Map<string, ImageData>
): void {
    const pSize = point.patchSize || DEFAULT_PATCH_SIZE;
    const startX = Math.max(0, Math.floor(point.x - pSize / 2));
    const startY = Math.max(0, Math.floor(point.y - pSize / 2));
    try {
        const imageData = ctx.getImageData(startX, startY, pSize, pSize);
        templates.set(point.id, imageData);
    } catch (e) {
        // Canvas security error or out of bounds — skip
    }
}

/**
 * Two-stage coarse-to-fine template matching using SAD.
 * Ported from VideoWorkspace.tsx lines 1905-1958.
 *
 * Stage 1 (Coarse): 2px step, 2px template sampling — fast scan of search window
 * Stage 2 (Fine): ±6px around coarse winner, 2px template sampling — subpixel refinement
 *
 * Returns new tracker position + error metric, or null if no template.
 */
function findBestMatch(
    ctx: CanvasRenderingContext2D,
    center: InternalTracker,
    predictedX: number,
    predictedY: number,
    templates: Map<string, ImageData>
): MatchResult | null {
    const template = templates.get(center.id);
    if (!template) return null;

    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const tData = template.data;
    const tSize = center.patchSize || DEFAULT_PATCH_SIZE;
    const searchWin = center.searchWindow || DEFAULT_SEARCH_WINDOW;

    // Center search on predicted TOP-LEFT corner (predictedX/Y are CENTER coords)
    // Without this offset, the search is asymmetric: biased +tSize/2 px to the right/bottom
    const cornerX = predictedX - tSize / 2;
    const cornerY = predictedY - tSize / 2;
    const searchStartX = Math.max(0, Math.floor(cornerX - searchWin));
    const searchStartY = Math.max(0, Math.floor(cornerY - searchWin));
    const searchEndX = Math.min(width - tSize, Math.floor(cornerX + searchWin));
    const searchEndY = Math.min(height - tSize, Math.floor(cornerY + searchWin));

    if (searchEndX <= searchStartX || searchEndY <= searchStartY) {
        return { point: center, error: 0 };
    }

    const searchWidth = searchEndX - searchStartX + tSize;
    const searchHeight = searchEndY - searchStartY + tSize;
    const searchImgData = ctx.getImageData(searchStartX, searchStartY, searchWidth, searchHeight);
    const sData = searchImgData.data;

    // --- Coarse pass: 2px step ---
    let minDiff = Number.MAX_VALUE;
    let bestX = center.x;
    let bestY = center.y;

    for (let y = 0; y < searchEndY - searchStartY; y += 2) {
        for (let x = 0; x < searchEndX - searchStartX; x += 2) {
            let diff = 0;
            for (let ty = 0; ty < tSize; ty += 2) {
                for (let tx = 0; tx < tSize; tx += 2) {
                    const tIndex = (ty * tSize + tx) * 4;
                    const sIndex = ((y + ty) * searchWidth + (x + tx)) * 4;
                    diff += Math.abs(tData[tIndex] - sData[sIndex])
                          + Math.abs(tData[tIndex + 1] - sData[sIndex + 1])
                          + Math.abs(tData[tIndex + 2] - sData[sIndex + 2]);
                }
                if (diff > minDiff) break; // Early exit
            }
            if (diff < minDiff) {
                minDiff = diff;
                bestX = searchStartX + x;
                bestY = searchStartY + y;
            }
        }
    }

    // --- Fine pass: ±6px around coarse winner ---
    const fineRadius = 6;
    let minFineDiff = Number.MAX_VALUE;
    let fineBestX = bestX;
    let fineBestY = bestY;
    const coarseRelX = bestX - searchStartX;
    const coarseRelY = bestY - searchStartY;

    for (let fy = -fineRadius; fy <= fineRadius; fy++) {
        for (let fx = -fineRadius; fx <= fineRadius; fx++) {
            const y = coarseRelY + fy;
            const x = coarseRelX + fx;
            if (x < 0 || y < 0 || x >= searchWidth - tSize || y >= searchHeight - tSize) continue;
            let diff = 0;
            // Fine pass: compare EVERY pixel for maximum accuracy
            for (let ty = 0; ty < tSize; ty++) {
                for (let tx = 0; tx < tSize; tx++) {
                    const tIndex = (ty * tSize + tx) * 4;
                    const sIndex = ((y + ty) * searchWidth + (x + tx)) * 4;
                    diff += Math.abs(tData[tIndex] - sData[sIndex])
                          + Math.abs(tData[tIndex + 1] - sData[sIndex + 1])
                          + Math.abs(tData[tIndex + 2] - sData[sIndex + 2]);
                }
                if (diff > minFineDiff) break; // Early exit
            }
            if (diff < minFineDiff) {
                minFineDiff = diff;
                fineBestX = searchStartX + coarseRelX + fx;
                fineBestY = searchStartY + coarseRelY + fy;
            }
        }
    }

    const finalX = fineBestX + tSize / 2;
    const finalY = fineBestY + tSize / 2;
    // Full-pixel sampling: tSize * tSize pixels, 3 channels each
    const pixelsSampled = tSize * tSize;
    const avgDiffPerPixel = minFineDiff / pixelsSampled;
    const matchScore = Math.max(0, Math.min(100, 100 - (avgDiffPerPixel * 0.4)));

    return {
        point: {
            ...center,
            x: finalX,
            y: finalY,
            matchScore,
        },
        error: avgDiffPerPixel
    };
}

/**
 * Find high-contrast feature points for automatic tracker placement.
 * Ported from VideoWorkspace.tsx lines 1005-1029.
 *
 * Divides frame into 80px grid cells, finds the highest-contrast pixel
 * in each cell (horizontal + vertical luminance gradient).
 * Skips cells that already have a tracker nearby.
 */
function findGoodFeatures(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    existingTrackers: InternalTracker[]
): { x: number; y: number }[] {
    const GRID_SIZE = 80;
    const MARGIN = 40;
    const candidates: { x: number; y: number }[] = [];

    const cols = Math.floor((width - 2 * MARGIN) / GRID_SIZE);
    const rows = Math.floor((height - 2 * MARGIN) / GRID_SIZE);

    // Build and shuffle grid cells for randomness
    let gridCells: { c: number; r: number }[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            gridCells.push({ c, r });
        }
    }
    for (let i = gridCells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gridCells[i], gridCells[j]] = [gridCells[j], gridCells[i]];
    }

    for (const cell of gridCells) {
        const cellX = MARGIN + cell.c * GRID_SIZE;
        const cellY = MARGIN + cell.r * GRID_SIZE;

        // Skip if near existing tracker
        if (existingTrackers.some(t =>
            Math.abs(t.x - (cellX + GRID_SIZE / 2)) < GRID_SIZE * 0.8 &&
            Math.abs(t.y - (cellY + GRID_SIZE / 2)) < GRID_SIZE * 0.8
        )) continue;

        try {
            const imgData = ctx.getImageData(cellX, cellY, GRID_SIZE, GRID_SIZE);
            const data = imgData.data;
            let maxContrast = 0;
            let bestX = 0;
            let bestY = 0;

            for (let y = 0; y < GRID_SIZE - 4; y += 4) {
                for (let x = 0; x < GRID_SIZE - 4; x += 4) {
                    const i = (y * GRID_SIZE + x) * 4;
                    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    const rightLum = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
                    const downLum = (data[i + GRID_SIZE * 4] + data[i + GRID_SIZE * 4 + 1] + data[i + GRID_SIZE * 4 + 2]) / 3;
                    const contrast = Math.abs(lum - rightLum) + Math.abs(lum - downLum);
                    if (contrast > maxContrast) {
                        maxContrast = contrast;
                        bestX = x;
                        bestY = y;
                    }
                }
            }

            if (maxContrast > 30) {
                candidates.push({ x: cellX + bestX, y: cellY + bestY });
            }
        } catch (e) {
            // Canvas access error — skip cell
        }
    }

    return candidates;
}

// --- Seek-based Frame Extraction ---

/**
 * Seek video to a specific time and draw the frame to canvas.
 *
 * Uses seeked event + readyState polling, then draws.
 * Previously used requestVideoFrameCallback but it has a race condition:
 * RVFC can fire for a stale pre-seek frame, causing the canvas to contain
 * wrong pixel data (manifests as score=0 in template matching).
 */
async function seekAndDraw(
    video: HTMLVideoElement,
    ctx: CanvasRenderingContext2D,
    time: number
): Promise<void> {
    // If already very close to target time, just draw
    if (Math.abs(video.currentTime - time) < 0.005) {
        try { ctx.drawImage(video, 0, 0); } catch (_) {}
        return;
    }

    // Seek and wait for the seeked event
    await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
            if (resolved) return;
            resolved = true;
            video.removeEventListener('seeked', onSeeked);
            resolve();
        };

        const onSeeked = () => {
            // seeked fired — now poll readyState until frame is decoded
            if (video.readyState >= 2) {
                finish();
            } else {
                let attempts = 0;
                const poll = () => {
                    if (resolved) return;
                    if (video.readyState >= 2 || attempts >= 30) {
                        finish();
                    } else {
                        attempts++;
                        setTimeout(poll, 10);
                    }
                };
                setTimeout(poll, 10);
            }
        };

        video.addEventListener('seeked', onSeeked);
        video.currentTime = time;

        // Safety timeout (2s)
        setTimeout(finish, 2000);
    });

    // Draw the current video frame to the canvas
    try { ctx.drawImage(video, 0, 0); } catch (_) {}
}

/**
 * Create a tracker with a unique ID at the given position.
 */
let trackerCounter = 0;
function spawnTracker(x: number, y: number): InternalTracker {
    return {
        id: `auto_${++trackerCounter}_${Date.now()}`,
        x,
        y,
        patchSize: DEFAULT_PATCH_SIZE,
        searchWindow: DEFAULT_SEARCH_WINDOW,
    };
}

// --- Main Tracking Pipeline ---

/**
 * Track a video segment using template matching.
 * Creates offscreen video + canvas, seeks frame-by-frame, runs matching.
 * Returns array of { time, medianX } positions for keyframe generation.
 */
async function trackSegment(
    file: File,
    segment: TrackingSegment,
    onProgress?: (progress: number, label: string) => void
): Promise<{ positions: TrackedPosition[]; videoWidth: number }> {
    onProgress?.(0, 'Loading video...');
    console.log('[TemplateTracking] Starting template matching analysis...');

    // Create offscreen video element
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // NOT added to DOM — offscreen is fine for canvas drawImage

    // Wait for video metadata
    await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Video load failed'));
        setTimeout(() => reject(new Error('Video load timeout')), 15000);
    });

    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const duration = video.duration;
    console.log(`[TemplateTracking] Video: ${videoWidth}x${videoHeight}, ${duration.toFixed(1)}s`);

    if (!duration || duration < 0.1) {
        URL.revokeObjectURL(objectUrl);
        throw new Error('Invalid video duration');
    }

    // Create offscreen canvas at video resolution
    const canvas = document.createElement('canvas');
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        URL.revokeObjectURL(objectUrl);
        throw new Error('Failed to create canvas context');
    }

    const startTime = Math.max(0, segment.startTime);
    const endTime = Math.min(duration, segment.endTime);
    const totalDuration = endTime - startTime;
    const totalSamples = Math.ceil(totalDuration / SAMPLE_INTERVAL);
    console.log(`[TemplateTracking] Range: ${startTime.toFixed(2)}s → ${endTime.toFixed(2)}s (${totalSamples} samples)`);

    // --- Initialize: seek to first frame, find features ---
    onProgress?.(0.05, 'Detecting features...');
    await seekAndDraw(video, ctx, startTime);

    let trackers: InternalTracker[] = [];
    const templates = new Map<string, ImageData>();
    const lastPoints = new Map<string, InternalTracker>();
    const prevFramePoints = new Map<string, InternalTracker>(); // points from frame N-1
    const prevPrevFramePoints = new Map<string, InternalTracker>(); // points from frame N-2
    const badFrameCounts = new Map<string, number>();

    // Auto-detect features and spawn trackers
    const candidates = findGoodFeatures(ctx, videoWidth, videoHeight, []);
    const toSpawn = Math.min(MAX_TRACKERS, candidates.length);
    for (let i = 0; i < toSpawn; i++) {
        const t = spawnTracker(candidates[i].x, candidates[i].y);
        trackers.push(t);
        captureTemplate(t, ctx, templates);
        lastPoints.set(t.id, t);
    }
    console.log(`[TemplateTracking] Spawned ${trackers.length} initial trackers`);

    if (trackers.length === 0) {
        URL.revokeObjectURL(objectUrl);
        return { positions: [], videoWidth };
    }

    // Store initial frame as previous
    for (const t of trackers) {
        prevFramePoints.set(t.id, { ...t });
    }

    const positions: TrackedPosition[] = [];

    // Record first position
    const initialXs = trackers.map(t => t.x).sort((a, b) => a - b);
    positions.push({
        time: startTime,
        medianX: initialXs[Math.floor(initialXs.length / 2)]
    });

    // --- Main tracking loop: seek through each sample ---
    let sampleIndex = 0;
    for (let t = startTime + SAMPLE_INTERVAL; t <= endTime; t += SAMPLE_INTERVAL) {
        sampleIndex++;
        const progress = sampleIndex / totalSamples;
        onProgress?.(0.05 + progress * 0.85, `Tracking ${trackers.length} points (${Math.round(progress * 100)}%)`);

        // Move prevPrev ← prev, prev ← current
        prevPrevFramePoints.clear();
        for (const [id, pt] of prevFramePoints) {
            prevPrevFramePoints.set(id, pt);
        }
        prevFramePoints.clear();
        for (const t of trackers) {
            const lp = lastPoints.get(t.id);
            if (lp) prevFramePoints.set(t.id, { ...lp });
        }

        // Seek and draw frame
        await seekAndDraw(video, ctx, t);

        // Track each point
        const survivingTrackers: InternalTracker[] = [];
        const motions: { id: string; dx: number; dy: number }[] = [];

        for (const tracker of trackers) {
            const prevPoint = lastPoints.get(tracker.id) || tracker;

            // Velocity prediction from last 2 frames
            let velocityX = 0;
            let velocityY = 0;
            const p1 = prevFramePoints.get(tracker.id);
            if (p1) {
                const p2 = prevPrevFramePoints.get(tracker.id);
                if (p2) {
                    velocityX = p1.x - p2.x;
                    velocityY = p1.y - p2.y;
                }
            }

            const predictedX = prevPoint.x + velocityX;
            const predictedY = prevPoint.y + velocityY;

            const result = findBestMatch(ctx, prevPoint, predictedX, predictedY, templates);

            if (!result) {
                // No template — keep tracker at last known position
                survivingTrackers.push(prevPoint);
                continue;
            }

            // Delete if match score too low
            if (result.point.matchScore !== undefined && result.point.matchScore < DELETE_MATCH_THRESHOLD) {
                // Tracker lost — don't add to survivors
                templates.delete(tracker.id);
                lastPoints.delete(tracker.id);
                continue;
            }

            // Check error threshold
            const errorThreshold = 20 + (100 - DEFAULT_SENSITIVITY) * 0.6; // = 50
            if (result.error > errorThreshold) {
                templates.delete(tracker.id);
                lastPoints.delete(tracker.id);
                continue;
            }

            // Adaptive re-capture
            if (result.point.matchScore !== undefined && result.point.matchScore < ADAPTIVE_RECAPTURE_THRESHOLD) {
                captureTemplate(result.point, ctx, templates);
            }

            lastPoints.set(tracker.id, result.point);
            survivingTrackers.push(result.point);

            // Record motion for outlier detection
            motions.push({
                id: tracker.id,
                dx: result.point.x - prevPoint.x,
                dy: result.point.y - prevPoint.y
            });
        }

        // --- Outlier rejection (ported from VideoWorkspace.tsx lines 2130-2137) ---
        let finalTrackers = survivingTrackers;
        if (motions.length > 2) {
            const sortedDx = [...motions].sort((a, b) => a.dx - b.dx);
            const medianDx = sortedDx[Math.floor(sortedDx.length / 2)].dx;
            const sortedDy = [...motions].sort((a, b) => a.dy - b.dy);
            const medianDy = sortedDy[Math.floor(sortedDy.length / 2)].dy;

            const idsToDelete = new Set<string>();
            for (const m of motions) {
                const dev = Math.abs(m.dx - medianDx) + Math.abs(m.dy - medianDy);
                if (dev > OUTLIER_THRESHOLD) {
                    const badCount = (badFrameCounts.get(m.id) || 0) + 1;
                    badFrameCounts.set(m.id, badCount);
                    if (badCount > BAD_FRAMES_BEFORE_DELETE) {
                        idsToDelete.add(m.id);
                    }
                } else {
                    badFrameCounts.set(m.id, 0);
                }
            }

            if (idsToDelete.size > 0) {
                finalTrackers = survivingTrackers.filter(t => !idsToDelete.has(t.id));
                for (const id of idsToDelete) {
                    templates.delete(id);
                    lastPoints.delete(id);
                    badFrameCounts.delete(id);
                }
            }
        }

        trackers = finalTrackers;

        // --- Replenish trackers if count drops too low ---
        if (trackers.length < MIN_TRACKERS) {
            const newCandidates = findGoodFeatures(ctx, videoWidth, videoHeight, trackers);
            const needed = MAX_TRACKERS - trackers.length;
            const toAdd = Math.min(needed, newCandidates.length);
            for (let i = 0; i < toAdd; i++) {
                const newT = spawnTracker(newCandidates[i].x, newCandidates[i].y);
                trackers.push(newT);
                captureTemplate(newT, ctx, templates);
                lastPoints.set(newT.id, newT);
            }
        }

        // Record median X position of surviving trackers
        if (trackers.length > 0) {
            const xValues = trackers.map(tr => tr.x).sort((a, b) => a - b);
            const medianX = xValues[Math.floor(xValues.length / 2)];
            positions.push({ time: t, medianX });
        }
    }

    // Cleanup
    URL.revokeObjectURL(objectUrl);
    console.log(`[TemplateTracking] Complete: ${positions.length} positions tracked across ${totalDuration.toFixed(1)}s`);

    return { positions, videoWidth };
}

// --- Keyframe Generation (kept from personTrackingService.ts) ---

/**
 * Calculate translateX to center the subject in portrait crop.
 */
function centeringOffset(personX: number): number {
    const offset = PORTRAIT_CENTER - personX;
    const maxShift = (100 - PORTRAIT_WIDTH_PCT) / 2; // ±21.875
    return Math.max(-maxShift, Math.min(maxShift, offset));
}

/**
 * Convert tracked positions into centering keyframes (translateX only).
 * Applies EMA smoothing, then samples at regular intervals.
 * Keyframe times are RELATIVE to segment start (0 = clip start).
 */
function generateTrackingKeyframes(
    positions: TrackedPosition[],
    segment: TrackingSegment,
    videoWidth: number
): ClipKeyframe[] {
    if (positions.length === 0) return [];

    const sorted = [...positions].sort((a, b) => a.time - b.time);

    // Convert pixel positions to percentages
    const asPercentages = sorted.map(p => ({
        time: p.time,
        personX: (p.medianX / videoWidth) * 100
    }));

    // EMA smoothing (α=0.8: 80% new, 20% previous — light smoothing)
    const ALPHA = 0.8;
    const smoothed: { time: number; x: number }[] = [];
    let emaX = asPercentages[0].personX;

    for (const p of asPercentages) {
        emaX += ALPHA * (p.personX - emaX);
        smoothed.push({ time: p.time, x: emaX });
    }

    // Interpolation helper
    const getXAtTime = (t: number): number => {
        if (smoothed.length === 0) return 50;
        if (t <= smoothed[0].time) return smoothed[0].x;
        if (t >= smoothed[smoothed.length - 1].time) return smoothed[smoothed.length - 1].x;

        for (let i = 0; i < smoothed.length - 1; i++) {
            if (t >= smoothed[i].time && t < smoothed[i + 1].time) {
                const ratio = (t - smoothed[i].time) / (smoothed[i + 1].time - smoothed[i].time);
                return smoothed[i].x + ratio * (smoothed[i + 1].x - smoothed[i].x);
            }
        }
        return smoothed[smoothed.length - 1].x;
    };

    // Generate keyframes at regular intervals — times relative to clip start
    const keyframes: ClipKeyframe[] = [];
    const INTERVAL = 0.1;

    for (let t = segment.startTime; t <= segment.endTime; t += INTERVAL) {
        keyframes.push({
            time: t - segment.startTime, // RELATIVE to clip start
            translateX: centeringOffset(getXAtTime(t)),
            translateY: 0,
            scale: 1,
            rotation: 0
        });
    }

    // Ensure end keyframe
    const lastTime = segment.endTime - segment.startTime;
    if (keyframes.length === 0 || Math.abs(keyframes[keyframes.length - 1].time - lastTime) > 0.01) {
        keyframes.push({
            time: lastTime,
            translateX: centeringOffset(getXAtTime(segment.endTime)),
            translateY: 0,
            scale: 1,
            rotation: 0
        });
    }

    console.log(`[TemplateTracking] Generated ${keyframes.length} keyframes (0 → ${lastTime.toFixed(2)}s)`);
    if (keyframes.length > 0) {
        const txValues = keyframes.map(k => k.translateX);
        console.log(`[TemplateTracking] translateX range: ${Math.min(...txValues).toFixed(1)}% to ${Math.max(...txValues).toFixed(1)}%`);
    }

    return keyframes;
}

// --- Public API (same contract as personTrackingService.ts) ---

/**
 * Main entry point: analyze one segment and generate centering keyframes.
 * Drop-in replacement for personTrackingService.analyzeAndGenerateKeyframes.
 */
export async function analyzeAndGenerateKeyframes(
    file: File,
    segment: TrackingSegment,
    onProgress?: (progress: number, label: string) => void
): Promise<ClipKeyframe[]> {
    console.log(`[TemplateTracking] Starting for segment ${segment.startTime.toFixed(1)}-${segment.endTime.toFixed(1)}s`);

    try {
        const { positions, videoWidth } = await trackSegment(file, segment, onProgress);

        if (positions.length === 0) {
            onProgress?.(1.0, 'No trackable features found');
            return [];
        }

        onProgress?.(0.95, 'Generating keyframes...');
        const keyframes = generateTrackingKeyframes(positions, segment, videoWidth);

        onProgress?.(1.0, `Done — ${keyframes.length} keyframes`);
        return keyframes;
    } catch (err) {
        console.error('[TemplateTracking] FAILED:', err);
        onProgress?.(1.0, 'Tracking failed');
        return [];
    }
}

// =============================================================================
// Threshold-based Auto-Center (scan mode) — 1 AI anchor + free template tracking
// =============================================================================

/**
 * Scan a video element through a segment by tracking a SINGLE person-anchored point.
 *
 * Strategy:
 *   - Caller provides the initial person position (pixel X/Y from one Gemini detection)
 *   - We place ONE template tracker on that point at frame 0
 *   - We track that one point through every frame using SAD template matching (0 tokens)
 *   - We generate a keyframe only when the tracked position exits the 9:16 zone
 *     by more than `outOfZoneThreshold` % of the zone half-width
 *
 * outOfZoneThreshold: 0 = center always, 100 = only when almost fully outside zone
 */
export async function scanAndGenerateThresholdKeyframes(
    videoElement: HTMLVideoElement,
    segment: TrackingSegment,
    /** Initial person center in VIDEO pixel coords (from Gemini detection) */
    initialPersonX: number,
    initialPersonY: number,
    outOfZoneThreshold: number = 15,
    onProgress?: (progress: number, label: string) => void
): Promise<{ keyframes: ClipKeyframe[]; triggerCount: number; frameCount: number }> {
    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;
    if (vw === 0 || vh === 0) return { keyframes: [], triggerCount: 0, frameCount: 0 };

    // Clamp initial position to valid range
    const startX = Math.max(0, Math.min(vw, initialPersonX));
    const startY = Math.max(0, Math.min(vh, initialPersonY));

    onProgress?.(0.02, 'Setting up person trackers...');

    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { keyframes: [], triggerCount: 0, frameCount: 0 };

    // Seek to clip start and grab first frame
    await seekAndDraw(videoElement, ctx, segment.startTime);

    // --- Snap trackers to high-contrast features near the detected person ---
    // The person's center (from Gemini) is often a low-contrast area (plain shirt, skin).
    // SAD template matching needs texture. Find the best-contrast points NEAR the person.
    const SEARCH_RADIUS = Math.min(vw, vh) * 0.25; // 25% of smaller dimension
    const PATCH_SIZE = 32;
    const SEARCH_WIN = 80;
    const templates = new Map<string, ImageData>();
    const trackers: InternalTracker[] = [];

    const allFeatures = findGoodFeatures(ctx, vw, vh, []);
    console.log(`[ScanCenter] Person detected at (${startX.toFixed(0)}, ${startY.toFixed(0)}) px = ${((startX/vw)*100).toFixed(1)}% x. Found ${allFeatures.length} features total.`);

    // Sort features by distance from person center, take up to 4 closest
    const nearbyFeatures = allFeatures
        .map(f => ({ ...f, dist: Math.hypot(f.x - startX, f.y - startY) }))
        .filter(f => f.dist < SEARCH_RADIUS)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 4);

    console.log(`[ScanCenter] ${nearbyFeatures.length} high-contrast features within ${SEARCH_RADIUS.toFixed(0)}px of person`);

    if (nearbyFeatures.length > 0) {
        // Use nearby high-contrast features
        nearbyFeatures.forEach((f, i) => {
            const t: InternalTracker = { id: `person_${i}`, x: f.x, y: f.y, patchSize: PATCH_SIZE, searchWindow: SEARCH_WIN };
            captureTemplate(t, ctx, templates);
            if (templates.has(t.id)) trackers.push(t);
        });
    }

    // Always add a fallback tracker directly on the Gemini-detected center
    // (even if low contrast, it gives us the reference position)
    const centerTracker: InternalTracker = {
        id: 'person_center',
        x: startX,
        y: startY,
        patchSize: 48, // larger patch catches more context
        searchWindow: SEARCH_WIN,
    };
    captureTemplate(centerTracker, ctx, templates);
    if (templates.has('person_center')) trackers.push(centerTracker);

    if (trackers.length === 0) {
        onProgress?.(1.0, 'Could not capture any person templates');
        return { keyframes: [], triggerCount: 0, frameCount: 0 };
    }

    console.log(`[ScanCenter] Tracking with ${trackers.length} trackers (${nearbyFeatures.length} contrast + 1 center)`);

    // --- Track person through every frame ---
    const positions: { time: number; x: number }[] = [];
    const duration = segment.endTime - segment.startTime;
    const totalFrames = Math.ceil(duration / SAMPLE_INTERVAL) + 1;
    let frameIdx = 0;
    let lostFrames = 0;
    let goodFrames = 0;

    // Record initial position
    positions.push({ time: segment.startTime, x: startX });

    for (let t = segment.startTime + SAMPLE_INTERVAL; t <= segment.endTime + 0.001; t += SAMPLE_INTERVAL) {
        const clampedT = Math.min(t, segment.endTime);
        await seekAndDraw(videoElement, ctx, clampedT);

        // Match all trackers, collect successful ones
        const frameXs: number[] = [];
        for (const tracker of trackers) {
            const result = findBestMatch(ctx, tracker, tracker.x, tracker.y, templates);
            if (result && result.point.matchScore !== undefined && result.point.matchScore >= DELETE_MATCH_THRESHOLD) {
                tracker.x = result.point.x;
                tracker.y = result.point.y;
                tracker.matchScore = result.point.matchScore;
                if (result.point.matchScore < ADAPTIVE_RECAPTURE_THRESHOLD) {
                    captureTemplate(tracker, ctx, templates);
                }
                frameXs.push(tracker.x);
            }
        }

        if (frameXs.length > 0) {
            // Use median X of all successfully tracked points
            frameXs.sort((a, b) => a - b);
            const mid = Math.floor(frameXs.length / 2);
            const medX = frameXs.length % 2 === 0
                ? (frameXs[mid - 1] + frameXs[mid]) / 2
                : frameXs[mid];
            positions.push({ time: clampedT, x: medX });
            lostFrames = 0;
            goodFrames++;
        } else {
            // All trackers lost — hold last known position
            lostFrames++;
            positions.push({ time: clampedT, x: trackers[trackers.length - 1].x });
            if (lostFrames >= 5) {
                // Re-anchor all trackers at their current positions
                for (const tracker of trackers) captureTemplate(tracker, ctx, templates);
                lostFrames = 0;
            }
        }

        frameIdx++;
        onProgress?.(0.05 + (frameIdx / totalFrames) * 0.85, `Tracking... frame ${frameIdx}/${totalFrames} (${goodFrames} good)`);
    }

    if (positions.length === 0) {
        onProgress?.(1.0, 'No positions tracked');
        return { keyframes: [], triggerCount: 0, frameCount: frameIdx };
    }

    // --- EMA smoothing on tracked X positions (% of video width) ---
    onProgress?.(0.92, 'Generating keyframes...');

    // Build a lookup: time → smoothed personX%
    const smoothed: { time: number; personX: number }[] = [];
    let emaX = (positions[0].x / vw) * 100;
    for (const { time, x } of positions) {
        const pct = (x / vw) * 100;
        emaX = emaX + 0.4 * (pct - emaX); // 0.4 alpha = moderate smoothing
        smoothed.push({ time, personX: emaX });
    }

    // Helper: interpolate personX at any time t
    const getPersonXAt = (t: number): number => {
        if (smoothed.length === 0) return 50;
        if (t <= smoothed[0].time) return smoothed[0].personX;
        if (t >= smoothed[smoothed.length - 1].time) return smoothed[smoothed.length - 1].personX;
        for (let i = 0; i < smoothed.length - 1; i++) {
            if (t >= smoothed[i].time && t < smoothed[i + 1].time) {
                const ratio = (t - smoothed[i].time) / (smoothed[i + 1].time - smoothed[i].time);
                return smoothed[i].personX + ratio * (smoothed[i + 1].personX - smoothed[i].personX);
            }
        }
        return smoothed[smoothed.length - 1].personX;
    };

    // --- Zone math (deadband from center) ---
    // outOfZoneThreshold = % of frame width from center before centering kicks in
    // 0% = always follow person,  15% = follow when >15% off-center,  28% ≈ only at zone boundary
    const distFromCenter = (personX: number): number => Math.abs(personX - PORTRAIT_CENTER);

    // --- Generate keyframes at every 0.2s — always write, threshold controls value ---
    const KEYFRAME_INTERVAL = 0.2;
    const keyframes: ClipKeyframe[] = [];
    let triggerCount = 0;
    let prevTx: number | null = null;

    for (let t = segment.startTime; t <= segment.endTime + 0.001; t += KEYFRAME_INTERVAL) {
        const clampedT = Math.min(t, segment.endTime);
        const personX = getPersonXAt(clampedT);
        const shouldCenter = distFromCenter(personX) > outOfZoneThreshold;
        const translateX = shouldCenter ? centeringOffset(personX) : 0;

        // Emit keyframe if first or changed by more than 0.1%
        if (prevTx === null || Math.abs(translateX - prevTx) > 0.1) {
            keyframes.push({
                time: Math.max(0, clampedT - segment.startTime),
                translateX,
                translateY: 0,
                scale: 1,
                rotation: 0,
            });
            if (shouldCenter && (prevTx === null || Math.abs(prevTx) < 0.5)) triggerCount++;
            prevTx = translateX;
        }
    }

    // Always ensure keyframe at t=0
    if (keyframes.length === 0 || keyframes[0].time > 0.01) {
        const px = getPersonXAt(segment.startTime);
        keyframes.unshift({
            time: 0,
            translateX: distFromCenter(px) > outOfZoneThreshold ? centeringOffset(px) : 0,
            translateY: 0, scale: 1, rotation: 0,
        });
    }

    const pctTracked = ((frameIdx - lostFrames) / Math.max(1, frameIdx) * 100).toFixed(0);
    console.log(`[ScanCenter] Complete: ${keyframes.length} keyframes, ${triggerCount} triggers, ${frameIdx} frames, ${pctTracked}% tracked`);
    console.log(`[ScanCenter] PersonX range: ${Math.min(...smoothed.map(s=>s.personX)).toFixed(1)}% – ${Math.max(...smoothed.map(s=>s.personX)).toFixed(1)}%`);
    console.log(`[ScanCenter] TranslateX range: ${Math.min(...keyframes.map(k=>k.translateX)).toFixed(1)}% – ${Math.max(...keyframes.map(k=>k.translateX)).toFixed(1)}%`);

    onProgress?.(1.0, `Done — ${keyframes.length} keyframes, ${triggerCount} centering event${triggerCount !== 1 ? 's' : ''}`);
    return { keyframes, triggerCount, frameCount: frameIdx };
}

// =============================================================================
// Manual Tracking API — used by the TrackingPanel for user-placed trackers
// =============================================================================

/**
 * Capture a template from a live (visible) video element for a tracker.
 * Used when placing or repositioning a tracker in the viewport.
 */
export function captureTemplateFromVideo(
    tracker: VibeCutTracker,
    videoEl: HTMLVideoElement,
    templates: Map<string, ImageData>
): void {
    const canvas = document.createElement('canvas');
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    try {
        ctx.drawImage(videoEl, 0, 0);
    } catch (e) {
        return;
    }
    captureTemplate(
        { id: tracker.id, x: tracker.x, y: tracker.y, patchSize: tracker.patchSize, searchWindow: tracker.searchWindow },
        ctx,
        templates
    );
}

/**
 * Track user-placed trackers through a video segment using seek-based template matching.
 * Unlike trackSegment(), this uses the user's trackers (no auto-detect/replenish/outlier rejection).
 * Returns TrackedFrame[] with per-tracker positions for every sampled frame.
 */
export async function trackManualTrackers(
    videoElement: HTMLVideoElement,
    segment: TrackingSegment,
    trackers: VibeCutTracker[],
    templates: Map<string, ImageData>,
    options?: {
        onProgress?: (progress: number, label: string) => void;
        onFrame?: (frame: TrackedFrame) => void;
        signal?: AbortSignal;
    }
): Promise<TrackedFrame[]> {
    const onProgress = options?.onProgress;
    const onFrame = options?.onFrame;
    const signal = options?.signal;

    onProgress?.(0, 'Initializing...');

    const activeTrackers = trackers.filter(t => t.isActive);
    if (activeTrackers.length === 0) {
        onProgress?.(1, 'No active trackers');
        return [];
    }

    // Use the viewport video element directly (user sees seeks in real-time)
    const video = videoElement;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;

    console.log(`[ManualTracking] Starting: video=${videoWidth}x${videoHeight}, paused=${video.paused}, readyState=${video.readyState}, currentTime=${video.currentTime.toFixed(3)}`);

    // Create scratch canvas for pixel operations
    const canvas = document.createElement('canvas');
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('Failed to create canvas context');
    }

    const startTime = Math.max(0, segment.startTime);
    const endTime = Math.min(video.duration, segment.endTime);
    const totalDuration = endTime - startTime;
    const totalSamples = Math.ceil(totalDuration / SAMPLE_INTERVAL);

    // Build internal trackers from VibeCutTracker
    let internalTrackers: InternalTracker[] = activeTrackers.map(t => ({
        id: t.id,
        x: t.x,
        y: t.y,
        patchSize: t.patchSize,
        searchWindow: t.searchWindow,
        matchScore: 100,
    }));

    // Capture templates from the start frame — but only for trackers that don't already
    // have a template (e.g. from handlePlaceTracker). When the user places a tracker on
    // a specific frame and hits Track, we want to keep that template, not overwrite it by
    // seeking to a potentially different start time.
    const missingTemplates = internalTrackers.filter(it => !templates.has(it.id));
    if (missingTemplates.length > 0) {
        onProgress?.(0.02, 'Capturing templates...');
        await seekAndDraw(video, ctx, startTime);
        for (const it of missingTemplates) {
            captureTemplate(it, ctx, templates);
        }
    } else {
        // Still need to seek to start time so the first frame draw is correct
        onProgress?.(0.02, 'Seeking to start...');
        await seekAndDraw(video, ctx, startTime);
    }

    const lastPoints = new Map<string, InternalTracker>();
    const prevFramePoints = new Map<string, InternalTracker>();
    const prevPrevFramePoints = new Map<string, InternalTracker>();
    for (const it of internalTrackers) {
        lastPoints.set(it.id, { ...it });
        prevFramePoints.set(it.id, { ...it });
    }

    const results: TrackedFrame[] = [];

    // === DIAGNOSTIC: Self-test on first frame ===
    // Run findBestMatch on the frame that was just drawn to verify templates + canvas work
    for (const it of internalTrackers) {
        const tmpl = templates.get(it.id);
        if (!tmpl) {
            console.error(`[ManualTracking] DIAG: No template for tracker ${it.id}!`);
            continue;
        }
        // Check template is non-empty
        let nonZeroCount = 0;
        for (let p = 0; p < Math.min(tmpl.data.length, 400); p += 4) {
            if (tmpl.data[p] > 0 || tmpl.data[p + 1] > 0 || tmpl.data[p + 2] > 0) nonZeroCount++;
        }
        console.log(`[ManualTracking] DIAG: Template ${it.id}: size=${tmpl.width}x${tmpl.height}, nonZeroPixels(first100)=${nonZeroCount}/100, patchSize=${it.patchSize}`);

        // Check canvas has data at tracker position
        const cx = Math.floor(it.x);
        const cy = Math.floor(it.y);
        if (cx >= 0 && cx < videoWidth && cy >= 0 && cy < videoHeight) {
            const pixel = ctx.getImageData(cx, cy, 1, 1).data;
            console.log(`[ManualTracking] DIAG: Canvas pixel at tracker (${cx},${cy}): rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]})`);
        }

        // Run actual match
        const selfTest = findBestMatch(ctx, it, it.x, it.y, templates);
        if (selfTest) {
            const dx = selfTest.point.x - it.x;
            const dy = selfTest.point.y - it.y;
            console.log(`[ManualTracking] DIAG: Self-test match: score=${selfTest.point.matchScore?.toFixed(1)}, delta=(${dx.toFixed(1)}, ${dy.toFixed(1)})`);
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                console.warn(`[ManualTracking] DIAG: WARNING — self-test position off by (${dx.toFixed(1)}, ${dy.toFixed(1)})px! Template may not match this frame.`);
            }
        } else {
            console.error(`[ManualTracking] DIAG: Self-test returned null (no template in map?)`);
        }
    }
    // === END DIAGNOSTIC ===

    // Record first frame
    const firstFrame: TrackedFrame = {
        time: startTime,
        trackers: internalTrackers.map(it => ({
            id: it.id, x: it.x, y: it.y, matchScore: 100,
        })),
    };
    results.push(firstFrame);
    onFrame?.(firstFrame);

    // Main tracking loop — use index-based iteration to avoid float accumulation
    for (let i = 1; i <= totalSamples; i++) {
        // Check for abort
        if (signal?.aborted) {
            console.log(`[ManualTracking] Aborted at frame ${i}/${totalSamples}`);
            onProgress?.(1.0, `Stopped — ${results.length} frames tracked`);
            return results;
        }

        const t = startTime + i * SAMPLE_INTERVAL;
        if (t > endTime) break;

        const progress = i / totalSamples;
        onProgress?.(0.05 + progress * 0.90, `Tracking ${internalTrackers.length} points — frame ${i}/${totalSamples}`);

        // Shift history
        prevPrevFramePoints.clear();
        for (const [id, pt] of prevFramePoints) prevPrevFramePoints.set(id, pt);
        prevFramePoints.clear();
        for (const it of internalTrackers) {
            const lp = lastPoints.get(it.id);
            if (lp) prevFramePoints.set(it.id, { ...lp });
        }

        await seekAndDraw(video, ctx, t);

        // Log actual video time vs target for first 5 frames
        if (i <= 5) {
            console.log(`[ManualTracking] Frame ${i}: target=${t.toFixed(3)}, actual=${video.currentTime.toFixed(3)}, delta=${(video.currentTime - t).toFixed(3)}s`);
        }

        const frameTrackers: TrackedFrame['trackers'] = [];

        for (const tracker of internalTrackers) {
            const prevPoint = lastPoints.get(tracker.id) || tracker;

            // Velocity prediction
            let velocityX = 0, velocityY = 0;
            const p1 = prevFramePoints.get(tracker.id);
            if (p1) {
                const p2 = prevPrevFramePoints.get(tracker.id);
                if (p2) {
                    velocityX = p1.x - p2.x;
                    velocityY = p1.y - p2.y;
                }
            }

            const predictedX = prevPoint.x + velocityX;
            const predictedY = prevPoint.y + velocityY;
            const result = findBestMatch(ctx, prevPoint, predictedX, predictedY, templates);

            if (!result) {
                // No template, keep at last position with score 0
                frameTrackers.push({ id: tracker.id, x: prevPoint.x, y: prevPoint.y, matchScore: 0 });
                if (i <= 5) console.warn(`[ManualTracking] Frame ${i}: tracker ${tracker.id} — NO RESULT (null template?)`);
                continue;
            }

            // Log first 5 frames for diagnostics
            if (i <= 5) {
                const dx = result.point.x - predictedX;
                const dy = result.point.y - predictedY;
                const totalDrift = result.point.x - tracker.x;
                const totalDriftY = result.point.y - tracker.y;
                console.log(`[ManualTracking] Frame ${i}: score=${result.point.matchScore?.toFixed(1)}, delta=(${dx.toFixed(1)},${dy.toFixed(1)}), totalDrift=(${totalDrift.toFixed(1)},${totalDriftY.toFixed(1)}), vel=(${velocityX.toFixed(1)},${velocityY.toFixed(1)})`);
            }

            lastPoints.set(tracker.id, result.point);
            frameTrackers.push({
                id: tracker.id,
                x: result.point.x,
                y: result.point.y,
                matchScore: result.point.matchScore ?? 0,
            });
        }

        const frame: TrackedFrame = { time: t, trackers: frameTrackers };
        results.push(frame);
        onFrame?.(frame);

        // Yield to browser event loop — gives the video decoder time to process
        // the next frame and prevents the tracking from starving other tasks
        await new Promise<void>(r => setTimeout(r, 0));
    }

    onProgress?.(1.0, `Done — ${results.length} frames tracked`);
    console.log(`[ManualTracking] Complete: ${results.length} frames, ${internalTrackers.length} trackers`);
    return results;
}

/**
 * Generate stabilization keyframes from tracking data.
 * For each frame, computes the median delta of specified stabilizer trackers
 * relative to their initial positions, then returns INVERSE translateX/Y
 * as percentage offsets (to counteract the motion).
 * Uses raw deltas with no smoothing — EMA introduced a lag that caused visible
 * drift between the tracked motion and the applied keyframes.
 * Keyframe times are relative to segment start.
 */
export function generateStabilizationKeyframes(
    trackingData: TrackedFrame[],
    stabTrackerIds: string[],
    segment: TrackingSegment,
    videoWidth: number,
    videoHeight: number
): ClipKeyframe[] {
    if (trackingData.length === 0 || stabTrackerIds.length === 0) return [];

    // Get initial positions from first frame
    const firstFrame = trackingData[0];
    const initialPos = new Map<string, { x: number; y: number }>();
    for (const t of firstFrame.trackers) {
        if (stabTrackerIds.includes(t.id)) {
            initialPos.set(t.id, { x: t.x, y: t.y });
        }
    }

    if (initialPos.size === 0) return [];

    // Compute deltas per frame
    const rawDeltas: { time: number; dx: number; dy: number }[] = [];

    for (const frame of trackingData) {
        const deltas: { dx: number; dy: number }[] = [];
        for (const t of frame.trackers) {
            const init = initialPos.get(t.id);
            if (!init) continue;
            deltas.push({ dx: t.x - init.x, dy: t.y - init.y });
        }
        if (deltas.length === 0) continue;

        // Median delta
        const sortedDx = deltas.map(d => d.dx).sort((a, b) => a - b);
        const sortedDy = deltas.map(d => d.dy).sort((a, b) => a - b);
        const medDx = sortedDx[Math.floor(sortedDx.length / 2)];
        const medDy = sortedDy[Math.floor(sortedDy.length / 2)];

        rawDeltas.push({ time: frame.time, dx: medDx, dy: medDy });
    }

    if (rawDeltas.length === 0) return [];

    // Convert raw deltas directly to keyframes with INVERSE motion (to stabilize)
    // No EMA smoothing — it introduced a constant lag that caused visible drift
    const keyframes: ClipKeyframe[] = rawDeltas.map(d => ({
        time: d.time - segment.startTime,
        translateX: -(d.dx / videoWidth) * 100,
        translateY: -(d.dy / videoHeight) * 100,
        scale: 1,
        rotation: 0,
    }));

    console.log(`[Stabilization] Generated ${keyframes.length} keyframes`);
    return keyframes;
}

/**
 * Generate follow keyframes from tracking data for a single tracker.
 * Extracts one tracker's motion path and returns FORWARD translateX/Y
 * as percentage offsets. Uses raw deltas with no smoothing.
 * Keyframe times are relative to segment start.
 */
export function generateFollowKeyframes(
    trackingData: TrackedFrame[],
    trackerId: string,
    segment: TrackingSegment,
    videoWidth: number,
    videoHeight: number
): ClipKeyframe[] {
    if (trackingData.length === 0) return [];

    // Get initial position from first frame
    const firstTrackerData = trackingData[0].trackers.find(t => t.id === trackerId);
    if (!firstTrackerData) return [];

    const initX = firstTrackerData.x;
    const initY = firstTrackerData.y;

    // Extract motion deltas
    const rawDeltas: { time: number; dx: number; dy: number }[] = [];
    for (const frame of trackingData) {
        const tData = frame.trackers.find(t => t.id === trackerId);
        if (!tData) continue;
        rawDeltas.push({
            time: frame.time,
            dx: tData.x - initX,
            dy: tData.y - initY,
        });
    }

    if (rawDeltas.length === 0) return [];

    // Convert raw deltas directly to keyframes with FORWARD motion (follows the point)
    // No EMA smoothing — it introduced a constant lag that caused visible drift
    const keyframes: ClipKeyframe[] = rawDeltas.map(d => ({
        time: d.time - segment.startTime,
        translateX: (d.dx / videoWidth) * 100,
        translateY: (d.dy / videoHeight) * 100,
        scale: 1,
        rotation: 0,
    }));

    console.log(`[FollowTracker] Generated ${keyframes.length} keyframes for tracker ${trackerId}`);
    return keyframes;
}
