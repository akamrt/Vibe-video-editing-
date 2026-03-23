/**
 * Tracking bridge: tries Python-enhanced tracking first, falls back to browser-based.
 *
 * The Python tracker (vibecut-tracker) uses MediaPipe + OpenCV for faster, more robust
 * person detection and tracking. If unavailable, falls back seamlessly to the existing
 * canvas-based SAD template matching in templateTrackingService.ts.
 */

import { ClipKeyframe } from '../types';
import type { PivotKeyframe } from '../types';
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
    if (!res.ok) {
      console.log(`[TrackingBridge] capabilities check failed: HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    const available = data.success && data.available;
    console.log(`[TrackingBridge] capabilities check: available=${available}`, data);
    return available;
  } catch (e) {
    console.log('[TrackingBridge] capabilities check error (server not running?):', e);
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
      const errText = await res.text().catch(() => '');
      console.error(`[TrackingBridge] Upload failed: HTTP ${res.status}`, errText.substring(0, 200));
      return null;
    }

    const data = await res.json();
    if (!data.success || !data.fileId) {
      console.error('[TrackingBridge] Upload returned unexpected data:', data);
      return null;
    }

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
 * Reconstruct a File object from a video element's src URL (blob: or http:).
 * This handles the case where the original File object was lost (e.g., after page reload)
 * but the video element still has a valid src with the video data.
 */
async function reconstructFileFromVideoElement(
  videoElement: HTMLVideoElement,
  onProgress?: (progress: number, label: string) => void,
): Promise<File | null> {
  const src = videoElement.src || videoElement.currentSrc;
  if (!src) {
    console.log('[TrackingBridge] No video src to reconstruct File from');
    return null;
  }

  try {
    onProgress?.(0.02, 'Preparing video for upload...');
    const response = await fetch(src);
    if (!response.ok) {
      console.error('[TrackingBridge] Failed to fetch video src:', response.status);
      return null;
    }
    const blob = await response.blob();
    // Determine a reasonable filename and type
    const type = blob.type || 'video/mp4';
    const ext = type.includes('webm') ? '.webm' : type.includes('ogg') ? '.ogg' : '.mp4';
    const name = `video_${Date.now()}${ext}`;
    const file = new File([blob], name, { type });
    console.log(`[TrackingBridge] Reconstructed File from blob URL: ${name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
    return file;
  } catch (e) {
    console.error('[TrackingBridge] Failed to reconstruct File from video src:', e);
    return null;
  }
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
    // If no File object (e.g., lost after page reload), reconstruct from video element's blob URL
    let file = videoFile;
    console.log(`[TrackingBridge] Starting: videoFile=${videoFile ? `File(${videoFile.name}, ${(videoFile.size/1024/1024).toFixed(1)}MB)` : 'null'}, videoEl.src=${videoElement.src?.substring(0, 60) || 'none'}`);
    if (!file) {
      console.log('[TrackingBridge] No File object, reconstructing from video element src...');
      file = await reconstructFileFromVideoElement(videoElement, onProgress);
      if (!file) {
        console.log('[TrackingBridge] Could not obtain video file, skipping Python tracker');
        return null;
      }
    }
    console.log(`[TrackingBridge] File ready: name=${file.name}, size=${(file.size / 1024 / 1024).toFixed(1)}MB, type=${file.type}`);

    onProgress?.(0.01, 'Checking Python tracker...');

    // First check if the Python tracker is available
    const available = await checkPythonTrackerAvailable();
    if (!available) {
      console.log('[TrackingBridge] Python tracker not available (server says unavailable)');
      return null;
    }
    console.log('[TrackingBridge] Tracker available, uploading video...');

    // Upload the video file to the server
    onProgress?.(0.03, 'Uploading video for tracking...');
    const fileId = await uploadVideoForTracking(file, onProgress);
    if (!fileId) {
      console.log('[TrackingBridge] Video upload failed');
      return null;
    }
    console.log(`[TrackingBridge] Uploaded, fileId=${fileId}. Running analyze...`);

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
    if (response.status === 400 && file) {
      console.log('[TrackingBridge] Got 400 — stale fileId, re-uploading...');
      invalidateUploadCache(file);
      onProgress?.(0.08, 'Re-uploading video (server restarted)...');
      const freshFileId = await uploadVideoForTracking(file, onProgress, true);
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

    console.log(`[TrackingBridge] Analyze response: HTTP ${response.status}`);

    if (response.status === 501 || response.status === 404) {
      console.log('[TrackingBridge] Tracker endpoint not available:', response.status);
      return null;
    }

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[TrackingBridge] Analyze failed: HTTP ${response.status}:`, errBody.substring(0, 500));
      return null;
    }

    const result: PythonTrackingResult = await response.json();
    console.log(`[TrackingBridge] Result: success=${result.success}, positions=${result.positions?.length ?? 0}, method=${result.method || 'n/a'}, error=${result.error || 'none'}`);
    if (result.stderr) console.log(`[TrackingBridge] Tracker stderr: ${result.stderr.substring(0, 300)}`);

    if (!result.success) {
      console.error('[TrackingBridge] Python tracker error:', result.error, result.stderr);
      return null;
    }

    if (result.fallback || !result.positions || result.positions.length === 0) {
      console.log('[TrackingBridge] Python tracker returned no usable positions, falling back to browser');
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

// ============ HEAD PIVOT TRACKING ============

/**
 * Track the person's head and return PivotKeyframes in safe-zone % coordinates.
 *
 * @param videoFile  - Source video File object (null = reconstruct from videoElement.src)
 * @param videoElement - The video element (used for fallback reconstruction + native size)
 * @param segment    - The clip segment time range to track
 * @param cropAspectRatio - Output crop AR (e.g. 9/16). Used to compute safe-zone bounds.
 * @param onProgress - Optional progress callback
 */
export async function trackHeadForPivot(
  videoFile: File | null,
  videoElement: HTMLVideoElement,
  segment: TrackingSegment,
  cropAspectRatio: number,
  onProgress?: (progress: number, label: string) => void,
): Promise<PivotKeyframe[] | null> {
  try {
    let file = videoFile;
    if (!file) {
      file = await reconstructFileFromVideoElement(videoElement, onProgress);
      if (!file) {
        console.log('[TrackingBridge] trackHeadForPivot: could not obtain video file');
        return null;
      }
    }

    const available = await checkPythonTrackerAvailable();
    if (!available) {
      console.log('[TrackingBridge] trackHeadForPivot: Python tracker not available');
      return null;
    }

    onProgress?.(0.05, 'Uploading for head tracking...');
    let fileId = await uploadVideoForTracking(file, onProgress);
    if (!fileId) return null;

    onProgress?.(0.15, 'Running head tracker (MediaPipe)...');

    const makeRequest = (fid: string) => fetch('/api/tracking/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: fid,
        startTime: segment.startTime,
        endTime: segment.endTime,
        sampleInterval: 0.1,
        mode: 'head_center',
        options: {},
      }),
    });

    let response = await makeRequest(fileId);

    // Retry on stale fileId (server restarted)
    if (response.status === 400 && file) {
      console.log('[TrackingBridge] trackHeadForPivot: stale fileId, re-uploading...');
      invalidateUploadCache(file);
      const freshId = await uploadVideoForTracking(file, onProgress, true);
      if (!freshId) return null;
      fileId = freshId;
      response = await makeRequest(fileId);
    }

    if (!response.ok) {
      console.error('[TrackingBridge] trackHeadForPivot: analyze failed', response.status);
      return null;
    }

    const result: PythonTrackingResult = await response.json();
    if (!result.success || !result.positions || result.positions.length === 0) {
      console.log('[TrackingBridge] trackHeadForPivot: no positions returned', result.error);
      return null;
    }

    const vw = result.videoWidth || videoElement.videoWidth;
    const vh = result.videoHeight || videoElement.videoHeight;
    const videoAR = vw / vh;

    // Compute safe-zone rectangle in video pixels
    let szLeft: number, szTop: number, szWidth: number, szHeight: number;
    if (cropAspectRatio < videoAR) {
      // Pillarbox (e.g. 9:16 crop in 16:9 video): safe zone is vertically full, horizontally centered
      szHeight = vh;
      szWidth = vh * cropAspectRatio;
      szLeft = (vw - szWidth) / 2;
      szTop = 0;
    } else {
      // Letterbox: safe zone is horizontally full, vertically centered
      szWidth = vw;
      szHeight = vw / cropAspectRatio;
      szLeft = 0;
      szTop = (vh - szHeight) / 2;
    }

    onProgress?.(0.9, 'Generating pivot keyframes...');

    // Convert video-pixel positions to safe-zone % pivot keyframes
    const keyframes: PivotKeyframe[] = [];
    let lastX = -999;
    let lastY = -999;

    for (const pos of result.positions) {
      const relTime = pos.time - segment.startTime;
      if (relTime < -0.001) continue;

      const pivX = ((pos.x - szLeft) / szWidth) * 100;
      const pivY = ((pos.y - szTop) / szHeight) * 100;

      // Only emit keyframe when pivot has moved meaningfully (>0.5% of safe zone)
      if (Math.abs(pivX - lastX) > 0.5 || Math.abs(pivY - lastY) > 0.5 || keyframes.length === 0) {
        keyframes.push({
          time: Math.round(Math.max(0, relTime) * 1000) / 1000,
          x: Math.round(pivX * 10) / 10,
          y: Math.round(pivY * 10) / 10,
        });
        lastX = pivX;
        lastY = pivY;
      }
    }

    // Ensure there is a keyframe at the end of the segment
    const lastPos = result.positions[result.positions.length - 1];
    if (lastPos) {
      const lastRelTime = lastPos.time - segment.startTime;
      const lastKf = keyframes[keyframes.length - 1];
      if (!lastKf || lastKf.time < lastRelTime - 0.05) {
        keyframes.push({
          time: Math.round(Math.max(0, lastRelTime) * 1000) / 1000,
          x: lastKf?.x ?? 50,
          y: lastKf?.y ?? 20,
        });
      }
    }

    onProgress?.(1.0, `Head pivot: ${keyframes.length} keyframes generated`);
    console.log(`[TrackingBridge] trackHeadForPivot: ${keyframes.length} pivot keyframes, method=${result.method}`);
    return keyframes;

  } catch (e) {
    console.error('[TrackingBridge] trackHeadForPivot error:', e);
    return null;
  }
}
