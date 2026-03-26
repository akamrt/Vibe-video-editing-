/**
 * Offline Frame-by-Frame Renderer — WebCodecs edition
 *
 * Uses VideoEncoder (explicit timestamps) + OfflineAudioContext (offline audio decode)
 * + webm-muxer to produce correctly-timed, full-quality WebM output.
 *
 * Why this is correct:
 *  - MediaRecorder timestamps frames by wall-clock time → slow-motion if seeks are slow
 *  - VideoEncoder.encode(frame, {timestamp}) stamps frames explicitly → always correct speed
 *  - OfflineAudioContext decodes audio from source files without real-time playback → correct audio
 */

import { Muxer, ArrayBufferTarget } from 'webm-muxer';
import { getInterpolatedTransform, ASPECT_RATIO_PRESETS } from '../utils/interpolation';
import { renderTransition as renderTransitionCanvas } from '../utils/transitionRenderer';
import { drawSubtitleOnCanvas } from '../utils/canvasSubtitleRenderer';
import type {
  ExportSettings,
  Segment,
  ClipKeyframe,
  TitleLayer,
  SubtitleStyle,
  Transition,
} from '../types';

type SubtitleTemplate = any;
type TextAnimation = any;

export interface RendererDeps {
  segments: Segment[];
  globalKeyframes: ClipKeyframe[];
  titleLayer: TitleLayer | null;
  subtitleStyle: SubtitleStyle;
  titleStyle: any;
  activeSubtitleTemplate: SubtitleTemplate | null;
  activeTitleTemplate: SubtitleTemplate | null;
  activeKeywordAnimation: TextAnimation | null;
  removedWords: { mediaId: string; eventIndex: number; wordIndex: number }[];
  library: { id: string; url: string; analysis?: any }[];
  videoRefs: Map<string, HTMLVideoElement>;
  audioContext: AudioContext;
  audioSourcesRef: WeakMap<HTMLVideoElement, MediaElementAudioSourceNode>;
  safeZoneHeight: number;
  getCombinedTransform: (
    kfs: ClipKeyframe[] | undefined,
    clipTime: number,
    timelineTime: number,
  ) => any;
  setIsExporting: (v: boolean) => void;
}

export interface RenderCallbacks {
  onProgress: (frame: number, totalFrames: number) => void;
  onComplete: (blob: Blob) => void;
  onError: (err: Error) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seekVideo(vid: HTMLVideoElement, targetTime: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (Math.abs(vid.currentTime - targetTime) < 0.001) { resolve(); return; }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      vid.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve();
    };
    const onSeeked = () => settle();
    vid.addEventListener('seeked', onSeeked, { once: true });
    const timer = setTimeout(settle, 500);
    vid.currentTime = targetTime;
  });
}

function waitForReadyState(vid: HTMLVideoElement): Promise<void> {
  if (vid.readyState >= 2) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => { if (settled) return; settled = true; clearInterval(poll); clearTimeout(cap); resolve(); };
    const poll = setInterval(() => { if (vid.readyState >= 2) settle(); }, 10);
    const cap = setTimeout(settle, 300);
  });
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ─── OfflineRenderer Class ────────────────────────────────────────────────────

export class OfflineRenderer {
  private settings: ExportSettings;
  private deps: RendererDeps;
  private callbacks: RenderCallbacks;
  private aborted = false;

  constructor(settings: ExportSettings, deps: RendererDeps, callbacks: RenderCallbacks) {
    this.settings = settings;
    this.deps = deps;
    this.callbacks = callbacks;
  }

  abort(): void { this.aborted = true; }

  async render(): Promise<void> {
    const { settings, deps, callbacks } = this;

    // ── Mount ALL video elements (React only mounts active ones) ──────────
    deps.setIsExporting(true);
    await sleep(500);

    // Wait up to 10s for all non-blank segments to have video elements loaded
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const allReady = deps.segments.every(seg => {
        if (seg.type === 'blank') return true;
        const vid = deps.videoRefs.get(seg.id);
        return vid && vid.readyState >= 1;
      });
      if (allReady) break;
      await sleep(100);
    }

    // Pause all videos — we control time manually
    deps.videoRefs.forEach(vid => vid.pause());

    // ── Dimensions ────────────────────────────────────────────────────────
    const preset = ASPECT_RATIO_PRESETS[settings.aspectRatio];
    const baseRes = settings.resolution === '4K' ? 2160 : settings.resolution === '1080p' ? 1080 : 720;
    let outputWidth: number, outputHeight: number;
    if (preset && preset.ratio > 1) {
      outputHeight = baseRes; outputWidth = Math.round(baseRes * preset.ratio);
    } else if (preset) {
      outputWidth = Math.round(baseRes * preset.ratio); outputHeight = baseRes;
    } else {
      outputWidth = baseRes; outputHeight = baseRes;
    }

    // ── Duration ──────────────────────────────────────────────────────────
    const contentDuration = deps.segments.length > 0
      ? Math.max(...deps.segments.map(s => s.timelineStart + (s.endTime - s.startTime)))
      : 0;
    if (contentDuration <= 0) {
      deps.setIsExporting(false);
      callbacks.onError(new Error('No content to render (duration is 0)'));
      return;
    }

    const fps = settings.fps;
    const totalFrames = Math.ceil(contentDuration * fps);
    const frameDurationUs = Math.round(1_000_000 / fps); // microseconds per frame

    // ── Canvas ────────────────────────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth; canvas.height = outputHeight;
    const ctx = canvas.getContext('2d')!;
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = outputWidth; tmpCanvas.height = outputHeight;
    const tmpCtx = tmpCanvas.getContext('2d')!;
    let prevSegmentCanvas: HTMLCanvasElement | null = null;
    const lastGoodFrame = document.createElement('canvas');
    lastGoodFrame.width = outputWidth; lastGoodFrame.height = outputHeight;
    const lastGoodCtx = lastGoodFrame.getContext('2d')!;

    // ── Offline audio decode ──────────────────────────────────────────────
    // Decode all segment audio tracks offline — no real-time capture needed.
    const AUDIO_SAMPLE_RATE = 48000;
    const AUDIO_CHANNELS = 2;
    let renderedAudioBuffer: AudioBuffer | null = null;
    try {
      const offlineCtx = new OfflineAudioContext(
        AUDIO_CHANNELS,
        Math.ceil(contentDuration * AUDIO_SAMPLE_RATE) + AUDIO_SAMPLE_RATE, // +1s padding
        AUDIO_SAMPLE_RATE,
      );

      // Decode each unique media URL once, then reuse the AudioBuffer for all
      // segments from that media (multiple AudioBufferSourceNodes can share one buffer).
      // This is critical after silence removal, which can create 60-100 segments from
      // the same source file — without dedup, the browser would OOM loading the full
      // video file once per segment concurrently.
      const urlDecodeCache = new Map<string, Promise<AudioBuffer | null>>();
      const decodePromises = deps.segments
        .filter(seg => seg.type !== 'blank')
        .map(async seg => {
          const item = deps.library.find(m => m.id === seg.mediaId);
          if (!item?.url) return;

          // Decode the source file once per unique URL
          if (!urlDecodeCache.has(item.url)) {
            urlDecodeCache.set(item.url, (async () => {
              try {
                const response = await fetch(item.url);
                const arrayBuffer = await response.arrayBuffer();
                return await offlineCtx.decodeAudioData(arrayBuffer);
              } catch (e) {
                console.warn('[OfflineRenderer] Audio decode failed for', item.url, e);
                return null;
              }
            })());
          }

          const audioBuffer = await urlDecodeCache.get(item.url)!;
          if (!audioBuffer) return;

          const source = offlineCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineCtx.destination);

          // Schedule: start at timelineStart, offset into source at seg.startTime
          const segDuration = seg.endTime - seg.startTime;
          source.start(
            Math.max(0, seg.timelineStart),
            Math.max(0, seg.startTime),
            segDuration,
          );
        });

      await Promise.all(decodePromises);
      renderedAudioBuffer = await offlineCtx.startRendering();
      console.log('[OfflineRenderer] Audio rendered:', renderedAudioBuffer.duration.toFixed(2), 's');
    } catch (e) {
      console.warn('[OfflineRenderer] Audio rendering failed, video will be silent:', e);
    }

    // ── WebCodecs setup ───────────────────────────────────────────────────
    if (typeof VideoEncoder === 'undefined') {
      deps.setIsExporting(false);
      callbacks.onError(new Error('VideoEncoder (WebCodecs) not available in this browser. Please use Chrome 94+.'));
      return;
    }

    const muxerTarget = new ArrayBufferTarget();
    const muxer = new Muxer({
      target: muxerTarget,
      video: { codec: 'V_VP9', width: outputWidth, height: outputHeight, frameRate: fps },
      ...(renderedAudioBuffer ? { audio: { codec: 'A_OPUS', sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS } } : {}),
      firstTimestampBehavior: 'offset',
    });

    let videoEncoderError: Error | null = null;
    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta as any),
      error: (e) => { videoEncoderError = e; },
    });
    videoEncoder.configure({
      codec: 'vp09.00.41.08',
      width: outputWidth,
      height: outputHeight,
      bitrate: settings.bitrateMbps * 1_000_000,
      framerate: fps,
    });

    let audioEncoder: AudioEncoder | null = null;
    if (renderedAudioBuffer && typeof AudioEncoder !== 'undefined') {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta as any),
        error: (e) => console.warn('[OfflineRenderer] AudioEncoder error:', e),
      });
      audioEncoder.configure({
        codec: 'opus',
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_SAMPLE_RATE,
        bitrate: 128_000,
      });
    }

    // ── Frame loop ────────────────────────────────────────────────────────
    try {
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        if (this.aborted) break;
        if (videoEncoderError) throw videoEncoderError;

        const currentTime = frameIndex / fps;
        const timestampUs = frameIndex * frameDurationUs; // explicit — correct speed!

        const activeSegments = deps.segments
          .filter(s => currentTime >= s.timelineStart && currentTime < s.timelineStart + (s.endTime - s.startTime))
          .sort((a, b) => (a.track || 0) - (b.track || 0));

        // Seek active videos to exact frame time
        await Promise.all(activeSegments.map(seg => {
          const vid = deps.videoRefs.get(seg.id);
          if (!vid) return Promise.resolve();
          return seekVideo(vid, seg.startTime + (currentTime - seg.timelineStart));
        }));
        await Promise.all(activeSegments.map(seg => {
          const vid = deps.videoRefs.get(seg.id);
          return vid ? waitForReadyState(vid) : Promise.resolve();
        }));

        // Draw frame
        const anyVideoReady = activeSegments.some(s => { const v = deps.videoRefs.get(s.id); return v && v.readyState >= 2; });
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, outputWidth, outputHeight);
        if (!anyVideoReady && lastGoodFrame) ctx.drawImage(lastGoodFrame, 0, 0);

        for (const activeSeg of activeSegments) {
          const vid = deps.videoRefs.get(activeSeg.id);
          const clipTime = currentTime - activeSeg.timelineStart;
          const segDuration = activeSeg.endTime - activeSeg.startTime;

          if (vid && vid.readyState >= 2) {
            const transform = deps.getCombinedTransform(activeSeg.keyframes, clipTime, currentTime);
            const coverScale = Math.max(outputWidth / vid.videoWidth, outputHeight / vid.videoHeight);
            const dw = vid.videoWidth * coverScale;
            const dh = vid.videoHeight * coverScale;

            let transitionActive = false, transitionProgress = 0;
            let activeTransition: Transition | undefined, isTransitionIn = false;
            if (activeSeg.transitionIn && clipTime < activeSeg.transitionIn.duration) {
              transitionActive = true;
              transitionProgress = Math.max(0, Math.min(1, clipTime / activeSeg.transitionIn.duration));
              activeTransition = activeSeg.transitionIn; isTransitionIn = true;
            }
            if (activeSeg.transitionOut && clipTime > segDuration - activeSeg.transitionOut.duration) {
              transitionActive = true;
              const remaining = segDuration - clipTime;
              transitionProgress = 1 - Math.max(0, Math.min(1, remaining / activeSeg.transitionOut.duration));
              activeTransition = activeSeg.transitionOut; isTransitionIn = false;
            }

            if (transitionActive && activeTransition && activeTransition.type !== 'NONE') {
              tmpCtx.clearRect(0, 0, outputWidth, outputHeight);
              tmpCtx.save();
              tmpCtx.translate(outputWidth / 2, outputHeight / 2);
              tmpCtx.translate(transform.translateX * dw / 100, transform.translateY * dh / 100);
              tmpCtx.scale(transform.scale, transform.scale);
              tmpCtx.rotate(transform.rotation * Math.PI / 180);
              tmpCtx.drawImage(vid, -dw / 2, -dh / 2, dw, dh);
              tmpCtx.restore();

              if (isTransitionIn) {
                renderTransitionCanvas({ ctx, width: outputWidth, height: outputHeight, outFrame: (activeTransition.type === 'CROSSFADE' && prevSegmentCanvas) ? prevSegmentCanvas : null, inFrame: tmpCanvas, progress: transitionProgress, transition: activeTransition });
              } else {
                renderTransitionCanvas({ ctx, width: outputWidth, height: outputHeight, outFrame: tmpCanvas, inFrame: null, progress: transitionProgress, transition: activeTransition });
                if (!prevSegmentCanvas) { prevSegmentCanvas = document.createElement('canvas'); prevSegmentCanvas.width = outputWidth; prevSegmentCanvas.height = outputHeight; }
                prevSegmentCanvas.getContext('2d')!.drawImage(tmpCanvas, 0, 0);
              }
            } else {
              ctx.save();
              ctx.translate(outputWidth / 2, outputHeight / 2);
              ctx.translate(transform.translateX * dw / 100, transform.translateY * dh / 100);
              ctx.scale(transform.scale, transform.scale);
              ctx.rotate(transform.rotation * Math.PI / 180);
              ctx.drawImage(vid, -dw / 2, -dh / 2, dw, dh);
              ctx.restore();
              if (!prevSegmentCanvas) { prevSegmentCanvas = document.createElement('canvas'); prevSegmentCanvas.width = outputWidth; prevSegmentCanvas.height = outputHeight; }
              prevSegmentCanvas.getContext('2d')!.drawImage(ctx.canvas, 0, 0);
            }
          }

          // Subtitles
          const media = deps.library.find(m => m.id === activeSeg.mediaId);
          if (media?.analysis) {
            const mediaTime = activeSeg.startTime + clipTime;
            const subtitle = media.analysis.events?.find((e: any) => e.type === 'dialogue' && mediaTime >= e.startTime && mediaTime <= e.endTime);
            if (subtitle) {
              const subTemplate = subtitle.templateOverride || deps.activeSubtitleTemplate;
              const sourceStyle = subtitle.styleOverride || deps.subtitleStyle;
              let kfTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
              if (subtitle.keyframes?.length) kfTransform = getInterpolatedTransform(subtitle.keyframes, (activeSeg.startTime + clipTime) - subtitle.startTime);
              const sourceTime = activeSeg.startTime + clipTime;
              drawSubtitleOnCanvas({
                ctx, text: subtitle.details, style: sourceStyle, templateStyle: subTemplate?.style || null,
                animation: subTemplate?.animation || null, frame: Math.round((sourceTime - subtitle.startTime) * fps), fps,
                outputWidth, outputHeight, viewportSafeZoneHeight: deps.safeZoneHeight,
                totalTx: (subtitle.translateX || 0) + kfTransform.translateX, totalTy: (subtitle.translateY || 0) + kfTransform.translateY,
                totalScale: kfTransform.scale, totalRotation: kfTransform.rotation,
                wordEmphases: subtitle.wordEmphases, keywordAnimation: subtitle.keywordAnimation || subTemplate?.keywordAnimation || deps.activeKeywordAnimation || null,
                wordTimings: subtitle.wordTimings, sourceTime, eventStartTime: subtitle.startTime, eventEndTime: subtitle.endTime,
              });
            }
          }
        }

        // Title layer
        const tl = deps.titleLayer;
        if (tl && currentTime >= tl.startTime && currentTime < tl.endTime) {
          const titleStyle = tl.style || deps.titleStyle;
          const titleClipTime = currentTime - tl.startTime;
          const titleDuration = tl.endTime - tl.startTime;
          let titleOpacity = 1;
          if (tl.fadeInDuration > 0 && titleClipTime < tl.fadeInDuration) titleOpacity = titleClipTime / tl.fadeInDuration;
          if (tl.fadeOutDuration > 0 && titleClipTime > titleDuration - tl.fadeOutDuration) titleOpacity = (titleDuration - titleClipTime) / tl.fadeOutDuration;
          let kf = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
          if (tl.keyframes?.length) kf = getInterpolatedTransform(tl.keyframes, titleClipTime);
          drawSubtitleOnCanvas({
            ctx, text: tl.text, style: titleStyle as any, templateStyle: deps.activeTitleTemplate?.style || null,
            animation: tl.animation || deps.activeTitleTemplate?.animation || null,
            frame: Math.round(titleClipTime * fps), fps, outputWidth, outputHeight,
            viewportSafeZoneHeight: deps.safeZoneHeight, totalTx: kf.translateX, totalTy: kf.translateY,
            totalScale: kf.scale, totalRotation: kf.rotation, topOffset: (titleStyle as any).topOffset ?? 15, globalOpacity: titleOpacity,
          });
        }

        if (anyVideoReady) { lastGoodCtx.clearRect(0, 0, outputWidth, outputHeight); lastGoodCtx.drawImage(canvas, 0, 0); }

        // ── Encode frame with explicit timestamp (THE key fix) ────────────
        const videoFrame = new VideoFrame(canvas, {
          timestamp: timestampUs,
          duration: frameDurationUs,
        });
        videoEncoder.encode(videoFrame, { keyFrame: frameIndex % (fps * 2) === 0 });
        videoFrame.close();

        callbacks.onProgress(frameIndex + 1, totalFrames);

        // Yield to keep UI responsive (doesn't affect output timing with explicit timestamps)
        await sleep(0);
      }
    } catch (err: any) {
      console.error('[OfflineRenderer] Frame loop error:', err);
      deps.setIsExporting(false);
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    deps.setIsExporting(false);

    // ── Flush video encoder ───────────────────────────────────────────────
    try {
      await videoEncoder.flush();
    } catch (e) {
      callbacks.onError(new Error('Video encoder flush failed: ' + e));
      return;
    }

    // ── Encode audio ──────────────────────────────────────────────────────
    if (audioEncoder && renderedAudioBuffer) {
      try {
        const CHUNK_FRAMES = 960; // 20ms at 48kHz — standard Opus frame
        const totalSamples = renderedAudioBuffer.length;
        const leftData = renderedAudioBuffer.getChannelData(0);
        const rightData = renderedAudioBuffer.numberOfChannels > 1 ? renderedAudioBuffer.getChannelData(1) : leftData;

        for (let offset = 0; offset < totalSamples; offset += CHUNK_FRAMES) {
          const chunkSize = Math.min(CHUNK_FRAMES, totalSamples - offset);
          const audioData = new AudioData({
            format: 'f32-planar',
            sampleRate: AUDIO_SAMPLE_RATE,
            numberOfFrames: chunkSize,
            numberOfChannels: AUDIO_CHANNELS,
            timestamp: Math.round(offset * 1_000_000 / AUDIO_SAMPLE_RATE),
            data: (() => {
              const buf = new Float32Array(chunkSize * AUDIO_CHANNELS);
              buf.set(leftData.subarray(offset, offset + chunkSize), 0);
              buf.set(rightData.subarray(offset, offset + chunkSize), chunkSize);
              return buf;
            })(),
          });
          audioEncoder.encode(audioData);
          audioData.close();
        }
        await audioEncoder.flush();
      } catch (e) {
        console.warn('[OfflineRenderer] Audio encode error (video will be silent):', e);
      }
    }

    // ── Finalize and return blob ──────────────────────────────────────────
    try {
      muxer.finalize();
      const blob = new Blob([muxerTarget.buffer], { type: 'video/webm' });
      callbacks.onComplete(blob);
    } catch (err: any) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
