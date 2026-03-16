# Word Highlight: Animation Tracking & In-Flight Effects

**Date:** 2026-03-16
**Project:** VibeCut Pro — `Vibe-video-editing-/`
**Status:** Approved

---

## Overview

Two enhancements to the existing karaoke-style word highlight box:

1. **Animation Tracking** — the highlight box follows word positions in all axes as they animate (fly-in from bottom, scale, etc.) instead of snapping to their final layout positions.
2. **In-Flight Effects** — three independently toggleable visual effects that activate while the active word is still mid-animation and fade out as the word settles.

---

## 1. Position Tracking Fix

### Problem

The measurement `useEffect` in `AnimatedText.tsx` has deps `[wordHighlightEnabled, text, animation.scope]`. Positions are measured once after mount. During per-word animation (translateY, scale, etc.), word spans are mid-transform, so the cached rects are stale and the highlight box lags behind animated positions.

### Solution

Add `frame` to the `useEffect` dependency array. `getBoundingClientRect()` returns the current *visual* position including all CSS transforms, so re-running on every frame gives accurate in-motion tracking across all animation axes.

### Performance Guard

Re-measuring on every frame after animation completes is wasteful. Compute the last frame any word is still animating:

```
lastAnimFrame = (wordCount - 1) × animation.stagger × fps + animation.duration × fps
```

Skip the DOM walk when `frame > lastAnimFrame`. Only re-measure during the active animation window; words stay at settled positions thereafter.

### Canvas Export

Canvas positions are computed via `ctx.measureText()` (layout geometry, transform-agnostic). Position tracking of mid-transform words is not applicable to canvas. No changes needed for canvas position tracking.

---

## 2. In-Flight Effect Detection

### `wordAnimProgress` Computation

A new `wordAnimProgress` value (0→1) is computed for the currently active word each render:

```
wordStartFrame = activeWordIndex × animation.stagger × fps
wordEndFrame   = wordStartFrame + animation.duration × fps
wordAnimProgress = clamp((frame - wordStartFrame) / (wordEndFrame - wordStartFrame), 0, 1)
```

- `0` = word just started animating (fully in-flight)
- `1` = word fully settled at rest position

**Guard:** If `animation.effects.length === 0` or `animation.scope !== 'word'`, `wordAnimProgress` is always treated as `1` (settled) — no in-flight effects applied.

### Easing

All three effects interpolate using `easeOutCubic(wordAnimProgress)` — effects are strongest at word start and smoothly decay as the word lands.

### Canvas Export

Pass `animation.stagger`, `animation.duration`, `frame`, and `fps` into `drawWordHighlightBox()`. The same `wordAnimProgress` formula runs in canvas, so in-flight color/glow/scale effects render correctly on exported frames. Position tracking remains layout-based.

---

## 3. Three In-Flight Effects

All effects lerp from their **in-flight value** to their **settled value** using `easeOutCubic(wordAnimProgress)`.

### 3a. Color Burst

Box fill shifts from a vivid launch color to the normal highlight color as the word settles.

**New fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `wordHighlightFlightColorEnabled` | `boolean` | — | Toggle |
| `wordHighlightFlightColor` | `string` | `'#FFFFFF'` | In-flight box color |
| `wordHighlightFlightColorOpacity` | `number` | `1.0` | In-flight box opacity |

**Lerp:** Color and opacity each lerp independently from flight → settled values.

### 3b. Glow Surge

A strong glow radiates outward while the word is in-flight and fades once it settles. Independent of the static glow controls (`wordHighlightGlowColor` / `wordHighlightGlowBlur`).

**New fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `wordHighlightFlightGlowEnabled` | `boolean` | — | Toggle |
| `wordHighlightFlightGlowColor` | `string` | matches `wordHighlightColor` | In-flight glow color |
| `wordHighlightFlightGlowBlur` | `number` | `20` | In-flight glow blur px |

**Lerp:** Glow blur lerps from `flightGlowBlur` → static `wordHighlightGlowBlur` (or 0 if none).

### 3c. Scale Boost

The box expands to a larger size while the word is mid-air, then contracts to its settled scale. Gives a "catching the word" feel.

**New fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `wordHighlightFlightScaleEnabled` | `boolean` | — | Toggle |
| `wordHighlightFlightScale` | `number` | `1.25` | Scale multiplier at peak in-flight |

**Lerp:** Scale lerps from `flightScale` → `wordHighlightScale` (settled scale, default `1.0`).

---

## 4. New Type Fields Summary

9 new optional fields added to **both** `SubtitleStyle` and `TitleStyle` in `types.ts`:

```ts
// Color Burst
wordHighlightFlightColorEnabled?: boolean;
wordHighlightFlightColor?: string;
wordHighlightFlightColorOpacity?: number;

// Glow Surge
wordHighlightFlightGlowEnabled?: boolean;
wordHighlightFlightGlowColor?: string;
wordHighlightFlightGlowBlur?: number;

// Scale Boost
wordHighlightFlightScaleEnabled?: boolean;
wordHighlightFlightScale?: number;
```

---

## 5. Properties Panel UI

A new **"In-Flight Effects"** group inside the Word Highlight accordion, visible only when `wordHighlightEnabled` is true.

Three sub-sections, each with a checkbox toggle and controls that appear only when enabled:

**Color Burst**
- Enable checkbox
- Color picker (flight color)
- Opacity slider 0–1

**Glow Surge**
- Enable checkbox
- Color picker (glow color)
- Blur slider 0–40px

**Scale Boost**
- Enable checkbox
- Scale slider 1.0–2.0

---

## 6. Files Changed

| File | Change |
|---|---|
| `types.ts` | +9 fields × 2 interfaces = 18 field additions |
| `components/remotion/AnimatedText.tsx` | Tracking fix (`frame` in deps + perf guard) + `wordAnimProgress` + 3 effect lerps |
| `utils/canvasSubtitleRenderer.ts` | Pass `animation.stagger/duration/frame/fps` to `drawWordHighlightBox()`; apply in-flight effects |
| `components/PropertiesPanel.tsx` | "In-Flight Effects" group with 3 sub-sections |

---

## 7. Out of Scope

- Position tracking for canvas export (layout-based measureText can't reflect mid-transform positions)
- Per-character or per-line scope in-flight effects (word scope only)
- Easing customisation for in-flight lerp (always `easeOutCubic` for simplicity)
