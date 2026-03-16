/**
 * Pure utility functions for karaoke-style word highlight box.
 * No React, no DOM — works in both viewport and canvas export paths.
 */

export interface WordTiming {
  text: string;
  start: number; // seconds
  end: number;   // seconds
  confidence: number;
}

export interface ActiveWordInfo {
  /** Index into the non-whitespace word array (matches wordTimings index). -1 = none active yet. */
  activeIndex: number;
  /** 0-1 progress within the active word's duration */
  progress: number;
  /**
   * Interpolation factor between words (0-1).
   * When in a gap between word[i] and word[i+1], this is > 0.
   * Used by canvas path for stateless position lerping.
   * 0 = snapped to activeIndex, > 0 = blending toward next word.
   */
  gapProgress: number;
  /** Index of the word we're blending toward (during gap). -1 = no gap blend. */
  nextIndex: number;
}

/**
 * Estimate per-word timings when AssemblyAI wordTimings are not available.
 * Distributes event duration evenly across words.
 */
export function estimateWordTimings(
  text: string,
  eventStart: number,
  eventEnd: number
): WordTiming[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return [];
  const duration = eventEnd - eventStart;
  const wordDuration = duration / words.length;
  return words.map((word, i) => ({
    text: word,
    start: eventStart + i * wordDuration,
    end: eventStart + (i + 1) * wordDuration,
    confidence: 1,
  }));
}

/**
 * Given word timings and the current source time, returns which word is active.
 *
 * @param wordTimings - Per-word timestamps (from AssemblyAI or estimated)
 * @param eventStart  - Event start time in seconds
 * @param eventEnd    - Event end time in seconds
 * @param text        - Subtitle text (used only when wordTimings is absent)
 * @param sourceTime  - Current source video time in seconds
 */
export function getActiveWordInfo(
  wordTimings: WordTiming[] | undefined,
  eventStart: number,
  eventEnd: number,
  text: string,
  sourceTime: number
): ActiveWordInfo {
  const timings = wordTimings && wordTimings.length > 0
    ? wordTimings
    : estimateWordTimings(text, eventStart, eventEnd);

  if (timings.length === 0) {
    return { activeIndex: 0, progress: 0, gapProgress: 0, nextIndex: -1 };
  }

  // Before first word
  if (sourceTime < timings[0].start) {
    return { activeIndex: 0, progress: 0, gapProgress: 0, nextIndex: -1 };
  }

  // After last word
  if (sourceTime >= timings[timings.length - 1].end) {
    return {
      activeIndex: timings.length - 1,
      progress: 1,
      gapProgress: 0,
      nextIndex: -1,
    };
  }

  for (let i = 0; i < timings.length; i++) {
    const w = timings[i];

    // Inside this word's duration
    if (sourceTime >= w.start && sourceTime < w.end) {
      const progress = w.end > w.start
        ? (sourceTime - w.start) / (w.end - w.start)
        : 1;
      return { activeIndex: i, progress, gapProgress: 0, nextIndex: -1 };
    }

    // In the gap between this word and the next
    const next = timings[i + 1];
    if (next && sourceTime >= w.end && sourceTime < next.start) {
      const gapDuration = next.start - w.end;
      const gapProgress = gapDuration > 0
        ? (sourceTime - w.end) / gapDuration
        : 1;
      return {
        activeIndex: i,
        progress: 1,
        gapProgress,
        nextIndex: i + 1,
      };
    }
  }

  // Fallback
  return { activeIndex: 0, progress: 0, gapProgress: 0, nextIndex: -1 };
}

/**
 * Lerp between two numbers.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ease-out cubic for smooth deceleration */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}
