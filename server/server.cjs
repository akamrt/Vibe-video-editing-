const express = require('express');
const cors = require('cors');
const { spawn, exec, execSync } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');
const os = require('os');
const { extractVideoId, getTranscript } = require('./transcript.cjs');
const { getYtDlpPath, getPythonTrackerPath, getTrackerInfo, getEnvWithBinPath, getFfmpegPath } = require('./binpath.cjs');
const { transcribeFile, assemblyAIToAnalysisEvents } = require('./assemblyai.cjs');
const localStore = require('./localStore.cjs');
const saveStore = require('./saveStore.cjs');

// Resolve yt-dlp path once at startup
const YT_DLP = getYtDlpPath();
const childEnv = getEnvWithBinPath();
console.log(`Using yt-dlp: ${YT_DLP}`);

const COOKIE_FILE = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
const getCookieArg = () => fs.existsSync(COOKIE_FILE) ? ` --cookies "${COOKIE_FILE}"` : '';

// Detect which browsers are available for --cookies-from-browser
// Try common browsers in order of preference
const BROWSERS_TO_TRY = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'chromium'];

// Helper to run yt-dlp commands with multi-stage cookie fallback strategy
async function runYtDlpWithFallback(cmdBuilder, execOptions) {
    const isBotError = (text) => {
        const lower = (text || '').toLowerCase();
        return lower.includes('sign in') || lower.includes('bot') || lower.includes('login required') || lower.includes('confirm your age');
    };

    // 1. Try WITHOUT cookies first (avoids "Requested format not available" from stale cookies)
    const cmdNoCookies = cmdBuilder(false);
    try {
        console.log('Running yt-dlp (no cookies):', cmdNoCookies);
        return await execAsync(cmdNoCookies, execOptions);
    } catch (error) {
        const stderr = (error.stderr || error.message || '');

        if (!isBotError(stderr)) {
            // Not a bot error, just throw the original error
            throw error;
        }

        console.log('Bot protection detected. Trying authentication strategies...');

        // 2. Try --cookies-from-browser for each available browser
        for (const browser of BROWSERS_TO_TRY) {
            try {
                const browserCmd = cmdBuilder(false) + ` --cookies-from-browser ${browser}`;
                console.log(`Trying --cookies-from-browser ${browser}...`);
                const result = await execAsync(browserCmd, execOptions);
                console.log(`Success with --cookies-from-browser ${browser}`);
                return result;
            } catch (browserErr) {
                const browserStderr = (browserErr.stderr || browserErr.message || '').toLowerCase();
                // If the browser isn't installed/accessible, try the next one
                if (browserStderr.includes('no suitable') || browserStderr.includes('could not find') ||
                    browserStderr.includes('not available') || browserStderr.includes('not found') ||
                    browserStderr.includes('no cookies') || browserStderr.includes('permission') ||
                    browserStderr.includes('not installed') || browserStderr.includes('unsupported') ||
                    browserStderr.includes('could not copy')) {
                    console.log(`Browser ${browser} not available, trying next...`);
                    continue;
                }
                // If it's still a bot error, this browser's cookies didn't help — try next
                if (isBotError(browserStderr)) {
                    console.log(`Browser ${browser} cookies didn't resolve bot protection, trying next...`);
                    continue;
                }
                // Some other error (e.g., format not found) — throw it
                throw browserErr;
            }
        }

        // 3. Fall back to cookie file if it exists
        if (fs.existsSync(COOKIE_FILE)) {
            const cmdWithCookies = cmdBuilder(true);
            try {
                console.log('Trying cookie file:', COOKIE_FILE);
                return await execAsync(cmdWithCookies, execOptions);
            } catch (cookieError) {
                const cookieStderr = (cookieError.stderr || cookieError.message || '').toLowerCase();
                if (cookieStderr.includes('requested format is not available') || isBotError(cookieStderr)) {
                    throw new Error(
                        'YouTube bot protection blocked the download. All authentication strategies failed:\n' +
                        '• --cookies-from-browser: No browser cookies resolved the issue\n' +
                        '• Cookie file: Appears expired or invalid\n' +
                        'Please try: 1) Log into YouTube in Chrome, 2) Close Chrome completely, 3) Try again.\n' +
                        'Or export fresh cookies to www.youtube.com_cookies.txt'
                    );
                }
                throw cookieError;
            }
        }

        // 4. All strategies exhausted
        throw new Error(
            'YouTube bot protection blocked the download. To fix this:\n' +
            '1. Log into YouTube in Chrome (or Edge/Firefox)\n' +
            '2. Close the browser completely (so yt-dlp can read its cookie database)\n' +
            '3. Try the download again\n' +
            'Or export YouTube cookies to www.youtube.com_cookies.txt in the project root.'
        );
    }
}

const app = express();
const PORT = 3001; // Changed to 3001 to match Vite proxy

// Track all spawned child processes for cleanup on shutdown
const activeChildren = new Set();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In Electron production mode, serve the built frontend from dist/
const isElectron = process.env.VIBECUT_IS_ELECTRON === '1';
const distPath = path.join(__dirname, '..', 'dist');
if (isElectron && fs.existsSync(distPath)) {
    console.log('[Server] Electron mode: serving static files from dist/');
    app.use(express.static(distPath));
} else {
    app.use(express.static('public'));
}

// Root route to confirm server status
app.get('/', (req, res) => {
    res.send('Vibe Video Editing API Server is running. Access endpoints at /api/...');
});

// Health check endpoint for frontend/Electron to verify server is alive
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        activeProcesses: activeChildren.size,
        port: PORT,
    });
});

// Video download endpoint using global yt-dlp
app.get('/api/download', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube URL' });
    }

    try {
        const videoId = extractVideoId(url);
        if (!videoId) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

        console.log(`Getting info for: ${videoId}`);
        const infoCmdBuilder = (useCookies) => `"${YT_DLP}" --dump-single-json --no-warnings${useCookies ? getCookieArg() : ''} "${youtubeUrl}"`;

        const { stdout: infoJson } = await runYtDlpWithFallback(infoCmdBuilder, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            env: childEnv
        });
        const info = JSON.parse(infoJson);

        const title = info.title.replace(/[^\w\s-]/g, '').trim();
        console.log(`Downloading: ${title} (${info.resolution || info.format_note || 'best quality'})`);

        // Create temp file path
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `${videoId}_${Date.now()}.mp4`);

        // Download using yt-dlp (async to avoid blocking event loop)
        console.log('Downloading to temp file:', tempFile);

        const downloadCmdBuilder = (useCookies) => `"${YT_DLP}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${tempFile}"${useCookies ? getCookieArg() : ''} "${youtubeUrl}"`;

        await runYtDlpWithFallback(downloadCmdBuilder, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 300000, // 5 minute timeout
            env: childEnv
        });

        console.log('Download complete, streaming to client...');

        // Check file exists
        if (!fs.existsSync(tempFile)) {
            throw new Error('Downloaded file not found');
        }

        // Persist to local cache (non-blocking — don't delay streaming)
        try {
            localStore.saveVideo(videoId, tempFile);
        } catch (cacheErr) {
            console.warn('[Download] Failed to cache locally (continuing):', cacheErr.message);
        }

        const stat = fs.statSync(tempFile);
        res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
        res.header('Content-Type', 'video/mp4');
        res.header('Content-Length', stat.size);
        res.header('X-Video-Id', videoId);

        // Stream the file to response
        const fileStream = fs.createReadStream(tempFile);
        fileStream.pipe(res);

        fileStream.on('end', () => {
            console.log('Stream complete:', title);
            // Clean up temp file
            fs.unlink(tempFile, (err) => {
                if (err) console.error('Failed to delete temp file:', err);
            });
        });

        fileStream.on('error', (err) => {
            console.error('Stream error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to stream video' });
            }
            fs.unlink(tempFile, () => { });
        });

        // Handle client disconnect
        req.on('close', () => {
            fileStream.destroy();
            fs.unlink(tempFile, () => { });
        });

    } catch (error) {
        console.error('Download error:', error.message || error);
        // Log full error for debugging
        if (error.stderr) {
            console.error('yt-dlp stderr:', error.stderr);
        }
        if (!res.headersSent) {
            res.status(500).json({ error: error.message || 'Failed to download video' });
        }
    }
});

// Video info endpoint - fetches metadata without downloading
app.get('/api/video-info', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube URL' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const infoCmdBuilder = (useCookies) => `"${YT_DLP}" --dump-single-json --no-warnings${useCookies ? getCookieArg() : ''} "${youtubeUrl}"`;
        console.log('Fetching video info...');

        const { stdout: infoJson } = await runYtDlpWithFallback(infoCmdBuilder, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            env: childEnv
        });
        const info = JSON.parse(infoJson);

        res.json({
            id: videoId,
            title: info.title || 'Unknown Title',
            channel: info.channel || info.uploader || 'Unknown Channel',
            thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            duration: info.duration || 0,
            uploadDate: info.upload_date || null,
            viewCount: info.view_count || 0,
            description: info.description || ''
        });
    } catch (error) {
        console.error('Video info error:', error.message);
        // Return basic info with YouTube thumbnail fallback
        res.json({
            id: videoId,
            title: 'Video ' + videoId,
            channel: 'Unknown',
            thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
            duration: 0
        });
    }
});

app.get('/api/transcript', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube URL' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    try {
        console.log(`Fetching transcript for video: ${videoId}`);
        const data = await getTranscript(videoId);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            error: error.message || 'Failed to fetch transcript',
            code: error.code
        });
    }
});

// Helper to validate Netscape cookie format roughly
function isValidCookieFormat(content) {
    return content.includes('TRUE') || content.includes('FALSE') || content.includes('.youtube.com');
}

// Endpoint to update cookies.txt
app.post('/api/update-cookies', (req, res) => {
    try {
        const { content } = req.body;
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'Missing cookie content' });
        }

        if (!isValidCookieFormat(content)) {
            return res.status(400).json({ error: 'Invalid cookie file format. Must be Netscape HTTP Cookie File.' });
        }

        fs.writeFileSync(COOKIE_FILE, content, 'utf8');

        console.log('Cookies file updated via API');
        res.json({ success: true, message: 'Cookies updated successfully' });
    } catch (error) {
        console.error('Update cookies error:', error);
        res.status(500).json({ error: 'Failed to save cookies file' });
    }
});

// ==================== AI Endpoints ====================

// Load .env.local manually since we don't have dotenv
// In Electron, check VIBECUT_ENV_PATH (userData) first, then project root
try {
    const envPaths = [
        process.env.VIBECUT_ENV_PATH,           // Electron userData path
        path.join(__dirname, '..', '.env.local') // Project root
    ].filter(Boolean);

    let loaded = false;
    for (const envPath of envPaths) {
        if (fs.existsSync(envPath)) {
            const envConfig = fs.readFileSync(envPath, 'utf8');
            envConfig.split('\n').forEach(line => {
                const match = line.match(/^([^=]+)=(.*)$/);
                if (match) {
                    const key = match[1].trim();
                    const value = match[2].trim().replace(/^["']|["']$/g, '');
                    process.env[key] = value;
                }
            });
            console.log(`Loaded environment variables from ${envPath}`);
            loaded = true;
            break;
        }
    }
    if (!loaded) console.warn('.env.local not found in any location');
} catch (e) {
    console.warn('Failed to load .env.local:', e.message);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyB1srFICGtx-6D1J6giVDnjz6kcf8AbZoc';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

console.log(`Using Gemini Model: ${GEMINI_MODEL}`);
console.log(`Using Gemini API Key: ${GEMINI_API_KEY ? '******' + GEMINI_API_KEY.slice(-4) : 'Not Set'}`);
console.log(`Using Kimi API Key: ${KIMI_API_KEY ? '******' + KIMI_API_KEY.slice(-4) : 'Not Set'}`);
console.log(`Using OpenAI API Key: ${OPENAI_API_KEY ? '******' + OPENAI_API_KEY.slice(-4) : 'Not Set'}`);
console.log(`Using MiniMax API Key: ${MINIMAX_API_KEY ? '******' + MINIMAX_API_KEY.slice(-4) : 'Not Set'}`);

// Helper to call Kimi (Moonshot) API
async function callKimi(prompt, model = 'moonshot-v1-8k', retries = 3) {
    if (!KIMI_API_KEY) throw new Error("KIMI_API_KEY not set in .env.local");

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
                if (response.status === 429) {
                    if (attempt < retries) {
                        const delay = Math.pow(2, attempt) * 2000;
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
                return JSON.parse(text.replace(/```json|```/g, '').trim());
            } catch (parseError) {
                console.error('[Kimi] JSON Parse Error:', parseError.message);
                console.error('Raw Output:', text);
                throw new Error('Failed to parse Kimi AI response');
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
    if (!MINIMAX_API_KEY) throw new Error("MINIMAX_API_KEY not set in .env.local");

    // Official MiniMax OpenAI-compatible endpoint
    const url = 'https://api.minimax.io/v1/chat/completions';
    let attempt = 0;

    while (attempt <= retries) {
        try {
            console.log(`[MiniMax] Calling model: ${model}, attempt: ${attempt + 1}`);
            console.log(`[MiniMax] Prompt length: ${prompt.length} chars`);
            console.log(`[MiniMax] Prompt preview:`, prompt.substring(0, 300));

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
                    temperature: 0.1,
                    max_tokens: 8192,
                    stream: false
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

            // MiniMax V2 sometimes returns 200 OK even for errors
            if (data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
                throw new Error(`MiniMax API Error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
            }

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

                // Try the repair function as fallback
                const repaired = repairTruncatedJson(text);
                if (repaired) {
                    console.log('[MiniMax] Recovered via JSON repair');
                    return repaired;
                }

                throw new Error('Failed to parse (MiniMax) AI response');
            }

        } catch (error) {
            if (attempt >= retries) throw error;
            console.log(`[MiniMax] Error: ${error.message}. Retrying...`);
            attempt++;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// Helper to call OpenAI API
async function callOpenAI(prompt, model = 'gpt-4o', retries = 3) {
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set in .env.local");

    const url = 'https://api.openai.com/v1/chat/completions';
    let attempt = 0;

    while (attempt <= retries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: "system", content: "You are a professional video editor. Output only valid JSON, no markdown." },
                        { role: "user", content: prompt }
                    ],
                    temperature: 0.4,
                    response_format: { type: "json_object" }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 429) {
                    if (attempt < retries) {
                        const delay = Math.pow(2, attempt) * 2000;
                        console.log(`[OpenAI] Rate limited (429). Retrying in ${delay / 1000}s...`);
                        await new Promise(res => setTimeout(res, delay));
                        attempt++;
                        continue;
                    }
                }
                throw new Error(`OpenAI API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const text = data.choices?.[0]?.message?.content || '{}';

            try {
                return JSON.parse(text.replace(/```json|```/g, '').trim());
            } catch (parseError) {
                console.error('[OpenAI] JSON Parse Error:', parseError.message);
                console.error('[OpenAI] Raw Output:', text);
                throw new Error('Failed to parse OpenAI response');
            }

        } catch (error) {
            if (attempt >= retries) throw error;
            console.log(`[OpenAI] Error: ${error.message}. Retrying...`);
            attempt++;
            await new Promise(res => setTimeout(res, 1000));
        }
    }
}

// Parse transcript lines from "[start - end] text" format
function parseTranscriptLines(transcript) {
    const lines = transcript.split('\n');
    const parsed = [];
    const regex = /\[(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\]\s*(.*)/;
    for (const line of lines) {
        const match = line.match(regex);
        if (match) {
            parsed.push({
                start: parseFloat(match[1]),
                end: parseFloat(match[2]),
                text: match[3].trim()
            });
        }
    }
    return parsed;
}

// Merge nearby segments into paragraph-level chunks (reduces prompt size for
// AssemblyAI transcripts which produce many short utterance-level segments)
function consolidateSegments(lines, maxGapSec = 1.0) {
    // Filter out empty-text segments first
    const nonEmpty = lines.filter(l => l.text.length > 0);
    if (nonEmpty.length === 0) return [];
    const merged = [{ start: nonEmpty[0].start, end: nonEmpty[0].end, text: nonEmpty[0].text }];
    for (let i = 1; i < nonEmpty.length; i++) {
        const prev = merged[merged.length - 1];
        if (nonEmpty[i].start - prev.end <= maxGapSec) {
            prev.end = nonEmpty[i].end;
            prev.text += ' ' + nonEmpty[i].text;
        } else {
            merged.push({ start: nonEmpty[i].start, end: nonEmpty[i].end, text: nonEmpty[i].text });
        }
    }
    return merged;
}

// Look up transcript text for a given time range
function getTextForTimeRange(transcriptLines, startTime, endTime) {
    const overlapping = transcriptLines.filter(line =>
        line.end > startTime && line.start < endTime
    );
    return overlapping.map(l => l.text).join(' ').trim() || '';
}

/**
 * Snap a clip's endTime forward so the word AT or nearest-before that timestamp
 * is fully included. LLMs typically return the START timestamp of the last word
 * they want, but the clip needs to extend past that word's audio to avoid cutoff.
 *
 * Strategy: find the first word that starts AFTER endTime, and return its END
 * time. This captures both the target word AND allows for natural speech trailing
 * (LLMs are often ~1 word imprecise with end boundaries).
 * Falls back to endTime + 0.5s if no next word.
 */
function snapClipEndTime(transcriptLines, endTime) {
    // Find the first word that starts AFTER endTime
    const nextIdx = transcriptLines.findIndex(line => line.start > endTime + 0.01);

    if (nextIdx >= 0) {
        // Return the end time of the next word — this gives the LLM's target word
        // its full duration and adds a natural ~1 word buffer for speech trailing
        return transcriptLines[nextIdx].end;
    }

    // No next word (end of transcript) — add a buffer
    return endTime + 0.5;
}

/**
 * Snap a clip's startTime backward so it begins at the start of the word
 * AT or nearest-before that timestamp (not mid-word).
 */
function snapClipStartTime(transcriptLines, startTime) {
    // Find the last word that starts at or before the given startTime
    let bestLine = null;
    for (const line of transcriptLines) {
        if (line.start <= startTime + 0.01) {
            bestLine = line;
        } else {
            break;
        }
    }
    return bestLine ? bestLine.start : startTime;
}

/**
 * Match a phrase against word-level transcript to find precise timestamp.
 * mode = 'start' returns the start time of the first matching word.
 * mode = 'end' returns the end time of the last matching word.
 * Returns null if no match found.
 */
function matchPhraseToTimestamp(transcriptLines, phrase, approxTime, mode) {
    if (!phrase || !phrase.trim()) return null;

    const normalizeWord = w => w.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '').trim();
    const phraseWords = phrase.split(/\s+/).map(normalizeWord).filter(w => w.length > 0);
    if (phraseWords.length === 0) return null;

    // Search in a window around the approximate time (±30s)
    const searchWindow = 30;
    const candidates = transcriptLines.filter(l =>
        l.start >= approxTime - searchWindow && l.start <= approxTime + searchWindow
    );
    if (candidates.length === 0) return null;

    const candidateWords = candidates.map(l => normalizeWord(l.text));

    // Exact sequence match
    for (let i = 0; i <= candidateWords.length - phraseWords.length; i++) {
        let match = true;
        for (let j = 0; j < phraseWords.length; j++) {
            if (candidateWords[i + j] !== phraseWords[j]) {
                match = false;
                break;
            }
        }
        if (match) {
            const time = mode === 'start'
                ? candidates[i].start
                : candidates[i + phraseWords.length - 1].end;
            console.log(`[PhraseMatch] Exact match: "${phrase}" → ${time.toFixed(2)}s (${mode})`);
            return time;
        }
    }

    // Fuzzy fallback: find best partial match (≥60% words matching)
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i <= candidateWords.length - phraseWords.length; i++) {
        let matching = 0;
        for (let j = 0; j < phraseWords.length; j++) {
            if (candidateWords[i + j] === phraseWords[j]) matching++;
        }
        const score = matching / phraseWords.length;
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    if (bestScore >= 0.6 && bestIdx >= 0) {
        const time = mode === 'start'
            ? candidates[bestIdx].start
            : candidates[bestIdx + phraseWords.length - 1].end;
        console.log(`[PhraseMatch] Fuzzy match (${(bestScore * 100).toFixed(0)}%): "${phrase}" → ${time.toFixed(2)}s (${mode})`);
        return time;
    }

    console.log(`[PhraseMatch] No match for "${phrase}" near ${approxTime.toFixed(1)}s`);
    return null;
}

// Filler/preamble words that commonly start clips but shouldn't
const PREAMBLE_STARTERS = new Set(['so', 'and', 'but', 'well', 'now', 'like', 'okay', 'ok', 'alright', 'um', 'uh', 'yeah']);
const PREAMBLE_PHRASES = ['you know', 'i mean', 'as i was saying', 'you know what', 'and i think', 'and so'];
const TRAILER_ENDERS = new Set(['right', 'amen', 'yeah', 'okay', 'ok', 'huh']);
const TRAILER_PHRASES = ['so yeah', 'you know', 'right right', 'you know what i mean'];

/**
 * Trim preamble filler words from the start of a clip.
 * Returns the adjusted startTime or the original if no trimming needed.
 */
function trimPreambleWords(transcriptLines, startTime, endTime) {
    const clipWords = transcriptLines.filter(l => l.start >= startTime - 0.01 && l.end <= endTime + 0.01);
    if (clipWords.length <= 3) return startTime; // Don't trim very short clips

    let trimCount = 0;
    const maxTrim = Math.min(3, Math.floor(clipWords.length * 0.15)); // At most 3 words or 15%

    // Check single-word preambles
    for (let i = 0; i < maxTrim && i < clipWords.length; i++) {
        const word = clipWords[i].text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '');
        if (PREAMBLE_STARTERS.has(word)) {
            trimCount = i + 1;
        } else {
            break;
        }
    }

    // Check 2-word preamble phrases
    if (trimCount === 0 && clipWords.length >= 2) {
        const twoWords = clipWords.slice(0, 2).map(w =>
            w.text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '')
        ).join(' ');
        for (const phrase of PREAMBLE_PHRASES) {
            if (twoWords === phrase || twoWords.startsWith(phrase)) {
                trimCount = 2;
                break;
            }
        }
    }

    if (trimCount > 0 && trimCount < clipWords.length) {
        console.log(`[TrimPreamble] Trimming ${trimCount} word(s): "${clipWords.slice(0, trimCount).map(w => w.text).join(' ')}"`);
        return clipWords[trimCount].start;
    }
    return startTime;
}

/**
 * Trim trailing filler words from the end of a clip.
 * Returns the adjusted endTime or the original if no trimming needed.
 */
function trimTrailerWords(transcriptLines, startTime, endTime) {
    const clipWords = transcriptLines.filter(l => l.start >= startTime - 0.01 && l.end <= endTime + 0.01);
    if (clipWords.length <= 3) return endTime;

    let trimCount = 0;
    const maxTrim = Math.min(3, Math.floor(clipWords.length * 0.15));

    // Check single-word trailers (from end)
    for (let i = clipWords.length - 1; i >= clipWords.length - maxTrim && i >= 0; i--) {
        const word = clipWords[i].text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '');
        if (TRAILER_ENDERS.has(word)) {
            trimCount = clipWords.length - i;
        } else {
            break;
        }
    }

    // Check 2-word trailer phrases
    if (trimCount === 0 && clipWords.length >= 2) {
        const lastTwo = clipWords.slice(-2).map(w =>
            w.text.toLowerCase().replace(/[.,!?;:'"()\-—]/g, '')
        ).join(' ');
        for (const phrase of TRAILER_PHRASES) {
            if (lastTwo === phrase) {
                trimCount = 2;
                break;
            }
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

// Group granular transcript lines into short passages for AI clip selection
function groupIntoPassages(transcriptLines, targetSeconds = 5) {
    const passages = [];
    let current = { start: 0, end: 0, texts: [] };

    for (const line of transcriptLines) {
        if (current.texts.length === 0) {
            current.start = line.start;
        }
        current.end = line.end;
        current.texts.push(line.text);

        if (current.end - current.start >= targetSeconds) {
            passages.push(`[${current.start.toFixed(1)}s - ${current.end.toFixed(1)}s]\n${current.texts.join(' ')}`);
            current = { start: 0, end: 0, texts: [] };
        }
    }
    // Flush remaining
    if (current.texts.length > 0) {
        passages.push(`[${current.start.toFixed(1)}s - ${current.end.toFixed(1)}s]\n${current.texts.join(' ')}`);
    }
    return passages.join('\n\n');
}

// Repair truncated JSON from AI responses
function repairTruncatedJson(text) {
    let clean = text.replace(/```json|```/g, '').trim();

    // Try standard parse first
    try {
        return JSON.parse(clean);
    } catch (e) { /* continue to repair */ }

    // Find the last complete object in the clips array
    const lastCompleteObj = clean.lastIndexOf('},');
    if (lastCompleteObj !== -1) {
        // Close the clips array and root object
        const repaired = clean.substring(0, lastCompleteObj + 1) + '], "totalDuration": 0, "reasoning": "truncated"}';
        try {
            const result = JSON.parse(repaired);
            console.log(`[Gemini] Repaired truncated JSON. Recovered ${result.clips?.length || 0} clips.`);
            return result;
        } catch (e2) { /* continue */ }
    }

    // Try closing just the last object and array
    const lastBrace = clean.lastIndexOf('}');
    if (lastBrace !== -1) {
        const repaired = clean.substring(0, lastBrace + 1) + '], "totalDuration": 0, "reasoning": "truncated"}';
        try {
            return JSON.parse(repaired);
        } catch (e3) { /* give up */ }
    }

    return null;
}

// Helper to call Gemini API with retry logic
async function callGemini(prompt, model = GEMINI_MODEL, retries = 3) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    let attempt = 0;

    while (attempt <= retries) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        maxOutputTokens: 4096
                    }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorJson;
                try {
                    errorJson = JSON.parse(errorText);
                } catch (e) { /* ignore */ }

                // Check for 5xx errors or 429 (rate limit)
                if (response.status === 503 || response.status === 429 || response.status >= 500) {
                    if (attempt < retries) {
                        let delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);

                        // Try to extract specific retry delay from Gemini error
                        // Format example: "retryDelay": "56s"
                        if (errorJson && errorJson.error && errorJson.error.details) {
                            const retryInfo = errorJson.error.details.find(d => d['@type'] && d['@type'].includes('RetryInfo'));
                            if (retryInfo && retryInfo.retryDelay) {
                                const seconds = parseFloat(retryInfo.retryDelay.replace('s', ''));
                                if (!isNaN(seconds)) {
                                    delay = (seconds * 1000) + 2000; // Add 2s buffer
                                    console.log(`[Gemini] Hit Rate Limit. API requested wait of ${seconds}s.`);
                                }
                            }
                        }

                        console.log(`[Gemini] Error ${response.status}. Retrying in ${Math.round(delay)}ms...`);
                        await new Promise(res => setTimeout(res, delay));
                        attempt++;
                        continue;
                    }
                }

                throw new Error(errorJson ? JSON.stringify(errorJson) : `Gemini API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
            const usageMetadata = data.usageMetadata || null;

            // Try clean parse, then repair truncated JSON
            const parsed = repairTruncatedJson(text);
            if (parsed) {
                // Attach usage metadata to result for cost tracking
                if (usageMetadata) parsed._usageMetadata = usageMetadata;
                return parsed;
            }

            console.error('[Gemini] JSON Parse Error (unrecoverable)');
            console.error('[Gemini] Raw Text:', text);
            throw new Error('Failed to parse AI response: JSON was truncated beyond repair.');

        } catch (error) {
            if (attempt >= retries) throw error;

            console.log(`[Gemini] Network/Other Error: ${error.message}. Retrying...`);
            const delay = Math.pow(2, attempt) * 1000 + (Math.random() * 1000);
            await new Promise(res => setTimeout(res, delay));
            attempt++;
        }
    }
}

// Default editing instructions — injected into both generate-short and build-short-prompt.
// Callers can pass editingInstructions to override this entirely.
const DEFAULT_EDITING_INSTRUCTIONS = (duration, count = 10) => `EDITING RULES (apply to EACH of the ${count} short${count === 1 ? '' : 's'}):
1. HOOK (0-3s) — The clip MUST open with a scroll-stopping statement: provocative, emotional, surprising, or counterintuitive. This is the single most important factor. If a viewer wouldn't pause mid-scroll in the first 3 seconds, pick a different moment. Start the clip AT this statement, not before it — cut any preamble ("so", "as I was saying", "you know what", "and I think", throat-clearing).
2. BUILD & CONDENSE (middle) — Connect the strongest thoughts. AGGRESSIVELY cut dead air, tangents, filler, and restatements. Stitch together the speaker's best points to create a dense, fast-paced narrative. If they take 20 seconds to make a point that can be summarised in their own two 4-second sentences, jump-cut those two sentences together.
3. PAYOFF (end) — End on the PEAK: the mic-drop line, the emotional crescendo, the key insight landing. Cut IMMEDIATELY after the strongest statement. Never include trailing filler ("so yeah", "amen", "right?", softening, restating). The last 3 seconds should hit as hard as the first 3.
4. PRECISION TRIMMING — Start each clip at the exact moment compelling content begins. End at the exact peak. Common traps to avoid:
   - Including warm-up sentences before the hook
   - Trailing past the punchline into softening or restating
   - Including "and another thing..." transitions
   When in doubt, shorter and punchier beats longer and complete.
5. EMBRACE JUMP CUTS — To pack maximum value into ${duration} seconds, use 3 to 6 shorter clips stitched together. Do not rely on one long continuous block of speech. Jump cuts are highly engaging in short-form content; use them to skip the boring parts and connect the gold.
6. MINIMUM CLIP LENGTH — Each individual clip can be as short as 3 seconds, as long as it contains a complete, punchy thought or phrase.
7. CHRONOLOGICAL — Clips within each short must appear in the order they occur in the source.
8. TOTAL DURATION — All clips in each short combined ≈ ${duration} seconds.
9. DO NOT return transcript text — only return start/end times. The text will be filled in automatically.
10. PHRASE ANCHORS (REQUIRED) — For each clip, return the VERBATIM first 4-6 words (startPhrase) and last 4-6 words (endPhrase) exactly as they appear in the transcript. These enable precise cut-point alignment — timestamps are approximate but phrases are exact. Do NOT paraphrase or approximate — copy the exact words from the transcript.
11. KEYWORDS (optional) — If capacity allows, identify 2-4 words per clip that are PIVOTAL to the narrative arc: the turning point, the key insight, the emotional peak. NOT generic words. Lowercase only. Skip if uncertain.
12. B-ROLL SUGGESTIONS — Identify moments where stock footage or still images would enhance the visual storytelling and help mask jump cuts.
    Be generous — suggest B-roll for any concrete noun, action, place, emotion, or concept the speaker references. Aim for at least one suggestion per clip.
    Do NOT suggest B-roll only when the speaker's raw personal emotion or delivery IS the content.
    For each suggestion provide: clipIndex (0-based within that short), offsetInClip (seconds into that clip),
    duration (2-5s), searchQuery (concise Pexels search term, e.g. "sunset ocean waves" or "person praying hands"),
    and rationale (one sentence why this helps).

PLATFORM STRATEGY:
Short-form algorithms (TikTok, YouTube Shorts, Reels) rank by retention rate and rewatch ratio. Clips that hook in <3 seconds, maintain tension throughout, and end with impact get promoted. Dead air, slow buildups, and weak endings kill retention. Select moments that are SELF-CONTAINED — a viewer with zero context should immediately understand and be gripped.

GENRE-SPECIFIC STRATEGY:
- Sermons/faith content: emotional crescendos, counterintuitive theology, personal vulnerability, prophetic declarations, conviction
- Podcasts/interviews: hot takes, disagreements, surprising revelations, relatable stories, "I've never told anyone this"
- Lectures/educational: "aha" moments, counterintuitive facts, powerful analogies, myth-busting
- Motivational: universal truths, emotional breakthroughs, call-to-action moments
- General: emotional peaks, humor, controversy, vulnerability, universal relatability`;

// Generate Short endpoint
app.post('/api/ai/generate-short', async (req, res) => {
    try {
        const { transcript, videoTitle, prompt, targetDuration, refinementInstruction, existingShorts, model, editingInstructions, bRollEnabled, shortCount } = req.body;
        const includeBRoll = bRollEnabled !== false; // default true
        const count = Math.max(1, Math.min(20, parseInt(shortCount) || 10));
        const candidateCount = Math.round(count * 1.8); // Phase 1 longlist: ~80% more than requested

        if (!transcript || !videoTitle) {
            return res.status(400).json({ error: 'Missing transcript or videoTitle' });
        }

        // Parse transcript and group into readable passages
        const transcriptLines = parseTranscriptLines(transcript);
        const groupedTranscript = groupIntoPassages(transcriptLines, 5);

        const duration = targetDuration || 60;

        const userPromptSection = prompt?.trim()
            ? `USER'S CREATIVE DIRECTION: "${prompt}"`
            : `USER'S CREATIVE DIRECTION: None given — auto-detect the single most powerful, scroll-stopping moment. Prioritize emotional peaks, counterintuitive statements, and mic-drop lines.`;

        const refinementSection = refinementInstruction?.trim()
            ? `\nREFINEMENT (this overrides the original direction): "${refinementInstruction}"`
            : '';

        const existingShortsSection = (existingShorts && existingShorts.length > 0 && !refinementInstruction)
            ? `\nALREADY USED (pick a DIFFERENT moment):\n${existingShorts.map((s, i) => `- "${s.title}" (${s.startTime}-${s.endTime}s)`).join('\n')}`
            : '';

        let resolvedInstructions = (editingInstructions && editingInstructions.trim())
            ? editingInstructions.trim()
            : DEFAULT_EDITING_INSTRUCTIONS(duration, count);

        // Strip B-roll rule from editing instructions when disabled
        if (!includeBRoll) {
            resolvedInstructions = resolvedInstructions.replace(/\n?\d+\.\s*B-ROLL SUGGESTIONS[^\n]*(?:\n\s+[^\n]*)*/gi, '');
        }

        const bRollSchema = includeBRoll ? `
      "bRollSuggestions": [
        { "clipIndex": 0, "offsetInClip": 5.2, "duration": 3, "searchQuery": "descriptive stock footage query", "rationale": "why this helps" }
      ],` : '';

        const aiPrompt = `You are an expert short-form video editor and social media strategist.

BEFORE producing any JSON, work through these two phases internally:

PHASE 1 — MOMENT DISCOVERY
Read the ENTIRE transcript end-to-end. Identify ${candidateCount} candidate moments with strong standalone potential. For each, note the approximate timestamp range and one sentence on WHY it's powerful (what makes it scroll-stopping: the hook quality, the emotional peak, the counterintuitive statement). Then rank them and select the top ${count}.

PHASE 2 — PRECISION EDITING
For each of your top ${count} selected moments, construct the short: exact clip boundaries, jump cuts to condense, startPhrase/endPhrase anchors, keywords. Apply all editing rules below.

Output ONLY the final JSON — do not include your Phase 1 notes in the response.

---

Identify the content type (sermon, podcast, interview, lecture, motivational talk, etc.) and apply genre-appropriate selection strategies when choosing clips.

Create ${count} different dense, fast-paced ${duration}-second shorts from this content. Each short must use a DIFFERENT moment/section — no overlapping clips between shorts. Rank them from strongest to weakest viral potential.

${userPromptSection}${refinementSection}${existingShortsSection}

"${videoTitle}"

TRANSCRIPT (with timestamps):
${groupedTranscript.substring(0, 15000)}

${resolvedInstructions}

Return JSON only — an object with a "shorts" array containing exactly ${count} short${count === 1 ? '' : 's'}.

FIELD PRIORITY — work in this order:
1. REQUIRED (nail these for every short before touching anything else):
   - title, clips (startTime, endTime, startPhrase, endPhrase), totalDuration
2. OPTIONAL (populate only after all ${count} shorts have precise clips — omit if uncertain):
   - hookTitle, hook, resolution, keywords per clip${includeBRoll ? ', bRollSuggestions' : ''}

Schema:
{
  "shorts": [
    {
      "title": "engaging title, max 60 chars",
      "totalDuration": number,
      "clips": [
        {
          "startTime": number,
          "endTime": number,
          "startPhrase": "first 4-6 verbatim words of clip",
          "endPhrase": "last 4-6 verbatim words of clip",
          "keywords": ["word1", "word2"]
        }
      ],${bRollSchema}
      "hookTitle": "MAX 5 WORDS, dramatic",
      "hook": "the opening hook line",
      "resolution": "the closing payoff line"
    }
  ]
}

CRITICAL JSON RULES:
1. Return ONLY the raw JSON object. Do not wrap it in \`\`\`json markdown blocks.
2. Ensure ALL double quotes inside string values are properly escaped (e.g., \\"word\\").
3. Do not include any trailing commas.
4. Start immediately with { and end with }
5. Omitted optional fields are fine — never guess or pad them to fill space.`;

        // Use a stronger model for creative editorial decisions
        const effectiveModel = model || GEMINI_MODEL;
        console.log('[AI] Generating short for:', videoTitle, '| Model:', effectiveModel);

        let result;
        if (effectiveModel.startsWith('moonshot')) {
            result = await callKimi(aiPrompt, effectiveModel);
        } else if (effectiveModel.startsWith('MiniMax') || effectiveModel.startsWith('abab')) {
            // Force MiniMax-M2 if not specified correctly for coding plan
            const modelToUse = effectiveModel.includes('M2') ? effectiveModel : 'MiniMax-M2';
            result = await callMiniMax(aiPrompt, modelToUse);
        } else if (effectiveModel.startsWith('gpt-') || effectiveModel.startsWith('o')) {
            result = await callOpenAI(aiPrompt, effectiveModel);
        } else {
            result = await callGemini(aiPrompt, effectiveModel);
        }

        // Helper to process clips for a single short
        function processClips(clips) {
            for (const clip of clips) {
                let phraseMatchedStart = false;
                let phraseMatchedEnd = false;

                if (clip.startPhrase) {
                    const matched = matchPhraseToTimestamp(transcriptLines, clip.startPhrase, clip.startTime, 'start');
                    if (matched !== null) {
                        clip.startTime = matched;
                        phraseMatchedStart = true;
                    }
                }
                if (clip.endPhrase) {
                    const matched = matchPhraseToTimestamp(transcriptLines, clip.endPhrase, clip.endTime, 'end');
                    if (matched !== null) {
                        clip.endTime = matched;
                        phraseMatchedEnd = true;
                    }
                }

                if (!phraseMatchedStart) {
                    clip.startTime = snapClipStartTime(transcriptLines, clip.startTime);
                }
                if (!phraseMatchedEnd) {
                    clip.endTime = snapClipEndTime(transcriptLines, clip.endTime);
                }

                clip.startTime = Math.max(0, clip.startTime - 0.08);
                clip.endTime = clip.endTime + 0.08;

                clip.startTime = trimPreambleWords(transcriptLines, clip.startTime, clip.endTime);
                clip.endTime = trimTrailerWords(transcriptLines, clip.startTime, clip.endTime);

                clip.text = getTextForTimeRange(transcriptLines, clip.startTime, clip.endTime);
                if (clip.keywords && Array.isArray(clip.keywords) && clip.text) {
                    const words = clip.text.split(/\s+/);
                    const usedIndices = new Set();
                    clip.keywords = clip.keywords
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
                } else {
                    clip.keywords = [];
                }
            }
            return clips.reduce((sum, c) => sum + (c.endTime - c.startTime), 0);
        }

        // Handle both multi-short (shorts array) and legacy single-short (clips array) responses
        if (result.shorts && Array.isArray(result.shorts)) {
            for (const short of result.shorts) {
                if (short.clips && Array.isArray(short.clips)) {
                    short.totalDuration = processClips(short.clips);
                }
            }
        } else if (result.clips && Array.isArray(result.clips)) {
            // Legacy single-short response — wrap into shorts array
            result.totalDuration = processClips(result.clips);
            result.shorts = [{
                title: result.title,
                hookTitle: result.hookTitle,
                hook: result.hook,
                resolution: result.resolution,
                clips: result.clips,
                bRollSuggestions: result.bRollSuggestions,
                totalDuration: result.totalDuration
            }];
        }

        res.json(result);

    } catch (error) {
        console.error('[AI] Generate short error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Build Short Prompt endpoint (for external AI usage)
app.post('/api/ai/build-short-prompt', async (req, res) => {
    try {
        const { transcript, videoTitle, prompt, targetDuration, refinementInstruction, existingShorts, editingInstructions, bRollEnabled, shortCount } = req.body;
        const includeBRoll = bRollEnabled !== false;
        const count = Math.max(1, Math.min(20, parseInt(shortCount) || 10));
        const candidateCount = Math.round(count * 1.8);

        if (!transcript || !videoTitle) {
            return res.status(400).json({ error: 'Missing transcript or videoTitle' });
        }

        const transcriptLines = parseTranscriptLines(transcript);
        const consolidated = consolidateSegments(transcriptLines);
        const rawTranscript = consolidated
            .map(line => `[${line.start.toFixed(2)}s] ${line.text}`)
            .join('\n');

        const duration = targetDuration || 60;

        const userPromptSection = prompt?.trim()
            ? `USER'S CREATIVE DIRECTION: "${prompt}"`
            : `USER'S CREATIVE DIRECTION: None given — auto-detect the single most powerful, scroll-stopping moment. Prioritize emotional peaks, counterintuitive statements, and mic-drop lines.`;

        const refinementSection = refinementInstruction?.trim()
            ? `\nREFINEMENT (this overrides the original direction): "${refinementInstruction}"`
            : '';

        const existingShortsSection = (existingShorts && existingShorts.length > 0 && !refinementInstruction)
            ? `\nALREADY USED (pick a DIFFERENT moment):\n${existingShorts.map((s, i) => `- "${s.title}" (${s.startTime}-${s.endTime}s)`).join('\n')}`
            : '';

        let resolvedInstructions = (editingInstructions && editingInstructions.trim())
            ? editingInstructions.trim()
            : DEFAULT_EDITING_INSTRUCTIONS(duration, count);

        // Strip B-roll rule from editing instructions when disabled
        if (!includeBRoll) {
            resolvedInstructions = resolvedInstructions.replace(/\n?\d+\.\s*B-ROLL SUGGESTIONS[^\n]*(?:\n\s+[^\n]*)*/gi, '');
        }

        const bRollSchema = includeBRoll ? `
      "bRollSuggestions": [
        { "clipIndex": 0, "offsetInClip": 5.2, "duration": 3, "searchQuery": "descriptive stock footage query", "rationale": "why this helps" }
      ],` : '';

        const aiPrompt = `You are an expert short-form video editor and social media strategist.

BEFORE producing any JSON, work through these two phases internally:

PHASE 1 — MOMENT DISCOVERY
Read the ENTIRE transcript end-to-end. Identify ${candidateCount} candidate moments with strong standalone potential. For each, note the approximate timestamp range and one sentence on WHY it's powerful (what makes it scroll-stopping: the hook quality, the emotional peak, the counterintuitive statement). Then rank them and select the top ${count}.

PHASE 2 — PRECISION EDITING
For each of your top ${count} selected moments, construct the short: exact clip boundaries, jump cuts to condense, startPhrase/endPhrase anchors, keywords. Apply all editing rules below.

Output ONLY the final JSON — do not include your Phase 1 notes in the response.

---

Identify the content type (sermon, podcast, interview, lecture, motivational talk, etc.) and apply genre-appropriate selection strategies when choosing clips.

Create ${count} different dense, fast-paced ${duration}-second shorts from this content. Each short must use a DIFFERENT moment/section — no overlapping clips between shorts. Rank them from strongest to weakest viral potential.

${userPromptSection}${refinementSection}${existingShortsSection}

"${videoTitle}"

TRANSCRIPT (with precise timestamps):
${rawTranscript.substring(0, 50000)}

${resolvedInstructions}

Return JSON only — an object with a "shorts" array containing exactly ${count} short${count === 1 ? '' : 's'}.

FIELD PRIORITY — work in this order:
1. REQUIRED (nail these for every short before touching anything else):
   - title, clips (startTime, endTime, startPhrase, endPhrase), totalDuration
2. OPTIONAL (populate only after all ${count} shorts have precise clips — omit if uncertain):
   - hookTitle, hook, resolution, keywords per clip${includeBRoll ? ', bRollSuggestions' : ''}

Schema:
{
  "shorts": [
    {
      "title": "engaging title, max 60 chars",
      "totalDuration": number,
      "clips": [
        {
          "startTime": number,
          "endTime": number,
          "startPhrase": "first 4-6 verbatim words of clip",
          "endPhrase": "last 4-6 verbatim words of clip",
          "keywords": ["word1", "word2"]
        }
      ],${bRollSchema}
      "hookTitle": "MAX 5 WORDS, dramatic",
      "hook": "the opening hook line",
      "resolution": "the closing payoff line"
    }
  ]
}

CRITICAL JSON RULES:
1. Return ONLY the raw JSON object. Do not wrap it in \`\`\`json markdown blocks.
2. Ensure ALL double quotes inside string values are properly escaped (e.g., \\"word\\").
3. Do not include any trailing commas.
4. Start immediately with { and end with }
5. Omitted optional fields are fine — never guess or pad them to fill space.`;

        res.json({ prompt: aiPrompt });

    } catch (error) {
        console.error('[AI] Build short prompt error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== Social Media Packages ====================

/**
 * Build the social package prompt string shared by both the in-app generator
 * (/api/ai/generate-social-packages) and the external-AI copy-to-clipboard
 * flow (/api/ai/build-social-packages-prompt). Takes already-generated shorts
 * (title/hookTitle/hook/resolution/clipText) plus brand settings + source
 * video URL and returns a ready-to-send LLM prompt.
 */
function buildSocialPackagesPrompt(shorts, videoTitle, sourceVideoUrl, brandSettings) {
    const bs = brandSettings || {};
    const shortsBlock = (shorts || []).map((s, i) => {
        const hookLine = (s.hook || '').trim();
        const resolutionLine = (s.resolution || '').trim();
        const hookTitleLine = (s.hookTitle || '').trim();
        return `
---
SHORT #${i + 1}
id: ${s.id}
title: "${(s.title || '').replace(/"/g, '\\"')}"
hookTitle (on-screen text, ≤5 words)${hookTitleLine ? '' : ' [not provided — derive from clip]'}: "${hookTitleLine.replace(/"/g, '\\"')}"
spoken hook (opening line)${hookLine ? '' : ' [not provided — derive from clip]'}: "${hookLine.replace(/"/g, '\\"')}"
spoken resolution (closing line)${resolutionLine ? '' : ' [not provided — derive from clip]'}: "${resolutionLine.replace(/"/g, '\\"')}"
full clip transcript:
"""
${(s.clipText || '').substring(0, 4000)}
"""`;
    }).join('\n');

    return `You are a social media growth strategist producing ready-to-paste copy for a batch of short-form videos that were all cut from the same source video.

SOURCE VIDEO: "${videoTitle || 'Unknown'}"
SOURCE VIDEO URL: ${sourceVideoUrl || '(not provided)'}

BRAND PROFILE:
- Instagram: ${bs.instagramHandle || '(none)'}
- TikTok: ${bs.tiktokHandle || '(none)'}
- YouTube channel: ${bs.youtubeChannel || '(none)'}
- Website: ${bs.website || '(none)'}
- Default CTA: ${bs.defaultCta || '(none)'}

RULES:
- Write in a human, punchy tone — never corporate or generic.
- Each short is independent; do not cross-reference other shorts in the batch.
- First line of every caption MUST hook curiosity or emotion.
- Every caption must feel NATIVE to its platform. Do not reuse the same caption across platforms.
- If "spoken hook", "spoken resolution", or "hookTitle" are marked [not provided], extract them yourself from the full clip transcript: hook = the most compelling opening line, resolution = the most powerful closing line, hookTitle = ≤5 word distillation of the core idea.
- Hashtags lowercase, NO '#' prefix in the array values, NO spaces, NO emojis inside hashtags.
- TikTok caption must be under 150 characters.
- YouTube titles must create curiosity or promise value; avoid clickbait.
- Thumbnail text: ≤5 words each.
- If a source video URL is provided, include it naturally in the YouTube description (e.g. "Full sermon: <url>").
- If brand handles are provided, weave them into captions / CTAs where natural (don't force them).
- If a default CTA is provided, use it as the starting point for each platform's CTA and adapt per-platform.
- Do NOT include emojis in hashtags or tags arrays.

SHORTS TO PROCESS:
${shortsBlock}

OUTPUT FORMAT — return ONLY this JSON, no markdown fences, no commentary:
{
  "packages": [
    {
      "id": "<matching short id>",
      "instagram": {
        "hook": "...",
        "caption": "...",
        "cta": "...",
        "hashtags": ["tag1", "tag2"]
      },
      "tiktok": {
        "hook": "...",
        "caption": "...",
        "onScreenText": ["...", "...", "..."],
        "cta": "...",
        "hashtags": ["tag1"]
      },
      "youtube": {
        "titles": ["...", "...", "..."],
        "description": "...",
        "hook": "...",
        "thumbnailText": ["...", "..."],
        "cta": "...",
        "tags": ["keyword1"]
      }
    }
  ]
}

CRITICAL JSON RULES:
1. Return ONLY the raw JSON object. No \`\`\`json fences.
2. Escape all double quotes inside string values.
3. No trailing commas.
4. packages array length MUST equal the number of shorts in SHORTS TO PROCESS.
5. Each package's "id" MUST match its source short's id verbatim.`;
}

/**
 * In-app path — dispatches to the selected model and returns parsed packages.
 */
app.post('/api/ai/generate-social-packages', async (req, res) => {
    try {
        const { shorts, videoTitle, sourceVideoUrl, brandSettings, model } = req.body;

        if (!shorts || !Array.isArray(shorts) || shorts.length === 0) {
            return res.status(400).json({ error: 'Missing shorts array' });
        }

        const aiPrompt = buildSocialPackagesPrompt(shorts, videoTitle, sourceVideoUrl, brandSettings);

        const effectiveModel = model || GEMINI_MODEL;
        console.log('[AI] Generating social packages for', shorts.length, 'shorts | Model:', effectiveModel);

        let result;
        if (effectiveModel.startsWith('moonshot')) {
            result = await callKimi(aiPrompt, effectiveModel);
        } else if (effectiveModel.startsWith('MiniMax') || effectiveModel.startsWith('abab')) {
            const modelToUse = effectiveModel.includes('M2') ? effectiveModel : 'MiniMax-M2';
            result = await callMiniMax(aiPrompt, modelToUse);
        } else if (effectiveModel.startsWith('gpt-') || effectiveModel.startsWith('o')) {
            result = await callOpenAI(aiPrompt, effectiveModel);
        } else {
            result = await callGemini(aiPrompt, effectiveModel);
        }

        res.json(result);
    } catch (error) {
        console.error('[AI] Generate social packages error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

/**
 * External-AI path — returns the prompt string for the user to paste into
 * ChatGPT/Claude externally.
 */
app.post('/api/ai/build-social-packages-prompt', async (req, res) => {
    try {
        const { shorts, videoTitle, sourceVideoUrl, brandSettings } = req.body;

        if (!shorts || !Array.isArray(shorts) || shorts.length === 0) {
            return res.status(400).json({ error: 'Missing shorts array' });
        }

        const aiPrompt = buildSocialPackagesPrompt(shorts, videoTitle, sourceVideoUrl, brandSettings);
        res.json({ prompt: aiPrompt });
    } catch (error) {
        console.error('[AI] Build social packages prompt error:', error.message);
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
      "relevanceScore": number (0-100, how relevant is this sermon),
      "summary": "string (1-2 sentences explaining why this matches)",
      "matchingQuotes": [
        "string (exact quote from the transcript that matches)"
      ]
    }
  ]
}

Rules:
- Only include sermons with relevanceScore >= 30
- Sort by relevanceScore descending
- Include 1-5 matching quotes per sermon
- If no sermons match, return {"results": []}
`;

        console.log('[AI] Searching', transcripts.length, 'transcripts for:', query);
        const result = await callGemini(aiPrompt);
        res.json(result);

    } catch (error) {
        console.error('[AI] Search error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== Python Tracking Endpoints ====================

// Multer for handling video file uploads for Python tracking
const multer = require('multer');
const trackingUploadDir = path.join(os.tmpdir(), 'vibecut-tracking');
if (!fs.existsSync(trackingUploadDir)) fs.mkdirSync(trackingUploadDir, { recursive: true });

const trackingUpload = multer({
    storage: multer.diskStorage({
        destination: trackingUploadDir,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.mp4';
            cb(null, `track_${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
});

// Map of uploaded file IDs -> paths for tracking
const trackingFiles = new Map();

// Clean up old tracking files (older than 1 hour)
setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [id, info] of trackingFiles) {
        if (info.uploadedAt < cutoff) {
            try { fs.unlinkSync(info.path); } catch {}
            trackingFiles.delete(id);
        }
    }
}, 600000); // Check every 10 minutes

// Upload a video file for tracking
app.post('/api/tracking/upload', trackingUpload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No video file provided' });
    }
    const fileId = `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    trackingFiles.set(fileId, { path: req.file.path, uploadedAt: Date.now() });
    console.log(`[Tracking] Video uploaded: ${fileId} -> ${req.file.path} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    res.json({ success: true, fileId });
});

// Check if Python tracker is available
app.get('/api/tracking/capabilities', (req, res) => {
    const tracker = getTrackerInfo();
    if (!tracker) {
        return res.json({ success: true, available: false, reason: 'vibecut-tracker not installed and Python source not available' });
    }
    if (tracker.type === 'binary') {
        // Just check the binary exists and is accessible — don't actually run it
        // (running PyInstaller binaries cold can take 5-10 seconds and cause timeouts)
        try {
            // On Windows, X_OK is unreliable (doesn't map to Windows ACLs properly).
            const checkFlag = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
            fs.accessSync(tracker.path, checkFlag);
            console.log(`[Tracking] Tracker binary found: ${tracker.path}`);
            res.json({ success: true, available: true, mode: 'binary', capabilities: {} });
        } catch {
            console.log(`[Tracking] Tracker binary not accessible: ${tracker.path}`);
            res.json({ success: true, available: false, reason: 'Tracker binary not accessible' });
        }
    } else {
        // Python source mode — verify dependencies are installed
        console.log(`[Tracking] Tracker via Python source: ${tracker.python} in ${tracker.pythonDir}`);
        res.json({ success: true, available: true, mode: 'python-source', capabilities: {} });
    }
});

// Python-enhanced tracking endpoint
app.post('/api/tracking/analyze', async (req, res) => {
    const tracker = getTrackerInfo();
    if (!tracker) {
        return res.status(501).json({ success: false, fallback: true, error: 'Python tracker not installed' });
    }

    const { fileId, startTime, endTime, mode, options, sampleInterval } = req.body;

    // Look up the uploaded file
    const fileInfo = fileId ? trackingFiles.get(fileId) : null;
    if (!fileInfo || !fs.existsSync(fileInfo.path)) {
        return res.status(400).json({ success: false, fallback: true, error: 'Video file not found. Upload via /api/tracking/upload first.' });
    }

    const videoPath = fileInfo.path;

    const request = JSON.stringify({
        command: 'track',
        videoPath,
        startTime: startTime || 0,
        endTime: endTime || null,
        sampleInterval: sampleInterval || 0.1,
        mode: mode || 'person_center',
        options: options || {},
    });

    // Check the video file exists and log its size
    const videoStat = fs.statSync(videoPath);

    // Determine spawn command based on tracker type
    let spawnCmd, spawnArgs;
    if (tracker.type === 'binary') {
        spawnCmd = tracker.path;
        spawnArgs = [];
        console.log(`[Tracking] Running Python tracker (binary): ${tracker.path}`);
    } else {
        spawnCmd = tracker.python;
        spawnArgs = ['-m', 'vibecut_tracker.main'];
        console.log(`[Tracking] Running Python tracker (source): ${tracker.python} -m vibecut_tracker.main`);
    }
    console.log(`[Tracking] Video: ${videoPath} (${(videoStat.size / 1024 / 1024).toFixed(1)}MB), Time: ${startTime}-${endTime}, Mode: ${mode}`);

    try {
        const child = spawn(spawnCmd, spawnArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
            cwd: tracker.type === 'python' ? tracker.pythonDir : undefined,
        });
        activeChildren.add(child);

        // Manual timeout since spawn doesn't support timeout option
        const killTimer = setTimeout(() => {
            console.error('[Tracking] Python tracker timed out after 5 minutes, killing...');
            child.kill('SIGKILL');
        }, 300000);

        child.stdin.write(request);
        child.stdin.end();

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => {
            const chunk = d.toString();
            stderr += chunk;
            // Log progress updates and errors from Python
            for (const line of chunk.split('\n').filter(l => l.trim())) {
                try {
                    const progress = JSON.parse(line);
                    if (progress.progress !== undefined) {
                        console.log(`[Tracking] Progress: ${Math.round(progress.progress * 100)}% - ${progress.label || ''}`);
                    }
                } catch {
                    // Non-JSON stderr = Python error/traceback
                    console.log(`[Tracking] Python: ${line}`);
                }
            }
        });

        child.on('close', (code) => {
            activeChildren.delete(child);
            clearTimeout(killTimer);
            if (code !== 0) {
                console.error(`[Tracking] Python tracker exited with code ${code}`);
                console.error(`[Tracking] stderr: ${stderr.substring(0, 500)}`);
                return res.status(500).json({ success: false, error: `Tracker exited with code ${code}`, stderr: stderr.substring(0, 500), fallback: true });
            }

            // Try to parse JSON result from stdout first.
            // PyInstaller on Windows can sometimes redirect stdout to stderr,
            // so if stdout is empty/invalid, also check stderr for the result.
            let resultJson = stdout.trim();

            // If stdout is empty or not valid JSON, check stderr for backup result marker
            if (!resultJson || !resultJson.startsWith('{')) {
                const marker = stderr.match(/__RESULT__(.+?)__END_RESULT__/);
                if (marker) {
                    console.log('[Tracking] stdout empty, recovered result from stderr backup marker');
                    resultJson = marker[1];
                } else {
                    // Last resort: try to find a JSON object in stderr
                    // (PyInstaller may route print() to stderr on Windows)
                    const lines = stderr.split('\n').filter(l => l.trim());
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i].trim();
                        if (line.startsWith('{') && line.endsWith('}')) {
                            try {
                                JSON.parse(line);
                                console.log('[Tracking] stdout empty, recovered JSON result from stderr');
                                resultJson = line;
                                break;
                            } catch {}
                        }
                    }
                }
            }

            try {
                const result = JSON.parse(resultJson);
                if (result.success === false) {
                    console.error(`[Tracking] Tracker returned error: ${result.error}`);
                } else {
                    console.log(`[Tracking] Result: ${result.positions?.length || 0} positions, method=${result.method}`);
                }
                if (stderr.trim()) console.log(`[Tracking] stderr: ${stderr.substring(0, 1000)}`);
                res.json(result);
            } catch (e) {
                console.error('[Tracking] Invalid tracker output. stdout:', stdout.substring(0, 200));
                console.error('[Tracking] stderr:', stderr.substring(0, 500));
                res.status(500).json({ success: false, error: 'Invalid tracker output', fallback: true });
            }
        });

        child.on('error', (err) => {
            activeChildren.delete(child);
            clearTimeout(killTimer);
            console.error('[Tracking] Failed to spawn tracker:', err.message);
            res.status(500).json({ success: false, error: err.message, fallback: true });
        });
    } catch (err) {
        console.error('[Tracking] Error:', err.message);
        res.status(500).json({ success: false, error: err.message, fallback: true });
    }
});

// ==================== AssemblyAI Transcription & Local Cache ====================

// Check local cache for a video
app.get('/api/local-cache', (req, res) => {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });
    const cache = localStore.hasLocalCache(videoId);
    res.json(cache);
});

// Stream locally cached video with byte-range support (required for browser video playback/seeking)
app.get('/api/local-video', (req, res) => {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const videoPath = localStore.getLocalVideoPath(videoId);
    if (!videoPath) return res.status(404).json({ error: 'Video not cached locally' });

    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.header('Content-Type', 'video/mp4');
    res.header('Accept-Ranges', 'bytes');

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        res.status(206);
        res.header('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        res.header('Content-Length', chunkSize);
        fs.createReadStream(videoPath, { start, end }).pipe(res);
    } else {
        res.header('Content-Length', fileSize);
        fs.createReadStream(videoPath).pipe(res);
    }
});

// Get locally cached transcript
app.get('/api/local-transcript', (req, res) => {
    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    const transcript = localStore.loadTranscript(videoId);
    if (!transcript) return res.status(404).json({ error: 'Transcript not cached locally' });
    res.json(transcript);
});

// Transcribe using AssemblyAI (SSE for progress)
// For YouTube videos (with videoId): uses locally cached video
// For uploaded files: accepts multipart upload
const transcribeUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(os.tmpdir(), 'vibecut-transcribe');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.mp4';
            cb(null, `transcribe_${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
});

app.post('/api/transcribe', transcribeUpload.single('file'), async (req, res) => {
    // Read key fresh from process.env in case it was set via Settings after server startup
    const apiKey = process.env.ASSEMBLYAI_API_KEY || ASSEMBLYAI_API_KEY;
    if (!apiKey) {
        return res.status(400).json({ error: 'ASSEMBLYAI_API_KEY not configured. Add it in Settings.' });
    }

    const { videoId, youtubeUrl } = req.body || {};
    let videoPath = null;
    let tempAudioPath = null;
    let tempDownloadPath = null;
    let uploadedFilePath = req.file ? req.file.path : null;
    let resolvedVideoId = videoId;

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        // Resolve video file path
        if (videoId) {
            videoPath = localStore.getLocalVideoPath(videoId);
            if (!videoPath) {
                sendEvent({ status: 'error', detail: 'Video not found in local cache. Re-import from YouTube first.' });
                return res.end();
            }
        } else if (youtubeUrl) {
            // Auto-download YouTube video for transcription
            resolvedVideoId = extractVideoId(youtubeUrl);
            if (!resolvedVideoId) {
                sendEvent({ status: 'error', detail: 'Invalid YouTube URL.' });
                return res.end();
            }

            // Check local cache first
            videoPath = localStore.getLocalVideoPath(resolvedVideoId);
            if (!videoPath) {
                sendEvent({ status: 'downloading', detail: 'Downloading video from YouTube...' });
                const ytUrl = `https://www.youtube.com/watch?v=${resolvedVideoId}`;
                tempDownloadPath = path.join(os.tmpdir(), `${resolvedVideoId}_${Date.now()}.mp4`);

                const downloadCmdBuilder = (useCookies) => `"${YT_DLP}" -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${tempDownloadPath}"${useCookies ? getCookieArg() : ''} "${ytUrl}"`;

                await runYtDlpWithFallback(downloadCmdBuilder, {
                    encoding: 'utf8',
                    maxBuffer: 50 * 1024 * 1024,
                    timeout: 300000,
                    env: childEnv
                });

                if (!fs.existsSync(tempDownloadPath)) {
                    sendEvent({ status: 'error', detail: 'Failed to download video from YouTube.' });
                    return res.end();
                }

                // Save to local cache
                try {
                    localStore.saveVideo(resolvedVideoId, tempDownloadPath);
                    videoPath = localStore.getLocalVideoPath(resolvedVideoId);
                } catch (e) {
                    console.warn('[Transcribe] Failed to cache downloaded video:', e.message);
                    videoPath = tempDownloadPath;
                }
            }
        } else if (uploadedFilePath) {
            videoPath = uploadedFilePath;
        } else {
            sendEvent({ status: 'error', detail: 'No videoId, youtubeUrl, or file provided.' });
            return res.end();
        }

        // Extract audio via ffmpeg (smaller upload to AssemblyAI)
        let fileToUpload = videoPath;
        try {
            const FFMPEG = getFfmpegPath();
            tempAudioPath = path.join(os.tmpdir(), `assemblyai_audio_${Date.now()}.wav`);
            sendEvent({ status: 'extracting_audio' });

            await execAsync(
                `"${FFMPEG}" -i "${videoPath}" -vn -ac 1 -ar 16000 -f wav "${tempAudioPath}" -y`,
                { timeout: 120000, env: childEnv }
            );

            if (fs.existsSync(tempAudioPath) && fs.statSync(tempAudioPath).size > 0) {
                fileToUpload = tempAudioPath;
                console.log(`[Transcribe] Extracted audio: ${(fs.statSync(tempAudioPath).size / 1024 / 1024).toFixed(1)}MB`);
            } else {
                console.warn('[Transcribe] Audio extraction produced empty file, uploading original video');
                tempAudioPath = null;
            }
        } catch (ffmpegErr) {
            console.warn('[Transcribe] ffmpeg audio extraction failed, uploading original file:', ffmpegErr.message);
            tempAudioPath = null;
            // Fall through — upload original video file instead
        }

        // Run AssemblyAI transcription with progress updates
        const result = await transcribeFile(fileToUpload, apiKey, (progress) => {
            sendEvent(progress);
        });

        // Convert to app format
        const events = assemblyAIToAnalysisEvents(result);

        // Save transcript locally if this is a YouTube video
        const saveId = resolvedVideoId || videoId;
        if (saveId) {
            try {
                localStore.saveTranscript(saveId, {
                    source: 'assemblyai',
                    transcriptId: result.id,
                    text: result.text,
                    words: result.words,
                    events: events,
                    language: result.language_code,
                    createdAt: new Date().toISOString(),
                });
            } catch (saveErr) {
                console.warn('[Transcribe] Failed to cache transcript:', saveErr.message);
            }
        }

        sendEvent({
            status: 'completed',
            events: events,
            wordCount: result.words?.length || 0,
            language: result.language_code,
            text: result.text,
        });
    } catch (err) {
        console.error('[Transcribe] Error:', err.message);
        sendEvent({ status: 'error', detail: err.message });
    } finally {
        // Clean up temp files
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
            fs.unlink(tempAudioPath, () => {});
        }
        if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
            fs.unlink(uploadedFilePath, () => {});
        }
        if (tempDownloadPath && fs.existsSync(tempDownloadPath)) {
            fs.unlink(tempDownloadPath, () => {});
        }
        res.end();
    }
});

// ==================== Trends Endpoints ====================

const googleTrends = require('google-trends-api');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Simple in-memory cache: { key: { data, timestamp } }
const trendsCache = {};
const TRENDS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(key) {
    const entry = trendsCache[key];
    if (entry && Date.now() - entry.timestamp < TRENDS_CACHE_TTL) return entry.data;
    return null;
}
function setCache(key, data) {
    trendsCache[key] = { data, timestamp: Date.now() };
}

// YouTube Trending Videos
app.get('/api/trends/youtube', async (req, res) => {
    const { region = 'US', category = '0' } = req.query;
    const cacheKey = `yt_${region}_${category}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    if (!YOUTUBE_API_KEY) {
        return res.status(400).json({
            error: 'YOUTUBE_API_KEY not configured',
            setup: 'Get a free API key at https://console.cloud.google.com/apis/credentials and add YOUTUBE_API_KEY to your .env.local'
        });
    }

    try {
        const params = new URLSearchParams({
            part: 'snippet,statistics',
            chart: 'mostPopular',
            regionCode: region,
            maxResults: '25',
            key: YOUTUBE_API_KEY,
        });
        if (category !== '0') params.set('videoCategoryId', category);

        const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`YouTube API ${response.status}: ${err}`);
        }

        const data = await response.json();
        const now = Date.now();
        const items = (data.items || []).map((v, i) => ({
            id: `yt_${v.id}`,
            title: v.snippet.title,
            source: 'youtube',
            category: v.snippet.categoryId || 'General',
            rank: i + 1,
            previousRank: null,
            velocity: 'rising',
            viewCount: parseInt(v.statistics?.viewCount || '0', 10),
            engagement: parseInt(v.statistics?.likeCount || '0', 10),
            growthPercent: null,
            keywords: (v.snippet.tags || []).slice(0, 5),
            thumbnailUrl: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            fetchedAt: now,
        }));

        setCache(cacheKey, items);
        res.json(items);
    } catch (error) {
        console.error('YouTube trends error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Google Trends (Daily trending searches)
app.get('/api/trends/google', async (req, res) => {
    const { geo = 'US' } = req.query;
    const cacheKey = `gt_${geo}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    try {
        const result = await googleTrends.dailyTrends({ geo });
        const parsed = JSON.parse(result);
        const days = parsed.default?.trendingSearchesDays || [];
        const now = Date.now();
        const items = [];

        for (const day of days.slice(0, 2)) { // last 2 days
            for (const trend of day.trendingSearches || []) {
                const traffic = trend.formattedTraffic || '0';
                const viewCount = parseInt(traffic.replace(/[^0-9]/g, ''), 10) * (traffic.includes('M') ? 1000000 : traffic.includes('K') ? 1000 : 1);
                items.push({
                    id: `gt_${trend.title?.query?.replace(/\s+/g, '_') || items.length}`,
                    title: trend.title?.query || 'Unknown',
                    source: 'google',
                    category: 'Trending Search',
                    rank: items.length + 1,
                    previousRank: null,
                    velocity: viewCount > 500000 ? 'exploding' : viewCount > 100000 ? 'rising' : 'stable',
                    viewCount,
                    engagement: null,
                    growthPercent: null,
                    keywords: (trend.relatedQueries || []).map(q => q.query).slice(0, 5),
                    thumbnailUrl: trend.image?.imageUrl || null,
                    url: trend.title?.exploreLink ? `https://trends.google.com${trend.title.exploreLink}` : null,
                    fetchedAt: now,
                });
            }
        }

        setCache(cacheKey, items.slice(0, 25));
        res.json(items.slice(0, 25));
    } catch (error) {
        console.error('Google Trends error:', error.message);
        // Google Trends scraping is unreliable - return empty gracefully
        res.json([]);
    }
});

// Reddit Trending Posts
app.get('/api/trends/reddit', async (req, res) => {
    const { timeRange = 'today' } = req.query;
    const redditTime = timeRange === 'today' ? 'day' : timeRange === 'week' ? 'week' : 'month';
    const cacheKey = `reddit_${redditTime}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    try {
        const subreddits = ['videos', 'viral', 'trending'];
        const now = Date.now();
        const items = [];

        for (const sub of subreddits) {
            try {
                const response = await fetch(
                    `https://www.reddit.com/r/${sub}/top.json?t=${redditTime}&limit=10`,
                    { headers: { 'User-Agent': 'VibeCutPro/1.0' } }
                );
                if (!response.ok) continue;

                const data = await response.json();
                for (const post of (data.data?.children || [])) {
                    const d = post.data;
                    if (!d) continue;
                    items.push({
                        id: `reddit_${d.id}`,
                        title: d.title,
                        source: 'reddit',
                        category: `r/${sub}`,
                        rank: items.length + 1,
                        previousRank: null,
                        velocity: d.score > 10000 ? 'exploding' : d.score > 1000 ? 'rising' : 'stable',
                        viewCount: d.score || 0,
                        engagement: d.num_comments || 0,
                        growthPercent: null,
                        keywords: [],
                        thumbnailUrl: d.thumbnail && d.thumbnail.startsWith('http') ? d.thumbnail : null,
                        url: `https://reddit.com${d.permalink}`,
                        fetchedAt: now,
                    });
                }
            } catch (subErr) {
                console.warn(`Reddit r/${sub} failed:`, subErr.message);
            }
        }

        // Sort by score descending
        items.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
        items.forEach((item, i) => { item.rank = i + 1; });

        const result = items.slice(0, 25);
        setCache(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error('Reddit trends error:', error.message);
        res.json([]);
    }
});

// Aggregated trends from all sources
app.get('/api/trends/all', async (req, res) => {
    const { region = 'US', category = '0', timeRange = 'today' } = req.query;

    try {
        const [youtube, google, reddit] = await Promise.allSettled([
            fetch(`http://localhost:${PORT}/api/trends/youtube?region=${region}&category=${category}`).then(r => r.json()),
            fetch(`http://localhost:${PORT}/api/trends/google?geo=${region}`).then(r => r.json()),
            fetch(`http://localhost:${PORT}/api/trends/reddit?timeRange=${timeRange}`).then(r => r.json()),
        ]);

        const items = [];
        if (youtube.status === 'fulfilled' && Array.isArray(youtube.value)) items.push(...youtube.value);
        if (google.status === 'fulfilled' && Array.isArray(google.value)) items.push(...google.value);
        if (reddit.status === 'fulfilled' && Array.isArray(reddit.value)) items.push(...reddit.value);

        // Re-rank combined results
        items.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
        items.forEach((item, i) => { item.rank = i + 1; });

        res.json(items);
    } catch (error) {
        console.error('Aggregated trends error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// AI-powered Repost Ranker
app.post('/api/ai/analyze-trends', async (req, res) => {
    const { shorts, trends } = req.body;
    if (!shorts || !trends) {
        return res.status(400).json({ error: 'Missing shorts or trends data' });
    }

    const trendSummary = trends.map(t =>
        `- "${t.title}" (${t.category}, ${t.velocity}${t.growthPercent ? `, +${t.growthPercent}%` : ''}, keywords: ${(t.keywords || []).join(', ')})`
    ).join('\n');

    const shortsSummary = shorts.map(s =>
        `- ID: ${s.id} | Title: "${s.title}" | Hook: "${s.hook}" | Keywords: ${(s.keywords || []).join(', ')}`
    ).join('\n');

    const prompt = `You are a social media trend analyst and algorithm expert. Given these currently trending topics:

${trendSummary}

Score each of the following short-form video clips on how well they could perform if posted/reposted right now (0-100).
Consider: topic relevance, keyword overlap, emotional resonance with current trends, timing.

Shorts to analyze:
${shortsSummary}

Return a JSON array called "analyses" where each element has:
- "shortId": the ID of the short
- "trendScore": integer 0-100
- "matchedTrends": array of trend titles this short aligns with
- "reasoning": one sentence explaining the score
- "suggestedAngle": one sentence on how to reframe/re-title for better trend alignment (optional)

Example: { "analyses": [{ "shortId": "abc", "trendScore": 85, "matchedTrends": ["AI in Education"], "reasoning": "Strong alignment with trending AI content.", "suggestedAngle": "Reframe title to emphasize AI transformation angle." }] }`;

    try {
        const result = await callGemini(prompt);
        res.json(result);
    } catch (error) {
        console.error('Trend analysis error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== AI Stock Query Suggestions ====================

app.post('/api/ai/suggest-stock-queries', async (req, res) => {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: 'Missing transcript' });

    const truncated = transcript.substring(0, 2000);

    const prompt = `Given this video transcript, suggest 6-8 concise stock footage search queries that would work well as B-roll or supplementary visuals. Return ONLY a valid JSON array of strings, nothing else.
Focus on concrete visual concepts, not abstract ideas. Mix wide shots with close-ups.
Example: ["sunset ocean waves", "person walking city street", "close up hands typing", "aerial view mountains", "coffee shop interior", "smartphone screen scrolling"]

Transcript: ${truncated}`;

    try {
        const result = await callGemini(prompt, 'gemini-2.0-flash');
        if (!result) {
            return res.status(500).json({ error: 'AI returned no result' });
        }

        // Extract JSON array from response
        const text = typeof result === 'string' ? result :
            result.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(result);
        const match = text.match(/\[[\s\S]*?\]/);
        if (match) {
            const queries = JSON.parse(match[0]);
            return res.json({ queries });
        }
        res.status(500).json({ error: 'Could not parse AI response' });
    } catch (error) {
        console.error('Suggest stock queries error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==================== Pexels B-Roll Video Search ====================

app.get('/api/pexels/search', async (req, res) => {
    const { query, per_page = '5', orientation = 'portrait' } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    if (!PEXELS_API_KEY) {
        return res.status(400).json({
            error: 'PEXELS_API_KEY not configured',
            setup: 'Get a free API key at https://www.pexels.com/api/ — sign up and copy your key into .env.local'
        });
    }

    // Cache (1h TTL, reuses existing trendsCache)
    const cacheKey = `pexels_${query}_${orientation}_${per_page}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    try {
        const params = new URLSearchParams({ query, per_page, orientation });
        const response = await fetch(`https://api.pexels.com/videos/search?${params}`, {
            headers: { Authorization: PEXELS_API_KEY }
        });

        if (response.status === 429) {
            return res.status(429).json({ error: 'Pexels rate limit exceeded. Try again later.' });
        }
        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ error: `Pexels API error: ${text}` });
        }

        const data = await response.json();
        const videos = (data.videos || []).map(v => {
            // Pick the best HD file (prefer portrait-ish, HD quality)
            const files = v.video_files || [];
            const hdFile = files.find(f => f.quality === 'hd' && f.height >= 720)
                || files.find(f => f.quality === 'hd')
                || files.find(f => f.quality === 'sd')
                || files[0];
            return {
                id: v.id,
                url: v.url,
                thumbnailUrl: v.image || '',
                videoFileUrl: hdFile ? hdFile.link : '',
                duration: v.duration || 0,
                width: hdFile ? hdFile.width : 0,
                height: hdFile ? hdFile.height : 0,
            };
        }).filter(v => v.videoFileUrl);

        const result = { videos };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error('Pexels search error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/pexels/photos', async (req, res) => {
    if (!PEXELS_API_KEY) {
        return res.status(400).json({ error: 'PEXELS_API_KEY not configured' });
    }

    const { query, per_page = 8, orientation = 'portrait' } = req.query;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });

    const cacheKey = `pexels_photos_${query}_${per_page}_${orientation}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    try {
        const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${per_page}&orientation=${orientation}`;
        const response = await fetch(url, { headers: { 'Authorization': PEXELS_API_KEY } });

        if (response.status === 429) return res.status(429).json({ error: 'Pexels rate limit reached.' });
        if (!response.ok) throw new Error(`Pexels photos API error: ${response.status}`);

        const data = await response.json();
        const photos = (data.photos || []).map(p => ({
            id: p.id,
            url: p.url,
            thumbnailUrl: p.src.medium,
            fullUrl: p.src.large2x || p.src.original,
            photographer: p.photographer,
            width: p.width,
            height: p.height,
        }));

        const result = { photos };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error) {
        console.error('Pexels photos error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Download proxy for Pexels video files (avoids CORS)
app.get('/api/pexels/download', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    try {
        const response = await fetch(url);
        if (!response.ok) {
            return res.status(response.status).json({ error: `Download failed: ${response.status}` });
        }
        res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
        const contentLength = response.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        // Stream the response body to client
        const reader = response.body.getReader();
        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); return; }
                res.write(Buffer.from(value));
            }
        };
        await pump();
    } catch (error) {
        console.error('Pexels download error:', error);
        if (!res.headersSent) res.status(500).json({ error: error.message });
    }
});

// ==================== API Key Management ====================

// Get current API key status (masked)
app.get('/api/keys', (req, res) => {
    const mask = (val) => val ? { masked: '******' + val.slice(-4), set: true } : { masked: '', set: false };
    res.json({
        GEMINI_API_KEY: mask(GEMINI_API_KEY),
        YOUTUBE_API_KEY: mask(YOUTUBE_API_KEY),
        KIMI_API_KEY: mask(KIMI_API_KEY),
        OPENAI_API_KEY: mask(OPENAI_API_KEY),
        MINIMAX_API_KEY: mask(MINIMAX_API_KEY),
        ASSEMBLYAI_API_KEY: mask(ASSEMBLYAI_API_KEY),
        PEXELS_API_KEY: mask(PEXELS_API_KEY),
    });
});

// Update API keys (writes to .env.local)
app.post('/api/keys', (req, res) => {
    try {
        const { keys } = req.body;
        if (!keys || typeof keys !== 'object') {
            return res.status(400).json({ error: 'Missing keys object' });
        }

        const envPaths = [
            process.env.VIBECUT_ENV_PATH,
            path.join(__dirname, '..', '.env.local')
        ].filter(Boolean);

        const envPath = envPaths[0];
        const lines = Object.entries(keys)
            .filter(([, v]) => v && String(v).trim())
            .map(([k, v]) => `${k}=${String(v).trim()}`);

        fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');

        // Reload into process.env
        for (const [k, v] of Object.entries(keys)) {
            if (v && String(v).trim()) process.env[k] = String(v).trim();
        }

        console.log('API keys updated via /api/keys');
        res.json({ success: true });
    } catch (error) {
        console.error('Update keys error:', error);
        res.status(500).json({ error: 'Failed to update keys' });
    }
});

// ==================== SPA Fallback (Electron production) ====================
// ==================== File-Based Save/Load ====================

// --- Projects ---
app.get('/api/saves/projects', (req, res) => {
    try {
        res.json(saveStore.listProjectFiles());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/saves/projects/:name', express.json({ limit: '50mb' }), (req, res) => {
    try {
        const safeName = saveStore.saveProjectFile(req.params.name, req.body);
        res.json({ success: true, name: safeName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/saves/projects/:name', (req, res) => {
    try {
        const data = saveStore.loadProjectFile(req.params.name);
        if (!data) return res.status(404).json({ error: 'Project not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/saves/projects/:name', (req, res) => {
    try {
        const deleted = saveStore.deleteProjectFile(req.params.name);
        res.json({ success: deleted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Shorts ---
app.get('/api/saves/shorts', (req, res) => {
    try {
        res.json(saveStore.listShortsFiles());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/saves/shorts/:videoId', express.json({ limit: '50mb' }), (req, res) => {
    try {
        const { videoTitle, shorts } = req.body;
        const safeName = saveStore.saveShortsFile(req.params.videoId, videoTitle || '', shorts || []);
        res.json({ success: true, name: safeName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/saves/shorts/:videoId', (req, res) => {
    try {
        const data = saveStore.loadShortsFile(req.params.videoId);
        if (!data) return res.status(404).json({ error: 'Shorts not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Export/Import All ---
app.get('/api/saves/export-all', (req, res) => {
    try {
        res.json(saveStore.exportAll());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/saves/import-all', express.json({ limit: '200mb' }), (req, res) => {
    try {
        const result = saveStore.importAll(req.body);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Bundle Export/Import (with media files) ---

// Step 1: Create bundle with project JSON (auto-copies YouTube-cached videos)
app.post('/api/saves/export-bundle', express.json({ limit: '100mb' }), (req, res) => {
    try {
        const { name, project } = req.body;
        if (!name || !project) return res.status(400).json({ error: 'name and project required' });
        const result = saveStore.createExportBundle(name, project);
        // Return which media items still need uploading (not YouTube-cached)
        const library = project.library || [];
        const needsUpload = library
            .filter(m => !result.manifest.mediaFiles[m.id]?.filename)
            .map(m => ({ id: m.id, name: m.name, isAudioOnly: m.isAudioOnly }));
        res.json({ ...result, needsUpload });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 2: Upload a media file to the bundle (for user-imported files not in YouTube cache)
const bundleMediaUpload = multer({
    storage: multer.diskStorage({
        destination: (req, _file, cb) => {
            const tmpDir = path.join(os.tmpdir(), 'vibecut-bundle-upload');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            cb(null, tmpDir);
        },
        filename: (_req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB max
});

app.post('/api/saves/export-bundle/:bundleId/media', bundleMediaUpload.single('file'), (req, res) => {
    try {
        const { bundleId } = req.params;
        const { mediaId, originalName, isAudioOnly } = req.body;
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const filename = saveStore.addMediaToBundle(bundleId, mediaId, req.file.path, originalName || req.file.originalname, isAudioOnly === 'true');
        // Clean up temp file
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        res.json({ success: true, filename });
    } catch (err) {
        if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        res.status(500).json({ error: err.message });
    }
});

// Step 3: Read a bundle folder for import
app.post('/api/saves/import-bundle', express.json({ limit: '1mb' }), (req, res) => {
    try {
        const { bundlePath } = req.body;
        if (!bundlePath) return res.status(400).json({ error: 'bundlePath required' });
        const result = saveStore.readImportBundle(bundlePath);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 4: Serve a media file from a bundle folder
app.get('/api/saves/import-bundle/media/:filename', (req, res) => {
    try {
        const bundlePath = req.query.bundle;
        if (!bundlePath) return res.status(400).json({ error: 'bundle query param required' });
        const filePath = saveStore.getBundleMediaPath(bundlePath, req.params.filename);
        if (!filePath) return res.status(404).json({ error: 'Media file not found' });
        res.sendFile(filePath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Step 5: Download an existing bundle as a .zip file
app.get('/api/saves/export-bundle/:bundleId/zip', (req, res) => {
    try {
        const { bundleId } = req.params;
        saveStore.streamBundleZip(bundleId, res);
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// Import a bundle from a remote URL (Google Drive, Dropbox, or direct .zip link)
app.post('/api/saves/import-bundle-url', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const { url } = req.body;
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required' });
        const result = await saveStore.downloadAndExtractBundleFromUrl(url);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// This must be the LAST route — catch-all for client-side routing
if (isElectron && fs.existsSync(distPath)) {
    app.get('*', (req, res) => {
        // Don't interfere with API routes
        if (req.path.startsWith('/api')) {
            return res.status(404).json({ error: 'Not found' });
        }
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

// ==================== Server Startup & Process Management ====================

let server = null;

async function killProcessOnPort(port) {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execAsync(
                `netstat -ano | findstr :${port} | findstr LISTENING`
            );
            for (const line of stdout.trim().split('\n')) {
                const pid = line.trim().split(/\s+/).pop();
                if (pid && pid !== '0' && pid !== String(process.pid)) {
                    console.log(`[Server] Killing stale process on port ${port}: PID ${pid}`);
                    await execAsync(`taskkill /F /PID ${pid}`).catch(() => {});
                }
            }
        } else {
            await execAsync(`lsof -ti:${port} | xargs kill -9`).catch(() => {});
        }
    } catch {
        // No process found on port — that's fine
    }
}

function startServer(port, retryCount = 0) {
    server = app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        if (isElectron) console.log('[Server] Running in Electron mode');

        // Log Python tracker availability at startup
        const trackerInfo = getTrackerInfo();
        if (trackerInfo && trackerInfo.type === 'binary') {
            console.log(`[Tracking] Python tracker AVAILABLE (binary): ${trackerInfo.path}`);
        } else if (trackerInfo && trackerInfo.type === 'python') {
            console.log(`[Tracking] Python tracker AVAILABLE (source): ${trackerInfo.python} in ${trackerInfo.pythonDir}`);
        } else {
            console.log('[Tracking] WARNING: Python tracker NOT FOUND — will fall back to browser tracking');
            console.log('[Tracking] Install: cd python && pip install -r requirements.txt');
        }
    });

    server.on('error', async (err) => {
        if (err.code === 'EADDRINUSE' && retryCount === 0) {
            console.warn(`[Server] Port ${port} in use, killing stale process...`);
            await killProcessOnPort(port);
            setTimeout(() => startServer(port, 1), 1000);
        } else {
            console.error(`[Server] Failed to start on port ${port}:`, err.message);
            process.exit(1);
        }
    });
}

startServer(PORT);

// Graceful shutdown — clean up child processes and temp files
function gracefulShutdown(signal) {
    console.log(`[Server] ${signal} received, shutting down...`);

    // Kill all active child processes (Python tracker etc.)
    for (const child of activeChildren) {
        try {
            if (process.platform === 'win32' && child.pid) {
                spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
            } else {
                child.kill('SIGTERM');
            }
        } catch (e) {
            console.error('[Server] Failed to kill child:', e.message);
        }
    }
    activeChildren.clear();

    // Clean up tracking temp files
    for (const [id, info] of trackingFiles) {
        try { fs.unlinkSync(info.path); } catch {}
    }
    trackingFiles.clear();

    // Close the HTTP server
    if (server) {
        server.close(() => {
            console.log('[Server] HTTP server closed');
            process.exit(0);
        });
    }

    // Force exit after 5 seconds if graceful close hangs
    setTimeout(() => {
        console.error('[Server] Forced exit after timeout');
        process.exit(1);
    }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('exit', () => {
    // Last-ditch cleanup for unexpected exits
    for (const child of activeChildren) {
        try { child.kill(); } catch {}
    }
});

// Expose for Electron in-process usage
process.__vibecut_shutdown = gracefulShutdown;
