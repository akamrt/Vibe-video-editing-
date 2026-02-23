// Audio analysis utilities for snap-to-silence edit points
// Uses Web Audio API locally — no AI/API calls needed

// ── Types ────────────────────────────────────────────────

export interface SilenceSearchResult {
  /** The snapped time in source-video seconds */
  time: number;
  /** RMS energy at the snapped point (0 = perfect silence) */
  energy: number;
  /** How far (seconds) the snap moved from the original point */
  offset: number;
}

export interface SnappedFillerRange {
  startTime: number;
  endTime: number;
}

// ── AudioBuffer Cache ────────────────────────────────────

const audioBufferCache = new Map<string, AudioBuffer>();

/**
 * Decode audio from a video File into a Web Audio AudioBuffer.
 * Results are cached by mediaId so subsequent calls are instant.
 */
export async function getAudioBuffer(mediaId: string, file: File): Promise<AudioBuffer> {
  const cached = audioBufferCache.get(mediaId);
  if (cached) return cached;

  console.log(`[AudioAnalysis] Decoding audio for ${mediaId} (${(file.size / 1024 / 1024).toFixed(1)} MB)...`);
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new OfflineAudioContext(1, 1, 44100);
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  audioBufferCache.set(mediaId, audioBuffer);
  console.log(`[AudioAnalysis] Decoded: ${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch`);
  return audioBuffer;
}

/** Clear cached AudioBuffers when media is removed or project is reset */
export function clearAudioBufferCache(mediaId?: string): void {
  if (mediaId) {
    audioBufferCache.delete(mediaId);
  } else {
    audioBufferCache.clear();
  }
}

// ── Internal Helpers ─────────────────────────────────────

/** Compute RMS energy for a window of audio samples. Returns [0, 1] where 0 = silence. */
function computeRMS(samples: Float32Array, startSample: number, windowSize: number): number {
  const end = Math.min(startSample + windowSize, samples.length);
  const start = Math.max(startSample, 0);
  const count = end - start;
  if (count <= 0) return 0;

  let sumSquares = 0;
  for (let i = start; i < end; i++) {
    sumSquares += samples[i] * samples[i];
  }
  return Math.sqrt(sumSquares / count);
}

/**
 * Build an RMS energy envelope for a time range.
 * Returns an array of { sample, rms } at each step position.
 */
function buildEnergyEnvelope(
  samples: Float32Array,
  startSample: number,
  endSample: number,
  windowSizeSamples: number,
  stepSamples: number
): Array<{ sample: number; rms: number }> {
  const envelope: Array<{ sample: number; rms: number }> = [];
  for (let s = startSample; s <= endSample - windowSizeSamples; s += stepSamples) {
    envelope.push({
      sample: s + Math.floor(windowSizeSamples / 2),
      rms: computeRMS(samples, s, windowSizeSamples),
    });
  }
  return envelope;
}

/**
 * Compute a noise floor estimate from the lowest 10th-percentile of energy values.
 * This adapts to the recording's ambient noise level.
 */
function estimateNoiseFloor(envelope: Array<{ rms: number }>): number {
  if (envelope.length === 0) return 0;
  const sorted = envelope.map(e => e.rms).sort((a, b) => a - b);
  const p10Index = Math.max(0, Math.floor(sorted.length * 0.1));
  return sorted[p10Index];
}

/**
 * Find the nearest zero-crossing point to a target sample index.
 * Searches up to maxSearchSamples in each direction (~2ms at 44.1kHz).
 */
function findNearestZeroCrossing(
  samples: Float32Array,
  targetSample: number,
  maxSearchSamples: number = 100
): number {
  const clamped = Math.max(1, Math.min(targetSample, samples.length - 2));

  for (let offset = 0; offset < maxSearchSamples; offset++) {
    // Check forward
    const fwd = clamped + offset;
    if (fwd < samples.length - 1 && samples[fwd] * samples[fwd + 1] <= 0) return fwd;
    // Check backward
    const bwd = clamped - offset;
    if (bwd >= 1 && samples[bwd - 1] * samples[bwd] <= 0) return bwd;
  }

  return clamped; // No crossing found nearby — use original
}

// ── Exported Functions ───────────────────────────────────

/**
 * Find the nearest low-energy (silent) point near a proposed cut time.
 *
 * Strategy:
 * 1. Build an energy envelope with 30ms windows (word-boundary scale, not micro-pause)
 * 2. Compute adaptive noise floor from the search range
 * 3. Find all "quiet" regions (energy < noiseFloor * 3) — these are inter-word gaps
 * 4. Pick the quiet region closest to targetTime (prefer proximity, not absolute minimum)
 * 5. Within that region, find the minimum energy point
 * 6. Refine to zero-crossing for click-free cut
 */
export function findNearestSilence(
  audioBuffer: AudioBuffer,
  targetTime: number,
  searchWindowSec: number = 0.3,
  analysisWindowMs: number = 30
): SilenceSearchResult {
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);
  const windowSizeSamples = Math.floor((analysisWindowMs / 1000) * sampleRate);
  const stepSamples = Math.floor(windowSizeSamples / 3); // ~67% overlap for smoother envelope

  const searchStart = Math.max(0, targetTime - searchWindowSec);
  const searchEnd = Math.min(audioBuffer.duration, targetTime + searchWindowSec);
  const startSample = Math.floor(searchStart * sampleRate);
  const endSample = Math.floor(searchEnd * sampleRate);
  const targetSample = Math.floor(targetTime * sampleRate);

  // Build energy envelope
  const envelope = buildEnergyEnvelope(samples, startSample, endSample, windowSizeSamples, stepSamples);
  if (envelope.length === 0) {
    return { time: targetTime, energy: 0, offset: 0 };
  }

  // Adaptive threshold: noise floor * 3 (anything below is "quiet enough" for a cut)
  const noiseFloor = estimateNoiseFloor(envelope);
  const quietThreshold = Math.max(noiseFloor * 3, 0.005); // min threshold for near-digital-silence

  // Find quiet regions (contiguous runs of below-threshold frames)
  type QuietRegion = { startIdx: number; endIdx: number; minRms: number; minSample: number };
  const quietRegions: QuietRegion[] = [];
  let regionStart = -1;

  for (let i = 0; i < envelope.length; i++) {
    if (envelope[i].rms < quietThreshold) {
      if (regionStart === -1) regionStart = i;
    } else {
      if (regionStart !== -1) {
        // Close this quiet region
        let minRms = Infinity, minSample = envelope[regionStart].sample;
        for (let j = regionStart; j < i; j++) {
          if (envelope[j].rms < minRms) {
            minRms = envelope[j].rms;
            minSample = envelope[j].sample;
          }
        }
        quietRegions.push({ startIdx: regionStart, endIdx: i - 1, minRms, minSample });
        regionStart = -1;
      }
    }
  }
  // Close final region if open
  if (regionStart !== -1) {
    let minRms = Infinity, minSample = envelope[regionStart].sample;
    for (let j = regionStart; j < envelope.length; j++) {
      if (envelope[j].rms < minRms) {
        minRms = envelope[j].rms;
        minSample = envelope[j].sample;
      }
    }
    quietRegions.push({ startIdx: regionStart, endIdx: envelope.length - 1, minRms, minSample });
  }

  let bestSample: number;
  let bestEnergy: number;

  if (quietRegions.length > 0) {
    // Pick the quiet region whose center is closest to the target
    let bestRegion = quietRegions[0];
    let bestDist = Infinity;
    for (const region of quietRegions) {
      const regionCenter = (envelope[region.startIdx].sample + envelope[region.endIdx].sample) / 2;
      const dist = Math.abs(regionCenter - targetSample);
      if (dist < bestDist) {
        bestDist = dist;
        bestRegion = region;
      }
    }
    bestSample = bestRegion.minSample;
    bestEnergy = bestRegion.minRms;
  } else {
    // No quiet region found — fall back to absolute minimum energy (original behavior)
    let minRms = Infinity;
    bestSample = targetSample;
    for (const e of envelope) {
      if (e.rms < minRms) {
        minRms = e.rms;
        bestSample = e.sample;
      }
    }
    bestEnergy = minRms;
  }

  // Refine to nearest zero-crossing for a click-free cut
  bestSample = findNearestZeroCrossing(samples, bestSample);
  const bestTime = bestSample / sampleRate;

  console.log(`[AudioAnalysis] Snap ${targetTime.toFixed(3)}s → ${bestTime.toFixed(3)}s (Δ${(bestTime - targetTime).toFixed(3)}s, energy=${bestEnergy.toFixed(4)}, noise=${noiseFloor.toFixed(4)}, thresh=${quietThreshold.toFixed(4)}, regions=${quietRegions.length})`);

  return {
    time: bestTime,
    energy: bestEnergy,
    offset: bestTime - targetTime,
  };
}

/**
 * Snap both ends of a filler removal range to silence boundaries.
 *
 * For the START of the filler: search ONLY in the region before the filler
 * (between pre-filler speech and filler onset) — we want to cut right after
 * the previous word ends.
 *
 * For the END of the filler: search ONLY in the region after the filler
 * (between filler offset and next word) — we want to cut right before the
 * next word starts.
 *
 * A small padding (20ms) is added into the silence to avoid cutting right
 * at the speech boundary edge.
 */
export function snapFillerRange(
  audioBuffer: AudioBuffer,
  fillerStart: number,
  fillerEnd: number,
  maxSnapSec: number = 0.3
): SnappedFillerRange {
  const PADDING_SEC = 0.02; // 20ms padding into silence (avoids cutting at the very edge of speech)

  // For start: search the region BEFORE the filler (from maxSnap before to slightly into filler)
  // This finds the gap between the previous word and the filler
  const startSearchCenter = fillerStart - maxSnapSec / 2;
  const startResult = findNearestSilence(audioBuffer,
    Math.max(0, startSearchCenter),
    maxSnapSec / 2 + 0.05 // slightly asymmetric — mostly looking before
  );
  // Accept if snap is before filler start (or very close to it)
  let snappedStart: number;
  if (startResult.time <= fillerStart + 0.02) {
    // Add padding: move slightly into the silence gap (away from preceding speech)
    snappedStart = Math.min(startResult.time + PADDING_SEC, fillerStart);
  } else {
    snappedStart = fillerStart;
  }

  // For end: search the region AFTER the filler (from slightly before filler end to maxSnap after)
  const endSearchCenter = fillerEnd + maxSnapSec / 2;
  const endResult = findNearestSilence(audioBuffer,
    Math.min(audioBuffer.duration, endSearchCenter),
    maxSnapSec / 2 + 0.05
  );
  // Accept if snap is after filler end (or very close to it)
  let snappedEnd: number;
  if (endResult.time >= fillerEnd - 0.02) {
    // Add padding: move slightly into the silence gap (away from following speech)
    snappedEnd = Math.max(endResult.time - PADDING_SEC, fillerEnd);
  } else {
    snappedEnd = fillerEnd;
  }

  // Safety: don't create an inverted or zero-length range
  if (snappedStart >= snappedEnd) {
    return { startTime: fillerStart, endTime: fillerEnd };
  }

  console.log(`[AudioAnalysis] Filler snap: [${fillerStart.toFixed(3)} - ${fillerEnd.toFixed(3)}] → [${snappedStart.toFixed(3)} - ${snappedEnd.toFixed(3)}]`);

  return { startTime: snappedStart, endTime: snappedEnd };
}
