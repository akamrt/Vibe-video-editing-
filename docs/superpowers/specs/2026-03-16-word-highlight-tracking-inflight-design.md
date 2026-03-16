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
animatableWordCount = number of non-whitespace tokens in text.split(/(\s+)/)
                      (matches the animatableIndices array in AnimatedText.tsx — whitespace tokens
                      have staggerIndex === -1 and are excluded)
lastAnimFrame = (animatableWordCount - 1) × animation.stagger × fps + animation.duration × fps
```

Skip the DOM walk when `frame > lastAnimFrame`. Only re-measure during the active animation window.

**Note:** `keywordAnimation` may have its own stagger/duration. If both `animation` and `keywordAnimation` are active, use `max(lastAnimFrame_animation, lastAnimFrame_keyword)`. Implementing `keywordAnimation` guard is out of scope for this spec; default to always re-measuring when `keywordAnimation` is present.

### Canvas Export

Canvas positions are computed via `ctx.measureText()` (layout geometry, transform-agnostic). Position tracking of mid-transform words is not applicable to canvas. No changes needed for canvas position tracking.

---

## 2. In-Flight Effect Detection

### `wordAnimProgress` Computation

A new `wordAnimProgress` value (0→1) is computed for the currently active word each render. The `activeWordIndex` here is the same index returned by `getActiveWordInfo()` — the currently-spoken karaoke word — which is also the word whose animation stagger delay governs its fly-in timing.

```
wordStartFrame = activeWordIndex × animation.stagger × fps
wordEndFrame   = wordStartFrame + animation.duration × fps
wordAnimProgress = clamp((frame - wordStartFrame) / (wordEndFrame - wordStartFrame), 0, 1)
```

- `0` = word just started animating (fully in-flight)
- `1` = word fully settled at rest position

**Guard:** If `animation.effects.length === 0` or `animation.scope !== 'word'`, `wordAnimProgress` is always treated as `1` (settled) — no in-flight effects applied.

### Easing

All three effects interpolate using `easeOutCubic(wordAnimProgress)` — effects are strongest at word start and smoothly decay as the word lands. `easeOutCubic` already exists in `wordHighlightUtils.ts`.

### CSS Transition Interaction

The current `highlightBoxStyle` applies a CSS `transition` on `left`, `top`, `width`, and `height`. When Scale Boost is active, `width` and `height` change every frame via `wordAnimProgress` lerp — the CSS transition would fight the frame-driven math. **When any in-flight effect is active (`wordAnimProgress < 1`), remove `width` and `height` from the transition string** (keep `left` and `top` for karaoke sliding). Once `wordAnimProgress === 1`, restore the full transition.

### Canvas Export

Pass `animation.stagger`, `animation.duration`, `frame`, and `fps` into **both** `drawWordHighlightBox()` call sites in `canvasSubtitleRenderer.ts`:
- Line ~889: the main animated path
- Line ~1205: inside `drawPlainText()` (the fast path when `animation.effects.length === 0`)

`drawPlainText()` will also need its function signature updated to accept `frame`, `fps`, `animStagger`, `animDuration` (currently it does not receive these). The same `wordAnimProgress` formula runs in canvas using the `activeIdx` from `getActiveWordInfo()`.

---

## 3. New Utility: `lerpColor`

Add to `utils/wordHighlightUtils.ts`:

```ts
/** Lerp between two hex colors by decomposing into R/G/B channels */
export function lerpColor(hexA: string, hexB: string, t: number): string
```

Used by both `AnimatedText.tsx` and `canvasSubtitleRenderer.ts` for Color Burst. Having it in the shared utils file ensures both paths use identical math.

---

## 4. Three In-Flight Effects

All effects lerp from their **in-flight value** to their **settled value** using `easeOutCubic(wordAnimProgress)`.

### 4a. Color Burst

Box fill shifts from a vivid launch color to the normal highlight color as the word settles.

**New fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `wordHighlightFlightColorEnabled` | `boolean` | — | Toggle |
| `wordHighlightFlightColor` | `string` | `'#FFFFFF'` | In-flight box color |
| `wordHighlightFlightColorOpacity` | `number` | `1.0` | In-flight box opacity |

**Lerp:** Use `lerpColor(flightColor, normalColor, easeOutCubic(progress))` for color; lerp opacity separately.

### 4b. Glow Surge

A strong glow radiates outward while the word is in-flight and fades once it settles. This **replaces** (not adds to) the static glow during animation: the glow blur lerps from `flightGlowBlur` → `wordHighlightGlowBlur ?? 0`. When fully settled, the static glow takes over as normal. At `progress = 1` the two are equal.

**New fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `wordHighlightFlightGlowEnabled` | `boolean` | — | Toggle |
| `wordHighlightFlightGlowColor` | `string` | runtime fallback: `wordHighlightColor` | In-flight glow color |
| `wordHighlightFlightGlowBlur` | `number` | `20` | In-flight glow blur px |

**Note:** `wordHighlightFlightGlowColor` TypeScript default is `undefined`. The runtime fallback to `wordHighlightColor` is applied in rendering code, not in the type declaration.

**Lerp:** `currentGlowBlur = lerp(flightGlowBlur, wordHighlightGlowBlur ?? 0, easeOutCubic(progress))`

### 4c. Scale Boost

The box expands beyond its settled size while the word is mid-air, then contracts back. `wordHighlightFlightScale` is a **multiplier applied on top of `wordHighlightScale`** (the settled scale). This ensures the flight scale always feels larger than the settled scale regardless of the user's settled scale setting.

```
currentScale = lerp(wordHighlightScale * flightScale, wordHighlightScale, easeOutCubic(progress))
```

**New fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `wordHighlightFlightScaleEnabled` | `boolean` | — | Toggle |
| `wordHighlightFlightScale` | `number` | `1.25` | Scale multiplier at peak in-flight (applied on top of settled scale) |

---

## 5. New Type Fields Summary

8 new optional fields added to **both** `SubtitleStyle` and `TitleStyle` in `types.ts`:

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

## 6. Properties Panel UI

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
- Scale slider 1.0–2.0 (this is the multiplier on top of settled scale)

---

## 7. Files Changed

| File | Change |
|---|---|
| `types.ts` | +8 fields × 2 interfaces = 16 field additions |
| `utils/wordHighlightUtils.ts` | Add `lerpColor(hexA, hexB, t)` utility |
| `components/remotion/AnimatedText.tsx` | Tracking fix (`frame` in deps + perf guard) + `wordAnimProgress` + 3 effect lerps + CSS transition guard |
| `utils/canvasSubtitleRenderer.ts` | Update `drawWordHighlightBox()` signature (add `frame`, `fps`, `animStagger`, `animDuration`); update `drawPlainText()` signature to pass same; apply in-flight effects |
| `components/PropertiesPanel.tsx` | "In-Flight Effects" group with 3 sub-sections |

---

## 8. Out of Scope

- Position tracking for canvas export (layout-based measureText can't reflect mid-transform positions)
- Per-character or per-line scope in-flight effects (word scope only)
- Easing customisation for in-flight lerp (always `easeOutCubic` for simplicity)
- `keywordAnimation` guard in perf formula (always re-measure when `keywordAnimation` is present)
