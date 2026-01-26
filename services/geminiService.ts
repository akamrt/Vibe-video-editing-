import { GoogleGenAI, Type } from "@google/genai";
import { Segment, VideoAnalysis, AnalysisEvent } from "../types";

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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    console.log(`[GeminiService] Starting upload: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);

    try {
        // 1. Upload the file
        const uploadResponse = await ai.files.upload({
            file: file,
            config: { displayName: file.name }
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
        throw new Error(`Failed to process video: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
  existingAnalysis: VideoAnalysis | null = null
): Promise<VideoAnalysis> => {
    
    // Upload & Process Video (or retrieve from cache)
    const mediaPart = await prepareMediaPart(videoFile);

    // Run Transcription (Flash) and Visual Analysis (Pro) in parallel
    // This ensures we get high quality subtitles AND deep visual understanding without timeouts
    try {
        const [subtitles, visualEvents] = await Promise.all([
            generateGranularSubtitles(mediaPart),
            generateVisualEvents(mediaPart, customFocus)
        ]);

        // Merge logic:
        let finalEvents = [...subtitles, ...visualEvents];
        
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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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

    const result = await chat.sendMessage(parts.length > 1 ? parts : message);
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
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
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
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
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

  return response.text || "";
};