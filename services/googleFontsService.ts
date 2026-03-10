/**
 * Google Fonts Service
 *
 * Handles dynamic loading of Google Fonts via <link> tag injection,
 * font loading deduplication, and recent font persistence.
 */

import { SYSTEM_FONTS } from '../data/googleFonts';

const RECENT_FONTS_KEY = 'vibecut-recent-fonts';
const MAX_RECENT = 10;

// Track which fonts have already been loaded (avoid duplicate <link> tags)
const loadedFonts = new Set<string>();

/**
 * Load a Google Font by injecting a <link> stylesheet tag.
 * System fonts (Arial, Verdana, etc.) are skipped.
 * Deduplicates: calling twice for the same font is a no-op.
 */
export function loadGoogleFont(family: string): void {
  if (SYSTEM_FONTS.has(family)) return;
  if (loadedFonts.has(family)) return;

  loadedFonts.add(family);

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700&display=swap`;
  document.head.appendChild(link);
}

/**
 * Check if a font has been loaded (either system or previously injected).
 */
export function isFontLoaded(family: string): boolean {
  return SYSTEM_FONTS.has(family) || loadedFonts.has(family);
}

/**
 * Get the list of recently used fonts from localStorage.
 */
export function getRecentFonts(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_FONTS_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // Ignore corrupted data
  }
  return [];
}

/**
 * Add a font to the recent fonts list (moves to front if already present).
 */
export function addRecentFont(family: string): void {
  const recent = getRecentFonts().filter(f => f !== family);
  recent.unshift(family);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  try {
    localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(recent));
  } catch {
    // localStorage quota exceeded — ignore
  }
}

/**
 * Batch-load multiple Google Fonts (e.g. on project load).
 */
export function loadGoogleFonts(families: string[]): void {
  for (const family of families) {
    loadGoogleFont(family);
  }
}
