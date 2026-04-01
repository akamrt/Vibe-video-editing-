/**
 * Audio Processing Chain — shared between real-time preview and offline export.
 *
 * Builds a Web Audio API node graph: EQ → Compressor → Limiter → Master Gain.
 * All nodes are standard Web Audio API and work with both AudioContext and OfflineAudioContext.
 */

import type { AudioEffects, AudioMixerState } from '../types';

export interface AudioChain {
  input: GainNode;      // Connect sources here
  output: GainNode;     // Connected to destination by caller
  analyser: AnalyserNode; // For metering (branch off output)
  destroy: () => void;  // Disconnect all nodes
}

/**
 * Build the audio processing chain for given context and settings.
 * Connect source(s) → chain.input, then chain.output → ctx.destination.
 */
export function buildAudioChain(
  ctx: BaseAudioContext,
  effects: AudioEffects,
  masterVolume: number,
): AudioChain {
  const nodes: AudioNode[] = [];

  // Input gain (unity, just a connection point)
  const inputGain = ctx.createGain();
  inputGain.gain.value = 1.0;
  nodes.push(inputGain);

  let lastNode: AudioNode = inputGain;

  // 3-Band EQ
  if (effects.eqEnabled) {
    for (const band of effects.eqBands) {
      const filter = ctx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.frequency;
      filter.gain.value = band.gain;
      filter.Q.value = band.Q;
      lastNode.connect(filter);
      lastNode = filter;
      nodes.push(filter);
    }
  }

  // Compressor
  if (effects.compressorEnabled) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = effects.compressorThreshold;
    comp.knee.value = effects.compressorKnee;
    comp.ratio.value = effects.compressorRatio;
    comp.attack.value = effects.compressorAttack;
    comp.release.value = effects.compressorRelease;
    lastNode.connect(comp);
    lastNode = comp;
    nodes.push(comp);
  }

  // Limiter (hard compressor: high ratio, zero knee)
  if (effects.limiterEnabled) {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = effects.limiterThreshold;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.05;
    lastNode.connect(limiter);
    lastNode = limiter;
    nodes.push(limiter);
  }

  // Master gain
  const masterGain = ctx.createGain();
  masterGain.gain.value = masterVolume;
  lastNode.connect(masterGain);
  nodes.push(masterGain);

  // Analyser (branched off master output for metering)
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  masterGain.connect(analyser);

  return {
    input: inputGain,
    output: masterGain,
    analyser,
    destroy: () => {
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* already disconnected */ }
      }
      try { analyser.disconnect(); } catch { /* ok */ }
    },
  };
}

/**
 * Measure integrated LUFS of a rendered AudioBuffer.
 * Simplified ITU-R BS.1770 implementation (K-weighted loudness).
 */
export function measureLUFS(buffer: AudioBuffer): number {
  const sampleRate = buffer.sampleRate;
  const blockSize = Math.round(0.4 * sampleRate); // 400ms blocks
  const stepSize = Math.round(0.1 * sampleRate);  // 75% overlap
  const channels = Math.min(buffer.numberOfChannels, 2);

  // K-weighting filter coefficients (simplified — apply to blocks)
  // For accurate K-weighting we'd need pre-filter + RLB filter,
  // but for a mixer meter, RMS-based approximation is sufficient.
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    channelData.push(buffer.getChannelData(ch));
  }

  const totalSamples = buffer.length;
  const blockLoudness: number[] = [];

  for (let start = 0; start + blockSize <= totalSamples; start += stepSize) {
    let sumSquared = 0;
    for (let ch = 0; ch < channels; ch++) {
      const data = channelData[ch];
      for (let i = start; i < start + blockSize; i++) {
        sumSquared += data[i] * data[i];
      }
    }
    const meanSquared = sumSquared / (blockSize * channels);
    if (meanSquared > 0) {
      blockLoudness.push(meanSquared);
    }
  }

  if (blockLoudness.length === 0) return -Infinity;

  // Absolute gate: -70 LUFS
  const absThreshold = Math.pow(10, (-70 + 0.691) / 10);
  const gatedBlocks = blockLoudness.filter(l => l >= absThreshold);
  if (gatedBlocks.length === 0) return -Infinity;

  // Relative gate: mean - 10 LUFS
  const absMean = gatedBlocks.reduce((a, b) => a + b, 0) / gatedBlocks.length;
  const relThreshold = absMean * Math.pow(10, -10 / 10);
  const finalBlocks = gatedBlocks.filter(l => l >= relThreshold);
  if (finalBlocks.length === 0) return -Infinity;

  const integratedMean = finalBlocks.reduce((a, b) => a + b, 0) / finalBlocks.length;
  return -0.691 + 10 * Math.log10(integratedMean);
}

/**
 * Apply loudness normalization to an AudioBuffer in-place.
 * Scales all samples so integrated LUFS matches targetLUFS.
 */
export function normalizeLoudness(buffer: AudioBuffer, targetLUFS: number): void {
  const currentLUFS = measureLUFS(buffer);
  if (!isFinite(currentLUFS)) return; // Silent buffer

  const gainDB = targetLUFS - currentLUFS;
  const gainLinear = Math.pow(10, gainDB / 20);

  // Clamp to prevent extreme amplification of quiet content
  const clampedGain = Math.min(gainLinear, 10); // Max +20dB boost

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] *= clampedGain;
    }
  }
}

/**
 * Process an AudioBuffer through RNNoise for noise reduction.
 * Processes sample-by-sample through the WASM module.
 */
export async function processBufferThroughRNNoise(buffer: AudioBuffer): Promise<AudioBuffer> {
  try {
    // Dynamic import to avoid loading WASM unless needed
    const rnnoise = await import('@jitsi/rnnoise-wasm');
    const RnnoiseModule = (rnnoise as any).default || rnnoise;

    // RNNoise operates on 480-sample frames at 48kHz (10ms)
    const FRAME_SIZE = 480;
    const TARGET_RATE = 48000;

    // Create offline context at 48kHz for RNNoise processing
    const outChannels = buffer.numberOfChannels;
    const outLength = Math.round(buffer.length * TARGET_RATE / buffer.sampleRate);
    const offCtx = new OfflineAudioContext(outChannels, outLength, TARGET_RATE);

    // Resample to 48kHz if needed
    const src = offCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(offCtx.destination);
    src.start(0);
    const resampled = await offCtx.startRendering();

    // Initialize RNNoise
    const rnnoiseModule = await RnnoiseModule();
    const denoiseState = rnnoiseModule._rnnoise_create();

    // Process each channel
    for (let ch = 0; ch < resampled.numberOfChannels; ch++) {
      const data = resampled.getChannelData(ch);
      const inputPtr = rnnoiseModule._malloc(FRAME_SIZE * 4);
      const outputPtr = rnnoiseModule._malloc(FRAME_SIZE * 4);

      for (let offset = 0; offset + FRAME_SIZE <= data.length; offset += FRAME_SIZE) {
        // Copy frame to WASM memory (RNNoise expects float32 scaled to ~32768)
        const inputArray = new Float32Array(rnnoiseModule.HEAPF32.buffer, inputPtr, FRAME_SIZE);
        for (let i = 0; i < FRAME_SIZE; i++) {
          inputArray[i] = data[offset + i] * 32768;
        }

        rnnoiseModule._rnnoise_process_frame(denoiseState, outputPtr, inputPtr);

        // Copy back (scale from 32768 back to -1..1)
        const outputArray = new Float32Array(rnnoiseModule.HEAPF32.buffer, outputPtr, FRAME_SIZE);
        for (let i = 0; i < FRAME_SIZE; i++) {
          data[offset + i] = outputArray[i] / 32768;
        }
      }

      rnnoiseModule._free(inputPtr);
      rnnoiseModule._free(outputPtr);
    }

    rnnoiseModule._rnnoise_destroy(denoiseState);

    // If original was different sample rate, resample back
    if (buffer.sampleRate !== TARGET_RATE) {
      const finalCtx = new OfflineAudioContext(outChannels, buffer.length, buffer.sampleRate);
      const src2 = finalCtx.createBufferSource();
      src2.buffer = resampled;
      src2.connect(finalCtx.destination);
      src2.start(0);
      return await finalCtx.startRendering();
    }

    return resampled;
  } catch (e) {
    console.warn('[AudioProcessing] RNNoise processing failed, returning original buffer:', e);
    return buffer;
  }
}

/**
 * Compute peak level in dBFS from an AnalyserNode's time-domain data.
 * Returns a value from -Infinity to 0.
 */
export function getPeakLevel(analyser: AnalyserNode): number {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Compute RMS level in dBFS from an AnalyserNode's time-domain data.
 */
export function getRMSLevel(analyser: AnalyserNode): number {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / data.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
