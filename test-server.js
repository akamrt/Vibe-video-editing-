import express from 'express';
import cors from 'cors';
import { YoutubeTranscript } from 'youtube-transcript';
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Load .env.local manually
try {
    const envPath = path.join(__dirname, '.env.local');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim().replace(/^["']|["']$/g, ''); // Remove quotes
                process.env[key] = value;
            }
        });
        console.log('Loaded environment variables from .env.local');
    }
} catch (e) {
    console.warn('Failed to load .env.local:', e.message);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';



// Helper to call Gemini API
async function callGemini(prompt, model = GEMINI_MODEL, retries = 3) {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    let attempt = 0;

    while (attempt <= retries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                    ],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        maxOutputTokens: 8192
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                // Check for 5xx errors or 429
                if (response.status === 503 || response.status === 429 || response.status >= 500) {
                    if (attempt < retries) {
                        const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
                        console.log(`[Gemini] Error ${response.status}. Retrying in ${Math.round(delay)}ms...`);
                        await new Promise(res => setTimeout(res, delay));
                        attempt++;
                        continue;
                    } else if (response.status === 429) {
                        // If we are out of retries but it's a 429, try one last desperation wait if it's a "retry in X seconds" case
                        if (errorJson && errorJson.error && errorJson.error.details) {
                            const retryInfo = errorJson.error.details.find(d => d['@type'] && d['@type'].includes('RetryInfo'));
                            if (retryInfo && retryInfo.retryDelay) {
                                const seconds = parseFloat(retryInfo.retryDelay.replace('s', ''));
                                if (!isNaN(seconds) && seconds < 60) {
                                    console.log(`[Gemini] Rate limited on final attempt. Waiting ${seconds}s before one last try...`);
                                    await new Promise(res => setTimeout(res, (seconds + 1) * 1000));
                                    attempt++; // Grant one bonus attempt
                                    // Reset retries to ensure the loop continues for this one check
                                    if (attempt > retries) retries = attempt;
                                    continue;
                                }
                            }
                        }
                    }

                }
                throw new Error(`Gemini API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

            try {
                return JSON.parse(text.replace(/```json|```/g, '').trim());
            } catch (parseError) {
                console.error('[Gemini] JSON Parse Error:', parseError.message);
                throw new Error('Failed to parse AI response');
            }

        } catch (error) {
            if (attempt >= retries) throw error;
            console.log(`[Gemini] Network Error: ${error.message}. Retrying...`);
            await new Promise(res => setTimeout(res, 1000));
            attempt++;
        }
    }
}

async function callKimi(prompt, model = 'moonshot-v1-8k', retries = 3) {
    if (!KIMI_API_KEY) throw new Error("KIMI_API_KEY not set");

    const url = 'https://api.moonshot.ai/v1/chat/completions';
    let attempt = 0;


    while (attempt <= retries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${KIMI_API_KEY}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: "system", content: "You are a helpful assistant that outputs only valid JSON." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.3
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                // Check for 429
                if (response.status === 429) {
                    if (attempt < retries) {
                        const delay = Math.pow(2, attempt) * 2000; // Aggressive backoff for Kimi
                        console.log(`[Kimi] Rate limited (429). Retrying in ${delay / 1000}s...`);
                        await new Promise(res => setTimeout(res, delay));
                        attempt++;
                        continue;
                    }
                }
                throw new Error(`Kimi API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || '{}';

            try {
                // Kimi sometimes wraps in markdown
                return JSON.parse(text.replace(/```json|```/g, '').trim());
            } catch (parseError) {
                console.error('[Kimi] JSON Parse Error:', parseError.message);
                console.error('Raw Output:', text);
                throw new Error('Failed to parse (Kimi) AI response');
            }

        } catch (error) {
            if (attempt >= retries) throw error;
            console.log(`[Kimi] Error: ${error.message}. Retrying...`);
            attempt++;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// Helper to call MiniMax API (OpenAI-compatible)
async function callMiniMax(prompt, model = 'MiniMax-M2', retries = 3) {
    if (!MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY not set");

    // Official MiniMax OpenAI-compatible endpoint
    const url = 'https://api.minimax.io/v1/chat/completions';
    let attempt = 0;

    while (attempt <= retries) {
        try {
            console.log(`[MiniMax] Calling model: ${model}, attempt: ${attempt + 1}`);
            console.log(`[MiniMax] Prompt length: ${prompt.length} chars`);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${MINIMAX_API_KEY}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: "system", content: "You are a helpful assistant that outputs only valid JSON. Do not include any thinking, explanation, or markdown formatting — ONLY output the raw JSON object." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.3,
                    max_tokens: 8192
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[MiniMax] API Error ${response.status}: ${errorText}`);

                if (response.status === 429) {
                    if (attempt < retries) {
                        const delay = Math.pow(2, attempt) * 2000;
                        console.log(`[MiniMax] Rate limited (429). Retrying in ${delay / 1000}s...`);
                        await new Promise(res => setTimeout(res, delay));
                        attempt++;
                        continue;
                    }
                }
                throw new Error(`MiniMax API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            console.log('[MiniMax] Raw response keys:', Object.keys(data));

            // MiniMax returns in OpenAI-compatible format
            let text = data.choices?.[0]?.message?.content || '{}';
            console.log(`[MiniMax] Response text length: ${text.length}`);
            console.log('[MiniMax] Response preview:', text.substring(0, 300));

            // MiniMax M2/M2.5 are reasoning models that include <think>...</think> tags
            // in the content field. Strip these before parsing JSON.
            text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            // Strip markdown code blocks if present
            text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

            console.log('[MiniMax] Cleaned text preview:', text.substring(0, 300));

            try {
                return JSON.parse(text);
            } catch (parseError) {
                console.error('[MiniMax] JSON Parse Error:', parseError.message);
                console.error('[MiniMax] Cleaned text:', text.substring(0, 500));
                throw new Error('Failed to parse MiniMax AI response');
            }

        } catch (error) {
            if (attempt >= retries) throw error;
            console.log(`[MiniMax] Error: ${error.message}. Retrying...`);
            attempt++;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}


// Generate Short endpoint
app.post('/api/ai/generate-short', async (req, res) => {
    try {
        const { transcript, videoTitle, prompt, targetDuration, refinementInstruction, existingShorts, model } = req.body;


        if (!transcript || !videoTitle) {
            return res.status(400).json({ error: 'Missing transcript or videoTitle' });
        }

        const userPromptSection = prompt?.trim()
            ? `USER REQUEST: "${prompt}"`
            : `USER REQUEST: None specified. AUTO-DETECT the most viral-worthy content.`;

        const refinementSection = refinementInstruction?.trim()
            ? `\n\nREFINEMENT INSTRUCTION (Prioritize this over original request): "${refinementInstruction}"\nCONTEXT: The user is refining a previous generation. specific changes requested: ${refinementInstruction}`
            : '';

        const existingShortsSection = (existingShorts && existingShorts.length > 0 && !refinementInstruction)
            ? `\n\nCONTEXT - PREVIOUSLY GENERATED SHORTS (DO NOT DUPLICATE THESE MOMENTS):
${existingShorts.map((s, i) => `${i + 1}. "${s.title}" (Time: ${s.startTime}-${s.endTime}s)`).join('\n')}
INSTRUCTION: Find a DIFFERENT compelling moment from the sermon that hasn't been used yet.`
            : '';

        const aiPrompt = `
You are a viral short-form content editor specializing in sermon clips.

TASK: Create a compelling ${targetDuration || 60}-second short from this sermon transcript.

${userPromptSection}
${refinementSection}
${existingShortsSection}

SERMON: "${videoTitle}"

TRANSCRIPT (with timestamps):
${transcript.substring(0, 15000)}

INSTRUCTIONS:
1. Find the most engaging moments that match the user's request.
2. Create a HOOK - an attention-grabbing opening (first 3-5 seconds).
3. Create a HOOK TITLE - a SHORT, PUNCHY title (MAX 5 WORDS) that grabs attention immediately.
4. Select clips that tell a complete story with a RESOLUTION at the end.
5. The total duration should be approximately ${targetDuration || 60} seconds.
6. Clips must be in chronological order.

Return valid, parseable JSON with this exact structure:
{
  "title": "string (catchy title, max 60 chars)",
  "hookTitle": "string (SHORT PUNCHY TITLE, MAX 5 WORDS)",
  "hook": "string (hook text)",
  "resolution": "string (conclusion text)",
  "clips": [
    {
      "startTime": number,
      "endTime": number,
      "text": "string (transcript text)"
    }
  ],
  "totalDuration": number,
  "reasoning": "string"
}
`;

        console.log(`[AI] Generating short for: ${videoTitle} using model: ${model || GEMINI_MODEL}`);

        let result;
        if (model && model.startsWith('moonshot')) {
            result = await callKimi(aiPrompt, model);
        } else if (model && model.startsWith('MiniMax')) {
            result = await callMiniMax(aiPrompt, model);
        } else {
            result = await callGemini(aiPrompt, model || GEMINI_MODEL);
        }


        res.json(result);

    } catch (error) {
        console.error('[AI] Generate short error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Search transcripts endpoint
app.post('/api/ai/search-transcripts', async (req, res) => {
    try {
        const { query, transcripts } = req.body;

        if (!query || !transcripts || transcripts.length === 0) {
            return res.status(400).json({ error: 'Missing query or transcripts' });
        }

        const aiPrompt = `
You are a sermon content analyst. Search through these sermon transcripts to find content matching the user's query.

USER QUERY: "${query}"

TRANSCRIPTS:
${transcripts.map((t, idx) => `
=== SERMON ${idx} ===
Title: ${t.title}
Video ID: ${t.videoId}
Content:
${t.transcript.substring(0, 10000)}
`).join('\n')}

TASK:
1. Analyze each sermon for relevance to the query.
2. Find specific quotes/passages that match the query.
3. Return ONLY sermons that have relevant content.

Return JSON with this exact structure:
{
  "results": [
    {
      "videoId": "string (the Video ID from above)",
      "relevanceScore": number (0-100),
      "summary": "string",
      "matchingQuotes": [
        "string (exact quote)"
      ]
    }
  ]
}
`;

        console.log(`[AI] Searching transcripts via ${GEMINI_MODEL}...`);

        // Use Gemini 1.5 Flash for search by default as it has large context window which is great for RAG
        // Kimi 8k might be too small for big batches, so we default to Gemini unless specified
        const result = await callGemini(aiPrompt, GEMINI_MODEL);

        res.json(result);

    } catch (error) {
        console.error('[AI] Search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const getAgent = () => {
    try {
        if (fs.existsSync('cookies.txt')) {
            const content = fs.readFileSync('cookies.txt', 'utf8');
            const cookies = content.split('\n')
                .filter(l => l && !l.startsWith('#'))
                .map(l => {
                    const p = l.split('\t');
                    if (p.length < 7) return null;
                    return { name: p[5], value: p[6].trim() };
                }).filter(Boolean);

            if (cookies.length > 0) {
                console.log(`[API] Created agent with ${cookies.length} cookies`);
                return ytdl.createAgent(cookies);
            }
        }
    } catch (e) { console.error("Agent creation error", e); }
    return undefined;
};


// Update Cookies
app.post('/api/update-cookies', (req, res) => {
    const { content } = req.body;
    if (!content) {
        return res.status(400).json({ error: 'No content provided' });
    }

    try {
        fs.writeFileSync('cookies.txt', content);
        fs.writeFileSync('www.youtube.com_cookies.txt', content);
        console.log('[API] Cookies updated from upload');
        res.json({ success: true });
    } catch (e) {
        console.error("Cookie Update Error:", e);
        res.status(500).json({ error: 'Failed to write cookies file' });
    }
});

// Get Transcript
app.get('/api/transcript', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Valid URL required' });
    }

    console.log(`[API] Fetching transcript for: ${url}`);

    try {
        const agent = getAgent();
        // Validate URL
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const videoId = ytdl.getVideoID(url);
        const info = await ytdl.getBasicInfo(url, { agent });
        const title = info.videoDetails.title;


        // Fetch transcript
        // Note: YoutubeTranscript returns offset in milliseconds? 
        // Docs suggest it's consistent with what we need.
        const transcript = await YoutubeTranscript.fetchTranscript(videoId);

        const segments = transcript.map(t => ({
            start: t.offset,
            duration: t.duration,
            text: t.text
        }));

        res.json({ title, segments });
    } catch (e) {
        console.error("Transcript Error:", e);
        res.status(500).json({ error: 'Failed to fetch transcript. Video might not have captions, or they are disabled.' });
    }
});

// Download Video
app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Valid URL required' });
    }

    console.log(`[API] Downloading: ${url}`);

    try {
        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const agent = getAgent();
        const info = await ytdl.getBasicInfo(url, { agent });
        const title = info.videoDetails.title.replace(/[^a-z0-9]/gi, '_');

        res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);

        // Attempt 1: Try ytdl-core
        try {
            const stream = ytdl(url, { quality: '18', agent });

            stream.on('error', (err) => {
                console.error('[Download] ytdl stream error, switching to fallback:', err.message);
                if (!res.headersSent) {
                    // If headers aren't sent, we can still switch or send error
                    // But here we likely assumed success. 
                    // However, if we can detect failure early, good.
                    // For now, let's just log. 
                    // This try-catch mainly catches synchronous creation errors.
                }
                // If stream dies mid-way, it's hard to recover to a new stream on same response
            });

            // If ytdl works, it pipes. If it fails immediately (sync), we catch below.
            // But ytdl might emit error async. 
            // To be safe against the "decipher" error which often halts start:

            // We'll wrap the pipe in a promise to handle stream errors? 
            // No, we can't easily fallback once piping starts.
            // So we will try to see if we can get formats first?

            // Actually, best bet given the "WARNING" logs (which don't always throw):
            // The warning usually implies it WON'T work.

            // Let's use yt-dlp PRIMARILY if we detect it's available, OR just fallback if ytdl synchronous checks fail?
            // User says "exporting seems to be a problem", implying it fails.

            // Attempt 2: yt-dlp to file (allows merging)
            console.log('[Download] Attempting with yt-dlp (File Mode)...');

            // Ensure temp directory exists
            const tempDir = path.join(__dirname, 'temp_downloads');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

            const videoId = ytdl.getVideoID(url); // Use ID for filename
            const tempFileBase = path.join(tempDir, videoId);

            // Output template: temp_downloads/ID.mp4
            // We start by cleaning up potential old files
            const existingFiles = fs.readdirSync(tempDir).filter(f => f.startsWith(videoId));
            existingFiles.forEach(f => {
                try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) { }
            });

            const args = [
                // Best mp4 video + best m4a audio, OR best mp4 pre-merged, OR just best
                '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
                '--merge-output-format', 'mp4',
                '-o', `${tempFileBase}.%(ext)s`,
                url
            ];

            if (fs.existsSync('cookies.txt')) {
                args.push('--cookies', 'cookies.txt');
            }

            // Using spawn to run yt-dlp
            const ytDlpProcess = spawn('yt-dlp', args);

            ytDlpProcess.stderr.on('data', (data) => {
                // Log only errors
                const msg = data.toString();
                if (msg.includes('ERROR')) console.error('[Download] yt-dlp stderr:', msg);
            });

            ytDlpProcess.on('close', (code) => {
                if (code !== 0) {
                    console.error(`[Download] yt-dlp exited with code ${code}`);
                    if (!res.headersSent) res.status(500).json({ error: 'Download failed via fallback' });
                    return;
                }

                // Find the generated file (it should be .mp4 due to merge flag, but check)
                const files = fs.readdirSync(tempDir).filter(f => f.startsWith(videoId));
                if (files.length === 0) {
                    if (!res.headersSent) res.status(500).json({ error: 'Download finished but file not found' });
                    return;
                }

                const finalFilePath = path.join(tempDir, files[0]);
                console.log(`[Download] Serving file: ${finalFilePath}`);

                res.download(finalFilePath, `${title}.mp4`, (err) => {
                    // Cleanup after send
                    try { fs.unlinkSync(finalFilePath); } catch (e) { console.error('Cleanup error:', e); }
                    if (err) console.error('[Download] Response error:', err);
                });
            });

        } catch (ytdlError) {
            console.error('[Download] Setup error:', ytdlError);
            if (!res.headersSent) res.status(500).json({ error: 'Download setup failed' });
        }


    } catch (e) {
        console.error("Download Error:", e);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to download video stream' });
    }
});


app.listen(PORT, () => {
    console.log(`Test Server running at http://localhost:${PORT}`);
});
