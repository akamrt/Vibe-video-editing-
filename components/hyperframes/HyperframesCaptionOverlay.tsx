/**
 * HyperframesCaptionOverlay
 *
 * Renders a Hyperframes composition as a transparent caption overlay.
 *
 * ── Word highlighting ────────────────────────────────────────────────────────
 *   The overlay receives the raw AssemblyAI wordTimings (absolute media time).
 *   On every sourceTime update it computes the active word index using the same
 *   activeWordIndex() function as the canvas export renderer, then calls
 *   iframe.contentWindow.__hySetActiveWord(index) so the HTML can colour the
 *   correct word element instantly. This is completely decoupled from the GSAP
 *   animation timeline — the animation plays the entrance effect while the
 *   highlight tracks real speech timing.
 *
 * ── "Missing dialogue" fix ───────────────────────────────────────────────────
 *   Text is NOT in the iframe src URL. The iframe loads once per composition
 *   and stays alive across subtitle changes. New text is injected via
 *   __hyInit(text) in < 1 ms — no reload, no missed triggers.
 *
 * ── Seek-only model ──────────────────────────────────────────────────────────
 *   The GSAP timeline is always paused. Every sourceTime drives a tl.seek().
 *   A local rAF extrapolates between React updates for 60 Hz smoothness.
 */

import React, { useEffect, useRef } from 'react';
import type { HyperframesConfig } from '../../types';

interface GSAPTimeline {
  seek(position: number): GSAPTimeline;
  play(): GSAPTimeline;
  pause(): GSAPTimeline;
  time(): number;
  paused(): boolean;
  duration(): number;
}

export interface WordTiming { text: string; start: number; end: number; confidence?: number; }

interface Props {
  config: HyperframesConfig;
  text: string;
  sourceTime: number;           // absolute media sourceTime (same unit as wordTimings)
  eventStartTime: number;       // subtitle startTime in media time
  eventEndTime?: number;        // subtitle endTime   (for synthetic timing fallback)
  wordTimings?: WordTiming[];   // from AssemblyAI — absolute media time
  isPlaying: boolean;
  containerWidth: number;
  containerHeight: number;
  onMouseDown?: (e: React.MouseEvent) => void;
  divRef?: React.RefObject<HTMLDivElement>;
  style?: React.CSSProperties;
}

// ── Active-word logic (mirrors canvas renderer) ──────────────────────────────

function activeWordIndex(timings: WordTiming[], mediaTime: number): number {
  if (!timings.length) return -1;
  for (let i = 0; i < timings.length; i++) {
    if (mediaTime >= timings[i].start && mediaTime <= timings[i].end) return i;
  }
  let last = -1;
  for (let i = 0; i < timings.length; i++) {
    if (timings[i].end < mediaTime) last = i;
    else break;
  }
  return last;
}

function syntheticActiveWord(text: string, subtitleStart: number, subtitleEnd: number, mediaTime: number): number {
  const ws = text.split(/\s+/).filter(Boolean);
  if (!ws.length) return -1;
  const dur = Math.max(0.001, subtitleEnd - subtitleStart);
  const per = dur / ws.length;
  const idx = Math.floor((mediaTime - subtitleStart) / per);
  return Math.max(-1, Math.min(ws.length - 1, idx));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildStableSrc(config: HyperframesConfig): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(config.variables)) params.set(k, String(v));
  return `${config.compositionSrc}?${params.toString()}`;
}

function compositionIdFromSrc(src: string): string {
  return src.split('/').pop()?.replace('.html', '') ?? 'root';
}

function computeScale(w: number, h: number) {
  const COMP_W = 1920, COMP_H = 1080;
  return { scale: Math.min(w / COMP_W, h / COMP_H), COMP_W, COMP_H };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HyperframesCaptionOverlay({
  config,
  text,
  sourceTime,
  eventStartTime,
  eventEndTime,
  wordTimings,
  isPlaying,
  containerWidth,
  containerHeight,
  onMouseDown,
  divRef,
  style,
}: Props) {
  const wrapperRef      = useRef<HTMLDivElement>(null);
  const iframeRef       = useRef<HTMLIFrameElement | null>(null);
  const tlRef           = useRef<GSAPTimeline | null>(null);
  const probeRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef          = useRef<number | null>(null);
  const lastSrcRef      = useRef('');
  const isReadyRef      = useRef(false);
  // Seed with current text so the probe can inject even before the text effect fires
  const pendingTextRef  = useRef<string>(text);
  const baselineRef     = useRef({ offset: 0, wallclock: 0, playing: false });

  // ── Live refs for volatile props — read inside rAF at 60 fps ─────────────
  // React re-renders at timeupdate rate (~4/s) — not fast enough for word highlight.
  // rAF reads these refs directly to push highlights at 60 fps during playback.
  const wordTimingsRef  = useRef(wordTimings);
  const textRef         = useRef(text);
  const eventStartRef   = useRef(eventStartTime);
  const eventEndRef     = useRef(eventEndTime);
  // Keep refs in sync every render (cheap, no effect needed)
  wordTimingsRef.current  = wordTimings;
  textRef.current         = text;
  eventStartRef.current   = eventStartTime;
  eventEndRef.current     = eventEndTime;

  const stableSrc     = buildStableSrc(config);
  const compositionId = compositionIdFromSrc(config.compositionSrc);
  const offset        = Math.max(0, sourceTime - eventStartTime);

  // ── Resolve GSAP timeline from iframe ──────────────────────────────────────
  function getTimeline(win: Window): GSAPTimeline | null {
    const tls = (win as any).__timelines as Record<string, GSAPTimeline> | undefined;
    if (!tls) return null;
    return tls[compositionId] ?? Object.values(tls)[0] ?? null;
  }

  // ── Clamp-seek (timeline always paused) ───────────────────────────────────
  function seekTo(tl: GSAPTimeline, targetOffset: number) {
    const dur = tl.duration();
    const clamped = Math.max(0, dur > 0 ? Math.min(targetOffset, dur) : targetOffset);
    if (!tl.paused()) tl.pause();
    tl.seek(clamped);
  }

  // ── Push active word into iframe (reads from live refs) ───────────────────
  // Uses refs so it can be called safely from the rAF loop with stale closures.
  function pushActiveWordNow(win: Window, mediaTime: number) {
    const setWord = (win as any).__hySetActiveWord;
    if (typeof setWord !== 'function') return;
    const timings = wordTimingsRef.current;
    let idx: number;
    if (timings && timings.length > 0) {
      idx = activeWordIndex(timings, mediaTime);
    } else {
      const t     = textRef.current;
      const start = eventStartRef.current;
      const end   = eventEndRef.current ?? start + 10;
      idx = syntheticActiveWord(t, start, end, mediaTime);
    }
    setWord(idx);
  }

  // ── Inject text into live iframe without reloading ────────────────────────
  function injectText(win: Window, newText: string) {
    const hyInit = (win as any).__hyInit;
    if (typeof hyInit !== 'function') return;
    hyInit(newText);
    const freshTl = getTimeline(win);
    if (freshTl) {
      tlRef.current = freshTl;
      const b = baselineRef.current;
      const catchUp = b.wallclock > 0
        ? b.offset + (b.playing ? (performance.now() - b.wallclock) / 1000 : 0)
        : b.offset;
      seekTo(freshTl, catchUp);
      pushActiveWordNow(win, sourceTime);
    }
  }

  // ── rAF: smooth animation + 60 fps word highlight during playback ──────────
  function startRAF() {
    if (rafRef.current != null) return;
    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const tl  = tlRef.current;
      const win = iframeRef.current?.contentWindow;
      if (!tl) return;
      const b = baselineRef.current;
      if (!b.playing) return;
      const elapsed       = (performance.now() - b.wallclock) / 1000;
      const currentOffset = b.offset + elapsed;
      seekTo(tl, currentOffset);
      // Push word highlight at 60 fps — React timeupdate is too slow (~4 fps)
      if (win) pushActiveWordNow(win, eventStartRef.current + currentOffset);
    };
    rafRef.current = requestAnimationFrame(tick);
  }
  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
  }

  // ── Iframe mount / stableSrc change ───────────────────────────────────────
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (lastSrcRef.current === stableSrc && iframeRef.current?.isConnected) return;
    lastSrcRef.current = stableSrc;

    if (probeRef.current) { clearInterval(probeRef.current); probeRef.current = null; }
    stopRAF();
    wrapper.querySelector('iframe')?.remove();
    tlRef.current = null;
    isReadyRef.current = false;
    pendingTextRef.current = text;

    const { scale, COMP_W, COMP_H } = computeScale(containerWidth, containerHeight);
    const iframe = document.createElement('iframe');
    iframe.src = stableSrc;
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.scrolling = 'no';
    iframe.style.cssText = `
      position:absolute; top:50%; left:50%;
      width:${COMP_W}px; height:${COMP_H}px;
      transform:translate(-50%,-50%) scale(${scale});
      border:none; background:transparent; pointer-events:none;
    `;

    const handleLoad = () => {
      try {
        const win = iframe.contentWindow!;
        const doc = iframe.contentDocument;
        if (doc?.body) {
          doc.body.style.background = 'transparent';
          doc.documentElement.style.background = 'transparent';
        }
        probeRef.current = setInterval(() => {
          try {
            const tl = getTimeline(win);
            if (!tl) return;
            clearInterval(probeRef.current!); probeRef.current = null;
            isReadyRef.current = true;

            // Inject text first, then seek + highlight
            injectText(win, pendingTextRef.current);

            const b = baselineRef.current;
            const catchUp = b.wallclock > 0
              ? b.offset + (b.playing ? (performance.now() - b.wallclock) / 1000 : 0)
              : b.offset;
            if (tlRef.current) {
              seekTo(tlRef.current, catchUp);
              pushActiveWordNow(win, eventStartTime + catchUp);
            }
            if (b.playing) startRAF();
          } catch { /* cross-origin guard */ }
        }, 30);
      } catch { /* sandboxed */ }
    };

    iframe.addEventListener('load', handleLoad, { once: true });
    wrapper.appendChild(iframe);
    iframeRef.current = iframe;

    return () => {
      iframe.removeEventListener('load', handleLoad);
      if (probeRef.current) { clearInterval(probeRef.current); probeRef.current = null; }
      stopRAF();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableSrc]);

  // ── Text change: inject without reloading ─────────────────────────────────
  useEffect(() => {
    pendingTextRef.current = text;
    const win = iframeRef.current?.contentWindow;
    if (!win || !isReadyRef.current) return;
    injectText(win, text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // ── sourceTime / isPlaying: seek + push active word ───────────────────────
  useEffect(() => {
    baselineRef.current = { offset, wallclock: performance.now(), playing: isPlaying };
    const tl  = tlRef.current;
    const win = iframeRef.current?.contentWindow;
    if (isReadyRef.current && tl) {
      seekTo(tl, offset);
      if (win) pushActiveWordNow(win, sourceTime);
    }
    if (isPlaying) startRAF(); else stopRAF();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceTime, isPlaying, offset]);

  // ── Container resize ──────────────────────────────────────────────────────
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const { scale, COMP_W, COMP_H } = computeScale(containerWidth, containerHeight);
    iframe.style.width     = `${COMP_W}px`;
    iframe.style.height    = `${COMP_H}px`;
    iframe.style.transform = `translate(-50%,-50%) scale(${scale})`;
  }, [containerWidth, containerHeight]);

  // ── Unmount cleanup ───────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (probeRef.current) clearInterval(probeRef.current);
      stopRAF();
      tlRef.current?.pause();
      lastSrcRef.current = '';      // force fresh iframe on next mount
      iframeRef.current  = null;
      isReadyRef.current = false;
      tlRef.current      = null;
    };
  }, []);

  return (
    <div
      ref={(el) => {
        (wrapperRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (divRef) (divRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }}
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute', inset: 0,
        width: containerWidth, height: containerHeight,
        pointerEvents: 'auto', cursor: 'grab',
        overflow: 'hidden', background: 'transparent',
        ...style,
      }}
    />
  );
}
