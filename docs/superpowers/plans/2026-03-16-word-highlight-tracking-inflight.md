# Word Highlight: Animation Tracking & In-Flight Effects Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the karaoke highlight box follow animated word positions in real time, and add three independently toggleable in-flight visual effects (Color Burst, Glow Surge, Scale Boost) that activate while a word is mid-animation.

**Architecture:** `frame` is added to the DOM measurement `useEffect` deps so `getBoundingClientRect()` re-runs on every animation frame, tracking words as they fly in. A `wordAnimProgress` memo (0→1) is derived from the stagger/duration math; three new style fields each lerp between their in-flight and settled values using `easeOutCubic(wordAnimProgress)`. The same math runs in the canvas renderer for export fidelity.

**Tech Stack:** React 19 + TypeScript, Remotion (frame/fps math), CSS transitions, `getBoundingClientRect`, `canvas` 2D rendering.

**Spec:** `docs/superpowers/specs/2026-03-16-word-highlight-tracking-inflight-design.md`

---

## File Map

| File | Role |
|---|---|
| `types.ts` | +8 flight fields × 2 interfaces |
| `utils/wordHighlightUtils.ts` | +`lerpColor()` utility |
| `components/remotion/AnimatedText.tsx` | Tracking fix + `wordAnimProgress` + 3 effects |
| `utils/canvasSubtitleRenderer.ts` | 4 new params through `drawWordHighlightBox` + `drawPlainText` |
| `components/PropertiesPanel.tsx` | "In-Flight Effects" UI group |

---

## Chunk 1: Foundation — Types + lerpColor Utility

### Task 1: Add 8 flight fields to SubtitleStyle

**Files:**
- Modify: `types.ts:267` (after `wordHighlightOffsetY`)

- [ ] **Step 1: Add fields**

Open `types.ts`. After `wordHighlightOffsetY?: number;` (line 269) and before the closing `}` of `SubtitleStyle`, insert:

```typescript
  // In-flight effects (applied while active word is still animating in)
  wordHighlightFlightColorEnabled?: boolean;
  wordHighlightFlightColor?: string;          // in-flight box color, default '#FFFFFF'
  wordHighlightFlightColorOpacity?: number;   // in-flight box opacity, default 1.0
  wordHighlightFlightGlowEnabled?: boolean;
  wordHighlightFlightGlowColor?: string;      // runtime fallback: wordHighlightColor
  wordHighlightFlightGlowBlur?: number;       // in-flight glow blur px, default 20
  wordHighlightFlightScaleEnabled?: boolean;
  wordHighlightFlightScale?: number;          // multiplier on top of wordHighlightScale, default 1.25
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "C:/Users/Nathan/Documents/code/Vibe-video-editing-"
npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors.

---

### Task 2: Add 8 flight fields to TitleStyle

**Files:**
- Modify: `types.ts:346` (after `wordHighlightOffsetY` in TitleStyle)

- [ ] **Step 1: Add fields**

In `types.ts`, find the `TitleStyle` interface. After `wordHighlightOffsetY?: number;` (line 346) and before the closing `}` of `TitleStyle`, insert the same 8 fields:

```typescript
  // In-flight effects
  wordHighlightFlightColorEnabled?: boolean;
  wordHighlightFlightColor?: string;
  wordHighlightFlightColorOpacity?: number;
  wordHighlightFlightGlowEnabled?: boolean;
  wordHighlightFlightGlowColor?: string;
  wordHighlightFlightGlowBlur?: number;
  wordHighlightFlightScaleEnabled?: boolean;
  wordHighlightFlightScale?: number;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "types.ts" || echo "types.ts clean"
```

Expected: `types.ts clean`.

---

### Task 3: Add `lerpColor` to wordHighlightUtils.ts

**Files:**
- Modify: `utils/wordHighlightUtils.ts` (append after `easeOutCubic`)

- [ ] **Step 1: Add utility**

In `utils/wordHighlightUtils.ts`, after the `easeOutCubic` function (end of file), append:

```typescript

/** Lerp between two hex colors by decomposing into R/G/B channels */
export function lerpColor(hexA: string, hexB: string, t: number): string {
  function hexToRgb(hex: string): [number, number, number] {
    const clean = (hex.startsWith('#') ? hex.slice(1) : hex).replace(/[^0-9a-fA-F]/g, '');
    if (clean.length === 3) {
      return [
        parseInt(clean[0] + clean[0], 16),
        parseInt(clean[1] + clean[1], 16),
        parseInt(clean[2] + clean[2], 16),
      ];
    }
    return [
      parseInt(clean.slice(0, 2), 16) || 0,
      parseInt(clean.slice(2, 4), 16) || 0,
      parseInt(clean.slice(4, 6), 16) || 0,
    ];
  }
  const [rA, gA, bA] = hexToRgb(hexA);
  const [rB, gB, bB] = hexToRgb(hexB);
  return `rgb(${Math.round(lerp(rA, rB, t))}, ${Math.round(lerp(gA, gB, t))}, ${Math.round(lerp(bA, bB, t))})`;
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit 2>&1 | grep "wordHighlightUtils" || echo "wordHighlightUtils clean"
```

Expected: `wordHighlightUtils clean`.

- [ ] **Step 3: Commit Chunk 1**

```bash
git add types.ts utils/wordHighlightUtils.ts
git commit -m "feat: add in-flight highlight types and lerpColor utility

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Chunk 2: AnimatedText.tsx — Tracking + In-Flight Effects

### Task 4: Tracking fix — `frame` in useEffect + perf guard

**Files:**
- Modify: `components/remotion/AnimatedText.tsx:159-182`

The `AnimatedText` component receives `frame`, `fps`, `animation`, and optionally `keywordAnimation` as props. All are already available in scope.

- [ ] **Step 1: Update import to include lerp, easeOutCubic, lerpColor**

Find the current import at line 4:
```typescript
import { getActiveWordInfo, type WordTiming } from '../../utils/wordHighlightUtils';
```

Replace with:
```typescript
import { getActiveWordInfo, lerp, easeOutCubic, lerpColor, type WordTiming } from '../../utils/wordHighlightUtils';
```

- [ ] **Step 2: Replace the measurement useEffect (lines 159-182)**

Replace the entire `useEffect` block from `// Measure word span positions` through `}, [wordHighlightEnabled, text, animation.scope]);` with:

```typescript
  // Measure word span positions — re-runs every frame during animation for accurate tracking
  // getBoundingClientRect returns the live visual position including all CSS transforms
  useEffect(() => {
    if (!wordHighlightEnabled) return;
    const container = containerRef.current;
    if (!container) return;

    // Perf guard: skip re-measuring once all words have settled at final positions
    const animatableCount = text.split(/(\s+)/).filter(t => t.trim().length > 0).length;
    const lastAnimFrame = (animatableCount - 1) * animation.stagger * fps + animation.duration * fps;
    // Always re-measure when keywordAnimation present (its timing may extend beyond base animation)
    if (!keywordAnimation && frame > lastAnimFrame) return;

    const spans = container.querySelectorAll<HTMLSpanElement>('[data-word-idx]');
    if (spans.length === 0) return;
    const containerRect = container.getBoundingClientRect();
    const newRects = new Map<number, WordRect>();
    spans.forEach(span => {
      const idx = parseInt(span.dataset.wordIdx!, 10);
      if (!isNaN(idx)) {
        const spanRect = span.getBoundingClientRect();
        newRects.set(idx, {
          left: spanRect.left - containerRect.left,
          top: spanRect.top - containerRect.top,
          width: spanRect.width,
          height: spanRect.height,
        });
      }
    });
    setWordRects(newRects);
  }, [wordHighlightEnabled, text, animation.scope, animation.stagger, animation.duration,
      frame, fps, keywordAnimation]);
```

- [ ] **Step 3: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "AnimatedText" || echo "AnimatedText clean"
```

Expected: `AnimatedText clean`.

---

### Task 5: Add `wordAnimProgress` memo

**Files:**
- Modify: `components/remotion/AnimatedText.tsx` (insert after `const activeWordIndex` line)

- [ ] **Step 1: Insert memo after `const activeWordIndex = activeWordInfo?.activeIndex ?? -1;` (line 195)**

`useMemo` is already imported at line 1 of `AnimatedText.tsx` — no import change needed for this step.

```typescript
  // In-flight progress for the active word: 0 = just started animating, 1 = fully settled.
  // Guards: only meaningful when scope is 'word' and animation has effects.
  const wordAnimProgress = useMemo(() => {
    if (
      !wordHighlightEnabled ||
      activeWordIndex < 0 ||
      animation.effects.length === 0 ||
      animation.scope !== 'word'
    ) return 1;
    const wordStartFrame = activeWordIndex * animation.stagger * fps;
    const wordEndFrame = wordStartFrame + animation.duration * fps;
    if (wordEndFrame <= wordStartFrame) return 1;
    return Math.max(0, Math.min(1, (frame - wordStartFrame) / (wordEndFrame - wordStartFrame)));
  }, [wordHighlightEnabled, activeWordIndex, animation.effects.length, animation.scope,
      animation.stagger, animation.duration, frame, fps]);
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "AnimatedText" || echo "AnimatedText clean"
```

---

### Task 6: Apply in-flight effects inside `highlightBoxStyle` + update transition

**Files:**
- Modify: `components/remotion/AnimatedText.tsx:198-259`

The full replacement of the `highlightBoxStyle` useMemo. Replace from `// Build highlight box position + style` through `}, [wordHighlightEnabled, wordHighlightStyle, activeWordIndex, wordRects, eventStartTime]);` with:

- [ ] **Step 1: Replace highlightBoxStyle useMemo**

```typescript
  // Build highlight box position + style — applies settled values and lerps in-flight effects
  const highlightBoxStyle = useMemo((): React.CSSProperties | null => {
    if (!wordHighlightEnabled || !wordHighlightStyle || activeWordIndex < 0) return null;
    const rect = wordRects.get(activeWordIndex);
    if (!rect || rect.width === 0) return null;

    // Detect chunk boundary — snap instantly so the box doesn't slide back to word 0
    const isNewChunk = prevEventStartRef.current !== eventStartTime;
    prevEventStartRef.current = eventStartTime;

    // Settled values
    const hlColor = wordHighlightStyle.wordHighlightColor ?? '#FFD700';
    const hlOpacity = wordHighlightStyle.wordHighlightOpacity ?? 0.85;
    const paddingH = wordHighlightStyle.wordHighlightPaddingH ?? 4;
    const paddingV = wordHighlightStyle.wordHighlightPaddingV ?? 2;
    const hlRadius = wordHighlightStyle.wordHighlightBorderRadius ?? 4;
    const hlBlendMode = wordHighlightStyle.wordHighlightBlendMode ?? 'normal';
    const transitionMs = wordHighlightStyle.wordHighlightTransitionMs ?? 150;
    const hlScale = wordHighlightStyle.wordHighlightScale ?? 1.0;
    const shadowColor = wordHighlightStyle.wordHighlightShadowColor;
    const shadowBlur = wordHighlightStyle.wordHighlightShadowBlur ?? 0;
    const shadowX = wordHighlightStyle.wordHighlightShadowOffsetX ?? 0;
    const shadowY = wordHighlightStyle.wordHighlightShadowOffsetY ?? 0;
    const glowColor = wordHighlightStyle.wordHighlightGlowColor ?? null;
    const glowBlur = wordHighlightStyle.wordHighlightGlowBlur ?? 0;
    const offsetX = wordHighlightStyle.wordHighlightOffsetX ?? 0;
    const offsetY = wordHighlightStyle.wordHighlightOffsetY ?? 0;

    // In-flight effect fields
    const flightColorEnabled = !!wordHighlightStyle.wordHighlightFlightColorEnabled;
    const flightColor = wordHighlightStyle.wordHighlightFlightColor ?? '#FFFFFF';
    const flightColorOpacity = wordHighlightStyle.wordHighlightFlightColorOpacity ?? 1.0;
    const flightGlowEnabled = !!wordHighlightStyle.wordHighlightFlightGlowEnabled;
    const flightGlowColor = wordHighlightStyle.wordHighlightFlightGlowColor ?? hlColor;
    const flightGlowBlur = wordHighlightStyle.wordHighlightFlightGlowBlur ?? 20;
    const flightScaleEnabled = !!wordHighlightStyle.wordHighlightFlightScaleEnabled;
    const flightScale = wordHighlightStyle.wordHighlightFlightScale ?? 1.25;

    // Lerp factors
    const isInFlight = wordAnimProgress < 1;
    const easedP = easeOutCubic(wordAnimProgress);

    // Color Burst: lerp box color and opacity from flight → settled
    const currentColor = (flightColorEnabled && isInFlight)
      ? lerpColor(flightColor, hlColor, easedP)
      : hlColor;
    const currentOpacity = (flightColorEnabled && isInFlight)
      ? lerp(flightColorOpacity, hlOpacity, easedP)
      : hlOpacity;

    // Glow Surge: lerp glow blur from flightGlowBlur → static glowBlur (replaces static glow during flight)
    const currentGlowBlur = (flightGlowEnabled && isInFlight)
      ? lerp(flightGlowBlur, glowBlur, easedP)
      : glowBlur;
    const currentGlowColor = (flightGlowEnabled && isInFlight) ? flightGlowColor : glowColor;

    // Scale Boost: flightScale is a multiplier on top of settled hlScale
    const currentScale = (flightScaleEnabled && isInFlight)
      ? lerp(hlScale * flightScale, hlScale, easedP)
      : hlScale;

    const baseW = rect.width + 2 * paddingH;
    const baseH = rect.height + 2 * paddingV;
    const scaledW = baseW * currentScale;
    const scaledH = baseH * currentScale;
    const left = rect.left - paddingH - (scaledW - baseW) / 2 + offsetX;
    const top = rect.top - paddingV - (scaledH - baseH) / 2 + offsetY;

    const shadows: string[] = [];
    if (shadowColor && (shadowBlur > 0 || shadowX !== 0 || shadowY !== 0)) {
      shadows.push(`${shadowX}px ${shadowY}px ${shadowBlur}px ${shadowColor}`);
    }
    if (currentGlowColor && currentGlowBlur > 0) {
      shadows.push(`0 0 ${currentGlowBlur}px ${currentGlowColor}`);
      shadows.push(`0 0 ${currentGlowBlur * 1.5}px ${currentGlowColor}`);
    }

    // CSS transition: exclude width/height while in-flight (Scale Boost drives those via frame math)
    const slidePart = `left ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1), `
      + `top ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;
    const sizePart = `, width ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1), `
      + `height ${transitionMs}ms cubic-bezier(0.25, 0.1, 0.25, 1)`;

    return {
      position: 'absolute',
      left,
      top,
      width: scaledW,
      height: scaledH,
      backgroundColor: currentColor.startsWith('rgb(')
        ? currentColor.replace('rgb(', 'rgba(').replace(')', `, ${currentOpacity})`)
        : hexToRgba(currentColor, currentOpacity),
      borderRadius: hlRadius,
      mixBlendMode: hlBlendMode as React.CSSProperties['mixBlendMode'],
      boxShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
      transition: isNewChunk ? 'none' : (isInFlight ? slidePart : slidePart + sizePart),
      pointerEvents: 'none',
      zIndex: 0,
    };
  }, [wordHighlightEnabled, wordHighlightStyle, activeWordIndex, wordRects, eventStartTime,
      wordAnimProgress]);
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "AnimatedText" || echo "AnimatedText clean"
```

Expected: `AnimatedText clean`.

- [ ] **Step 3: Commit Chunk 2**

```bash
git add components/remotion/AnimatedText.tsx
git commit -m "feat: word highlight tracks animated positions + in-flight effects

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Chunk 3: Canvas Renderer — In-Flight Effects

### Task 7: Update `drawWordHighlightBox` signature and body

**Files:**
- Modify: `utils/canvasSubtitleRenderer.ts:539-656`

- [ ] **Step 1: Update import at top of file**

Find the existing import:
```typescript
import { getActiveWordInfo, lerp, type WordTiming } from './wordHighlightUtils';
```

Replace with:
```typescript
import { getActiveWordInfo, lerp, easeOutCubic, lerpColor, type WordTiming } from './wordHighlightUtils';
```

- [ ] **Step 2: Update `drawWordHighlightBox` signature (line 539)**

Replace:
```typescript
function drawWordHighlightBox(
    ctx: CanvasRenderingContext2D,
    text: string,
    style: SubtitleStyle,
    scaleFactor: number,
    fontSize: number,
    lineHeight: number,
    textPaddingH: number,
    outputWidth: number,
    wordTimings: WordTiming[] | undefined,
    eventStartTime: number,
    eventEndTime: number,
    sourceTime: number,
): void {
```

With:
```typescript
function drawWordHighlightBox(
    ctx: CanvasRenderingContext2D,
    text: string,
    style: SubtitleStyle,
    scaleFactor: number,
    fontSize: number,
    lineHeight: number,
    textPaddingH: number,
    outputWidth: number,
    wordTimings: WordTiming[] | undefined,
    eventStartTime: number,
    eventEndTime: number,
    sourceTime: number,
    frame: number,
    fps: number,
    animStagger: number,
    animDuration: number,
): void {
```

- [ ] **Step 3: Add in-flight computation inside `drawWordHighlightBox` body**

Immediately after the existing style-field extractions (after `const glowBlur = ...` and `const hlOffsetY = ...` lines), insert:

```typescript
    // In-flight fields
    const flightColorEnabled = !!style.wordHighlightFlightColorEnabled;
    const flightColor = style.wordHighlightFlightColor ?? '#FFFFFF';
    const flightColorOpacity = style.wordHighlightFlightColorOpacity ?? 1.0;
    const flightGlowEnabled = !!style.wordHighlightFlightGlowEnabled;
    const flightGlowColor = style.wordHighlightFlightGlowColor ?? hlColor;
    const flightGlowBlurFlight = (style.wordHighlightFlightGlowBlur ?? 20) * scaleFactor;
    const flightScaleEnabled = !!style.wordHighlightFlightScaleEnabled;
    const flightScale = style.wordHighlightFlightScale ?? 1.25;

    // Compute in-flight progress for the active word
    const wordStartFrame = activeIdx * animStagger * fps;
    const wordEndFrame = wordStartFrame + animDuration * fps;
    const rawProgress = (wordEndFrame > wordStartFrame)
        ? Math.max(0, Math.min(1, (frame - wordStartFrame) / (wordEndFrame - wordStartFrame)))
        : 1;
    const isInFlight = rawProgress < 1;
    const easedP = easeOutCubic(rawProgress);

    // Derive current values
    const currentHlColor = (flightColorEnabled && isInFlight) ? lerpColor(flightColor, hlColor, easedP) : hlColor;
    const currentHlOpacity = (flightColorEnabled && isInFlight) ? lerp(flightColorOpacity, hlOpacity, easedP) : hlOpacity;
    const currentGlowBlur = (flightGlowEnabled && isInFlight) ? lerp(flightGlowBlurFlight, glowBlur, easedP) : glowBlur;
    const currentGlowColor = (flightGlowEnabled && isInFlight) ? flightGlowColor : (style.wordHighlightGlowColor ?? null);
    const currentScale = (flightScaleEnabled && isInFlight) ? lerp(hlScale * flightScale, hlScale, easedP) : hlScale;
```

**Note:** `activeIdx` is already computed earlier in the function from `getActiveWordInfo()`. Also: `glowBlur` here is the already-scaled value (from `const glowBlur = (style.wordHighlightGlowBlur ?? 0) * scaleFactor`).

- [ ] **Step 4: Replace `hlScale` and color/opacity/glow references in the body**

In the geometry calculation (`bx`, `by`, `scaledW`, `scaledH`), replace `hlScale` with `currentScale`.

In the `ctx.fillStyle` and glow-related ctx calls within `drawWordHighlightBox`, replace:
- `hlColor` → `currentHlColor`
- `hlOpacity` → `currentHlOpacity`
- `glowColor` → `currentGlowColor` (the shadow/glow color in glow rendering block)
- `glowBlur` → `currentGlowBlur` (the shadow blur in glow rendering block)

Parse `currentHlColor` to RGBA in the existing hex→RGBA block:
```typescript
    // Parse current color to RGBA
    let r = 0, g = 0, b = 0;
    if (currentHlColor.startsWith('rgb(')) {
        const m = currentHlColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (m) { r = parseInt(m[1]); g = parseInt(m[2]); b = parseInt(m[3]); }
    } else {
        const clean = (currentHlColor.startsWith('#') ? currentHlColor.slice(1) : currentHlColor);
        r = parseInt(clean.slice(0, 2), 16) || 0;
        g = parseInt(clean.slice(2, 4), 16) || 0;
        b = parseInt(clean.slice(4, 6), 16) || 0;
    }
```

Replace the existing hex parse block (which starts with `const clean = (hlColor.startsWith('#')...`) entirely with the block above.

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "canvasSubtitleRenderer" || echo "canvasSubtitleRenderer clean"
```

---

### Task 8: Update call sites to pass new params

**Files:**
- Modify: `utils/canvasSubtitleRenderer.ts:889-894` (animated path call)
- Modify: `utils/canvasSubtitleRenderer.ts:1056-1070` (`drawPlainText` signature)
- Modify: `utils/canvasSubtitleRenderer.ts:720-724` (`drawPlainText` caller)
- Modify: `utils/canvasSubtitleRenderer.ts:1204-1210` (`drawWordHighlightBox` call inside `drawPlainText`)

- [ ] **Step 1: Update animated path call (line ~889)**

Replace:
```typescript
        drawWordHighlightBox(
            ctx, text, style, scaleFactor, fontSize, lineHeight,
            textPaddingH, outputWidth,
            wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, sourceTime,
        );
```

With:
```typescript
        drawWordHighlightBox(
            ctx, text, style, scaleFactor, fontSize, lineHeight,
            textPaddingH, outputWidth,
            wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, sourceTime,
            frame, fps, effectiveAnimation.stagger, effectiveAnimation.duration,
        );
```

(`effectiveAnimation` is already defined in scope at this point — line ~729.)

- [ ] **Step 2: Update `drawPlainText` signature (line ~1056)**

Replace:
```typescript
function drawPlainText(
    ctx: CanvasRenderingContext2D,
    text: string,
    style: SubtitleStyle,
    fontSize: number,
    scaleFactor: number,
    textPaddingV: number,
    textPaddingH: number,
    outputWidth: number,
    wordEmphases?: KeywordEmphasis[],
    wordTimings?: WordTiming[],
    sourceTime?: number,
    eventStartTime?: number,
    eventEndTime?: number,
): void {
```

With:
```typescript
function drawPlainText(
    ctx: CanvasRenderingContext2D,
    text: string,
    style: SubtitleStyle,
    fontSize: number,
    scaleFactor: number,
    textPaddingV: number,
    textPaddingH: number,
    outputWidth: number,
    wordEmphases?: KeywordEmphasis[],
    wordTimings?: WordTiming[],
    sourceTime?: number,
    eventStartTime?: number,
    eventEndTime?: number,
    frame?: number,
    fps?: number,
    animStagger?: number,
    animDuration?: number,
): void {
```

- [ ] **Step 3: Update `drawWordHighlightBox` call inside `drawPlainText` (line ~1204)**

Replace:
```typescript
        drawWordHighlightBox(
            ctx, text, style, scaleFactor, fontSize, lineHeight,
            textPaddingH, outputWidth,
            wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, sourceTime,
        );
```

With:
```typescript
        drawWordHighlightBox(
            ctx, text, style, scaleFactor, fontSize, lineHeight,
            textPaddingH, outputWidth,
            wordTimings, eventStartTime ?? 0, eventEndTime ?? 0, sourceTime,
            frame ?? 0, fps ?? 30, animStagger ?? 0, animDuration ?? 0,
        );
```

- [ ] **Step 4: Update `drawPlainText` caller (line ~720)**

Replace:
```typescript
        drawPlainText(ctx, text, style, fontSize, scaleFactor, textPaddingV, textPaddingH, outputWidth, wordEmphases,
            wordTimings, sourceTime, eventStartTime, eventEndTime);
```

With:
```typescript
        drawPlainText(ctx, text, style, fontSize, scaleFactor, textPaddingV, textPaddingH, outputWidth, wordEmphases,
            wordTimings, sourceTime, eventStartTime, eventEndTime,
            frame, fps, animation?.stagger ?? 0, animation?.duration ?? 0);
```

(`frame`, `fps`, `animation` are all in scope in `drawSubtitleOnCanvas`.)

- [ ] **Step 5: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "canvasSubtitleRenderer" || echo "canvasSubtitleRenderer clean"
```

Expected: `canvasSubtitleRenderer clean`.

- [ ] **Step 6: Commit Chunk 3**

```bash
git add utils/canvasSubtitleRenderer.ts
git commit -m "feat: word highlight in-flight effects in canvas export

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Chunk 4: Properties Panel UI

### Task 9: Add "In-Flight Effects" group

**Files:**
- Modify: `components/PropertiesPanel.tsx` (inside Word Highlight accordion, after Shadow & Glow group)

The Word Highlight accordion contains conditionally rendered groups inside `{subtitleStyle.wordHighlightEnabled && (<div>...</div>)}`. The "Shadow & Glow" group is the second-to-last group. Add the new "In-Flight Effects" group between "Shadow & Glow" and "Position Offset".

- [ ] **Step 1: Find insertion point**

In `PropertiesPanel.tsx`, find the Position Offset group that currently starts with:
```typescript
                    <Group title="Position Offset">
```

Insert the following block immediately before it:

```typescript
                    <Group title="In-Flight Effects">
                      <p className="text-xs text-gray-400 mb-2">Effects while a word is animating in. Each fades out as the word settles.</p>
                      <div className="space-y-3">
                        {/* Color Burst */}
                        <div>
                          <label className="flex items-center gap-2 text-xs text-gray-300 mb-2 cursor-pointer">
                            <input type="checkbox" checked={!!subtitleStyle.wordHighlightFlightColorEnabled} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightFlightColorEnabled: e.target.checked })} className="accent-blue-500" />
                            Color Burst
                          </label>
                          {subtitleStyle.wordHighlightFlightColorEnabled && (
                            <div className="pl-4 space-y-2">
                              <Field label="Flight Color" stack={true}>
                                <ColorPicker value={subtitleStyle.wordHighlightFlightColor || '#FFFFFF'} onChange={(v) => onUpdateSubtitleStyle({ wordHighlightFlightColor: v })} />
                              </Field>
                              <Field label="Flight Opacity" rightLabel={`${Math.round((subtitleStyle.wordHighlightFlightColorOpacity ?? 1) * 100)}%`} stack={true}>
                                <input type="range" min="0" max="1" step="0.05" value={subtitleStyle.wordHighlightFlightColorOpacity ?? 1} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightFlightColorOpacity: parseFloat(e.target.value) })} className={rangeClass} />
                              </Field>
                            </div>
                          )}
                        </div>
                        {/* Glow Surge */}
                        <div>
                          <label className="flex items-center gap-2 text-xs text-gray-300 mb-2 cursor-pointer">
                            <input type="checkbox" checked={!!subtitleStyle.wordHighlightFlightGlowEnabled} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightFlightGlowEnabled: e.target.checked })} className="accent-blue-500" />
                            Glow Surge
                          </label>
                          {subtitleStyle.wordHighlightFlightGlowEnabled && (
                            <div className="pl-4 space-y-2">
                              <Field label="Flight Glow Color" stack={true}>
                                <ColorPicker value={subtitleStyle.wordHighlightFlightGlowColor || subtitleStyle.wordHighlightColor || '#FFD700'} onChange={(v) => onUpdateSubtitleStyle({ wordHighlightFlightGlowColor: v })} />
                              </Field>
                              <Field label="Flight Glow Blur" rightLabel={`${subtitleStyle.wordHighlightFlightGlowBlur ?? 20}px`} stack={true}>
                                <input type="range" min="0" max="40" step="1" value={subtitleStyle.wordHighlightFlightGlowBlur ?? 20} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightFlightGlowBlur: parseInt(e.target.value) })} className={rangeClass} />
                              </Field>
                            </div>
                          )}
                        </div>
                        {/* Scale Boost */}
                        <div>
                          <label className="flex items-center gap-2 text-xs text-gray-300 mb-2 cursor-pointer">
                            <input type="checkbox" checked={!!subtitleStyle.wordHighlightFlightScaleEnabled} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightFlightScaleEnabled: e.target.checked })} className="accent-blue-500" />
                            Scale Boost
                          </label>
                          {subtitleStyle.wordHighlightFlightScaleEnabled && (
                            <div className="pl-4 space-y-2">
                              <Field label="Flight Scale" rightLabel={`${subtitleStyle.wordHighlightFlightScale ?? 1.25}×`} stack={true}>
                                <input type="range" min="1" max="2" step="0.05" value={subtitleStyle.wordHighlightFlightScale ?? 1.25} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightFlightScale: parseFloat(e.target.value) })} className={rangeClass} />
                              </Field>
                            </div>
                          )}
                        </div>
                      </div>
                    </Group>
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep "PropertiesPanel" || echo "PropertiesPanel clean"
```

Expected: `PropertiesPanel clean`.

- [ ] **Step 3: Full TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: exit code 0, no new errors (only pre-existing ones from GraphEditor.tsx and geminiService.ts per MEMORY.md).

- [ ] **Step 4: Commit Chunk 4**

```bash
git add components/PropertiesPanel.tsx
git commit -m "feat: add In-Flight Effects UI to Word Highlight panel

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Manual Verification

- [ ] Start dev server: `npm run dev` in `Vibe-video-editing-/`
- [ ] Load a project with a subtitle template that has per-word fly-in animation (e.g. translateY from bottom)
- [ ] Enable Word Highlight in Properties panel
- [ ] Play — verify the box tracks words as they fly in (no longer snaps to final positions)
- [ ] Enable Color Burst — verify box flashes white as each word enters, fades to yellow as it settles
- [ ] Enable Glow Surge — verify glow radiates as word enters, fades once settled
- [ ] Enable Scale Boost — verify box overshoots in size then contracts as word lands
- [ ] Try all three together — verify they combine correctly
- [ ] Test with no animation template — verify no in-flight effects fire (progress stays at 1)
- [ ] Push to remote: `git push`
