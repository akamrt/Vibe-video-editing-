import { GoogleGenAI, Type } from "@google/genai";
import { Segment, VideoAnalysis, AnalysisEvent } from "../types";
import { trackUsage } from "./costTracker";

// ==================== Runtime API Key Management ====================
// The API key is NOT baked into the bundle. It is fetched from the backend
// at runtime, so it's only available to authenticated users.
let _cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (_cachedApiKey) return _cachedApiKey;
  const resp = await fetch('/api/config');
  if (!resp.ok) throw new Error('Failed to fetch API config — are you logged in?');
  const data = await resp.json();
  if (!data.geminiApiKey) throw new Error('No Gemini API key configured on the server.');
  _cachedApiKey = data.geminiApiKey;
  return _cachedApiKey;
}

/** Call this on logout to clear the cached key from memory */
export function clearCachedApiKey() {
  _cachedApiKey = null;
}

// Session cache to store uploaded file URIs.
// Key: file.name + file.size + file.lastModified
// Value: { uri: string, mimeType: string }
const sessionFileCache = new Map<string, { uri: string, mimeType: string }>();

const getFileCacheKey = (file: File) => `${file.name}-${file.size}-${file.lastModified}`;

/**
 * Helper to safely parse JSON that might be truncated or wrapped in Markdown.
 * @param text The raw text from Gemini
 * @param arrayKey The expected key for the main array (e.g., 'd' or 'events')
 */
const tryParseChunkedJson = (text: string, arrayKey: string): any => {
  // 1. Strip Markdown
  let cleanText = text.replace(/```json|```/g, '').trim();

  // 2. Try standard parse
  try {
    return JSON.parse(cleanText);
  } catch (e) {
    console.warn(`[GeminiService] JSON parse failed, attempting repair for key: ${arrayKey}...`);

    // 3. Attempt Repair for truncated JSON
    // We look for the last valid closing object "}," inside the array structure
    const lastObjectEnd = cleanText.lastIndexOf('},');

    if (lastObjectEnd !== -1) {
      // Cut off everything after the last successful object
      // and forcefully close the array and root object
      const repaired = cleanText.substring(0, lastObjectEnd + 1) + `]}`;
      try {
        const result = JSON.parse(repaired);
        console.log(`[GeminiService] JSON repaired successfully. Recovered items.`);
        return result;
      } catch (e2) {
        console.error("[GeminiService] JSON repair failed:", e2);
      }
    }
    return {};
  }
};

/**
 * Uploads a file to the Gemini File API and waits for it to be processed.
 * This prevents browser crashes by offloading storage and processing to Google's cloud.
 */
const uploadAndPollFile = async (file: File): Promise<{ mimeType: string; fileUri: string }> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  // Determine MIME type — file.type can be empty after IndexedDB restore
  const mimeType = file.type
    || (file.name?.match(/\.mp4$/i) ? 'video/mp4' : null)
    || (file.name?.match(/\.webm$/i) ? 'video/webm' : null)
    || (file.name?.match(/\.mov$/i) ? 'video/quicktime' : null)
    || (file.name?.match(/\.avi$/i) ? 'video/x-msvideo' : null)
    || (file.name?.match(/\.mkv$/i) ? 'video/x-matroska' : null)
    || 'video/mp4'; // fallback

  console.log(`[GeminiService] Starting upload: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB) type=${mimeType} isBlob=${file instanceof Blob} isFile=${file instanceof File}`);

  try {
    // 1. Upload the file — always pass mimeType explicitly (may be lost after IndexedDB restore)
    const uploadResponse = await ai.files.upload({
      file: file,
      config: { displayName: file.name || 'video.mp4', mimeType }
    });

    // API Response Robustness: Handle if 'file' is nested or the root object
    // This fixes "Cannot read properties of undefined (reading 'uri')"
    // @ts-ignore
    const uploadedFile = uploadResponse.file ?? uploadResponse;

    if (!uploadedFile || !uploadedFile.uri) {
      console.error("Unexpected upload response structure:", uploadResponse);
      throw new Error("Upload succeeded but file URI was missing from response.");
    }

    console.log(`[GeminiService] Upload complete. URI: ${uploadedFile.uri}. Status: ${uploadedFile.state}`);

    // 2. Poll until the file is ACTIVE
    let fileState = uploadedFile.state;
    let fileName = uploadedFile.name;

    let attempts = 0;
    const maxAttempts = 120; // 20 minutes timeout for very large files

    while (fileState === 'PROCESSING') {
      if (attempts >= maxAttempts) {
        throw new Error("Video processing timed out on Google servers.");
      }

      // Wait 10 seconds
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Check status
      const freshFileResponse = await ai.files.get({ name: fileName });
      // @ts-ignore
      const freshFile = freshFileResponse.file ?? freshFileResponse;

      fileState = freshFile.state;
      attempts++;
      console.log(`[GeminiService] Processing... (${attempts * 10}s) State: ${fileState}`);
    }

    if (fileState === 'FAILED') {
      throw new Error("Video processing failed on Google servers.");
    }

    console.log(`[GeminiService] File is ACTIVE and ready for analysis.`);

    return {
      mimeType: uploadedFile.mimeType,
      fileUri: uploadedFile.uri
    };

  } catch (error) {
    console.error("Upload/Processing Error:", error);
    const msg = error instanceof Error ? error.message : (typeof error === 'object' ? JSON.stringify(error) : String(error));
    throw new Error(`Failed to upload video: ${msg}`);
  }
};

/**
 * Prepares the media part for the API request.
 * Routes videos to the File API (Upload) and images/audio to Inline Data (Base64).
 * Checks session cache to avoid re-uploading the same file.
 */
const prepareMediaPart = async (file: File): Promise<any> => {
  // Check if it's a video file (by type or extension)
  const isVideo = file.type.startsWith('video/') || file.name.match(/\.(mp4|mov|avi|mkv|webm)$/i);

  if (isVideo) {
    const cacheKey = getFileCacheKey(file);

    // 1. Check Cache
    if (sessionFileCache.has(cacheKey)) {
      const cached = sessionFileCache.get(cacheKey)!;
      console.log(`[GeminiService] Cache Hit: Using existing URI ${cached.uri}`);
      return {
        fileData: {
          mimeType: cached.mimeType,
          fileUri: cached.uri
        }
      };
    }

    // 2. Upload if not cached
    const fileData = await uploadAndPollFile(file);

    // 3. Store in Cache
    sessionFileCache.set(cacheKey, { uri: fileData.fileUri, mimeType: fileData.mimeType });

    return { fileData };
  }

  // AUDIO/IMAGE: Use Inline (Base64) - usually small enough
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64 = base64String.split(",")[1];
      resolve({
        inlineData: {
          mimeType: file.type || 'audio/wav', // Fallback for raw audio blobs
          data: base64
        }
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

export const analyzeVideoContent = async (
  videoFile: File,
  promptText: string
): Promise<string> => {
  try {
    const apiKey = await getApiKey();
    const ai = new GoogleGenAI({ apiKey });
    const mediaPart = await prepareMediaPart(videoFile);

    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: {
        parts: [
          mediaPart,
          { text: promptText },
        ],
      },
    });
    trackUsage("Video Analysis", "gemini-3-pro-preview", response.usageMetadata);

    return response.text || "No analysis could be generated.";
  } catch (error) {
    console.error("Video analysis error:", error);
    throw error;
  }
};

/**
 * Specialized parser for the Plain Text subtitle format.
 * Format: [StartSeconds - EndSeconds] Content
 */
const parseSubtitleText = (text: string): AnalysisEvent[] => {
  const lines = text.split('\n');
  const events: AnalysisEvent[] = [];
  // Regex matches: [0.00 - 1.20] Text OR [0:00 - 0:02] Text
  const timeRegex = /\[(\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?)\s*-\s*(\d+(?:\.\d+)?(?::\d+(?:\.\d+)?)?)\]\s*(.*)/;

  const parseTime = (t: string) => {
    // Handle MM:SS format if model outputs it
    if (t.includes(':')) {
      const parts = t.split(':');
      if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
      if (parts.length === 3) return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    // Handle raw seconds
    return parseFloat(t);
  };

  for (const line of lines) {
    const match = line.match(timeRegex);
    if (match) {
      const start = parseTime(match[1]);
      const end = parseTime(match[2]);
      const content = match[3].trim();

      if (!isNaN(start) && !isNaN(end) && content) {
        events.push({
          startTime: start,
          endTime: end,
          type: 'dialogue',
          label: 'Speaker',
          details: content
        });
      }
    }
  }
  return events;
};

/**
 * Specialized function for High-Fidelity Audio Transcription.
 * 
 * OPTIMIZATIONS:
 * 1. Uses Plain Text output to save tokens (JSON overhead is heavy).
 * 2. Enforces line-by-line format for synchronization accuracy.
 */
const generateGranularSubtitles = async (mediaPart: any): Promise<AnalysisEvent[]> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });
  console.log("[GeminiService] Starting granular subtitle generation (Text Mode)...");

  const prompt = `
      Task: Create accurate subtitles for the ENTIRE duration of the video.
      
      INSTRUCTIONS:
      1. Transcribe spoken dialogue exactly.
      2. Break into short, readable segments (3-8 words max).
      3. TIMESTAMPS: Use Seconds (e.g. 150.5). Be extremely precise with start and end times.
      4. COVERAGE: Do not stop early. Transcribe until the very end.
      
      OUTPUT FORMAT:
      [StartSeconds - EndSeconds] Text Content
      [StartSeconds - EndSeconds] Text Content
      
      Example:
      [0.00 - 2.50] Hello everyone and welcome back.
      [2.50 - 4.10] Today we are going to build a rocket.
      [4.10 - 7.00] It is going to be a very long journey.
      
      Constraints:
      - No Markdown. No JSON. Just the lines.
      - Ensure synchronization.
    `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: {
        parts: [mediaPart, { text: prompt }]
      },
      config: {
        // High token limit to allow full video transcription
        maxOutputTokens: 8192,
      }
    });
    trackUsage("Transcription", "gemini-3-flash-preview", response.usageMetadata);

    const text = response.text || "";
    const events = parseSubtitleText(text);

    console.log(`[GeminiService] Parsed ${events.length} subtitle lines.`);
    return events;

  } catch (e) {
    console.warn("Subtitle generation failed", e);
    return [];
  }
};

/**
 * Specialized function for Visual Event Analysis using Pro.
 */
const generateVisualEvents = async (mediaPart: any, customFocus: string): Promise<AnalysisEvent[]> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });
  console.log("[GeminiService] Starting visual analysis...");

  const prompt = `
      Task: Analyze visual events in this video.
      Focus: ${customFocus || "General key actions and people"}
      
      Rules:
      1. Identify people entering/leaving.
      2. Identify key actions (running, falling, laughing).
      3. IGNORE DIALOGUE (This is handled by a separate process).
      
      Output JSON Format:
      {
        "events": [
          { "startTime": number, "endTime": number, "type": "visual" | "action", "label": "string", "details": "string" }
        ]
      }
    `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: {
        parts: [mediaPart, { text: prompt }]
      },
      config: {
        responseMimeType: "application/json",
      }
    });
    trackUsage("Visual Analysis", "gemini-3-pro-preview", response.usageMetadata);

    const text = response.text || "{}";
    const json = tryParseChunkedJson(text, 'events');
    return Array.isArray(json.events) ? json.events : [];
  } catch (e) {
    console.warn("Visual analysis failed", e);
    return [];
  }
};

export const performDeepAnalysis = async (
  videoFile: File,
  duration: number,
  customFocus: string = "",
  existingAnalysis: VideoAnalysis | null = null,
  options: { skipAudio?: boolean, skipVisual?: boolean } = {}
): Promise<VideoAnalysis> => {

  // Upload & Process Video (or retrieve from cache)
  const mediaPart = await prepareMediaPart(videoFile);

  // Run Transcription (Flash) and Visual Analysis (Pro) in parallel
  // This ensures we get high quality subtitles AND deep visual understanding without timeouts
  try {
    const promises: Promise<AnalysisEvent[]>[] = [];

    if (!options.skipAudio) {
      promises.push(generateGranularSubtitles(mediaPart));
    } else {
      console.log("[GeminiService] Skipping audio analysis (using existing transcript).");
      promises.push(Promise.resolve([]));
    }

    if (!options.skipVisual) {
      promises.push(generateVisualEvents(mediaPart, customFocus));
    } else {
      promises.push(Promise.resolve([]));
    }

    const [subtitles, visualEvents] = await Promise.all(promises);

    // Merge logic:
    let finalEvents = [...subtitles, ...visualEvents];

    // If we are appending to existing analysis (e.g. adding visuals to trusted transcript)
    if (existingAnalysis && existingAnalysis.events) {
      // If we skipped audio, we likely want to keep the old dialogue
      if (options.skipAudio) {
        const oldDialogue = existingAnalysis.events.filter(e => e.type === 'dialogue');
        finalEvents = [...finalEvents, ...oldDialogue];
      }
    }

    // Sort by start time
    finalEvents.sort((a, b) => a.startTime - b.startTime);

    return {
      summary: "Deep analysis complete (Audio + Visual)",
      events: finalEvents,
      generatedAt: new Date()
    };

  } catch (e) {
    console.error("Deep analysis failed", e);
    throw new Error("Failed to perform deep analysis.");
  }
};

export const chatWithVideoContext = async (
  history: { role: string; parts: { text: string }[] }[],
  message: string,
  videoFile: File | null
): Promise<string> => {
  try {
    const apiKey = await getApiKey();
    const ai = new GoogleGenAI({ apiKey });
    const model = "gemini-3-pro-preview";

    // Prepare message parts
    let parts: any[] = [{ text: message }];

    if (videoFile) {
      try {
        // Upload the video context (or retrieve from cache)
        const mediaPart = await prepareMediaPart(videoFile);
        parts.unshift(mediaPart);
      } catch (e) {
        console.warn("Could not attach video to chat context:", e);
        parts[0].text += "\n[System Note: Video context unavailable due to upload failure.]";
      }
    }

    const chat = ai.chats.create({
      model: model,
      history: history as any,
    });

    const result = await chat.sendMessage(parts.length > 1 ? parts : [{ text: message }]);
    trackUsage("Chat", model, result.usageMetadata);
    return result.text || "I couldn't generate a response.";
  } catch (error) {
    console.error("Chat error:", error);
    throw error;
  }
};

export const generateVibeEdit = async (
  videoFile: File,
  instructions: string,
  videoDuration: number,
  existingAnalysis: VideoAnalysis | null
): Promise<Segment[]> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  // Upload Video (or retrieve from cache)
  const mediaPart = await prepareMediaPart(videoFile);

  // Construct the prompt. If analysis exists, we inject it.
  let analysisContext = "";
  if (existingAnalysis) {
    // Use a limited slice of events to avoid token overflow in edit prompt
    analysisContext = `
      PRE-COMPUTED VIDEO ANALYSIS (Use this to locate specific content/people):
      ${JSON.stringify(existingAnalysis.events.slice(0, 150))} 
      (Note: list may be truncated if very long, but contains key events)
      `;
  }

  const prompt = `
    You are a professional video editor. 
    Task: Analyze the provided video ${existingAnalysis ? "AND the pre-computed analysis log" : ""} to generate a list of edit segments (cuts).
    
    User Instruction: "${instructions}"
    Video Duration: ${videoDuration}s.

    ${analysisContext}

    Instructions:
    1. If the user asks to "remove" or "exclude" something (e.g. "remove blonde girl"), look at the ANALYSIS LOG (if provided) or visual data to find when that subject is present, and ensure those time ranges are NOT in your output list.
    2. If the user asks to "keep" only X, find X in the analysis/video and only output those segments.
    3. Auto-detect logical cut points (people entering/leaving, speech starting/stopping) to make the edit smooth.
    
    Return the response strictly as a JSON object with a "segments" property containing an array of objects.
    Each object must have:
    - "startTime": number (in seconds)
    - "endTime": number (in seconds)
    - "description": string (keep concise, under 10 words)
    - "color": string (hex code)

    Constraints:
    - Ensure timecodes are within 0 and ${videoDuration}.
    - The segments should represent the parts of the video to KEEP.
    - Limit to 40 segments max.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: {
      parts: [
        mediaPart,
        { text: prompt },
      ],
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          segments: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startTime: { type: Type.NUMBER },
                endTime: { type: Type.NUMBER },
                description: { type: Type.STRING },
                color: { type: Type.STRING }
              }
            }
          }
        }
      }
    },
  });
  trackUsage("Vibe Edit", "gemini-3-pro-preview", response.usageMetadata);

  const parseSegments = (json: any) => {
    if (json.segments && Array.isArray(json.segments)) {
      return json.segments.map((s: any, index: number) => ({
        description: s.description || "Untitled Segment",
        color: s.color || "#3b82f6",
        // Robust parsing to handle potential AI quirks or strings
        startTime: typeof s.startTime === 'number' ? s.startTime : parseFloat(s.startTime || '0'),
        endTime: typeof s.endTime === 'number' ? s.endTime : parseFloat(s.endTime || '0'),
        id: `auto-seg-${index}-${Date.now()}`
      }));
    }
    return [];
  };

  try {
    let text = response.text || "{}";
    const json = tryParseChunkedJson(text, 'segments');
    return parseSegments(json);
  } catch (e) {
    console.error("Failed to parse edit decisions", e);
    throw new Error("Failed to generate edit decisions. The analysis might have been too long.");
  }
};

export const transcribeAudio = async (audioBlob: Blob): Promise<string> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  // Audio is usually small enough for Base64 inline
  const reader = new FileReader();
  const base64Promise = new Promise<string>((resolve, reject) => {
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64 = base64String.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(audioBlob);
  });

  const base64Audio = await base64Promise;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: "audio/wav",
            data: base64Audio,
          },
        },
        { text: "Transcribe this audio exactly as spoken." },
      ],
    },
  });
  trackUsage("Audio Transcription", "gemini-3-flash-preview", response.usageMetadata);

  return response.text || "";
};

// ============ PERSON DETECTION (for auto-centering) ============

export interface PersonDetectionResult {
  personVisible: boolean;
  centerX: number;  // 0-100, percentage from left
  centerY: number;  // 0-100, percentage from top
  confidence: number; // 0-100
}

export const detectPersonPosition = async (
  imageBlob: Blob
): Promise<PersonDetectionResult> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(imageBlob);
  });

  const prompt = `Analyze this video frame. Find the most prominent person in the image.

Return their position as a percentage of the frame dimensions:
- centerX: horizontal center of the person's body/torso (0 = left edge, 50 = center, 100 = right edge)
- centerY: vertical center of the person's chest/torso area — NOT the top of their head, but the middle of their visible body (0 = top edge, 50 = center, 100 = bottom edge). For a typical talking-head shot where only the upper body is visible, this should be roughly the vertical center of the visible portion.
- personVisible: true if a person is clearly visible, false if not
- confidence: 0-100 how confident you are in the detection

IMPORTANT: centerX and centerY should represent the point that, if placed at the center of the frame, would best center the person visually. Think of it as the "visual center of mass" of the person.

If multiple people are visible, focus on the most prominent/central person (usually the speaker).
If no person is visible, set personVisible to false and centerX/centerY to 50.`;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: "image/png",
            data: base64,
          },
        },
        { text: prompt },
      ],
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          personVisible: { type: Type.BOOLEAN },
          centerX: { type: Type.NUMBER },
          centerY: { type: Type.NUMBER },
          confidence: { type: Type.NUMBER },
        },
      },
    },
  });
  trackUsage("Person Detection", "gemini-3-flash-preview", response.usageMetadata);

  const text = response.text || "{}";
  try {
    const json = JSON.parse(text);
    console.log("[GeminiService] Raw person detection response:", JSON.stringify(json));
    
    let cx = json.centerX ?? 50;
    let cy = json.centerY ?? 50;
    
    // Handle case where model returns 0-1 range instead of 0-100
    if (cx <= 1 && cy <= 1 && cx >= 0 && cy >= 0) {
      console.warn("[GeminiService] Detected 0-1 range, converting to 0-100");
      cx *= 100;
      cy *= 100;
    }
    
    const result = {
      personVisible: json.personVisible ?? false,
      centerX: Math.max(0, Math.min(100, cx)),
      centerY: Math.max(0, Math.min(100, cy)),
      confidence: json.confidence ?? 0,
    };
    console.log("[GeminiService] Parsed detection:", result);
    return result;
  } catch (e) {
    console.warn("[GeminiService] Person detection parse failed:", e);
    return { personVisible: false, centerX: 50, centerY: 50, confidence: 0 };
  }
};

// ── Filler Word Detection ──────────────────────────────────────────

export interface FillerDetection {
  startTime: number;
  endTime: number;
  text: string;
  type: 'filler' | 'repeated' | 'stammer';
}

const parseFillerDetections = (text: string): FillerDetection[] => {
  // Strip markdown code fences if the model wrapped output in ```
  let cleaned = text.replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, '').replace(/```/g, ''));
  // Also handle if the entire response is in a code block
  cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');

  const lines = cleaned.split('\n');
  const detections: FillerDetection[] = [];

  // Multiple regex patterns to handle different model output formats
  const patterns = [
    // Standard: [3.20 - 3.55] [FILLER] um
    /\[(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\]\s*\[(FILLER|REPEATED|STAMMER)\]\s*(.*)/i,
    // With 's' suffix: [3.20s - 3.55s] [FILLER] um
    /\[(\d+(?:\.\d+)?)s?\s*-\s*(\d+(?:\.\d+)?)s?\]\s*\[(FILLER|REPEATED|STAMMER)\]\s*(.*)/i,
    // Pipe/dash separated: 3.20 - 3.55 | FILLER | um  OR  3.20 - 3.55 - FILLER - um
    /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*[\|:\-]\s*(FILLER|REPEATED|STAMMER)\s*[\|:\-]\s*(.*)/i,
    // Parentheses: (3.20 - 3.55) [FILLER] um
    /\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\)\s*\[(FILLER|REPEATED|STAMMER)\]\s*(.*)/i,
    // Timestamps with colon format: [0:03.20 - 0:03.55] — skip these, handled below
  ];

  // Also handle mm:ss or m:ss.ms timestamps
  const mmssPattern = /\[?(\d+):(\d+(?:\.\d+)?)\s*-\s*(\d+):(\d+(?:\.\d+)?)\]?\s*\[(FILLER|REPEATED|STAMMER)\]\s*(.*)/i;

  let unmatchedNonEmpty = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'NONE' || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;

    let matched = false;

    // Try mm:ss pattern first
    const mmssMatch = trimmed.match(mmssPattern);
    if (mmssMatch) {
      const start = parseFloat(mmssMatch[1]) * 60 + parseFloat(mmssMatch[2]);
      const end = parseFloat(mmssMatch[3]) * 60 + parseFloat(mmssMatch[4]);
      const type = mmssMatch[5].toLowerCase() as 'filler' | 'repeated' | 'stammer';
      const detectedText = mmssMatch[6].trim();
      if (!isNaN(start) && !isNaN(end) && end > start && detectedText) {
        detections.push({ startTime: start, endTime: end, text: detectedText, type });
        matched = true;
      }
    }

    // Try standard patterns
    if (!matched) {
      for (const regex of patterns) {
        const match = trimmed.match(regex);
        if (match) {
          const start = parseFloat(match[1]);
          const end = parseFloat(match[2]);
          const type = match[3].toLowerCase() as 'filler' | 'repeated' | 'stammer';
          const detectedText = match[4].trim();
          if (!isNaN(start) && !isNaN(end) && end > start && detectedText) {
            detections.push({ startTime: start, endTime: end, text: detectedText, type });
            matched = true;
            break;
          }
        }
      }
    }

    if (!matched) unmatchedNonEmpty++;
  }

  if (unmatchedNonEmpty > 0) {
    console.warn(`[GeminiService] ${unmatchedNonEmpty} lines didn't match any filler pattern. Raw text:\n${cleaned}`);
  }
  console.log(`[GeminiService] Parsed ${detections.length} filler detections.`);
  return detections;
};

/** Build the filler detection prompt for a time window */
const buildFillerPrompt = (duration: number, windowStart: number, windowEnd: number, passLabel: string) => `
Task: Analyze the audio in this video from ${windowStart.toFixed(1)}s to ${windowEnd.toFixed(1)}s and identify ALL filler words, repeated words, stammering, and fumbled speech that should be removed for a clean edit.

Video Duration: ${duration}s. You are analyzing the window [${windowStart.toFixed(1)}s - ${windowEnd.toFixed(1)}s]. ${passLabel}

WHAT TO DETECT:
1. FILLER WORDS: "um", "uh", "er", "ah", "like" (when used as filler), "you know" (when filler),
   "I mean" (when filler), "so" (when used to stall), "basically", "literally" (when filler),
   "right" (when used as verbal tic), "kind of" / "sort of" (when filler)
2. REPEATED WORDS: When the speaker says the same word twice in a row
   (e.g., "the the", "I I", "we we")
3. STAMMERING: False starts, stuttering, abandoned words/phrases
   (e.g., "I was g- I was going to")
4. LONG PAUSES: Unnatural silences or hesitations mid-sentence (> 0.5s)
5. FALSE STARTS: Beginning a word or phrase and restarting it
   (e.g., "I th- I think", "we should- we need to")

IMPORTANT RULES:
- Be EXTREMELY precise with timestamps in seconds, marking ONLY the filler portion.
- The time range should be tight — only the filler itself, not surrounding clean speech.
- Add a small padding of ~0.05s before and after for natural cutting.
- Include the TYPE in brackets before the text: [FILLER], [REPEATED], or [STAMMER]
- Do NOT flag intentional repetition for emphasis or rhetorical use.
- Transcribe the EXACT filler/stammer as spoken.
- Listen carefully to EVERY word — even brief "uh" or "um" sounds between words count.
- Pay special attention to transitions between sentences where fillers commonly hide.

OUTPUT FORMAT (one per line, no markdown, no JSON):
[StartSeconds - EndSeconds] [TYPE] detected text

Example:
[3.20 - 3.55] [FILLER] um
[7.80 - 8.10] [FILLER] uh
[12.40 - 13.00] [REPEATED] the the
[15.60 - 16.30] [STAMMER] I was g- I was

If there are NO filler words in this window, output exactly: NONE

Constraints:
- No Markdown. No JSON. Just the lines.
- Only report fillers within the window [${windowStart.toFixed(1)}s - ${windowEnd.toFixed(1)}s].
- Timestamps must be within ${windowStart.toFixed(1)} and ${windowEnd.toFixed(1)}.
`;

/** Retry a Gemini API call with exponential backoff on 429 rate limit errors */
const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  onRetry?: (attempt: number, waitSec: number) => void
): Promise<T> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const is429 = e?.status === 429 || e?.message?.includes('429') || e?.message?.includes('RESOURCE_EXHAUSTED');
      if (!is429 || attempt === maxRetries) throw e;
      const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000); // 2s, 4s, 8s... max 30s
      onRetry?.(attempt + 1, waitMs / 1000);
      console.log(`[GeminiService] Rate limited, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw new Error('Unreachable');
};

/** Deduplicate filler detections — remove any that overlap an existing detection by >50% */
const deduplicateFillers = (existing: FillerDetection[], newOnes: FillerDetection[]): FillerDetection[] => {
  const unique: FillerDetection[] = [];
  for (const n of newOnes) {
    const nDur = n.endTime - n.startTime;
    const isDuplicate = existing.some(e => {
      const overlapStart = Math.max(e.startTime, n.startTime);
      const overlapEnd = Math.min(e.endTime, n.endTime);
      if (overlapStart >= overlapEnd) return false;
      const overlap = overlapEnd - overlapStart;
      return overlap > nDur * 0.5;
    });
    if (!isDuplicate) unique.push(n);
  }
  return unique;
};

/**
 * Text-based filler detection — analyzes timestamped transcript text only.
 * ~35x cheaper than video upload. Catches fillers present in the transcript
 * but cannot detect non-verbal hesitations that weren't transcribed.
 */
export const detectFillersFromTranscript = async (
  transcript: Array<{ startTime: number; endTime: number; text: string }>,
  onProgress?: (msg: string) => void
): Promise<FillerDetection[]> => {
  if (transcript.length === 0) return [];

  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  onProgress?.('Analyzing transcript for filler words...');

  const lines = transcript
    .map(e => `[${e.startTime.toFixed(2)} - ${e.endTime.toFixed(2)}] ${e.text}`)
    .join('\n');

  const prompt = `Task: Analyze this timestamped transcript and identify ALL filler words, repeated words, and stammering that should be removed for a clean edit.

TRANSCRIPT:
${lines}

WHAT TO DETECT:
1. FILLER WORDS: "um", "uh", "er", "ah", "like" (when used as filler), "you know" (when filler),
   "I mean" (when filler), "so" (when used to stall), "basically", "literally" (when filler),
   "right" (when used as verbal tic), "kind of" / "sort of" (when filler)
2. REPEATED WORDS: When the speaker says the same word twice in a row
   (e.g., "the the", "I I", "we we")
3. STAMMERING: False starts, stuttering, abandoned words/phrases
   (e.g., "I was g- I was going to")

IMPORTANT RULES:
- Use the timestamps from the transcript lines to estimate filler positions.
- If a filler word appears within a line, estimate its position proportionally within that line's time range.
- Be PRECISE — only mark actual fillers, not intentional use of words.
- Do NOT flag intentional repetition for emphasis or rhetorical use.

OUTPUT FORMAT (one per line, no markdown, no JSON):
[StartSeconds - EndSeconds] [TYPE] detected text

Example:
[3.20 - 3.55] [FILLER] um
[12.40 - 13.00] [REPEATED] the the

If there are NO filler words, output exactly: NONE

Constraints:
- No Markdown. No JSON. Just the lines.
`;

  const response = await retryWithBackoff(
    () => ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 8192 }
    }),
    3,
    (attempt, waitSec) => onProgress?.(`Rate limited, retrying in ${waitSec}s...`)
  );
  trackUsage("Filler Detection (text)", "gemini-2.0-flash", response.usageMetadata);

  const text = response.text || "";
  console.log(`[GeminiService] Text-based filler detection raw (${text.length} chars):`, text);

  let detections: FillerDetection[] = [];
  if (text.trim() !== 'NONE') {
    detections = parseFillerDetections(text);
  }

  detections.sort((a, b) => a.startTime - b.startTime);
  onProgress?.(`Found ${detections.length} fillers`);
  console.log(`[GeminiService] Text-based detections: ${detections.length}`);
  return detections;
};

/**
 * Transcript-based re-detection — tells the AI what was already found and asks
 * it to look for anything MISSED. Uses text only (~35x cheaper than video upload).
 */
export const redetectFillersFromTranscript = async (
  transcript: Array<{ startTime: number; endTime: number; text: string }>,
  existingDetections: FillerDetection[],
  onProgress?: (msg: string) => void
): Promise<FillerDetection[]> => {
  if (transcript.length === 0) return [];

  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  onProgress?.('Re-analyzing transcript for missed fillers...');

  const lines = transcript
    .map(e => `[${e.startTime.toFixed(2)} - ${e.endTime.toFixed(2)}] ${e.text}`)
    .join('\n');

  const existingList = existingDetections
    .map(d => `[${d.startTime.toFixed(2)} - ${d.endTime.toFixed(2)}] [${d.type.toUpperCase()}] ${d.text}`)
    .join('\n');

  const prompt = `Task: You previously analyzed this transcript and found these filler words:

--- ALREADY DETECTED (DO NOT report these again) ---
${existingList || '(none)'}
--- END OF ALREADY DETECTED ---

Now re-read the transcript MORE CAREFULLY and find any filler words, stammers,
repeated words, or fumbled speech that were MISSED in the first pass.

TRANSCRIPT:
${lines}

WHAT TO DETECT (be MORE aggressive this pass — catch subtle fillers):
1. FILLER WORDS: Even very brief "um", "uh", "er", "ah". Also "like", "you know",
   "I mean", "so", "basically", "literally", "right", "kind of", "sort of" when used as verbal filler.
2. REPEATED WORDS: "the the", "I I", "we we", "and and", etc.
3. STAMMERING: Any false starts, stuttering, or abandoned words/phrases.
4. FALSE STARTS: "I th- I think", "we should- we need to", etc.

IMPORTANT RULES:
- Use the timestamps from the transcript lines to estimate filler positions.
- If a filler word appears within a line, estimate its position proportionally within that line's time range.
- Do NOT re-report any detection from the ALREADY DETECTED list above.
- Only report NEW fillers that were missed.

OUTPUT FORMAT (one per line, no markdown, no JSON):
[StartSeconds - EndSeconds] [TYPE] detected text

If there are NO additional filler words found, output exactly: NONE

Constraints:
- No Markdown. No JSON. Just the lines.
- Do NOT duplicate any previously detected filler.
`;

  const response = await retryWithBackoff(
    () => ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 8192 }
    }),
    3,
    (attempt, waitSec) => onProgress?.(`Rate limited, retrying in ${waitSec}s...`)
  );
  trackUsage("Filler Re-detection (text)", "gemini-2.0-flash", response.usageMetadata);

  const text = response.text || "";
  console.log("[GeminiService] Text-based re-detect raw response:", text);

  if (text.trim() === 'NONE') {
    onProgress?.('No additional fillers found');
    return [];
  }

  const newDetections = parseFillerDetections(text);
  const unique = deduplicateFillers(existingDetections, newDetections);

  onProgress?.(`Found ${unique.length} additional fillers`);
  console.log(`[GeminiService] Text-based re-detect: ${unique.length} new (${newDetections.length} raw, ${newDetections.length - unique.length} duplicates removed)`);
  return unique;
};

/**
 * Primary filler detection — single request for the entire video.
 * Gemini processes the full video regardless of time-window prompts, so chunking
 * just re-processes the same file N times. One comprehensive pass is faster and avoids rate limits.
 */
export const detectFillerWords = async (
  videoFile: File,
  duration: number,
  onProgress?: (msg: string) => void
): Promise<FillerDetection[]> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  onProgress?.('Uploading video to AI...');
  console.log("[GeminiService] Starting filler word detection...");
  const mediaPart = await prepareMediaPart(videoFile);

  onProgress?.('Analyzing audio for filler words...');
  const prompt = buildFillerPrompt(duration, 0, duration, 'Analyze the ENTIRE video thoroughly.');

  const response = await retryWithBackoff(
    () => ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: { parts: [mediaPart, { text: prompt }] },
      config: { maxOutputTokens: 8192 }
    }),
    3,
    (attempt, waitSec) => onProgress?.(`Rate limited, retrying in ${waitSec}s...`)
  );
  trackUsage("Filler Detection", "gemini-2.0-flash", response.usageMetadata);

  const text = response.text || "";
  console.log(`[GeminiService] Filler detection raw (${text.length} chars):`, text);
  console.log(`[GeminiService] Response object keys:`, Object.keys(response));
  if (!text || text.length < 5) {
    console.warn(`[GeminiService] Response text is very short or empty! Full response:`, JSON.stringify(response).slice(0, 500));
  }

  let detections: FillerDetection[] = [];
  if (text.trim() !== 'NONE') {
    detections = parseFillerDetections(text);
    if (detections.length === 0 && text.trim().length > 10) {
      console.warn(`[GeminiService] Parser returned 0 detections but response was not NONE. First 500 chars:\n${text.slice(0, 500)}`);
    }
  }

  detections.sort((a, b) => a.startTime - b.startTime);
  onProgress?.(`Found ${detections.length} fillers`);
  console.log(`[GeminiService] Total detections: ${detections.length}`);
  return detections;
};

/**
 * Re-detect fillers — tells the AI what was already found and asks it to look
 * for anything that was MISSED. Uses a more aggressive/sensitive prompt.
 */
export const redetectFillerWords = async (
  videoFile: File,
  duration: number,
  existingDetections: FillerDetection[],
  onProgress?: (msg: string) => void
): Promise<FillerDetection[]> => {
  const apiKey = await getApiKey();
  const ai = new GoogleGenAI({ apiKey });

  onProgress?.('Uploading video to AI...');
  const mediaPart = await prepareMediaPart(videoFile);

  // Format existing detections as context
  const existingList = existingDetections
    .map(d => `[${d.startTime.toFixed(2)} - ${d.endTime.toFixed(2)}] [${d.type.toUpperCase()}] ${d.text}`)
    .join('\n');

  // Build gap windows — focus on time ranges BETWEEN existing detections
  const gaps: string[] = [];
  const sorted = [...existingDetections].sort((a, b) => a.startTime - b.startTime);
  let cursor = 0;
  for (const d of sorted) {
    if (d.startTime - cursor > 0.5) {
      gaps.push(`${cursor.toFixed(1)}s - ${d.startTime.toFixed(1)}s`);
    }
    cursor = Math.max(cursor, d.endTime);
  }
  if (duration - cursor > 0.5) {
    gaps.push(`${cursor.toFixed(1)}s - ${duration.toFixed(1)}s`);
  }

  onProgress?.('Re-analyzing for missed fillers...');

  const prompt = `
Task: You previously analyzed this video's audio and found these filler words:

--- ALREADY DETECTED (DO NOT report these again) ---
${existingList || '(none)'}
--- END OF ALREADY DETECTED ---

Now listen to the ENTIRE video again MORE CAREFULLY and find any filler words, stammers,
repeated words, or fumbled speech that were MISSED in the first pass.

Video Duration: ${duration}s.

PRIORITY AREAS TO RE-CHECK (gaps between previously detected fillers):
${gaps.join('\n')}

WHAT TO DETECT (be MORE aggressive this pass — catch subtle/quiet fillers):
1. FILLER WORDS: Even very brief/quiet "um", "uh", "er", "ah" sounds. Also "like", "you know",
   "I mean", "so", "basically", "literally", "right", "kind of", "sort of" when used as verbal filler.
2. REPEATED WORDS: "the the", "I I", "we we", "and and", etc.
3. STAMMERING: Any false starts, stuttering, or abandoned words/phrases.
4. BREATH FILLERS: Audible inhales/exhales used as stalling between phrases.
5. FALSE STARTS: "I th- I think", "we should- we need to", etc.

CRITICAL: Do NOT re-report any detection from the ALREADY DETECTED list above.
Only report NEW fillers that were missed.

OUTPUT FORMAT (one per line, no markdown, no JSON):
[StartSeconds - EndSeconds] [TYPE] detected text

If there are NO additional filler words found, output exactly: NONE

Constraints:
- No Markdown. No JSON. Just the lines.
- Timestamps must be within 0 and ${duration}.
- Do NOT duplicate any previously detected filler.
`;

  const response = await retryWithBackoff(
    () => ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: { parts: [mediaPart, { text: prompt }] },
      config: { maxOutputTokens: 8192 }
    }),
    3,
    (attempt, waitSec) => onProgress?.(`Rate limited, retrying in ${waitSec}s...`)
  );
  trackUsage("Filler Re-detection", "gemini-2.0-flash", response.usageMetadata);

  const text = response.text || "";
  console.log("[GeminiService] Re-detect raw response:", text);

  if (text.trim() === 'NONE') {
    onProgress?.('No additional fillers found');
    return [];
  }

  const newDetections = parseFillerDetections(text);
  // Safety: deduplicate against existing even if the AI was told not to repeat
  const unique = deduplicateFillers(existingDetections, newDetections);
  onProgress?.(`Found ${unique.length} additional fillers`);
  return unique;
};