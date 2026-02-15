/**
 * Content AI Service
 * 
 * Calls server-side AI endpoints for content search and short generation.
 * This keeps the API key secure on the server and avoids browser rate limits.
 */

import { contentDB, VideoRecord, TranscriptSegment, GeneratedShort, ShortSegment, generateId } from "./contentDatabase";

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
        `[${Math.floor(seg.start)} - ${Math.floor(seg.start + seg.duration)}] ${seg.text}`
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
            text: clip.text
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

// ==================== Helpers ====================

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}
