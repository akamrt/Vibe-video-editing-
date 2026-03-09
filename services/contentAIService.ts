/**
 * Content AI Service
 * 
 * Calls server-side AI endpoints for content search and short generation.
 * This keeps the API key secure on the server and avoids browser rate limits.
 */

import { contentDB, VideoRecord, TranscriptSegment, GeneratedShort, ShortSegment, generateId } from "./contentDatabase";
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
    const transcriptWithTimestamps = segments.map(seg =>
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

    const transcriptWithTimestamps = segments.map(seg =>
        `[${seg.start.toFixed(1)} - ${(seg.start + seg.duration).toFixed(1)}] ${seg.text}`
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

        // Remove trailing commas before closing braces/brackets (common LLM mistake)
        cleanJsonString = cleanJsonString.replace(/,\s*([\]}])/g, '$1');

        // Remove unescaped control characters (newlines) inside strings (another common LLM mistake)
        cleanJsonString = cleanJsonString.replace(/[\u0000-\u0019]+/g, "");

        let json;
        try {
            json = JSON.parse(cleanJsonString);
        } catch (parseErr) {
            // If the parse fails, see if we can do a more aggressive cleanup or just fail gracefully with the original error
            console.warn("First JSON parse attempt failed, trying aggressive cleanup...", parseErr);
            // sometimes quotes inside strings are unescaped. It's very hard to fix safely with regex.
            // We just throw the original error if we can't parse it.
            throw parseErr;
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

        let shortsToProcess = [];
        if (json.shorts && Array.isArray(json.shorts)) {
            shortsToProcess = json.shorts;
        } else if (Array.isArray(json)) {
            shortsToProcess = json;
        } else if (json.clips) {
            shortsToProcess = [json];
        } else {
            return { success: false, error: "JSON must contain a 'shorts' array or a valid 'clips' array" };
        }

        if (shortsToProcess.length === 0) {
            return { success: false, error: "No shorts found in JSON" };
        }

        const generatedShorts: GeneratedShort[] = [];

        for (const [index, shortData] of shortsToProcess.entries()) {
            if (!shortData.clips || !Array.isArray(shortData.clips)) {
                console.warn(`Skipping short at index ${index} due to missing clips array.`);
                continue;
            }

            const shortSegments: ShortSegment[] = shortData.clips.map((clip: any) => {
                const startTime = parseTime(clip.startTime);
                const endTime = parseTime(clip.endTime);
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

            await contentDB.addShort(generatedShort);
            generatedShorts.push(generatedShort);
        }

        if (generatedShorts.length === 0) {
            return { success: false, error: "Failed to parse any valid shorts from JSON" };
        }

        return { success: true, short: generatedShorts[0], shorts: generatedShorts };
    } catch (error) {
        return { success: false, error: "JSON Parse error: " + (error instanceof Error ? error.message : "Invalid JSON format") };
    }
}

// ==================== Helpers ====================

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
