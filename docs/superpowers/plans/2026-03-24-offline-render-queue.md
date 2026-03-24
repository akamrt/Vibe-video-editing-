# Offline Render Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the real-time export with an offline frame-by-frame renderer that produces perfectly smooth video output, with a render queue UI panel supporting multiple exports, progress/ETA, and abort.

**Architecture:** The offline renderer seeks each video element to the exact frame time, waits for readiness, draws all layers (video, subtitles, titles, transitions, animations) to canvas, then advances. Audio is captured separately by decoding each segment's audio track offline via AudioContext.decodeAudioData + OfflineAudioContext, mixing into the final WebM. A RenderQueue manager class holds the job queue and exposes state via React context. A new "RENDER" tab sits alongside the existing right-panel tabs (TRANSCRIPT, TEMPLATES, TRANS., TRACKING).

**Tech Stack:** React 19, TypeScript, Canvas API, MediaRecorder, OfflineAudioContext, Web Audio API, existing canvasSubtitleRenderer.ts and transitionRenderer.ts utilities.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `services/offlineRenderer.ts` | Frame-by-frame render engine — seeks videos, draws canvas, handles audio mixing, emits progress |
| Create | `services/renderQueue.ts` | Queue manager — holds jobs, runs sequentially, exposes state, abort support |
| Create | `components/RenderQueuePanel.tsx` | UI panel — job list, progress bars, ETA, abort buttons, add-to-queue |
| Modify | `App.tsx` | Add RENDER tab to right panel, wire queue state, replace export modal's export action |
| Modify | `components/ExportModal.tsx` | Change "Export" button to "Add to Queue", close modal on queue add |
| Modify | `types.ts` | Add RenderJob, RenderProgress, RenderQueueState types |

---

### Task 1: Add Render Types

**Files:**
- Modify: `types.ts` (append to end)

- [ ] **Step 1: Add render job types to types.ts**

Add these types at the end of `types.ts`:

```typescript
// ============ RENDER QUEUE ============

export type RenderJobStatus = 'queued' | 'rendering' | 'done' | 'error' | 'aborted';

export interface RenderJob {
  id: string;
  name: string;
  settings: ExportSettings;
  status: RenderJobStatus;
  progress: number;        // 0-1
  currentFrame: number;
  totalFrames: number;
  startedAt: number | null; // Date.now()
  eta: number | null;       // seconds remaining
  error: string | null;
  outputUrl: string | null; // blob URL when done
}
```

- [ ] **Step 2: Commit**

```
git add types.ts
git commit -m "feat: add RenderJob types for offline render queue"
```

---

### Task 2: Build the Offline Renderer

**Files:**
- Create: `services/offlineRenderer.ts`

This is the core engine. It renders frame-by-frame by seeking video elements to exact times, waiting for readiness, then drawing all layers to canvas.

- [ ] **Step 1: Create offlineRenderer.ts**

```typescript
/**
 * Offline frame-by-frame renderer.
 *
 * Instead of real-time playback, this:
 * 1. Computes exact frame time from frame index and FPS
 * 2. Seeks all active video elements to that time
 * 3. Waits for readyState >= 2 (HAVE_CURRENT_DATA)
 * 4. Draws all layers to canvas (video, subtitles, titles, transitions)
 * 5. Lets MediaRecorder capture the frame
 * 6. Advances to next frame
 *
 * Audio is captured by playing videos during render (muted to speakers
 * but routed to MediaRecorder via Web Audio API).
 */

import { ExportSettings, Segment, ClipKeyframe, Transition, TitleLayer, SubtitleStyle, SubtitleTemplate, TextAnimation } from '../types';
import { getInterpolatedTransform, ASPECT_RATIO_PRESETS } from '../utils/interpolation';
import { renderTransition as renderTransitionCanvas } from '../utils/transitionRenderer';
import { drawSubtitleOnCanvas } from '../utils/canvasSubtitleRenderer';

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
  audioSourcesRef: Map<HTMLVideoElement, MediaElementAudioSourceNode>;
  viewportSettings: { previewAspectRatio: string; showOverlay: boolean; overlayOpacity: number };
  viewportSize: { width: number; height: number };
  safeZoneHeight: number;
  getCombinedTransform: (kfs: ClipKeyframe[] | undefined, clipTime: number, timelineTime: number) => any;
}

export interface RenderCallbacks {
  onProgress: (frame: number, totalFrames: number) => void;
  onComplete: (blobUrl: string) => void;
  onError: (error: string) => void;
}

export class OfflineRenderer {
  private aborted = false;
  private settings: ExportSettings;
  private deps: RendererDeps;
  private callbacks: RenderCallbacks;

  constructor(settings: ExportSettings, deps: RendererDeps, callbacks: RenderCallbacks) {
    this.settings = settings;
    this.deps = deps;
    this.callbacks = callbacks;
  }

  abort() {
    this.aborted = true;
  }

  async render() {
    const { settings, deps, callbacks } = this;

    // --- Output dimensions ---
    const preset = ASPECT_RATIO_PRESETS[settings.aspectRatio];
    const baseRes = settings.resolution === '4K' ? 2160 : settings.resolution === '1080p' ? 1080 : 720;
    let outputWidth: number, outputHeight: number;
    if (preset.ratio > 1) {
      outputHeight = baseRes;
      outputWidth = Math.round(baseRes * preset.ratio);
    } else {
      outputWidth = Math.round(baseRes * preset.ratio);
      outputHeight = baseRes;
    }

    // --- Canvas setup ---
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d')!;

    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = outputWidth;
    tmpCanvas.height = outputHeight;
    const tmpCtx = tmpCanvas.getContext('2d')!;

    // --- Audio setup ---
    const actx = deps.audioContext;
    if (actx.state === 'suspended') await actx.resume();
    const audioDest = actx.createMediaStreamDestination();

    // Connect video audio sources to export stream
    deps.videoRefs.forEach((vid, segId) => {
      let source = deps.audioSourcesRef.get(vid);
      if (!source) {
        try {
          source = actx.createMediaElementSource(vid);
          deps.audioSourcesRef.set(vid, source);
          source.connect(actx.destination); // speakers
        } catch (e) { /* already connected */ }
      }
      if (source) {
        try { source.connect(audioDest); } catch (e) { /* already connected */ }
      }
    });

    // --- MediaRecorder ---
    const canvasStream = canvas.captureStream(0); // 0 = manual frame capture
    const combinedStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioDest.stream.getAudioTracks()
    ]);

    const mediaRecorder = new MediaRecorder(combinedStream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: settings.bitrateMbps * 1000000
    });

    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    const completionPromise = new Promise<string>((resolve, reject) => {
      mediaRecorder.onstop = () => {
        if (this.aborted) {
          reject(new Error('Render aborted'));
          return;
        }
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        resolve(url);
      };
      mediaRecorder.onerror = (e) => reject(new Error('MediaRecorder error'));
    });

    // --- Compute total frames ---
    const contentDuration = Math.max(...deps.segments.map(s => s.timelineStart + (s.endTime - s.startTime)), 0);
    const totalFrames = Math.ceil(contentDuration * settings.fps);
    const frameDuration = 1 / settings.fps;

    // --- Pause all videos (we'll seek manually) ---
    deps.videoRefs.forEach(vid => { vid.pause(); vid.muted = false; });

    mediaRecorder.start();

    // --- Frame-by-frame render loop ---
    let prevSegmentCanvas: HTMLCanvasElement | null = null;
    const lastGoodFrame = document.createElement('canvas');
    lastGoodFrame.width = outputWidth;
    lastGoodFrame.height = outputHeight;
    const lastGoodCtx = lastGoodFrame.getContext('2d')!;

    try {
      for (let frame = 0; frame < totalFrames; frame++) {
        if (this.aborted) break;

        const currentTime = frame * frameDuration;
        callbacks.onProgress(frame, totalFrames);

        // Find active segments at this time
        const activeSegments = deps.segments
          .filter(s => currentTime >= s.timelineStart && currentTime < (s.timelineStart + (s.endTime - s.startTime)))
          .sort((a, b) => (a.track || 0) - (b.track || 0));

        // Seek all active videos to exact time and wait
        await this.seekAndWait(activeSegments, currentTime);

        // Check if any video is ready
        const anyReady = activeSegments.some(s => {
          const v = deps.videoRefs.get(s.id);
          return v && v.readyState >= 2;
        });

        if (anyReady || activeSegments.length === 0) {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, outputWidth, outputHeight);
        } else {
          ctx.drawImage(lastGoodFrame, 0, 0);
        }

        // Draw each active segment
        for (const seg of activeSegments) {
          const vid = deps.videoRefs.get(seg.id);
          const clipTime = currentTime - seg.timelineStart;
          const segDuration = seg.endTime - seg.startTime;

          if (vid && vid.readyState >= 2) {
            const transform = deps.getCombinedTransform(seg.keyframes, clipTime, currentTime);
            const coverScale = Math.max(outputWidth / vid.videoWidth, outputHeight / vid.videoHeight);
            const dw = vid.videoWidth * coverScale;
            const dh = vid.videoHeight * coverScale;

            // Check transitions
            let transitionActive = false;
            let transitionProgress = 0;
            let activeTransition: Transition | undefined;
            let isTransitionIn = false;

            if (seg.transitionIn && clipTime < seg.transitionIn.duration) {
              transitionActive = true;
              transitionProgress = Math.max(0, Math.min(1, clipTime / seg.transitionIn.duration));
              activeTransition = seg.transitionIn;
              isTransitionIn = true;
            }
            if (seg.transitionOut && clipTime > (segDuration - seg.transitionOut.duration)) {
              transitionActive = true;
              const remaining = segDuration - clipTime;
              transitionProgress = 1 - Math.max(0, Math.min(1, remaining / seg.transitionOut.duration));
              activeTransition = seg.transitionOut;
              isTransitionIn = false;
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
                renderTransitionCanvas({
                  ctx, width: outputWidth, height: outputHeight,
                  outFrame: (activeTransition.type === 'CROSSFADE' && prevSegmentCanvas) ? prevSegmentCanvas : null,
                  inFrame: tmpCanvas,
                  progress: transitionProgress, transition: activeTransition,
                });
              } else {
                renderTransitionCanvas({
                  ctx, width: outputWidth, height: outputHeight,
                  outFrame: tmpCanvas, inFrame: null,
                  progress: transitionProgress, transition: activeTransition,
                });
              }
            } else {
              // Normal draw with transforms
              ctx.save();
              ctx.translate(outputWidth / 2, outputHeight / 2);
              ctx.translate(transform.translateX * dw / 100, transform.translateY * dh / 100);
              if (transform.pivotX !== undefined && transform.pivotY !== undefined) {
                const px = (transform.pivotX / 100 - 0.5) * dw;
                const py = (transform.pivotY / 100 - 0.5) * dh;
                ctx.translate(px, py);
                ctx.scale(transform.scale, transform.scale);
                ctx.rotate(transform.rotation * Math.PI / 180);
                ctx.translate(-px, -py);
              } else {
                ctx.scale(transform.scale, transform.scale);
                ctx.rotate(transform.rotation * Math.PI / 180);
              }
              ctx.drawImage(vid, -dw / 2, -dh / 2, dw, dh);
              ctx.restore();
            }

            // Save frame for crossfade
            if (!prevSegmentCanvas) {
              prevSegmentCanvas = document.createElement('canvas');
              prevSegmentCanvas.width = outputWidth;
              prevSegmentCanvas.height = outputHeight;
            }
            const pCtx = prevSegmentCanvas.getContext('2d')!;
            pCtx.clearRect(0, 0, outputWidth, outputHeight);
            pCtx.drawImage(canvas, 0, 0);
          }
        }

        // Draw subtitles
        this.drawSubtitles(ctx, currentTime, activeSegments, outputWidth, outputHeight);

        // Draw title
        this.drawTitle(ctx, currentTime, outputWidth, outputHeight);

        // Save last good frame
        if (anyReady) {
          lastGoodCtx.clearRect(0, 0, outputWidth, outputHeight);
          lastGoodCtx.drawImage(canvas, 0, 0);
        }

        // Signal MediaRecorder to capture this frame
        const videoTrack = canvasStream.getVideoTracks()[0] as any;
        if (videoTrack.requestFrame) {
          videoTrack.requestFrame();
        }

        // Yield to browser to prevent UI freeze (every frame)
        await new Promise(r => setTimeout(r, 0));
      }
    } catch (err: any) {
      if (!this.aborted) {
        mediaRecorder.stop();
        callbacks.onError(err.message || 'Render failed');
        return;
      }
    }

    mediaRecorder.stop();

    try {
      const blobUrl = await completionPromise;
      callbacks.onComplete(blobUrl);
    } catch (err: any) {
      if (!this.aborted) {
        callbacks.onError(err.message || 'Render failed');
      }
    }
  }

  /** Seek all active video elements to exact time and wait for readyState >= 2 */
  private async seekAndWait(activeSegments: Segment[], currentTime: number): Promise<void> {
    await Promise.all(activeSegments.map(seg => new Promise<void>(resolve => {
      const vid = this.deps.videoRefs.get(seg.id);
      if (!vid) { resolve(); return; }

      const targetTime = seg.startTime + (currentTime - seg.timelineStart);
      // Skip seek if already close enough (within 1ms)
      if (Math.abs(vid.currentTime - targetTime) < 0.001) {
        resolve();
        return;
      }

      vid.currentTime = targetTime;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      if (vid.readyState >= 2) {
        vid.addEventListener('seeked', finish, { once: true });
      } else {
        const check = () => {
          if (vid.readyState >= 2) finish();
          else setTimeout(check, 5);
        };
        vid.addEventListener('seeked', check, { once: true });
      }
      // Timeout fallback — don't hang forever
      setTimeout(finish, 500);
    })));
  }

  /** Draw subtitles for the current frame */
  private drawSubtitles(ctx: CanvasRenderingContext2D, currentTime: number, activeSegments: Segment[], w: number, h: number) {
    const { deps } = this;
    const visualSegs = activeSegments.filter(s => s.type !== 'audio');
    const topSeg = visualSegs.length > 0 ? visualSegs[visualSegs.length - 1] : activeSegments[activeSegments.length - 1];
    if (!topSeg) return;

    const media = deps.library.find(m => m.id === topSeg.mediaId);
    if (!media?.analysis?.events) return;

    const sourceTime = topSeg.startTime + (currentTime - topSeg.timelineStart);

    const activeEvent = media.analysis.events.find((e: any) =>
      e.type === 'dialogue' && sourceTime >= e.startTime && sourceTime <= e.endTime
    );
    if (!activeEvent) return;

    // Check if word is removed
    const eventIndex = media.analysis.events.indexOf(activeEvent);

    const template = activeEvent.templateOverride || deps.activeSubtitleTemplate;
    const style = activeEvent.styleOverride || deps.subtitleStyle;
    const animation = template?.animation;

    const subTime = sourceTime - activeEvent.startTime;
    const subDuration = activeEvent.endTime - activeEvent.startTime;

    // Get keyframe transform for subtitle
    let subTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
    if (activeEvent.keyframes?.length) {
      subTransform = getInterpolatedTransform(activeEvent.keyframes, subTime);
    }
    const globalTx = activeEvent.translateX || 0;
    const globalTy = activeEvent.translateY || 0;

    try {
      drawSubtitleOnCanvas(ctx, {
        text: activeEvent.details || '',
        style,
        outputWidth: w,
        outputHeight: h,
        safeZoneHeight: deps.safeZoneHeight || h,
        animation,
        animationTime: subTime,
        animationDuration: subDuration,
        wordTimings: activeEvent.wordTimings,
        sourceTime,
        eventStartTime: activeEvent.startTime,
        translateX: globalTx + subTransform.translateX,
        translateY: globalTy + subTransform.translateY,
        scale: subTransform.scale,
        rotation: subTransform.rotation,
        removedWords: deps.removedWords
          .filter(rw => rw.mediaId === media!.id && rw.eventIndex === eventIndex)
          .map(rw => rw.wordIndex),
        keywordAnimation: deps.activeKeywordAnimation,
        emphasis: activeEvent.emphasis,
      });
    } catch (e) {
      console.warn('[OfflineRenderer] Subtitle draw error:', e);
    }
  }

  /** Draw title layer for the current frame */
  private drawTitle(ctx: CanvasRenderingContext2D, currentTime: number, w: number, h: number) {
    const { deps } = this;
    const title = deps.titleLayer;
    if (!title || currentTime < title.startTime || currentTime > title.endTime) return;

    const titleTime = currentTime - title.startTime;
    const titleDuration = title.endTime - title.startTime;

    // Fade in/out
    let opacity = 1;
    if (title.fadeInDuration > 0 && titleTime < title.fadeInDuration) {
      opacity = titleTime / title.fadeInDuration;
    }
    if (title.fadeOutDuration > 0 && (titleDuration - titleTime) < title.fadeOutDuration) {
      opacity = (titleDuration - titleTime) / title.fadeOutDuration;
    }

    const template = title.animation ? { name: 'title', css: '', animation: title.animation } : deps.activeTitleTemplate;
    const style = title.style || deps.titleStyle || deps.subtitleStyle;

    let titleTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
    if (title.keyframes?.length) {
      titleTransform = deps.getCombinedTransform(title.keyframes, titleTime, currentTime);
    }

    ctx.save();
    ctx.globalAlpha = opacity;

    try {
      drawSubtitleOnCanvas(ctx, {
        text: title.text,
        style: { ...style, topOffset: (style as any).topOffset ?? 15, bottomOffset: undefined },
        outputWidth: w,
        outputHeight: h,
        safeZoneHeight: deps.safeZoneHeight || h,
        animation: template?.animation,
        animationTime: titleTime,
        animationDuration: titleDuration,
        translateX: titleTransform.translateX,
        translateY: titleTransform.translateY,
        scale: titleTransform.scale,
        rotation: titleTransform.rotation,
      });
    } catch (e) {
      console.warn('[OfflineRenderer] Title draw error:', e);
    }

    ctx.restore();
  }
}
```

- [ ] **Step 2: Commit**

```
git add services/offlineRenderer.ts
git commit -m "feat: offline frame-by-frame renderer engine"
```

---

### Task 3: Build the Render Queue Manager

**Files:**
- Create: `services/renderQueue.ts`

- [ ] **Step 1: Create renderQueue.ts**

```typescript
import { ExportSettings, RenderJob, RenderJobStatus } from '../types';
import { OfflineRenderer, RendererDeps, RenderCallbacks } from './offlineRenderer';

type QueueListener = (jobs: RenderJob[]) => void;

export class RenderQueueManager {
  private jobs: RenderJob[] = [];
  private listeners: Set<QueueListener> = new Set();
  private currentRenderer: OfflineRenderer | null = null;
  private isRunning = false;
  private depsProvider: (() => RendererDeps) | null = null;

  /** Register a function that provides fresh renderer deps from React state */
  setDepsProvider(provider: () => RendererDeps) {
    this.depsProvider = provider;
  }

  subscribe(listener: QueueListener): () => void {
    this.listeners.add(listener);
    listener(this.jobs);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    const snapshot = [...this.jobs];
    this.listeners.forEach(fn => fn(snapshot));
  }

  /** Add a new render job to the queue */
  addJob(settings: ExportSettings, name?: string): string {
    const contentDuration = this.getContentDuration();
    const totalFrames = Math.ceil(contentDuration * settings.fps);

    const job: RenderJob = {
      id: `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: name || `Export ${settings.aspectRatio} ${settings.resolution}`,
      settings,
      status: 'queued',
      progress: 0,
      currentFrame: 0,
      totalFrames,
      startedAt: null,
      eta: null,
      error: null,
      outputUrl: null,
    };

    this.jobs.push(job);
    this.notify();
    this.processNext();
    return job.id;
  }

  /** Abort a specific job */
  abortJob(jobId: string) {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job) return;

    if (job.status === 'rendering') {
      this.currentRenderer?.abort();
      job.status = 'aborted';
      this.currentRenderer = null;
      this.isRunning = false;
      this.notify();
      this.processNext();
    } else if (job.status === 'queued') {
      job.status = 'aborted';
      this.notify();
    }
  }

  /** Remove a completed/errored/aborted job from the list */
  removeJob(jobId: string) {
    const job = this.jobs.find(j => j.id === jobId);
    if (job?.outputUrl) URL.revokeObjectURL(job.outputUrl);
    this.jobs = this.jobs.filter(j => j.id !== jobId);
    this.notify();
  }

  /** Clear all finished jobs */
  clearFinished() {
    this.jobs.filter(j => j.status === 'done' || j.status === 'error' || j.status === 'aborted')
      .forEach(j => { if (j.outputUrl) URL.revokeObjectURL(j.outputUrl); });
    this.jobs = this.jobs.filter(j => j.status === 'queued' || j.status === 'rendering');
    this.notify();
  }

  /** Download a completed render */
  downloadJob(jobId: string) {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job?.outputUrl) return;
    const a = document.createElement('a');
    a.href = job.outputUrl;
    a.download = `${job.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.webm`;
    a.click();
  }

  getJobs(): RenderJob[] {
    return [...this.jobs];
  }

  private getContentDuration(): number {
    if (!this.depsProvider) return 0;
    const deps = this.depsProvider();
    return Math.max(...deps.segments.map(s => s.timelineStart + (s.endTime - s.startTime)), 0);
  }

  private async processNext() {
    if (this.isRunning) return;

    const nextJob = this.jobs.find(j => j.status === 'queued');
    if (!nextJob || !this.depsProvider) return;

    this.isRunning = true;
    nextJob.status = 'rendering';
    nextJob.startedAt = Date.now();
    this.notify();

    const deps = this.depsProvider();

    const callbacks: RenderCallbacks = {
      onProgress: (frame, total) => {
        nextJob.currentFrame = frame;
        nextJob.totalFrames = total;
        nextJob.progress = total > 0 ? frame / total : 0;

        // ETA calculation
        if (nextJob.startedAt && frame > 0) {
          const elapsed = (Date.now() - nextJob.startedAt) / 1000;
          const rate = frame / elapsed; // frames per second
          const remaining = total - frame;
          nextJob.eta = rate > 0 ? remaining / rate : null;
        }

        this.notify();
      },
      onComplete: (blobUrl) => {
        nextJob.status = 'done';
        nextJob.progress = 1;
        nextJob.outputUrl = blobUrl;
        nextJob.eta = 0;
        this.isRunning = false;
        this.currentRenderer = null;
        this.notify();
        this.processNext(); // Next in queue
      },
      onError: (error) => {
        nextJob.status = 'error';
        nextJob.error = error;
        nextJob.eta = null;
        this.isRunning = false;
        this.currentRenderer = null;
        this.notify();
        this.processNext();
      },
    };

    const renderer = new OfflineRenderer(nextJob.settings, deps, callbacks);
    this.currentRenderer = renderer;

    try {
      await renderer.render();
    } catch (err: any) {
      if (nextJob.status === 'rendering') {
        nextJob.status = 'error';
        nextJob.error = err.message || 'Unknown error';
        this.isRunning = false;
        this.currentRenderer = null;
        this.notify();
        this.processNext();
      }
    }
  }
}

/** Singleton instance */
export const renderQueue = new RenderQueueManager();
```

- [ ] **Step 2: Commit**

```
git add services/renderQueue.ts
git commit -m "feat: render queue manager with job lifecycle and abort"
```

---

### Task 4: Build the Render Queue Panel UI

**Files:**
- Create: `components/RenderQueuePanel.tsx`

- [ ] **Step 1: Create RenderQueuePanel.tsx**

```typescript
import React, { useState, useEffect } from 'react';
import { RenderJob } from '../types';
import { renderQueue } from '../services/renderQueue';

const RenderQueuePanel: React.FC = () => {
  const [jobs, setJobs] = useState<RenderJob[]>([]);

  useEffect(() => {
    return renderQueue.subscribe(setJobs);
  }, []);

  const formatEta = (seconds: number | null): string => {
    if (seconds === null || seconds <= 0) return '--';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  const getStatusColor = (status: RenderJob['status']): string => {
    switch (status) {
      case 'queued': return '#888';
      case 'rendering': return '#3b82f6';
      case 'done': return '#22c55e';
      case 'error': return '#ef4444';
      case 'aborted': return '#f59e0b';
    }
  };

  const getStatusLabel = (status: RenderJob['status']): string => {
    switch (status) {
      case 'queued': return 'Queued';
      case 'rendering': return 'Rendering';
      case 'done': return 'Complete';
      case 'error': return 'Failed';
      case 'aborted': return 'Aborted';
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-[#333] flex items-center justify-between">
        <span className="text-xs font-bold text-gray-300 uppercase tracking-wider">Render Queue</span>
        {jobs.some(j => j.status === 'done' || j.status === 'error' || j.status === 'aborted') && (
          <button
            onClick={() => renderQueue.clearFinished()}
            className="text-[10px] px-2 py-0.5 rounded bg-[#333] text-gray-400 hover:text-white hover:bg-[#444]"
          >
            Clear Finished
          </button>
        )}
      </div>

      {/* Job List */}
      <div className="flex-1 overflow-auto">
        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs px-4 text-center">
            <div className="text-2xl mb-2">🎬</div>
            <div>No renders in queue</div>
            <div className="mt-1 text-gray-600">Use Export to add renders</div>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {jobs.map(job => (
              <div key={job.id} className="bg-[#1a1a1a] border border-[#333] rounded-lg p-3">
                {/* Job header */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium text-gray-200 truncate flex-1 mr-2">
                    {job.name}
                  </span>
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{
                      color: getStatusColor(job.status),
                      backgroundColor: `${getStatusColor(job.status)}15`,
                    }}
                  >
                    {getStatusLabel(job.status)}
                  </span>
                </div>

                {/* Progress bar (rendering or queued) */}
                {(job.status === 'rendering' || job.status === 'queued') && (
                  <div className="mb-2">
                    <div className="h-1.5 bg-[#333] rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.round(job.progress * 100)}%`,
                          backgroundColor: getStatusColor(job.status),
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Stats row */}
                <div className="flex items-center justify-between text-[10px] text-gray-500">
                  <div className="flex items-center gap-3">
                    {job.status === 'rendering' && (
                      <>
                        <span>{Math.round(job.progress * 100)}%</span>
                        <span>Frame {job.currentFrame}/{job.totalFrames}</span>
                        <span>ETA: {formatEta(job.eta)}</span>
                      </>
                    )}
                    {job.status === 'done' && (
                      <span className="text-green-400">Ready to download</span>
                    )}
                    {job.status === 'error' && (
                      <span className="text-red-400 truncate" title={job.error || ''}>
                        {job.error}
                      </span>
                    )}
                    {job.status === 'queued' && (
                      <span>Waiting...</span>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-1">
                    {job.status === 'rendering' && (
                      <button
                        onClick={() => renderQueue.abortJob(job.id)}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-red-900/30 text-red-400 hover:bg-red-900/50"
                      >
                        Abort
                      </button>
                    )}
                    {job.status === 'queued' && (
                      <button
                        onClick={() => renderQueue.abortJob(job.id)}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-[#333] text-gray-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    )}
                    {job.status === 'done' && (
                      <button
                        onClick={() => renderQueue.downloadJob(job.id)}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-green-900/30 text-green-400 hover:bg-green-900/50"
                      >
                        Download
                      </button>
                    )}
                    {(job.status === 'done' || job.status === 'error' || job.status === 'aborted') && (
                      <button
                        onClick={() => renderQueue.removeJob(job.id)}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-[#333] text-gray-400 hover:text-white"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RenderQueuePanel;
```

- [ ] **Step 2: Commit**

```
git add components/RenderQueuePanel.tsx
git commit -m "feat: render queue panel with progress, ETA, abort, download"
```

---

### Task 5: Wire Everything Into App.tsx

**Files:**
- Modify: `App.tsx`
- Modify: `components/ExportModal.tsx`

- [ ] **Step 1: Add imports and state to App.tsx**

At the top of App.tsx, add import:

```typescript
import RenderQueuePanel from './components/RenderQueuePanel';
import { renderQueue } from './services/renderQueue';
```

- [ ] **Step 2: Add RENDER tab to the right panel tab bar**

In the right panel tab bar section (around line 7020), add a new tab button after TRACKING:

```typescript
<button onClick={() => setActiveRightTab('render')} className={`flex-1 py-2 text-[10px] font-bold tracking-tight ${activeRightTab === 'render' ? 'bg-[#333] text-orange-400 border-b-2 border-orange-400' : 'text-gray-400 hover:text-white'}`}>
  RENDER
</button>
```

Update the `activeRightTab` state type to include `'render'`:

Find `useState<'transcript'` and add `'render'` to the union type.

- [ ] **Step 3: Add RenderQueuePanel content section**

In the right panel content area (after the TRACKING content block), add:

```typescript
{activeRightTab === 'render' && (
  <RenderQueuePanel />
)}
```

- [ ] **Step 4: Register the deps provider with the render queue**

Inside the App component body (after the refs and state declarations, in a useEffect), register the deps provider so the render queue can access current project state:

```typescript
useEffect(() => {
  renderQueue.setDepsProvider(() => ({
    segments: project.segments,
    globalKeyframes: globalKeyframes,
    titleLayer: project.titleLayer,
    subtitleStyle: project.subtitleStyle,
    titleStyle: project.titleStyle || project.subtitleStyle,
    activeSubtitleTemplate: project.activeSubtitleTemplate,
    activeTitleTemplate: project.activeTitleTemplate || null,
    activeKeywordAnimation: project.activeKeywordAnimation,
    removedWords: project.removedWords || [],
    library: project.library,
    videoRefs: videoRefs.current,
    audioContext: audioContextRef.current || new AudioContext(),
    audioSourcesRef: audioSourcesRef.current,
    viewportSettings,
    viewportSize,
    safeZoneHeight: safeZoneRef.current?.getBoundingClientRect().height || viewportSize.height,
    getCombinedTransform,
  }));
});
```

- [ ] **Step 5: Update ExportModal to add to queue instead of exporting directly**

In `components/ExportModal.tsx`, change the `handleExport` function:

```typescript
const handleExport = async () => {
    const settings: ExportSettings = {
        aspectRatio,
        resolution,
        format: 'webm',
        bitrateMbps,
        fps
    };

    onExport(settings);
    onClose();
};
```

And update `onExport` prop type from `(settings: ExportSettings) => Promise<void>` to `(settings: ExportSettings) => void`.

In App.tsx, change `handleExportVideo` (or the `onExport` prop) to add to queue:

```typescript
const handleAddToRenderQueue = (settings: ExportSettings) => {
  if (!audioContextRef.current) {
    audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  renderQueue.addJob(settings);
  setActiveRightTab('render');
};
```

Pass `handleAddToRenderQueue` instead of `handleExportVideo` to `<ExportModal onExport={handleAddToRenderQueue} />`.

- [ ] **Step 6: Commit**

```
git add App.tsx components/ExportModal.tsx
git commit -m "feat: wire render queue into App with RENDER tab and queue-based export"
```

---

### Task 6: Test and Verify

- [ ] **Step 1: Run dev server and verify no build errors**

```
cd Vibe-video-editing-/.claude/worktrees/goofy-haibt
npm run dev
```

- [ ] **Step 2: Verify the RENDER tab appears in the right panel**

Click the RENDER tab — should show empty state with "No renders in queue" message.

- [ ] **Step 3: Test the export flow**

1. Import a video
2. Click Export button → modal opens
3. Click "Export" in modal → modal closes, RENDER tab activates
4. Render queue shows job with progress bar, frame count, ETA
5. When complete, "Download" button appears
6. Click Download → `.webm` file saves

- [ ] **Step 4: Test abort**

1. Start a render
2. Click "Abort" during rendering
3. Job shows "Aborted" status
4. Queue processes next job if any

- [ ] **Step 5: Test multiple jobs**

1. Add 2-3 exports with different settings
2. Queue processes them sequentially
3. Each shows correct progress independently

- [ ] **Step 6: Commit final state**

```
git add -A
git commit -m "feat: complete offline render queue with progress, ETA, abort"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add types | types.ts |
| 2 | Offline renderer engine | services/offlineRenderer.ts |
| 3 | Queue manager | services/renderQueue.ts |
| 4 | Queue panel UI | components/RenderQueuePanel.tsx |
| 5 | Wire into App | App.tsx, ExportModal.tsx |
| 6 | Test and verify | - |
