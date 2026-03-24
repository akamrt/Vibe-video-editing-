/**
 * Offline Frame-by-Frame Renderer
 *
 * Instead of real-time playback capture, this renderer seeks each video element
 * to the exact frame time and waits for the frame to be decoded before drawing.
 * This eliminates stutter and frame drops caused by real-time recording.
 *
 * Flow per frame:
 *   1. Compute target time: frameIndex / fps
 *   2. Seek all active video elements to that exact time
 *   3. Wait for readyState >= 2 (HAVE_CURRENT_DATA) or 500ms timeout
 *   4. Draw all layers: video (with transforms/transitions), subtitles, titles
 *   5. Call requestFrame() to push canvas frame into MediaRecorder
 *   6. Yield to browser with setTimeout(0) to prevent UI freeze
 *   7. Advance to next frame
 */

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

// ─── Re-exported from types to avoid circular imports ────────────────────────

type SubtitleTemplate = any;
type TextAnimation = any;

// ─── Public Interfaces ───────────────────────────────────────────────────────

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
}

export interface RenderCallbacks {
  onProgress: (frame: number, totalFrames: number) => void;
  onComplete: (blob: Blob) => void;
  onError: (err: Error) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Seek a video to targetTime, resolving once seeked or after 500 ms timeout. */
function seekVideo(vid: HTMLVideoElement, targetTime: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Skip seek when already within 1 ms of target
    if (Math.abs(vid.currentTime - targetTime) < 0.001) {
      resolve();
      return;
    }

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

    const timer = setTimeout(() => {
      // Timeout fallback: resolve even if 'seeked' never fired
      settle();
    }, 500);

    vid.currentTime = targetTime;
  });
}

/** Wait until video readyState >= 2 (HAVE_CURRENT_DATA), with a 300 ms cap. */
function waitForReadyState(vid: HTMLVideoElement): Promise<void> {
  if (vid.readyState >= 2) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(cap);
      resolve();
    };

    const poll = setInterval(() => {
      if (vid.readyState >= 2) settle();
    }, 10);

    const cap = setTimeout(settle, 300);
  });
}

/** Yield to the browser event loop (prevents UI freeze on long renders). */
const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ─── OfflineRenderer Class ───────────────────────────────────────────────────

export class OfflineRenderer {
  private settings: ExportSettings;
  private deps: RendererDeps;
  private callbacks: RenderCallbacks;
  private aborted = false;

  constructor(
    settings: ExportSettings,
    deps: RendererDeps,
    callbacks: RenderCallbacks,
  ) {
    this.settings = settings;
    this.deps = deps;
    this.callbacks = callbacks;
  }

  /** Signal the renderer to stop after the current frame. */
  abort(): void {
    this.aborted = true;
  }

  async render(): Promise<void> {
    const { settings, deps, callbacks } = this;

    // ── Compute output dimensions ──────────────────────────────────────────
    const preset = ASPECT_RATIO_PRESETS[settings.aspectRatio];
    const baseRes =
      settings.resolution === '4K'
        ? 2160
        : settings.resolution === '1080p'
        ? 1080
        : 720;

    let outputWidth: number;
    let outputHeight: number;
    if (preset && preset.ratio > 1) {
      outputHeight = baseRes;
      outputWidth = Math.round(baseRes * preset.ratio);
    } else if (preset) {
      outputWidth = Math.round(baseRes * preset.ratio);
      outputHeight = baseRes;
    } else {
      // Fallback for custom aspect ratio
      outputWidth = baseRes;
      outputHeight = baseRes;
    }

    // ── Content duration ───────────────────────────────────────────────────
    const contentDuration =
      deps.segments.length > 0
        ? Math.max(
            ...deps.segments.map(
              (s) => s.timelineStart + (s.endTime - s.startTime),
            ),
          )
        : 0;

    if (contentDuration <= 0) {
      callbacks.onError(new Error('No content to render (duration is 0)'));
      return;
    }

    const fps = settings.fps;
    const totalFrames = Math.ceil(contentDuration * fps);

    // ── Canvas setup ───────────────────────────────────────────────────────
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d')!;

    // Temp canvas for transition rendering (reused, allocated once)
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = outputWidth;
    tmpCanvas.height = outputHeight;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    // Previous segment canvas for crossfade transitions
    let prevSegmentCanvas: HTMLCanvasElement | null = null;

    // Last-good-frame fallback (avoids black flashes at cut boundaries)
    const lastGoodFrame = document.createElement('canvas');
    lastGoodFrame.width = outputWidth;
    lastGoodFrame.height = outputHeight;
    const lastGoodCtx = lastGoodFrame.getContext('2d')!;

    // ── Audio setup ────────────────────────────────────────────────────────
    const actx = deps.audioContext;
    if (actx.state === 'suspended') {
      try { await actx.resume(); } catch (_) { /* best-effort */ }
    }

    const dest = actx.createMediaStreamDestination();

    deps.videoRefs.forEach((vid, segId) => {
      let source = deps.audioSourcesRef.get(vid);
      if (!source) {
        try {
          source = actx.createMediaElementSource(vid);
          deps.audioSourcesRef.set(vid, source);
          source.connect(actx.destination); // Keep speakers connected
        } catch (e) {
          console.warn('[OfflineRenderer] Audio source creation failed for', segId, e);
        }
      }
      if (source) {
        try { source.connect(dest); } catch (_) { /* already connected */ }
      }
    });

    // ── Capture stream & MediaRecorder setup ───────────────────────────────
    // captureStream(0) = manual frame push only; we call requestFrame() ourselves
    const canvasStream = canvas.captureStream(0);
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: settings.bitrateMbps * 1_000_000,
    });

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const recordingFinished = new Promise<Blob>((resolve, reject) => {
      mediaRecorder.onstop = () => {
        try {
          const blob = new Blob(chunks, { type: 'video/webm' });
          resolve(blob);
        } catch (err) {
          reject(err);
        }
      };
      mediaRecorder.onerror = (e) => reject((e as any).error ?? e);
    });

    mediaRecorder.start();

    // ── Frame loop ─────────────────────────────────────────────────────────
    try {
      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
        if (this.aborted) {
          console.log('[OfflineRenderer] Aborted at frame', frameIndex);
          break;
        }

        const currentTime = frameIndex / fps;

        // Find active segments at this time, ordered by track (bottom to top)
        const activeSegments = deps.segments
          .filter(
            (s) =>
              currentTime >= s.timelineStart &&
              currentTime < s.timelineStart + (s.endTime - s.startTime),
          )
          .sort((a, b) => (a.track || 0) - (b.track || 0));

        // Seek all active video elements to the exact frame time
        const seekPromises = activeSegments.map((seg) => {
          const vid = deps.videoRefs.get(seg.id);
          if (!vid) return Promise.resolve();
          const mediaTime = seg.startTime + (currentTime - seg.timelineStart);
          return seekVideo(vid, mediaTime);
        });
        await Promise.all(seekPromises);

        // Wait for each video to have decoded data
        const readyPromises = activeSegments.map((seg) => {
          const vid = deps.videoRefs.get(seg.id);
          return vid ? waitForReadyState(vid) : Promise.resolve();
        });
        await Promise.all(readyPromises);

        // ── Draw frame ──────────────────────────────────────────────────
        const anyVideoReady = activeSegments.some((s) => {
          const v = deps.videoRefs.get(s.id);
          return v && v.readyState >= 2;
        });

        if (anyVideoReady || activeSegments.length === 0) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, outputWidth, outputHeight);
        } else {
          // Hold last good frame to avoid black flash at cut boundaries
          ctx.drawImage(lastGoodFrame, 0, 0);
        }

        activeSegments.forEach((activeSeg) => {
          const vid = deps.videoRefs.get(activeSeg.id);
          const clipTime = currentTime - activeSeg.timelineStart;
          const segDuration = activeSeg.endTime - activeSeg.startTime;

          // ── Video drawing ────────────────────────────────────────────
          if (vid && vid.readyState >= 2) {
            const transform = deps.getCombinedTransform(
              activeSeg.keyframes,
              clipTime,
              currentTime,
            );

            const coverScale = Math.max(
              outputWidth / vid.videoWidth,
              outputHeight / vid.videoHeight,
            );
            const drawWidth = vid.videoWidth * coverScale;
            const drawHeight = vid.videoHeight * coverScale;

            // Determine active transition
            let transitionActive = false;
            let transitionProgress = 0;
            let activeTransition: Transition | undefined;
            let isTransitionIn = false;

            if (activeSeg.transitionIn && clipTime < activeSeg.transitionIn.duration) {
              transitionActive = true;
              transitionProgress = Math.max(
                0,
                Math.min(1, clipTime / activeSeg.transitionIn.duration),
              );
              activeTransition = activeSeg.transitionIn;
              isTransitionIn = true;
            }
            if (
              activeSeg.transitionOut &&
              clipTime > segDuration - activeSeg.transitionOut.duration
            ) {
              transitionActive = true;
              const remaining = segDuration - clipTime;
              transitionProgress =
                1 -
                Math.max(
                  0,
                  Math.min(1, remaining / activeSeg.transitionOut.duration),
                );
              activeTransition = activeSeg.transitionOut;
              isTransitionIn = false;
            }

            if (transitionActive && activeTransition && activeTransition.type !== 'NONE') {
              // Draw video frame to tmpCanvas with transforms applied
              tmpCtx.clearRect(0, 0, outputWidth, outputHeight);
              tmpCtx.save();
              tmpCtx.translate(outputWidth / 2, outputHeight / 2);
              tmpCtx.translate(
                transform.translateX * drawWidth / 100,
                transform.translateY * drawHeight / 100,
              );
              tmpCtx.scale(transform.scale, transform.scale);
              tmpCtx.rotate((transform.rotation * Math.PI) / 180);
              tmpCtx.drawImage(vid, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
              tmpCtx.restore();

              if (isTransitionIn) {
                const outFrame =
                  activeTransition.type === 'CROSSFADE' && prevSegmentCanvas
                    ? prevSegmentCanvas
                    : null;
                renderTransitionCanvas({
                  ctx,
                  width: outputWidth,
                  height: outputHeight,
                  outFrame,
                  inFrame: tmpCanvas,
                  progress: transitionProgress,
                  transition: activeTransition,
                });
              } else {
                renderTransitionCanvas({
                  ctx,
                  width: outputWidth,
                  height: outputHeight,
                  outFrame: tmpCanvas,
                  inFrame: null,
                  progress: transitionProgress,
                  transition: activeTransition,
                });
                // Capture frame for potential crossfade with next segment
                if (!prevSegmentCanvas) {
                  prevSegmentCanvas = document.createElement('canvas');
                  prevSegmentCanvas.width = outputWidth;
                  prevSegmentCanvas.height = outputHeight;
                }
                const pCtx = prevSegmentCanvas.getContext('2d')!;
                pCtx.clearRect(0, 0, outputWidth, outputHeight);
                pCtx.drawImage(tmpCanvas, 0, 0);
              }
            } else {
              // Normal draw — no transition
              ctx.save();
              ctx.translate(outputWidth / 2, outputHeight / 2);
              ctx.translate(
                transform.translateX * drawWidth / 100,
                transform.translateY * drawHeight / 100,
              );
              ctx.scale(transform.scale, transform.scale);
              ctx.rotate((transform.rotation * Math.PI) / 180);
              ctx.drawImage(vid, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
              ctx.restore();

              // Capture frame for potential crossfade with next segment
              if (!prevSegmentCanvas) {
                prevSegmentCanvas = document.createElement('canvas');
                prevSegmentCanvas.width = outputWidth;
                prevSegmentCanvas.height = outputHeight;
              }
              const pCtx = prevSegmentCanvas.getContext('2d')!;
              pCtx.clearRect(0, 0, outputWidth, outputHeight);
              pCtx.drawImage(ctx.canvas, 0, 0);
            }
          }

          // ── Subtitle drawing ─────────────────────────────────────────
          // Drawn regardless of video readyState (subtitles should not stall on buffering)
          const media = deps.library.find((m) => m.id === activeSeg.mediaId);
          if (media && media.analysis) {
            const mediaTime = activeSeg.startTime + clipTime;
            const subtitle = media.analysis.events?.find(
              (e: any) =>
                e.type === 'dialogue' &&
                mediaTime >= e.startTime &&
                mediaTime <= e.endTime,
            );

            if (subtitle) {
              const subTemplate =
                subtitle.templateOverride || deps.activeSubtitleTemplate;
              const sourceStyle = subtitle.styleOverride || deps.subtitleStyle;

              let kfTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
              if (subtitle.keyframes && subtitle.keyframes.length > 0) {
                const sourceTime = activeSeg.startTime + clipTime;
                const subTime = sourceTime - subtitle.startTime;
                kfTransform = getInterpolatedTransform(subtitle.keyframes, subTime);
              }

              const evtTx = subtitle.translateX || 0;
              const evtTy = subtitle.translateY || 0;

              const sourceTime = activeSeg.startTime + clipTime;
              const localFrame = Math.round(
                (sourceTime - subtitle.startTime) * fps,
              );
              const subAnim = subTemplate?.animation || null;
              const kwAnim =
                subtitle.keywordAnimation ||
                subTemplate?.keywordAnimation ||
                deps.activeKeywordAnimation ||
                null;

              drawSubtitleOnCanvas({
                ctx,
                text: subtitle.details,
                style: sourceStyle,
                templateStyle: subTemplate?.style || null,
                animation: subAnim,
                frame: localFrame,
                fps,
                outputWidth,
                outputHeight,
                viewportSafeZoneHeight: deps.safeZoneHeight,
                totalTx: evtTx + kfTransform.translateX,
                totalTy: evtTy + kfTransform.translateY,
                totalScale: kfTransform.scale,
                totalRotation: kfTransform.rotation,
                wordEmphases: subtitle.wordEmphases,
                keywordAnimation: kwAnim,
                wordTimings: subtitle.wordTimings,
                sourceTime,
                eventStartTime: subtitle.startTime,
                eventEndTime: subtitle.endTime,
              });
            }
          }
        });

        // ── Title drawing (global layer, outside segment loop) ──────────
        const titleLayer = deps.titleLayer;
        if (
          titleLayer &&
          currentTime >= titleLayer.startTime &&
          currentTime < titleLayer.endTime
        ) {
          const titleStyle = titleLayer.style || deps.titleStyle;
          const titleTemplate = deps.activeTitleTemplate;
          const titleAnim = titleLayer.animation || titleTemplate?.animation || null;

          const titleClipTime = currentTime - titleLayer.startTime;
          const titleDuration = titleLayer.endTime - titleLayer.startTime;
          const titleLocalFrame = Math.round(titleClipTime * fps);

          // Fade-in / fade-out opacity
          let titleOpacity = 1;
          if (titleLayer.fadeInDuration > 0 && titleClipTime < titleLayer.fadeInDuration) {
            titleOpacity = titleClipTime / titleLayer.fadeInDuration;
          }
          if (
            titleLayer.fadeOutDuration > 0 &&
            titleClipTime > titleDuration - titleLayer.fadeOutDuration
          ) {
            titleOpacity =
              (titleDuration - titleClipTime) / titleLayer.fadeOutDuration;
          }

          let titleKfTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
          if (titleLayer.keyframes && titleLayer.keyframes.length > 0) {
            titleKfTransform = getInterpolatedTransform(
              titleLayer.keyframes,
              titleClipTime,
            );
          }

          drawSubtitleOnCanvas({
            ctx,
            text: titleLayer.text,
            style: titleStyle as any,
            templateStyle: titleTemplate?.style || null,
            animation: titleAnim,
            frame: titleLocalFrame,
            fps,
            outputWidth,
            outputHeight,
            viewportSafeZoneHeight: deps.safeZoneHeight,
            totalTx: titleKfTransform.translateX,
            totalTy: titleKfTransform.translateY,
            totalScale: titleKfTransform.scale,
            totalRotation: titleKfTransform.rotation,
            topOffset: (titleStyle as any).topOffset ?? 15,
            globalOpacity: titleOpacity,
          });
        }

        // ── Save last good frame for cut-boundary fallback ──────────────
        if (anyVideoReady) {
          lastGoodCtx.clearRect(0, 0, outputWidth, outputHeight);
          lastGoodCtx.drawImage(canvas, 0, 0);
        }

        // ── Push frame into MediaRecorder ───────────────────────────────
        (canvasStream.getVideoTracks()[0] as any).requestFrame();

        // ── Report progress ─────────────────────────────────────────────
        callbacks.onProgress(frameIndex + 1, totalFrames);

        // ── Yield to browser ────────────────────────────────────────────
        await yieldToBrowser();
      }
    } catch (err: any) {
      console.error('[OfflineRenderer] Frame loop error:', err);
      try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // ── Stop recorder and await blob ───────────────────────────────────────
    try {
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
      const blob = await recordingFinished;
      callbacks.onComplete(blob);
    } catch (err: any) {
      console.error('[OfflineRenderer] MediaRecorder stop error:', err);
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
