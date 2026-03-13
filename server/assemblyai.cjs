const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSEMBLYAI_BASE = 'https://api.assemblyai.com';

/**
 * Upload an audio/video file to AssemblyAI.
 * Returns the upload_url for use in transcript creation.
 */
async function uploadAudio(filePath, apiKey) {
    const fileSize = fs.statSync(filePath).size;
    console.log(`[AssemblyAI] Uploading ${path.basename(filePath)} (${(fileSize / 1024 / 1024).toFixed(1)}MB)...`);

    const fileBuffer = fs.readFileSync(filePath);

    const response = await fetch(`${ASSEMBLYAI_BASE}/v2/upload`, {
        method: 'POST',
        headers: {
            authorization: apiKey,
            'content-type': 'application/octet-stream',
            'transfer-encoding': 'chunked',
        },
        body: fileBuffer,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`AssemblyAI upload failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    console.log(`[AssemblyAI] Upload complete: ${data.upload_url}`);
    return data.upload_url;
}

/**
 * Create a transcript job on AssemblyAI.
 * Returns the transcript ID for polling.
 */
async function createTranscript(audioUrl, apiKey) {
    console.log(`[AssemblyAI] Creating transcript job...`);

    const response = await fetch(`${ASSEMBLYAI_BASE}/v2/transcript`, {
        method: 'POST',
        headers: {
            authorization: apiKey,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            audio_url: audioUrl,
            language_detection: true,
            speech_models: ['universal-3-pro', 'universal-2'],
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`AssemblyAI transcript creation failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    console.log(`[AssemblyAI] Transcript job created: ${data.id} (status: ${data.status})`);
    return data;
}

/**
 * Poll for transcript completion.
 * Calls onProgress with status updates.
 * Returns the completed transcript with word-level timestamps.
 */
async function pollTranscript(transcriptId, apiKey, onProgress) {
    const pollingEndpoint = `${ASSEMBLYAI_BASE}/v2/transcript/${transcriptId}`;
    const POLL_INTERVAL = 3000; // 3 seconds
    const MAX_POLLS = 200; // ~10 minutes max

    for (let i = 0; i < MAX_POLLS; i++) {
        const response = await fetch(pollingEndpoint, {
            headers: { authorization: apiKey },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`AssemblyAI poll failed (${response.status}): ${text}`);
        }

        const result = await response.json();

        if (result.status === 'completed') {
            console.log(`[AssemblyAI] Transcription complete! ${result.words?.length || 0} words detected.`);
            if (onProgress) onProgress({ status: 'completed' });
            return result;
        }

        if (result.status === 'error') {
            throw new Error(`AssemblyAI transcription failed: ${result.error}`);
        }

        // Still processing
        if (onProgress) onProgress({ status: 'transcribing', detail: result.status });
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }

    throw new Error('AssemblyAI transcription timed out after 10 minutes');
}

/**
 * Full transcription pipeline: upload → create → poll → return results.
 * onProgress callback receives: { status: 'uploading'|'transcribing'|'completed'|'error', detail? }
 */
async function transcribeFile(filePath, apiKey, onProgress) {
    try {
        // Upload
        if (onProgress) onProgress({ status: 'uploading' });
        const uploadUrl = await uploadAudio(filePath, apiKey);

        // Create transcript job
        if (onProgress) onProgress({ status: 'transcribing', detail: 'queued' });
        const job = await createTranscript(uploadUrl, apiKey);

        // Poll for completion
        const result = await pollTranscript(job.id, apiKey, onProgress);

        return result;
    } catch (err) {
        if (onProgress) onProgress({ status: 'error', detail: err.message });
        throw err;
    }
}

/**
 * Convert AssemblyAI word array to the app's segment format.
 * AssemblyAI words: [{text, start, end, confidence}] with times in milliseconds.
 * App segments: [{start, duration, text, isKaraoke}] with times in seconds.
 */
function wordsToSegments(words) {
    if (!words || !words.length) return [];

    return words.map(w => ({
        start: w.start / 1000,           // ms → seconds
        duration: (w.end - w.start) / 1000,
        text: w.text,
        isKaraoke: true,
        confidence: w.confidence,
    }));
}

/**
 * Convert AssemblyAI result to app's AnalysisEvent[] format.
 * Creates word-level events with real timestamps, then groups into readable slides.
 */
function assemblyAIToAnalysisEvents(result) {
    if (!result.words || !result.words.length) return [];

    // Create per-word AnalysisEvents with real timing
    const wordEvents = result.words.map(w => ({
        type: 'dialogue',
        startTime: w.start / 1000,
        endTime: w.end / 1000,
        label: 'speech',
        details: w.text,
        confidence: w.confidence,
    }));

    // Group into readable slides (same logic as App.tsx import post-processing)
    const processedEvents = [];
    if (wordEvents.length === 0) return processedEvents;

    let buffer = [wordEvents[0]];

    for (let i = 1; i < wordEvents.length; i++) {
        const current = wordEvents[i];
        const prev = buffer[buffer.length - 1];
        const gap = current.startTime - prev.endTime;
        const bufferDuration = prev.endTime - buffer[0].startTime;
        const combinedDuration = current.endTime - buffer[0].startTime;
        const wordCount = buffer.length;

        // Deduplication
        const isDuplicate = current.details.trim().toLowerCase() === prev.details.trim().toLowerCase();
        const isOverlap = current.startTime < prev.endTime;
        if (isDuplicate && isOverlap) {
            prev.endTime = Math.max(prev.endTime, current.endTime);
            continue;
        }

        const isContiguous = gap < 0.1;
        if (isContiguous && (bufferDuration < 0.5 || wordCount < 3) && combinedDuration < 1.2) {
            buffer.push(current);
        } else {
            // Flush buffer as a slide
            const slide = {
                type: 'dialogue',
                startTime: buffer[0].startTime,
                endTime: buffer[buffer.length - 1].endTime,
                label: 'speech',
                details: buffer.map(e => e.details).join(' '),
                confidence: buffer.reduce((sum, e) => sum + (e.confidence || 0), 0) / buffer.length,
                wordTimings: buffer.map(e => ({
                    text: e.details,
                    start: e.startTime,
                    end: e.endTime,
                    confidence: e.confidence || 0,
                })),
            };
            processedEvents.push(slide);
            buffer = [current];
        }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
        processedEvents.push({
            type: 'dialogue',
            startTime: buffer[0].startTime,
            endTime: buffer[buffer.length - 1].endTime,
            label: 'speech',
            details: buffer.map(e => e.details).join(' '),
            confidence: buffer.reduce((sum, e) => sum + (e.confidence || 0), 0) / buffer.length,
            wordTimings: buffer.map(e => ({
                text: e.details,
                start: e.startTime,
                end: e.endTime,
                confidence: e.confidence || 0,
            })),
        });
    }

    return processedEvents;
}

module.exports = {
    uploadAudio,
    createTranscript,
    pollTranscript,
    transcribeFile,
    wordsToSegments,
    assemblyAIToAnalysisEvents,
};
