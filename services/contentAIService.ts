/**
 * Content AI Service
 * 
 * Calls server-side AI endpoints for content search and short generation.
 * This keeps the API key secure on the server and avoids browser rate limits.
 */

import { contentDB, VideoRecord, TranscriptSegment, GeneratedShort, ShortSegment, BRollSuggestion, PexelsVideoResult, PexelsPhotoResult, generateId } from "./contentDatabase";
import { trackServerUsage } from "./costTracker";

// ==================== Types ====================

export interface SearchResult {
    videoId: string;
    videoTitle: string;
    thumbnailUrl: string;
    relevanceScore: number;
    matchingSegments: {
        text: string;
        startTime: number;
        endTime: number;
    }[];
    summary: string;
}

export interface ShortGenerationResult {
    success: boolean;
    short?: GeneratedShort;
    shorts?: GeneratedShort[];
    error?: string;
}

// ==================== AI Functions ====================

/**
 * Search all sermon transcripts using AI semantic search.
 */
export async function searchTranscripts(query: string): Promise<SearchResult[]> {
    // 1. Get all videos with their transcripts
    const videos = await contentDB.getAllVideos();
    if (videos.length === 0) {
        return [];
    }

    // 2. Build transcript data for the server
    const transcripts: { videoId: string; title: string; transcript: string }[] = [];

    for (const video of videos) {
        const transcript = await contentDB.getFullTranscript(video.id);
        if (transcript.length > 0) {
            transcripts.push({
                videoId: video.id,
                title: video.title,
                transcript
            });
        }
    }

    if (transcripts.length === 0) {
        return [];
    }

    try {
        console.log(`[ContentAI] Searching ${transcripts.length} sermons for: "${query}"`);

        // Call server endpoint
        const response = await fetch('/api/ai/search-transcripts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, transcripts })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Search failed');
        }

        const json = await response.json();

        // Track cost from server-side AI call
        if (json._usageMetadata) {
            trackServerUsage("Transcript Search", "gemini-2.5-flash", json._usageMetadata);
            delete json._usageMetadata;
        }

        if (!json.results || !Array.isArray(json.results)) {
            return [];
        }

        // Map AI results back to full video data
        const searchResults: SearchResult[] = [];

        for (const result of json.results) {
            const video = videos.find(v => v.id === result.videoId);
            if (!video) continue;

            // Find actual segment timestamps for the matching quotes
            const segments = await contentDB.getSegmentsByVideoId(video.id);
            const matchingSegments: { text: string; startTime: number; endTime: number }[] = [];

            for (const quote of (result.matchingQuotes || [])) {
                const quoteLower = quote.toLowerCase();
                for (const seg of segments) {
                    if (seg.text.toLowerCase().includes(quoteLower.substring(0, 50))) {
                        matchingSegments.push({
                            text: quote,
                            startTime: seg.start,
                            endTime: seg.start + seg.duration
                        });
                        break;
                    }
                }
            }

            searchResults.push({
                videoId: video.id,
                videoTitle: video.title,
                thumbnailUrl: video.thumbnailUrl,
                relevanceScore: result.relevanceScore || 50,
                matchingSegments,
                summary: result.summary || ""
            });
        }

        searchResults.sort((a, b) => b.relevanceScore - a.relevanceScore);
        console.log(`[ContentAI] Found ${searchResults.length} relevant sermons`);
        return searchResults;

    } catch (error) {
        console.error("[ContentAI] Search error:", error);
        throw new Error("Failed to search transcripts: " + (error instanceof Error ? error.message : "Unknown error"));
    }
}

/**
 * Search Pexels for B-roll stock footage.
 */
async function searchPexelsBRoll(query: string, count: number = 10): Promise<PexelsVideoResult[]> {
    const res = await fetch(`/api/pexels/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.videos || [];
}

async function searchPexelsPhotos(query: string, count: number = 8): Promise<PexelsPhotoResult[]> {
    const res = await fetch(`/api/pexels/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.photos || [];
}

/**
 * Generate a short-form video edit from a single sermon.
 */
export interface ExistingShortContext {
    title: string;
    startTime: number;
    endTime: number;
}

export async function generateShort(
    videoId: string,
    prompt: string,
    targetDuration: number = 60,
    refinementInstruction?: string,
    existingShorts: ExistingShortContext[] = [],
    model?: string
): Promise<ShortGenerationResult> {
    // 1. Get video and its full transcript with timestamps
    const video = await contentDB.getVideo(videoId);
    if (!video) {
        return { success: false, error: "Video not found" };
    }

    const segments = await contentDB.getSegmentsByVideoId(videoId);
    if (segments.length === 0) {
        return { success: false, error: "No transcript found for this video" };
    }

    // 2. Format transcript with timestamps (Use SECONDS to help AI avoid math errors)
    const hasWordTimings = segments.some(s => s.wordTimings && s.wordTimings.length > 0);
    const transcriptWithTimestamps = hasWordTimings
        ? segments.map(seg => {
            if (seg.wordTimings && seg.wordTimings.length > 0) {
                const words = seg.wordTimings.map(w => `  ${w.text} [${w.start.toFixed(3)}-${w.end.toFixed(3)}]`).join('\n');
                return `[${seg.start.toFixed(1)} - ${(seg.start + seg.duration).toFixed(1)}] ${seg.text}\n  WORD TIMINGS:\n${words}`;
            }
            return `[${seg.start.toFixed(1)} - ${(seg.start + seg.duration).toFixed(1)}] ${seg.text}`;
        }).join('\n')
        : segments.map(seg =>
            `[${seg.start.toFixed(1)} - ${(seg.start + seg.duration).toFixed(1)}] ${seg.text}`
        ).join('\n');

    try {
        console.log(`[ContentAI] Generating short from "${video.title}" (Refinement: ${refinementInstruction ? 'Yes' : 'No'}, Excluding ${existingShorts.length} existing)`);

        // Call server endpoint
        const response = await fetch('/api/ai/generate-short', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transcript: transcriptWithTimestamps,
                videoTitle: video.title,
                prompt,
                targetDuration,
                refinementInstruction,
                existingShorts,
                model
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Generation failed');
        }

        const json = await response.json();

        // Track cost from server-side AI call
        if (json._usageMetadata) {
            trackServerUsage("Generate Short", model || "gemini-2.5-flash", json._usageMetadata);
            delete json._usageMetadata;
        }

        if (!json.clips || !Array.isArray(json.clips) || json.clips.length === 0) {
            return { success: false, error: "AI could not find suitable content for this prompt" };
        }

        // Helper to parse potential string timestamps (e.g. "120" or "2:00")
        const parseTime = (val: any): number => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string') {
                if (val.includes(':')) {
                    const parts = val.split(':').map(Number);
                    if (parts.length === 2) return parts[0] * 60 + parts[1];
                    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
                return parseFloat(val);
            }
            return 0;
        };

        // Create the GeneratedShort object
        const shortSegments: ShortSegment[] = json.clips.map((clip: any) => ({
            startTime: parseTime(clip.startTime),
            endTime: parseTime(clip.endTime),
            text: clip.text,
            keywords: clip.keywords || []
        }));

        const generatedShort: GeneratedShort = {
            id: generateId(),
            title: json.title || `Short from ${video.title}`,
            prompt,
            videoId: video.id,
            videoTitle: video.title,
            segments: shortSegments,
            hook: json.hook || shortSegments[0]?.text || "",
            hookTitle: json.hookTitle || (json.title || "").split(' ').slice(0, 5).join(' ') || "Watch This",
            resolution: json.resolution || shortSegments[shortSegments.length - 1]?.text || "",
            totalDuration: json.totalDuration || shortSegments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0),
            createdAt: new Date()
        };

        // Fetch B-roll suggestions from Pexels if LLM provided them
        if (json.bRollSuggestions && Array.isArray(json.bRollSuggestions) && json.bRollSuggestions.length > 0) {
            try {
                const keysRes = await fetch('/api/keys');
                const keys = await keysRes.json();
                if (keys.PEXELS_API_KEY) {
                    const bRollResults = await Promise.all(
                        json.bRollSuggestions.map(async (suggestion: any): Promise<BRollSuggestion | null> => {
                            try {
                                const [videos, photos] = await Promise.all([
                                    searchPexelsBRoll(suggestion.searchQuery),
                                    searchPexelsPhotos(suggestion.searchQuery),
                                ]);
                                if (videos.length === 0 && photos.length === 0) return null;
                                return {
                                    id: generateId(),
                                    clipIndex: suggestion.clipIndex ?? 0,
                                    offsetInClip: suggestion.offsetInClip ?? 0,
                                    duration: suggestion.duration ?? 3,
                                    searchQuery: suggestion.searchQuery || '',
                                    rationale: suggestion.rationale || '',
                                    approved: true,
                                    pexelsResults: videos,
                                    pexelsPhotos: photos,
                                    selectedVideoIndex: 0,
                                    selectedType: 'video',
                                };
                            } catch (e) {
                                console.warn('[ContentAI] Pexels search failed for:', suggestion.searchQuery, e);
                                return null;
                            }
                        })
                    );
                    const validSuggestions = bRollResults.filter((s): s is BRollSuggestion => s !== null);
                    if (validSuggestions.length > 0) {
                        generatedShort.bRollSuggestions = validSuggestions;
                        console.log(`[ContentAI] Found ${validSuggestions.length} B-roll suggestions with Pexels results`);
                    }
                }
            } catch (e) {
                console.warn('[ContentAI] B-roll fetch failed (non-fatal):', e);
            }
        }

        // Save to database
        await contentDB.addShort(generatedShort);

        console.log(`[ContentAI] Generated short: "${generatedShort.title}" (${generatedShort.totalDuration}s)`);

        return { success: true, short: generatedShort };

    } catch (error) {
        console.error("[ContentAI] Short generation error:", error);
        return {
            success: false,
            error: "Failed to generate short: " + (error instanceof Error ? error.message : "Unknown error")
        };
    }
}

// ==================== B-Roll Pexels Fetching ====================

async function fetchBRollForSuggestions(rawSuggestions: any[]): Promise<BRollSuggestion[]> {
    // Check if Pexels API key is available
    const keysRes = await fetch('/api/keys');
    const keys = await keysRes.json();
    if (!keys.PEXELS_API_KEY) {
        console.log('[ContentAI] No Pexels API key configured, skipping B-roll');
        return [];
    }

    // Fetch Pexels results for all suggestions in parallel
    const results = await Promise.all(
        rawSuggestions.map(async (suggestion: any): Promise<BRollSuggestion | null> => {
            try {
                const query = encodeURIComponent(suggestion.searchQuery || '');
                if (!query) return null;

                const res = await fetch(`/api/pexels/search?query=${query}&per_page=5&orientation=portrait`);
                if (!res.ok) return null;

                const data = await res.json();
                const pexelsResults: PexelsVideoResult[] = (data.videos || []);

                if (pexelsResults.length === 0) return null;

                return {
                    id: generateId(),
                    clipIndex: suggestion.clipIndex ?? 0,
                    offsetInClip: suggestion.offsetInClip ?? 0,
                    duration: suggestion.duration ?? 3,
                    searchQuery: suggestion.searchQuery || '',
                    rationale: suggestion.rationale || '',
                    approved: true,
                    pexelsResults,
                    selectedVideoIndex: 0,
                };
            } catch (e) {
                console.warn(`[ContentAI] Pexels search failed for "${suggestion.searchQuery}":`, e);
                return null;
            }
        })
    );

    return results.filter((r): r is BRollSuggestion => r !== null);
}

export async function buildShortPrompt(
    videoId: string,
    prompt: string,
    targetDuration: number = 60,
    refinementInstruction?: string,
    existingShorts: ExistingShortContext[] = []
): Promise<{ success: boolean; prompt?: string; error?: string }> {
    const video = await contentDB.getVideo(videoId);
    if (!video) return { success: false, error: "Video not found" };

    const segments = await contentDB.getSegmentsByVideoId(videoId);
    if (segments.length === 0) return { success: false, error: "No transcript found for this video" };

    // Segment-level timestamps only — word timings are not used in the prompt
    const transcriptWithTimestamps = segments.map(seg =>
        `[${seg.start.toFixed(2)} - ${(seg.start + seg.duration).toFixed(2)}] ${seg.text}`
    ).join('\n');

    try {
        const response = await fetch('/api/ai/build-short-prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                transcript: transcriptWithTimestamps,
                videoTitle: video.title,
                prompt,
                targetDuration,
                refinementInstruction,
                existingShorts
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to build prompt');
        }

        const json = await response.json();
        return { success: true, prompt: json.prompt };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}

export async function importManualShort(
    videoId: string,
    jsonString: string,
    promptUsed: string
): Promise<ShortGenerationResult> {
    const video = await contentDB.getVideo(videoId);
    if (!video) return { success: false, error: "Video not found" };

    const segments = await contentDB.getSegmentsByVideoId(videoId);
    if (segments.length === 0) return { success: false, error: "No transcript found for this video" };

    // Parse transcript lines for text filling
    const transcriptLines = segments.map(seg => ({
        start: seg.start,
        end: seg.start + seg.duration,
        text: seg.text
    }));

    try {
        let cleanJsonString = jsonString.trim();

        // Extract JSON from markdown blocks if present
        const jsonBlockMatch = cleanJsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (jsonBlockMatch && jsonBlockMatch[1]) {
            cleanJsonString = jsonBlockMatch[1].trim();
        } else {
            // Fallback: Just strip starting/ending backticks if they exist
            cleanJsonString = cleanJsonString.replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
        }

        // ── Multi-pass JSON cleanup ──

        // 1. Replace smart/curly quotes with straight quotes (very common from AI chat UIs & rich-text paste)
        cleanJsonString = cleanJsonString
            .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')   // " " „ ‟ ″ ‶ → "
            .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")   // ' ' ‚ ‛ ′ ‵ → '
            .replace(/[\u00AB\u00BB]/g, '"');                           // « » → "

        // 2. Remove BOM and zero-width characters
        cleanJsonString = cleanJsonString.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');

        // 3. Remove JS-style single-line comments (// ...) that aren't inside strings
        //    Simple heuristic: remove lines that start with // (after optional whitespace)
        cleanJsonString = cleanJsonString.replace(/^\s*\/\/.*$/gm, '');

        // 4. Remove trailing commas before closing braces/brackets (common LLM mistake)
        cleanJsonString = cleanJsonString.replace(/,\s*([\]}])/g, '$1');

        // 5. Remove unescaped control characters (newlines, tabs, etc.) inside strings
        cleanJsonString = cleanJsonString.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, "");

        // 6. If the string starts with a JSON structure but has trailing non-JSON text
        //    (e.g. "Here is the JSON: {...} Let me know if..."), try to extract just the JSON
        if (!/^\s*[\[{]/.test(cleanJsonString)) {
            // Try to find the first { or [ and extract from there
            const firstBrace = cleanJsonString.search(/[\[{]/);
            if (firstBrace > 0) {
                cleanJsonString = cleanJsonString.substring(firstBrace).trim();
            }
        }

        let json;
        try {
            json = JSON.parse(cleanJsonString);
            console.log('[ImportJSON] Parsed JSON type:', Array.isArray(json) ? 'array' : typeof json, 'keys:', typeof json === 'object' && json ? Object.keys(json).join(', ') : 'n/a');
        } catch (parseErr) {
            console.warn("[ImportJSON] First parse attempt failed, trying repairs...", parseErr);

            let repaired = cleanJsonString;

            // Repair pass 1: Convert single-quoted JSON to double-quoted
            // Only if the string appears to use single quotes for keys/values
            if (repaired.includes("'") && !repaired.includes('"')) {
                repaired = repaired.replace(/'/g, '"');
            }

            // Repair pass 2: Fix unescaped newlines inside string values
            repaired = repaired.replace(/("(?:[^"\\]|\\.)*")|[\r\n]+/g, (match, quoted) => {
                if (quoted) return quoted; // leave proper strings alone
                return ' '; // replace bare newlines with spaces
            });

            // Repair pass 3: Remove trailing text after the top-level JSON structure closes
            // Find the matching closing bracket/brace for the first opening one
            const openChar = repaired.trim()[0];
            if (openChar === '{' || openChar === '[') {
                const closeChar = openChar === '{' ? '}' : ']';
                let depth = 0;
                let inString = false;
                let escaped = false;
                let endPos = -1;
                for (let i = 0; i < repaired.length; i++) {
                    const ch = repaired[i];
                    if (escaped) { escaped = false; continue; }
                    if (ch === '\\') { escaped = true; continue; }
                    if (ch === '"') { inString = !inString; continue; }
                    if (inString) continue;
                    if (ch === openChar) depth++;
                    if (ch === closeChar) {
                        depth--;
                        if (depth === 0) { endPos = i; break; }
                    }
                }
                if (endPos > 0 && endPos < repaired.length - 1) {
                    repaired = repaired.substring(0, endPos + 1);
                }
            }

            try {
                json = JSON.parse(repaired);
                console.log('[ImportJSON] Repaired JSON parsed successfully');
            } catch (repairErr) {
                // Final attempt: try to fix unescaped double quotes inside string values
                // by replacing internal " with \"
                try {
                    // Strategy: walk character by character, track if we're in a string,
                    // and escape any unescaped quotes that appear to be inside a value
                    let fixed = '';
                    let inStr = false;
                    let esc = false;
                    for (let i = 0; i < repaired.length; i++) {
                        const c = repaired[i];
                        if (esc) { fixed += c; esc = false; continue; }
                        if (c === '\\') { fixed += c; esc = true; continue; }
                        if (c === '"') {
                            if (!inStr) {
                                inStr = true;
                                fixed += c;
                            } else {
                                // Is this the real end of the string?
                                // Look ahead: after optional whitespace, should be , or } or ] or :
                                const rest = repaired.substring(i + 1).trimStart();
                                if (rest.length === 0 || /^[,}\]:]/.test(rest)) {
                                    inStr = false;
                                    fixed += c;
                                } else {
                                    // Likely an unescaped quote inside the string
                                    fixed += '\\"';
                                }
                            }
                        } else {
                            fixed += c;
                        }
                    }
                    json = JSON.parse(fixed);
                    console.log('[ImportJSON] Fixed unescaped quotes, parsed successfully');
                } catch {
                    // All repair attempts failed — throw the original error with context
                    const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
                    // Add a snippet around the error position to help debugging
                    const posMatch = errMsg.match(/position\s+(\d+)/i);
                    let hint = '';
                    if (posMatch) {
                        const pos = parseInt(posMatch[1]);
                        const start = Math.max(0, pos - 30);
                        const end = Math.min(cleanJsonString.length, pos + 30);
                        hint = `\n\nNear position ${pos}: ...${cleanJsonString.substring(start, pos)}👉${cleanJsonString.substring(pos, end)}...`;
                    }
                    throw new Error(errMsg + hint);
                }
            }
        }

        const parseTime = (val: any): number => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string') {
                if (val.includes(':')) {
                    const parts = val.split(':').map(Number);
                    if (parts.length === 2) return parts[0] * 60 + parts[1];
                    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
                }
                return parseFloat(val);
            }
            return 0;
        };

        // ── Flexible JSON structure detection ──
        // Supports many formats that AI models commonly return:
        //   { "shorts": [{ "clips": [...] }] }         ← standard
        //   { "shorts": [{ "segments": [...] }] }      ← common alternative
        //   { "clips": [...] }                          ← single short with clips
        //   { "segments": [...] }                       ← single short with segments
        //   [{ "clips": [...] }]                        ← array of shorts
        //   [{ "startTime": ..., "endTime": ... }]      ← flat array of clips
        //   { "startTime": ..., "endTime": ... }         ← single clip object

        const isClipLike = (obj: any): boolean =>
            obj && typeof obj === 'object' && (obj.startTime !== undefined || obj.start_time !== undefined || obj.start !== undefined) && (obj.endTime !== undefined || obj.end_time !== undefined || obj.end !== undefined);

        // Only treat an array as clips if its first element looks like a clip (has time fields)
        const getValidatedArray = (arr: any[]): any[] | null =>
            arr.length > 0 && isClipLike(arr[0]) ? arr : null;

        const getClipsArray = (obj: any): any[] | null => {
            // Check named array properties — but ONLY if their elements look like clips
            if (obj.clips && Array.isArray(obj.clips)) return getValidatedArray(obj.clips) ?? obj.clips;
            if (obj.segments && Array.isArray(obj.segments)) return getValidatedArray(obj.segments);
            if (obj.content && Array.isArray(obj.content)) return getValidatedArray(obj.content);
            // Object itself looks like a single clip (has time fields directly)
            if (isClipLike(obj)) return [obj];
            return null;
        };

        let shortsToProcess: any[] = [];

        if (json.shorts && Array.isArray(json.shorts)) {
            shortsToProcess = json.shorts;
        } else if (json.clips && Array.isArray(json.clips)) {
            shortsToProcess = [json];
        } else if (json.segments && Array.isArray(json.segments)) {
            shortsToProcess = [{ ...json, clips: json.segments }];
        } else if (json.content && Array.isArray(json.content)) {
            shortsToProcess = [{ ...json, clips: json.content }];
        } else if (Array.isArray(json)) {
            // Could be array of shorts (each with clips) or flat array of clips
            if (json.length > 0 && isClipLike(json[0])) {
                // Flat array of clips → wrap as single short
                shortsToProcess = [{ clips: json }];
            } else {
                shortsToProcess = json;
            }
        } else if (isClipLike(json)) {
            // Single clip object
            shortsToProcess = [{ clips: [json] }];
        } else {
            console.error('[ImportJSON] Unrecognized JSON structure. Keys:', Object.keys(json));
            return { success: false, error: `Unrecognized JSON structure. Expected 'shorts', 'clips', or 'segments' array. Found keys: ${Object.keys(json).join(', ')}` };
        }

        if (shortsToProcess.length === 0) {
            return { success: false, error: "No shorts found in JSON" };
        }

        const generatedShorts: GeneratedShort[] = [];

        for (const [index, shortData] of shortsToProcess.entries()) {
            // Try to find clips under any common key name
            const clips = getClipsArray(shortData);
            if (!clips || clips.length === 0) {
                console.warn(`[ImportJSON] Skipping short at index ${index}: no clips/segments found. Keys: ${Object.keys(shortData).join(', ')}`);
                continue;
            }
            // Normalize: ensure shortData.clips is set for downstream processing
            shortData.clips = clips;

            const shortSegments: ShortSegment[] = shortData.clips.map((clip: any) => {
                // Support both camelCase and snake_case time fields
                let startTime = parseTime(clip.startTime ?? clip.start_time ?? clip.start ?? 0);
                let endTime = parseTime(clip.endTime ?? clip.end_time ?? clip.end ?? 0);

                // Step 1: Phrase-based matching (most accurate when available)
                let phraseMatchedStart = false;
                let phraseMatchedEnd = false;

                if (clip.startPhrase) {
                    const matched = matchPhraseToTimestamp(transcriptLines, clip.startPhrase, startTime, 'start');
                    console.log(`[PhraseMatch] startPhrase="${clip.startPhrase}" approx=${startTime.toFixed(2)} → ${matched !== null ? matched.toFixed(2) : 'FAILED'}`);
                    if (matched !== null) { startTime = matched; phraseMatchedStart = true; }
                }
                if (clip.endPhrase) {
                    const matched = matchPhraseToTimestamp(transcriptLines, clip.endPhrase, endTime, 'end');
                    console.log(`[PhraseMatch] endPhrase="${clip.endPhrase}" approx=${endTime.toFixed(2)} → ${matched !== null ? matched.toFixed(2) : 'FAILED'}`);
                    if (matched !== null) { endTime = matched; phraseMatchedEnd = true; }
                }

                // Step 2: Fall back to word-boundary snap if phrase matching didn't work
                if (!phraseMatchedStart) {
                    const startWord = [...transcriptLines].reverse().find(l => l.start <= startTime + 0.01);
                    if (startWord) startTime = startWord.start;
                }
                if (!phraseMatchedEnd) {
                    const nextWordIdx = transcriptLines.findIndex(l => l.start > endTime + 0.01);
                    if (nextWordIdx >= 0) {
                        endTime = transcriptLines[nextWordIdx].end;
                    } else {
                        endTime = endTime + 0.5;
                    }
                }

                // Step 2.5: Safety padding for transcript timestamp imprecision (~100ms).
                // YouTube word timestamps can lag the actual phoneme onset by 50-100ms.
                // This padding ensures we don't lose word edges. Export-time audio snap
                // will refine these to actual silence gaps. Placed before preamble trim
                // so the trimmer can still strip filler words from the padded window.
                startTime = Math.max(0, startTime - 0.08);
                endTime = endTime + 0.08;

                // Step 3: Trim preamble/trailer filler words
                startTime = trimPreambleWords(transcriptLines, startTime, endTime);
                endTime = trimTrailerWords(transcriptLines, startTime, endTime);

                let text = clip.text;

                // Look up text if missing
                if (!text) {
                    const overlapping = transcriptLines.filter(line =>
                        line.end > startTime && line.start < endTime
                    );
                    text = overlapping.map(l => l.text).join(' ').trim() || '';
                }

                // Map keywords
                let mappedKeywords = [];
                if (clip.keywords && Array.isArray(clip.keywords) && text) {
                    const words = text.split(/\s+/);
                    const usedIndices = new Set();
                    mappedKeywords = clip.keywords
                        .map(kw => {
                            const kwLower = (typeof kw === 'string' ? kw : '').toLowerCase().replace(/[.,!?;:'"()]/g, '');
                            if (!kwLower) return null;
                            const idx = words.findIndex((w, i) =>
                                !usedIndices.has(i) && w.toLowerCase().replace(/[.,!?;:'"()]/g, '') === kwLower
                            );
                            if (idx >= 0) {
                                usedIndices.add(idx);
                                return { word: typeof kw === 'string' ? kw : '', wordIndex: idx, enabled: true };
                            }
                            return null;
                        })
                        .filter(Boolean);
                }

                return {
                    startTime,
                    endTime,
                    text,
                    keywords: mappedKeywords
                };
            });

            const totalDuration = shortSegments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);

            const generatedShort: GeneratedShort = {
                id: generateId(),
                title: shortData.title || `Manual Short ${index + 1} from ${video.title}`,
                prompt: promptUsed,
                videoId: video.id,
                videoTitle: video.title,
                segments: shortSegments,
                hook: shortData.hook || shortSegments[0]?.text || "",
                hookTitle: shortData.hookTitle || (shortData.title || "").split(' ').slice(0, 5).join(' ') || "Watch This",
                resolution: shortData.resolution || shortSegments[shortSegments.length - 1]?.text || "",
                totalDuration: shortData.totalDuration || totalDuration,
                createdAt: new Date()
            };

            // Fetch B-roll from Pexels if ChatGPT/external AI provided suggestions
            if (shortData.bRollSuggestions && Array.isArray(shortData.bRollSuggestions) && shortData.bRollSuggestions.length > 0) {
                try {
                    const bRollSuggestions = await fetchBRollForSuggestions(shortData.bRollSuggestions);
                    if (bRollSuggestions.length > 0) {
                        generatedShort.bRollSuggestions = bRollSuggestions;
                    }
                } catch (e) {
                    console.warn('[ImportJSON] B-roll fetch failed (non-fatal):', e);
                }
            }

            await contentDB.addShort(generatedShort);
            generatedShorts.push(generatedShort);
        }

        if (generatedShorts.length === 0) {
            const sampleKeys = shortsToProcess.length > 0 ? Object.keys(shortsToProcess[0]).join(', ') : 'empty';
            console.error(`[ImportJSON] No valid shorts parsed. ${shortsToProcess.length} entries checked. First entry keys: ${sampleKeys}`);
            return { success: false, error: `Failed to parse any valid shorts. Found ${shortsToProcess.length} entries but none had clips. First entry keys: [${sampleKeys}]. Expected each short to contain a 'clips' or 'segments' array.` };
        }

        return { success: true, short: generatedShorts[0], shorts: generatedShorts };
    } catch (error) {
        return { success: false, error: "JSON Parse error: " + (error instanceof Error ? error.message : "Invalid JSON format") };
    }
}

// ==================== Phrase Matching & Trimming ====================

/**
 * Match a phrase against word-level transcript to find precise timestamp.
 * mode = 'start' returns the start time of the first matching word.
 * mode = 'end' returns the end time of the last matching word.
 */
function matchPhraseToTimestamp(
    transcriptLines: { start: number; end: number; text: string }[],
    phrase: string,
    approxTime: number,
    mode: 'start' | 'end'
): number | null {
    if (!phrase || !phrase.trim()) return null;

    const normalizeWord = (w: string) => w.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '').trim();
    const phraseWords = phrase.split(/\s+/).map(normalizeWord).filter(w => w.length > 0);
    if (phraseWords.length === 0) return null;

    const searchWindow = 30;
    const candidates = transcriptLines.filter(l =>
        l.start >= approxTime - searchWindow && l.start <= approxTime + searchWindow
    );
    if (candidates.length === 0) return null;

    // Explode multi-word segments into individual words with interpolated timestamps.
    // YouTube transcripts have multi-word chunks like "but jesus did" as one segment,
    // while AssemblyAI has one word per segment. This handles both uniformly.
    type WordEntry = { word: string; start: number; end: number };
    const explodedWords: WordEntry[] = [];
    for (const seg of candidates) {
        const words = seg.text.split(/\s+/).filter(w => w.length > 0);
        if (words.length <= 1) {
            explodedWords.push({ word: normalizeWord(seg.text), start: seg.start, end: seg.end });
        } else {
            const segDuration = seg.end - seg.start;
            const wordDur = segDuration / words.length;
            for (let wi = 0; wi < words.length; wi++) {
                explodedWords.push({
                    word: normalizeWord(words[wi]),
                    start: seg.start + wi * wordDur,
                    end: seg.start + (wi + 1) * wordDur
                });
            }
        }
    }

    const candidateWords = explodedWords.map(e => e.word);
    console.log(`[PhraseMatch] Looking for [${phraseWords.join(', ')}] in ${explodedWords.length} words (from ${candidates.length} segments) near ${approxTime.toFixed(1)}s. Sample: [${candidateWords.slice(0, 25).join(', ')}]`);

    // Exact sequence match
    for (let i = 0; i <= candidateWords.length - phraseWords.length; i++) {
        let match = true;
        for (let j = 0; j < phraseWords.length; j++) {
            if (candidateWords[i + j] !== phraseWords[j]) { match = false; break; }
        }
        if (match) {
            const result = mode === 'start'
                ? explodedWords[i].start
                : explodedWords[i + phraseWords.length - 1].end;
            console.log(`[PhraseMatch] ✓ Exact match at word index ${i}: "${explodedWords.slice(i, i + phraseWords.length).map(e => e.word).join(' ')}" → ${result.toFixed(2)}s`);
            return result;
        }
    }

    // Fuzzy fallback (≥60%)
    let bestScore = 0, bestIdx = -1;
    for (let i = 0; i <= candidateWords.length - phraseWords.length; i++) {
        let matching = 0;
        for (let j = 0; j < phraseWords.length; j++) {
            if (candidateWords[i + j] === phraseWords[j]) matching++;
        }
        const score = matching / phraseWords.length;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestScore >= 0.6 && bestIdx >= 0) {
        const result = mode === 'start'
            ? explodedWords[bestIdx].start
            : explodedWords[bestIdx + phraseWords.length - 1].end;
        console.log(`[PhraseMatch] ~ Fuzzy match (${(bestScore * 100).toFixed(0)}%) at word index ${bestIdx}: "${explodedWords.slice(bestIdx, bestIdx + phraseWords.length).map(e => e.word).join(' ')}" → ${result.toFixed(2)}s`);
        return result;
    }

    console.log(`[PhraseMatch] ✗ No match found (best fuzzy: ${(bestScore * 100).toFixed(0)}%)`);
    return null;
}

const PREAMBLE_STARTERS = new Set(['so', 'and', 'but', 'well', 'now', 'like', 'okay', 'ok', 'alright', 'um', 'uh', 'yeah']);
const PREAMBLE_PHRASES = ['you know', 'i mean', 'as i was saying', 'you know what', 'and i think', 'and so'];
const TRAILER_ENDERS = new Set(['right', 'amen', 'yeah', 'okay', 'ok', 'huh']);
const TRAILER_PHRASES_LIST = ['so yeah', 'you know', 'right right', 'you know what i mean'];

function trimPreambleWords(
    transcriptLines: { start: number; end: number; text: string }[],
    startTime: number, endTime: number
): number {
    const clipWords = transcriptLines.filter(l => l.start >= startTime - 0.01 && l.end <= endTime + 0.01);
    if (clipWords.length <= 3) return startTime;

    let trimCount = 0;
    const maxTrim = Math.min(3, Math.floor(clipWords.length * 0.15));

    for (let i = 0; i < maxTrim && i < clipWords.length; i++) {
        const word = clipWords[i].text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '');
        if (PREAMBLE_STARTERS.has(word)) { trimCount = i + 1; } else { break; }
    }

    if (trimCount === 0 && clipWords.length >= 2) {
        const twoWords = clipWords.slice(0, 2).map(w =>
            w.text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '')
        ).join(' ');
        for (const phrase of PREAMBLE_PHRASES) {
            if (twoWords === phrase || twoWords.startsWith(phrase)) { trimCount = 2; break; }
        }
    }

    if (trimCount > 0 && trimCount < clipWords.length) {
        console.log(`[TrimPreamble] Trimming ${trimCount} word(s): "${clipWords.slice(0, trimCount).map(w => w.text).join(' ')}"`);
        return clipWords[trimCount].start;
    }
    return startTime;
}

function trimTrailerWords(
    transcriptLines: { start: number; end: number; text: string }[],
    startTime: number, endTime: number
): number {
    const clipWords = transcriptLines.filter(l => l.start >= startTime - 0.01 && l.end <= endTime + 0.01);
    if (clipWords.length <= 3) return endTime;

    let trimCount = 0;
    const maxTrim = Math.min(3, Math.floor(clipWords.length * 0.15));

    for (let i = clipWords.length - 1; i >= clipWords.length - maxTrim && i >= 0; i--) {
        const word = clipWords[i].text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '');
        if (TRAILER_ENDERS.has(word)) { trimCount = clipWords.length - i; } else { break; }
    }

    if (trimCount === 0 && clipWords.length >= 2) {
        const lastTwo = clipWords.slice(-2).map(w =>
            w.text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '')
        ).join(' ');
        for (const phrase of TRAILER_PHRASES_LIST) {
            if (lastTwo === phrase) { trimCount = 2; break; }
        }
    }

    if (trimCount > 0) {
        const lastKeepIdx = clipWords.length - trimCount - 1;
        if (lastKeepIdx >= 0) {
            console.log(`[TrimTrailer] Trimming ${trimCount} word(s): "${clipWords.slice(-trimCount).map(w => w.text).join(' ')}"`);
            return clipWords[lastKeepIdx].end;
        }
    }
    return endTime;
}

// ==================== Helpers ====================

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
