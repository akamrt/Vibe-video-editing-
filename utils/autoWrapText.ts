/**
 * Auto-wrap dialogue text so no line exceeds a given pixel width.
 * Uses an offscreen canvas for text measurement.
 * Processes each existing line independently — preserves manual line breaks.
 */

/** Shared canvas for text measurement — avoids creating one per call */
let measureCanvas: HTMLCanvasElement | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
    if (!measureCanvas) measureCanvas = document.createElement('canvas');
    return measureCanvas.getContext('2d')!;
}

/**
 * Auto-wrap text so no line exceeds maxWidth pixels.
 * @param text - The dialogue text, may contain existing \n
 * @param fontSize - CSS font size in pixels
 * @param fontFamily - CSS font family string
 * @param maxWidth - Maximum line width in CSS pixels
 * @param bold - Whether font is bold
 * @returns Text with \n inserted at wrap points
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
