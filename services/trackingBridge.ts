/**
 * Tracking bridge: tries Python-enhanced tracking first, falls back to browser-based.
 *
 * The Python tracker (vibecut-tracker) uses MediaPipe + OpenCV for faster, more robust
 * person detection and tracking. If unavailable, falls back seamlessly to the existing
 * canvas-based SAD template matching in templateTrackingService.ts.
 */

import { ClipKeyframe } from '../types';
import type { TrackingSegment } from './templateTrackingService';

interface PythonTrackingPosition {
  time: number;
  x: number;
  y: number;
  confidence: number;
}

interface PythonTrackingResult {
  success: boolean;
  positions?: PythonTrackingPosition[];
  videoWidth?: number;
  videoHeight?: number;
  frameCount?: number;
  method?: string;
  error?: string;
  stderr?: string;
  fallback?: boolean;
}

// Cache uploaded file IDs so we don't re-upload the same file for each scan
const uploadCache = new Map<string, { fileId: string; uploadedAt: number }>();

/**
 * Check if the Python tracker is available on the server.
 */
export async function checkPythonTrackerAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/tracking/capabilities');
    if (!res.ok) return false;
    const data = await res.json();
    return data.success && data.available;
  } catch {
    return false;
  }
}

/**
 * Invalidate the upload cache for a given file (e.g., after server restart).
 */
function invalidateUploadCache(file: File): void {
  const cacheKey = `${file.name}_${file.size}`;
  if (uploadCache.has(cacheKey)) {
    console.log(`[TrackingBridge] Invalidating cached upload for: ${cacheKey}`);
    uploadCache.delete(cacheKey);
  }
}

/**
 * Upload a video file to the server for Python tracking.
 * Returns a fileId that can be used with /api/tracking/analyze.
 * Caches by file name + size to avoid re-uploading.
 * Set skipCache=true to force a fresh upload (e.g., after server restart).
 */
async function uploadVideoForTracking(
  file: File,
  onProgress?: (progress: number, label: string) => void,
  skipCache: boolean = false,
): Promise<string | null> {
  // Check cache (valid for 30 minutes) unless we're forcing a fresh upload
  if (!skipCache) {
    const cacheKey = `${file.name}_${file.size}`;
    const cached = uploadCache.get(cacheKey);
    if (cached && Date.now() - cached.uploadedAt < 1800000) {
      console.log(`[TrackingBridge] Using cached upload: ${cached.fileId}`);
      return cached.fileId;
    }
  }

  try {
    onProgress?.(0.05, 'Uploading video to tracker...');

    const formData = new FormData();
    formData.append('video', file);

    const res = await fetch('/api/tracking/upload', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      console.error('[TrackingBridge] Upload failed:', res.status);
      return null;
    }

    const data = await res.json();
    if (!data.success || !data.fileId) return null;

    // Cache the upload
    const cacheKey = `${file.name}_${file.size}`;
    uploadCache.set(cacheKey, { fileId: data.fileId, uploadedAt: Date.now() });
    console.log(`[TrackingBridge] Video uploaded: ${data.fileId} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
    return data.fileId;
  } catch (e) {
    console.error('[TrackingBridge] Upload error:', e);
    return null;
  }
}

/**
 * Smooth an array of numbers with a simple moving average.
 */
function smoothArray(values: number[], windowSize: number): number[] {
  if (values.length <= 2) return [...values];
  const half = Math.floor(windowSize / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    const slice = values.slice(lo, hi);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/**
 * Convert Python tracker positions to ClipKeyframe[] format.
 *
 * The Python tracker returns pixel positions (already smoothed with median + EMA).
 * We convert to translateX/Y percentage values matching the app's coordinate system:
 *   translateX = -(personCenterPercent - 50)
 * where personCenterPercent is 0-100 (0=left edge, 50=center, 100=right edge).
 *
 * CSS translate(X%) uses the element's own rendered width, so the max translateX
 * depends on how much wider the video is than the crop viewport.
 * For 9:16 crop of 16:9 video, max ≈ ±34%.
 */
function convertPositionsToKeyframes(
  positions: PythonTrackingPosition[],
  segment: TrackingSegment,
  videoWidth: number,
  videoHeight: number,
): { keyframes: ClipKeyframe[]; triggerCount: number } {
  if (positions.length === 0) return { keyframes: [], triggerCount: 0 };

  // Compute max translateX using the same formula as computeFollowPanPosition in App.tsx:
  //   visibleFractionX = cropAR / videoAR
  //   maxShiftX = (1 - visibleFractionX) * 50
  // For 9:16 crop of 16:9 video: (1 - (9/16)/(16/9)) * 50 ≈ 34.18%
  const videoAR = videoWidth / videoHeight;
  const cropAR = 9 / 16; // Portrait (9:16) — the primary use case for person tracking
  const visibleFractionX = Math.min(1, cropAR / videoAR);
  const maxShiftX = Math.max(5, (1 - visibleFractionX) * 50);

  // Step 1: Smooth positions with a wide moving average (Python already EMA-smoothed)
  const rawXs = positions.map(p => p.x);
  const smoothedXs = smoothArray(rawXs, 11);

  // Step 2: Compute translateX using the app's convention: -(centerPct - 50)
  const rawTranslates: { time: number; translateX: number }[] = [];
  let triggerCount = 0;
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const relativeTime = pos.time - segment.startTime;
    if (relativeTime < 0) continue;

    // Convert smoothed pixel position to 0-100 percentage
    const centerPct = (smoothedXs[i] / videoWidth) * 100;

    // App convention: negative translateX shifts crop to show right side
    let translateX = -(centerPct - 50);

    // Clamp so crop stays within frame bounds
    translateX = Math.max(-maxShiftX, Math.min(maxShiftX, translateX));

    if (Math.abs(translateX) > 5) triggerCount++;
    rawTranslates.push({ time: relativeTime, translateX });
  }

  // Step 3: Smooth the translateX values
  const txValues = rawTranslates.map(t => t.translateX);
  const smoothedTx = smoothArray(txValues, 11);

  // Step 4: Velocity limiter — cap max pan speed for smooth camera movement
  const MAX_PAN_PER_SAMPLE = 1.5; // percentage points per 0.1s
  const velocityLimited = [smoothedTx[0]];
  for (let i = 1; i < smoothedTx.length; i++) {
    const delta = smoothedTx[i] - velocityLimited[i - 1];
    const clamped = Math.max(-MAX_PAN_PER_SAMPLE, Math.min(MAX_PAN_PER_SAMPLE, delta));
    velocityLimited.push(velocityLimited[i - 1] + clamped);
  }

  // Step 5: Generate keyframes — emit when translateX changes by at least 1%
  const keyframes: ClipKeyframe[] = [];
  let lastTranslateX = 0;

  for (let i = 0; i < rawTranslates.length; i++) {
    const { time } = rawTranslates[i];
    const translateX = velocityLimited[i];

    const significantChange = Math.abs(translateX - lastTranslateX) > 1.0;
    if (significantChange || keyframes.length === 0) {
      keyframes.push({
        time,
        translateX: Math.round(translateX * 10) / 10,
        translateY: 0,
        scale: 1,
        rotation: 0,
      });
      lastTranslateX = translateX;
    }
  }

  // Ensure we have a final keyframe at the end
  if (rawTranslates.length > 0 && keyframes.length > 0) {
    const lastTime = rawTranslates[rawTranslates.length - 1].time;
    const lastKf = keyframes[keyframes.length - 1];
    if (lastKf.time < lastTime - 0.05) {
      keyframes.push({
        time: lastTime,
        translateX: lastKf.translateX,
        translateY: 0,
        scale: 1,
        rotation: 0,
      });
    }
  }

  return { keyframes, triggerCount };
}

/**
 * Full scan-and-center pipeline: person detection + tracking in one shot.
 *
 * When the Python tracker is available, this uploads the video file to the server,
 * runs MediaPipe detection + OpenCV tracking locally (zero API cost).
 * If Python is unavailable or upload fails, returns null so the caller can fall back to browser.
 */
export async function fullScanAndCenter(
  videoElement: HTMLVideoElement,
  segment: TrackingSegment,
  outOfZoneThreshold: number,
  videoFile: File | null,
  onProgress?: (progress: number, label: string) => void,
): Promise<{ keyframes: ClipKeyframe[]; triggerCount: number; frameCount: number; method: string } | null> {
  try {
    if (!videoFile) {
      console.log('[TrackingBridge] No video file provided, skipping Python tracker');
      return null;
    }

    onProgress?.(0.01, 'Checking Python tracker...');

    // First check if the Python tracker is available
    const available = await checkPythonTrackerAvailable();
    if (!available) {
      console.log('[TrackingBridge] Python tracker not available');
      return null;
    }

    // Upload the video file to the server
    onProgress?.(0.03, 'Uploading video for tracking...');
    const fileId = await uploadVideoForTracking(videoFile, onProgress);
    if (!fileId) {
      console.log('[TrackingBridge] Video upload failed');
      return null;
    }

    onProgress?.(0.15, 'Python tracker running (MediaPipe)...');

    // Call Python tracker — it detects the person and tracks through the segment
    let analyzeFileId = fileId;
    let response = await fetch('/api/tracking/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: analyzeFileId,
        startTime: segment.startTime,
        endTime: segment.endTime,
        sampleInterval: 0.1,
        mode: 'person_center',
        options: {},
      }),
    });

    // Handle 400 = stale fileId (server restarted, clearing its file map).
    // Invalidate our cache, re-upload, and retry once.
    if (response.status === 400 && videoFile) {
      console.log('[TrackingBridge] Got 400 — stale fileId, re-uploading...');
      invalidateUploadCache(videoFile);
      onProgress?.(0.08, 'Re-uploading video (server restarted)...');
      const freshFileId = await uploadVideoForTracking(videoFile, onProgress, true);
      if (!freshFileId) {
        console.log('[TrackingBridge] Re-upload failed');
        return null;
      }
      analyzeFileId = freshFileId;
      onProgress?.(0.15, 'Python tracker running (MediaPipe)...');
      response = await fetch('/api/tracking/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: analyzeFileId,
          startTime: segment.startTime,
          endTime: segment.endTime,
          sampleInterval: 0.1,
          mode: 'person_center',
          options: {},
        }),
      });
    }

    if (response.status === 501 || response.status === 404) {
      console.log('[TrackingBridge] Tracker endpoint not available:', response.status);
      return null;
    }

    const result: PythonTrackingResult = await response.json();

    if (!result.success) {
      console.error('[TrackingBridge] Python tracker error:', result.error, result.stderr);
      return null;
    }

    if (result.fallback || !result.positions || result.positions.length === 0) {
      console.log('[TrackingBridge] Python tracker returned no positions');
      return null;
    }

    onProgress?.(0.9, 'Generating keyframes from Python tracking...');

    const { keyframes, triggerCount } = convertPositionsToKeyframes(
      result.positions,
      segment,
      result.videoWidth || videoElement.videoWidth,
      result.videoHeight || videoElement.videoHeight,
    );

    onProgress?.(1.0, `Done (Python) — ${keyframes.length} keyframes`);

    return {
      keyframes,
      triggerCount,
      frameCount: result.frameCount || result.positions.length,
      method: result.method || 'python-mediapipe',
    };
  } catch (e) {
    console.error('[TrackingBridge] fullScanAndCenter error:', e);
    return null;
  }
}
