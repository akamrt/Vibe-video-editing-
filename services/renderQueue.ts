import { RenderJob, RenderJobStatus, ExportSettings } from '../types';
import { OfflineRenderer, RendererDeps } from './offlineRenderer';

class RenderQueueManager {
  private jobs: RenderJob[] = [];
  private listeners: Array<(jobs: RenderJob[]) => void> = [];
  private activeRenderer: OfflineRenderer | null = null;
  private depsProvider: (() => RendererDeps) | null = null;

  setDepsProvider(provider: () => RendererDeps): void {
    this.depsProvider = provider;
  }

  subscribe(listener: (jobs: RenderJob[]) => void): () => void {
    this.listeners.push(listener);
    listener([...this.jobs]);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  addJob(settings: ExportSettings, name?: string): string {
    const id = `render_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const jobName = name ?? `Export ${settings.aspectRatio} ${settings.resolution}`;

    const job: RenderJob = {
      id,
      name: jobName,
      settings,
      status: 'queued',
      progress: 0,
      currentFrame: 0,
      totalFrames: 0,
      startedAt: null,
      eta: null,
      error: null,
      outputUrl: null,
    };

    this.jobs.push(job);
    this.notify();
    this.processNext();
    return id;
  }

  abortJob(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;

    if (job.status === 'queued') {
      this.updateJob(jobId, { status: 'aborted' });
      return;
    }

    if (job.status === 'rendering' && this.activeRenderer) {
      this.activeRenderer.abort();
      // Status will be updated via the onError/abort path in processNext
    }
  }

  removeJob(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return;

    const terminal: RenderJobStatus[] = ['done', 'error', 'aborted'];
    if (!terminal.includes(job.status)) return;

    if (job.outputUrl) {
      URL.revokeObjectURL(job.outputUrl);
    }

    this.jobs = this.jobs.filter((j) => j.id !== jobId);
    this.notify();
  }

  clearFinished(): void {
    const terminal: RenderJobStatus[] = ['done', 'error', 'aborted'];
    const toRemove = this.jobs.filter((j) => terminal.includes(j.status));
    for (const job of toRemove) {
      if (job.outputUrl) {
        URL.revokeObjectURL(job.outputUrl);
      }
    }
    this.jobs = this.jobs.filter((j) => !terminal.includes(j.status));
    this.notify();
  }

  downloadJob(jobId: string): void {
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job || !job.outputUrl) return;

    const safeName = job.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeName}_${Date.now()}.webm`;

    const a = document.createElement('a');
    a.href = job.outputUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  getJobs(): RenderJob[] {
    return [...this.jobs];
  }

  private processNext(): void {
    if (this.activeRenderer) return;

    const next = this.jobs.find((j) => j.status === 'queued');
    if (!next) return;

    if (!this.depsProvider) {
      console.warn('[RenderQueue] No deps provider registered — cannot start render.');
      return;
    }

    const deps = this.depsProvider();
    const startedAt = Date.now();

    this.updateJob(next.id, { status: 'rendering', startedAt, progress: 0, currentFrame: 0 });

    const renderer = new OfflineRenderer(next.settings, deps, {
      onProgress: (currentFrame: number, totalFrames: number) => {
        const job = this.jobs.find((j) => j.id === next.id);
        if (!job) return;

        const progress = totalFrames > 0 ? currentFrame / totalFrames : 0;
        const elapsedSeconds = (Date.now() - startedAt) / 1000;
        let eta: number | null = null;
        if (currentFrame > 0 && elapsedSeconds > 0) {
          const framesPerSecond = currentFrame / elapsedSeconds;
          const remainingFrames = totalFrames - currentFrame;
          eta = remainingFrames / framesPerSecond;
        }

        this.updateJob(next.id, { progress, currentFrame, totalFrames, eta });
      },

      onComplete: (blob: Blob) => {
        this.activeRenderer = null;
        const outputUrl = URL.createObjectURL(blob);
        this.updateJob(next.id, {
          status: 'done',
          progress: 1,
          eta: null,
          outputUrl,
        });
        this.processNext();
      },

      onError: (err: Error) => {
        this.activeRenderer = null;
        const job = this.jobs.find((j) => j.id === next.id);
        // If job was aborted externally, mark as aborted rather than error
        const status: RenderJobStatus = job?.status === 'aborted' ? 'aborted' : 'error';
        this.updateJob(next.id, {
          status,
          eta: null,
          error: status === 'error' ? err.message : null,
        });
        this.processNext();
      },
    });

    this.activeRenderer = renderer;
    renderer.render().catch(() => {
      // Errors are handled via onError callback
    });
  }

  private updateJob(jobId: string, patch: Partial<RenderJob>): void {
    this.jobs = this.jobs.map((j) => (j.id === jobId ? { ...j, ...patch } : j));
    this.notify();
  }

  private notify(): void {
    const snapshot = [...this.jobs];
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export const renderQueue = new RenderQueueManager();
