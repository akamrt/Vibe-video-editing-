# Export Rendering Fixes & Auto-Wrap Feature

**Date**: 2026-03-17
**Status**: Approved (rev 2 — addresses spec review feedback)
**Scope**: Canvas export pipeline, subtitle/title rendering, auto-wrap utility

## Summary

Five fixes addressing export rendering issues and one new feature:

1. **Export newline rendering** — dialogue text ignores `\n` in canvas export
2. **Title rendering in export** — titles don't render at all
3. **Jittery cuts** — frame timing issues at segment boundaries
4. **Export sizing mismatch** — exported video slightly larger than viewport
5. **Auto-wrap for portrait** — auto-insert line breaks for 9:16 aspect ratio

---

## Fix 1: Export Newline Rendering

### Problem

When the user inserts a newline (`\n`) into dialogue text, the viewport renders it correctly (CSS `white-space: pre` handles it). But in the canvas export, the text renders on a single line while the word highlight box correctly positions for multi-line text.

### Root Cause

In `utils/canvasSubtitleRenderer.ts`, the animated text path splits text with `text.split(/(\s+)/)` (word scope at line 362, element scope at line 298). This groups adjacent whitespace:

- `"word \nword"` → `["word", " \n", "word"]` — whitespace token is `" \n"`
- `"word\n word"` → `["word", "\n ", "word"]` — whitespace token is `"\n "`

The newline detection at line 876 uses strict equality:
```js
const hasNewlines = elements.some(el => el.text === '\n');
```

This fails when `\n` is adjacent to spaces, so `hasNewlines` is `false` and text renders on one line.

Meanwhile, the word highlight box uses `text.split('\n')` in `computeWordCanvasRects`, which correctly splits into lines regardless of adjacent spaces.

### Fix

**File**: `utils/canvasSubtitleRenderer.ts`

**Both word scope AND element scope paths** need this fix (the element scope path at lines 273-357 uses the same `text.split(/(\s+)/)` and has the same bug).

1. **Post-process whitespace tokens containing `\n`**: After `text.split(/(\s+)/)`, iterate the elements array. For any whitespace token that contains `\n`, split it into separate tokens: e.g., `" \n"` → `[" ", "\n"]`, `"\n "` → `["\n", " "]`, `" \n "` → `[" ", "\n", " "]`. This ensures `\n` is always its own element.

   Implementation: add a helper function:
   ```typescript
   function splitNewlinesFromWhitespace(elements: string[]): string[] {
     const result: string[] = [];
     for (const el of elements) {
       if (/^\s+$/.test(el) && el.includes('\n')) {
         // Split around each \n, preserving non-newline whitespace
         const parts = el.split('\n');
         for (let i = 0; i < parts.length; i++) {
           if (parts[i]) result.push(parts[i]); // spaces before/after
           if (i < parts.length - 1) result.push('\n'); // the newline itself
         }
       } else {
         result.push(el);
       }
     }
     return result;
   }
   ```

   Apply this after `text.split(/(\s+)/)` in both the word scope path (line 362) and element scope path (line 298).

2. **Update `hasNewlines` check** (line 876) to use `.includes('\n')` as a safety net:
   ```js
   const hasNewlines = elements.some(el => el.text.includes('\n'));
   ```

3. The element drawing loop already checks `el.text === '\n'` at line 1059, which will now work correctly since `\n` is isolated into its own token by step 1.

### Files Changed
- `utils/canvasSubtitleRenderer.ts`

---

## Fix 2: Title Rendering in Export

### Problem

The canvas export render loop (`App.tsx:1497-1696`) only renders subtitles via `drawSubtitleOnCanvas()`. Title layers (`project.titleLayer`) are completely missing from the export.

### Root Cause

No title rendering code exists in `handleExportVideo`. The viewport renders titles via `AnimatedTitle.tsx` (Remotion component), but the canvas export has no equivalent.

### Fix

**File**: `App.tsx` (export render loop), `utils/canvasSubtitleRenderer.ts`

#### Step 1: Add `topOffset` support to `drawSubtitleOnCanvas`

Add an optional `topOffset` field to `DrawSubtitleOptions`:
```typescript
interface DrawSubtitleOptions {
  // ... existing fields ...
  /** If provided, positions text from top instead of bottom */
  topOffset?: number;
  /** Global opacity multiplier (for fade-in/fade-out) */
  globalOpacity?: number;
}
```

In the `yBase` calculation, check for `topOffset`:
```js
let yBase: number;
if (opts.topOffset != null) {
  // Title positioning: from top, offset by text block height
  // Compute number of lines first, then position baseline
  const textLines = text.split('\n');
  const totalTextHeight = textLines.length * lineHeight;
  yBase = outputHeight * (opts.topOffset / 100) + totalTextHeight;
} else {
  yBase = outputHeight * (1 - bottomOffset / 100);
}
```

For `globalOpacity`, wrap the entire draw in `ctx.save(); ctx.globalAlpha *= opts.globalOpacity; ... ctx.restore();`.

#### Step 2: Add title rendering to export loop

After the subtitle drawing block (~line 1690), outside the `activeSegments.forEach` loop:

```typescript
// --- TITLE DRAWING ---
const titleLayer = projectRef.current.titleLayer;
if (titleLayer && currentTime >= titleLayer.startTime && currentTime < titleLayer.endTime) {
  // Resolve style: per-title override → project-level titleStyle
  const titleStyle = titleLayer.style || projectRef.current.titleStyle;
  const titleTemplate = projectRef.current.activeTitleTemplate;
  const titleAnim = titleLayer.animation || titleTemplate?.animation || null;

  const titleClipTime = currentTime - titleLayer.startTime;
  const titleDuration = titleLayer.endTime - titleLayer.startTime;
  const titleLocalFrame = Math.round(titleClipTime * settings.fps);

  // Calculate fade-in/fade-out opacity
  let titleOpacity = 1;
  if (titleLayer.fadeInDuration > 0 && titleClipTime < titleLayer.fadeInDuration) {
    titleOpacity = titleClipTime / titleLayer.fadeInDuration;
  }
  if (titleLayer.fadeOutDuration > 0 && titleClipTime > (titleDuration - titleLayer.fadeOutDuration)) {
    titleOpacity = (titleDuration - titleClipTime) / titleLayer.fadeOutDuration;
  }

  // Keyframe transforms
  let titleKfTransform = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };
  if (titleLayer.keyframes && titleLayer.keyframes.length > 0) {
    titleKfTransform = getInterpolatedTransform(titleLayer.keyframes, titleClipTime);
  }

  // TitleStyle and SubtitleStyle share the same shape — cast directly,
  // passing topOffset separately
  drawSubtitleOnCanvas({
    ctx,
    text: titleLayer.text,
    style: titleStyle as any as SubtitleStyle,
    templateStyle: titleTemplate?.style || null,
    animation: titleAnim,
    frame: titleLocalFrame,
    fps: settings.fps,
    outputWidth,
    outputHeight,
    viewportSafeZoneHeight: safeZoneHeight,
    totalTx: titleKfTransform.translateX,
    totalTy: titleKfTransform.translateY,
    totalScale: titleKfTransform.scale,
    totalRotation: titleKfTransform.rotation,
    topOffset: titleStyle.topOffset ?? 15,
    globalOpacity: titleOpacity,
  });
}
```

#### Type compatibility note

`TitleStyle` and `SubtitleStyle` share nearly all fields — fontFamily, fontSize, color, backgroundColor, backgroundOpacity, backgroundType, boxBorderColor/Width/Radius, textAlign, bold, italic, textTransform, all shadow/glow/gradient/blend-mode fields. The only difference is `TitleStyle.topOffset` vs `SubtitleStyle.bottomOffset`. By passing `topOffset` as a separate parameter, the style object can be cast safely. `drawSubtitleOnCanvas` will use `topOffset` when provided, ignoring `bottomOffset`.

### Files Changed
- `App.tsx` (export render loop — add title block)
- `utils/canvasSubtitleRenderer.ts` (add `topOffset` and `globalOpacity` to `DrawSubtitleOptions`, modify `yBase` calculation)

---

## Fix 3: Jittery Cuts Between Segments

### Problem

Video cuts between segments are not clean in the export — visible jitter or flashing at boundaries.

### Root Cause

The export uses `requestAnimationFrame` which runs at display refresh rate (typically 60Hz), not at the export fps. The `currentTime` is read from the playing timeline state, but video elements may not have seeked to the exact frame at the moment the canvas captures. At segment boundaries, the outgoing segment's video may still show its last frame while the incoming segment hasn't loaded its first frame yet.

**Architectural note**: The proper long-term fix is a seek-based (non-real-time) export pipeline that advances a frame counter deterministically, seeks each video element, waits for `seeked` events, then draws. This spec proposes a mitigation within the current real-time architecture.

### Fix

**File**: `App.tsx` (export render loop)

**Frame validation at boundaries**: Before drawing a segment's video, check that `vid.currentTime` is within a reasonable tolerance of the expected source time:

```js
const expectedSourceTime = activeSeg.startTime + clipTime;
const timeDiff = Math.abs(vid.currentTime - expectedSourceTime);
const frameDuration = 1 / settings.fps;
if (timeDiff > frameDuration * 2) {
  // Video hasn't caught up — skip drawing this segment's video for this frame.
  // Keep whatever was previously on the canvas (no black flash).
  // Do NOT clear the canvas here — the black fill at line 1513-1514 stays
  // OUTSIDE the segment loop to preserve multi-track rendering.
  if (shouldLog) console.log(`[Export] Skipping segment ${activeSeg.id}: vid.currentTime=${vid.currentTime.toFixed(3)}, expected=${expectedSourceTime.toFixed(3)}`);
  return; // skip this segment in forEach, not the whole frame
}
```

**Important**: The canvas clear (`ctx.fillRect` at line 1513-1514) MUST remain outside the segment loop. Moving it inside would break multi-track rendering (segments on different tracks that overlap in time).

### Files Changed
- `App.tsx` (export render loop — add time validation before video draw)

---

## Fix 4: Export Sizing Mismatch

### Problem

The exported video appears slightly larger than what's displayed in the viewport. Text and elements are proportionally bigger.

### Root Cause

The safe zone height calculation in the export (`App.tsx:1430-1444`) recomputes from `viewportSize` and aspect ratio. This may not match the actual CSS-rendered safe zone height used during viewport display, due to rounding, padding, borders, or other layout factors.

### Fix

**File**: `App.tsx`

1. Add a ref to the safe zone container element in the viewport:
   ```js
   const safeZoneRef = useRef<HTMLDivElement>(null);
   ```

2. Attach this ref to the safe zone `<div>` in the viewport JSX (the div that constrains the video to the selected aspect ratio).

3. In `handleExportVideo`, read the actual height **BEFORE** `setIsExporting(true)` (since setting isExporting changes rendering and may alter layout):
   ```js
   // Capture safe zone height from DOM BEFORE export mode changes layout
   const measuredSafeZoneHeight = safeZoneRef.current?.getBoundingClientRect().height;

   setIsExporting(true);
   await new Promise(r => setTimeout(r, 300));

   // ... later when computing safeZoneHeight:
   let safeZoneHeight = measuredSafeZoneHeight || viewportSize.height || 360;
   ```

This ensures the export scale factor exactly matches the viewport's actual rendering dimensions.

### Files Changed
- `App.tsx` (add ref, measure before export, use actual height)

---

## Fix 5: Auto-Wrap Dialogue for Portrait (Feature)

### Problem

When importing transcript/dialogue text, long lines extend beyond the 9:16 portrait frame. The user must manually insert line breaks.

### Solution

Add an auto-wrap utility that measures text width and inserts `\n` when a line exceeds the safe zone width for the current aspect ratio.

### Implementation

**New utility**: `utils/autoWrapText.ts`

```typescript
/** Shared canvas for text measurement — avoids creating one per call */
let measureCanvas: HTMLCanvasElement | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCanvas) measureCanvas = document.createElement('canvas');
  return measureCanvas.getContext('2d')!;
}

/**
 * Auto-wrap text so no line exceeds maxWidth pixels.
 * Processes each existing line independently (preserves manual \n breaks).
 */
export function autoWrapDialogueText(
  text: string,
  fontSize: number,
  fontFamily: string,
  maxWidth: number,
  bold?: boolean,
): string {
  const ctx = getMeasureCtx();
  ctx.font = `${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`;

  // Process each existing line independently — preserves manual line breaks
  const existingLines = text.split('\n');
  const wrappedLines: string[] = [];

  for (const line of existingLines) {
    const words = line.split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) {
      wrappedLines.push('');
      continue;
    }

    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        wrappedLines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) wrappedLines.push(currentLine);
  }

  return wrappedLines.join('\n');
}
```

**Integration points**:

1. **During transcript import** — in `App.tsx` where dialogue events from transcript/analysis are stored into the library. After events are populated with `details` text, apply auto-wrap if the current viewport aspect ratio is portrait:
   ```typescript
   if (viewportSettings.previewAspectRatio === '9:16') {
     const style = project.subtitleStyle;
     const maxWidth = computeMaxTextWidth(viewportSettings.previewAspectRatio, style.fontSize);
     for (const event of media.analysis.events) {
       if (event.type === 'dialogue') {
         event.details = autoWrapDialogueText(
           event.details, style.fontSize, style.fontFamily || 'Arial', maxWidth, style.bold
         );
       }
     }
   }
   ```

2. **Manual trigger** (Properties Panel):
   - Add "Auto-wrap for frame" button next to the dialogue text editor
   - Reads current subtitle style (fontSize, fontFamily) and safe zone width from the ref
   - Applies to the selected dialogue event(s)
   - Pushes undo state before wrapping

3. **Max width calculation** (in viewport CSS pixel space, not export resolution):
   ```typescript
   function computeMaxTextWidth(aspectRatio: string, fontSize: number): number {
     // The viewport safe zone for 9:16 is the letterboxed area.
     // Use safeZoneRef to get actual width, or compute from known ratios.
     // 90% of safe zone width accounts for padding (5% each side).
     const safeZoneWidth = safeZoneRef.current?.getBoundingClientRect().width
       || (aspectRatio === '9:16' ? viewportSize.height * (9/16) : viewportSize.width);
     return safeZoneWidth * 0.9;
   }
   ```

### Files Changed
- New: `utils/autoWrapText.ts`
- `App.tsx` (import handler integration, properties panel button)

---

## Testing Plan

1. **Fix 1 — Newline rendering**:
   - Edit dialogue to add `\n` between words (no adjacent spaces): verify multi-line in export
   - Edit dialogue to add `\n` with adjacent spaces (`"word \nword"`, `"word\n word"`): verify same result
   - Test with multiple consecutive `\n\n`: verify blank line gap
   - Test with word-scope, line-scope, element-scope, and character-scope animations

2. **Fix 2 — Title rendering**:
   - Add a title layer with default style, export, verify it appears at correct top position
   - Test with custom `titleLayer.style` override (should use override, not project-level)
   - Test with animation template on title
   - Test with keyframe transforms on title
   - Test fade-in and fade-out at title boundaries
   - Test title with text effects (shadow, glow, gradient)

3. **Fix 3 — Jittery cuts**:
   - Create a project with 3+ segments with hard cuts (no transitions), export
   - Verify no black flash or frame jitter at cut points
   - Test with segments on multiple tracks (multi-track should still work)

4. **Fix 4 — Export sizing**:
   - Export at 1080p with 9:16 aspect ratio, compare text size against viewport
   - Export at different resolutions (720p, 4K), verify proportional match
   - Test with different viewport container sizes (resize browser window)

5. **Fix 5 — Auto-wrap**:
   - Import a transcript in 9:16 mode with long dialogue lines, verify auto-wrapping
   - Verify existing manual `\n` breaks are preserved (each line wrapped independently)
   - Test manual "Auto-wrap" button on a single dialogue event
   - Verify undo works after auto-wrap
