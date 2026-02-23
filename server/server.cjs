const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { extractVideoId, getTranscript } = require('./transcript.cjs');

const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== CORS ====================
// In production, restrict to your deployed domain.
// In development, allow all origins for Vite proxy.
const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : null; // null = allow all (dev mode)

app.use(cors(allowedOrigins ? {
    origin: allowedOrigins,
    credentials: true
} : undefined));

app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// ==================== Rate Limiting ====================
// Prevent abuse of AI endpoints (which cost money per call)
const aiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 AI requests per minute per IP
    message: { error: 'Too many AI requests. Please wait a moment.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/ai/', aiLimiter);

const configLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/config', configLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 login attempts per 15 min per IP
    message: { error: 'Too many login attempts. Please wait.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/auth', authLimiter);

// ==================== Simple Password Auth ====================
// In-memory token store. Tokens persist until the server restarts.
const validTokens = new Set();

// Auth middleware — checks Authorization: Bearer <token> header
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const token = authHeader.slice(7);
    if (!validTokens.has(token)) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next();
}

// ==================== Production Static Serving ====================
// In production, serve the Vite-built frontend from dist/
if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(distPath)) {
        app.use(express.static(distPath));
        console.log('Serving production frontend from dist/');
    }
}

// Root route to confirm server status
app.get('/', (req, res) => {
    // In production, the static middleware above will serve index.html
    // This is a fallback for API-only access
    res.send('Vibe Video Editing API Server is running. Access endpoints at /api/...');
});

// ==================== Auth Endpoints ====================
// POST /api/auth — validate password, return token
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    const APP_PASSWORD = process.env.APP_PASSWORD;

    if (!APP_PASSWORD) {
        // No password configured — open access (dev mode)
        const token = crypto.randomUUID();
        validTokens.add(token);
        return res.json({ token, mode: 'open' });
    }

    if (!password || password !== APP_PASSWORD) {
        return res.status(401).json({ error: 'Incorrect password' });
    }

    const token = crypto.randomUUID();
    validTokens.add(token);
    res.json({ token });
});

// GET /api/auth/check — validate an existing token
app.get('/api/auth/check', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.json({ valid: false });
    }
    const token = authHeader.slice(7);
    res.json({ valid: validTokens.has(token) });
});

// POST /api/auth/logout — invalidate a token
app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        validTokens.delete(authHeader.slice(7));
    }
    res.json({ ok: true });
});

// ==================== Config Endpoint ====================
// Protected — only returns API key to authenticated users.
app.get('/api/config', requireAuth, (req, res) => {
    res.json({
        geminiApiKey: GEMINI_API_KEY || null,
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

        // Check for cookies file
        const cookiesFile = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
        const hasCookiesFile = fs.existsSync(cookiesFile);

        let cookiesArg = '--cookies-from-browser chrome';

        if (hasCookiesFile) {
            console.log('Using cookies.txt file for authentication');
            cookiesArg = `--cookies "${cookiesFile}"`;
        } else {
            console.log('Using Chrome browser cookies for authentication');
        }

        // Get video info first using global yt-dlp
        console.log(`Getting info for: ${videoId}`);
        const uaArgs = '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --referer "https://www.youtube.com/"';
        const infoCmd = `yt-dlp --dump-single-json --no-warnings --remote-components ejs:github ${cookiesArg} ${uaArgs} "${youtubeUrl}"`;
        console.log('Running:', infoCmd);

        const infoJson = execSync(infoCmd, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
        const info = JSON.parse(infoJson);

        const title = info.title.replace(/[^\w\s-]/g, '').trim();
        console.log(`Downloading: ${title} (${info.resolution || info.format_note || 'best quality'})`);

        // Create temp file path
        const tempDir = os.tmpdir();
        const tempFile = path.join(tempDir, `${videoId}_${Date.now()}.mp4`);

        // Download using global yt-dlp
        console.log('Downloading to temp file:', tempFile);

        const downloadCmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 --remote-components ejs:github ${cookiesArg} ${uaArgs} -o "${tempFile}" "${youtubeUrl}"`;
        console.log('Running:', downloadCmd);

        execSync(downloadCmd, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,
            timeout: 300000 // 5 minute timeout
        });

        console.log('Download complete, streaming to client...');

        // Check file exists
        if (!fs.existsSync(tempFile)) {
            throw new Error('Downloaded file not found');
        }

        const stat = fs.statSync(tempFile);
        res.header('Content-Disposition', `attachment; filename="${title}.mp4"`);
        res.header('Content-Type', 'video/mp4');
        res.header('Content-Length', stat.size);

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
        // Check for cookies file
        const cookiesFile = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
        const hasCookiesFile = fs.existsSync(cookiesFile);

        let cookiesArg = '--cookies-from-browser chrome';

        if (hasCookiesFile) {
            console.log('Using cookies.txt file for authentication');
            cookiesArg = `--cookies "${cookiesFile}"`;
        } else {
            console.log('Using Chrome browser cookies for authentication (Make sure Chrome is closed if this fails)');
        }

        // Get video info using yt-dlp
        const cmd = `yt-dlp --dump-single-json --no-warnings ${cookiesArg} "${youtubeUrl}"`;
        console.log('Fetching video info:', cmd);

        const infoJson = execSync(cmd, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
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

        const cookiesFile = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
        fs.writeFileSync(cookiesFile, content, 'utf8');

        console.log('Cookies file updated via API');
        res.json({ success: true, message: 'Cookies updated successfully' });
    } catch (error) {
        console.error('Update cookies error:', error);
        res.status(500).json({ error: 'Failed to save cookies file' });
    }
});

// ==================== AI Endpoints ====================

// Load .env.local manually since we don't have dotenv
try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split(/\r?\n/).forEach(line => {
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
if (!GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY not set! AI features will not work. Set it in .env.local or environment variables.');
}
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;

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

// Look up transcript text for a given time range
function getTextForTimeRange(transcriptLines, startTime, endTime) {
    const overlapping = transcriptLines.filter(line =>
        line.end > startTime && line.start < endTime
    );
    return overlapping.map(l => l.text).join(' ').trim() || '';
}

// Group granular transcript lines into ~30-second passages for better AI comprehension
function groupIntoPassages(transcriptLines, targetSeconds = 30) {
    const passages = [];
    let current = { start: 0, end: 0, texts: [] };

    for (const line of transcriptLines) {
        if (current.texts.length === 0) {
            current.start = line.start;
        }
        current.end = line.end;
        current.texts.push(line.text);

        if (current.end - current.start >= targetSeconds) {
            passages.push(`[${Math.round(current.start)}s - ${Math.round(current.end)}s]\n${current.texts.join(' ')}`);
            current = { start: 0, end: 0, texts: [] };
        }
    }
    // Flush remaining
    if (current.texts.length > 0) {
        passages.push(`[${Math.round(current.start)}s - ${Math.round(current.end)}s]\n${current.texts.join(' ')}`);
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

// Generate Short endpoint
app.post('/api/ai/generate-short', async (req, res) => {
    try {
        const { transcript, videoTitle, prompt, targetDuration, refinementInstruction, existingShorts, model } = req.body;

        if (!transcript || !videoTitle) {
            return res.status(400).json({ error: 'Missing transcript or videoTitle' });
        }

        // Parse transcript and group into readable passages
        const transcriptLines = parseTranscriptLines(transcript);
        const groupedTranscript = groupIntoPassages(transcriptLines, 30);

        const duration = targetDuration || 60;

        const userPromptSection = prompt?.trim()
            ? `USER'S CREATIVE DIRECTION: "${prompt}"`
            : `USER'S CREATIVE DIRECTION: None given — auto-detect the single most powerful, viral-worthy moment.`;

        const refinementSection = refinementInstruction?.trim()
            ? `\nREFINEMENT (this overrides the original direction): "${refinementInstruction}"`
            : '';

        const existingShortsSection = (existingShorts && existingShorts.length > 0 && !refinementInstruction)
            ? `\nALREADY USED (pick a DIFFERENT moment):\n${existingShorts.map((s, i) => `- "${s.title}" (${s.startTime}-${s.endTime}s)`).join('\n')}`
            : '';

        const aiPrompt = `You are an expert short-form video editor creating a ${duration}-second clip from a sermon.

${userPromptSection}${refinementSection}${existingShortsSection}

SERMON: "${videoTitle}"

TRANSCRIPT (grouped into ~30-second passages):
${groupedTranscript.substring(0, 15000)}

EDITING RULES:
1. NARRATIVE ARC — Every short must follow this structure:
   - HOOK (0-5s): An attention-grabbing opening that makes viewers stop scrolling. Pick the most provocative, emotional, or surprising statement.
   - BUILD (middle): Context and rising tension. Let the speaker develop the idea.
   - PAYOFF (end): A satisfying conclusion, "mic drop" moment, or call to action.
2. PREFER CONTINUOUS SECTIONS — Use 2-4 long clips (15-30s each) rather than many tiny ones. Continuous speech is more watchable than jump cuts.
3. MINIMUM CLIP LENGTH — Each clip must be at least 10 seconds. Never select clips shorter than 10s.
4. CHRONOLOGICAL — Clips must appear in the order they occur in the sermon.
5. TOTAL DURATION — All clips combined should be approximately ${duration} seconds.
6. DO NOT return transcript text — only return start/end times. The text will be filled in automatically.
7. KEYWORDS — For each clip, identify 2-4 words that are PIVOTAL to the narrative arc of this short.
   These must be words that carry the STORY forward — the turning point, the key insight, the emotional peak.
   NOT generic spiritual words (avoid "God", "love", "hope" unless they ARE the narrative crux).
   Pick words the viewer needs to FEEL — the word that makes the hook provocative, the build tense,
   or the payoff land. Return them in lowercase.

Return JSON only:
{
  "title": "engaging title, max 60 chars",
  "hookTitle": "MAX 5 WORDS, dramatic and attention-grabbing",
  "hook": "the opening hook line that grabs attention",
  "resolution": "the closing payoff line",
  "clips": [
    { "startTime": number, "endTime": number, "keywords": ["word1", "word2"] }
  ],
  "totalDuration": number
}`;

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

        // Fill in clip text from transcript (AI only returns time ranges)
        if (result.clips && Array.isArray(result.clips)) {
            for (const clip of result.clips) {
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
            // Recalculate totalDuration from actual clips
            result.totalDuration = result.clips.reduce((sum, c) => sum + (c.endTime - c.startTime), 0);
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
        const { transcript, videoTitle, prompt, targetDuration, refinementInstruction, existingShorts } = req.body;

        if (!transcript || !videoTitle) {
            return res.status(400).json({ error: 'Missing transcript or videoTitle' });
        }

        // Parse transcript and group into readable passages
        const transcriptLines = parseTranscriptLines(transcript);
        const groupedTranscript = groupIntoPassages(transcriptLines, 30);

        const duration = targetDuration || 60;

        const userPromptSection = prompt?.trim()
            ? `USER'S CREATIVE DIRECTION: "${prompt}"`
            : `USER'S CREATIVE DIRECTION: None given — auto-detect the single most powerful, viral-worthy moment.`;

        const refinementSection = refinementInstruction?.trim()
            ? `\nREFINEMENT (this overrides the original direction): "${refinementInstruction}"`
            : '';

        const existingShortsSection = (existingShorts && existingShorts.length > 0 && !refinementInstruction)
            ? `\nALREADY USED (pick a DIFFERENT moment):\n${existingShorts.map((s, i) => `- "${s.title}" (${s.startTime}-${s.endTime}s)`).join('\n')}`
            : '';

        const aiPrompt = `You are an expert short-form video editor creating a ${duration}-second clip from a sermon.

${userPromptSection}${refinementSection}${existingShortsSection}

SERMON: "${videoTitle}"

TRANSCRIPT (grouped into ~30-second passages):
${groupedTranscript.substring(0, 15000)}

EDITING RULES:
1. NARRATIVE ARC — Every short must follow this structure:
   - HOOK (0-5s): An attention-grabbing opening that makes viewers stop scrolling. Pick the most provocative, emotional, or surprising statement.
   - BUILD (middle): Context and rising tension. Let the speaker develop the idea.
   - PAYOFF (end): A satisfying conclusion, "mic drop" moment, or call to action.
2. PREFER CONTINUOUS SECTIONS — Use 2-4 long clips (15-30s each) rather than many tiny ones. Continuous speech is more watchable than jump cuts.
3. MINIMUM CLIP LENGTH — Each clip must be at least 10 seconds. Never select clips shorter than 10s.
4. CHRONOLOGICAL — Clips must appear in the order they occur in the sermon.
5. TOTAL DURATION — All clips combined should be approximately ${duration} seconds.
6. DO NOT return transcript text — only return start/end times. The text will be filled in automatically.
7. KEYWORDS — For each clip, identify 2-4 words that are PIVOTAL to the narrative arc of this short.
   These must be words that carry the STORY forward — the turning point, the key insight, the emotional peak.
   NOT generic spiritual words (avoid "God", "love", "hope" unless they ARE the narrative crux).
   Pick words the viewer needs to FEEL — the word that makes the hook provocative, the build tense,
   or the payoff land. Return them in lowercase.

return JSON only:
{
  "shorts": [
    {
      "title": "engaging title, max 60 chars",
      "hookTitle": "MAX 5 WORDS, dramatic and attention-grabbing",
      "hook": "the opening hook line that grabs attention",
      "resolution": "the closing payoff line",
      "clips": [
        { "startTime": number, "endTime": number, "keywords": ["word1", "word2"] }
      ],
      "totalDuration": number
    }
  ]
}

CRITICAL JSON RULES:
1. Return ONLY the raw JSON object. Do not wrap it in \`\`\`json markdown blocks.
2. Ensure ALL double quotes inside string values are properly escaped (e.g., \\"word\\").
3. Do not include any trailing commas.
4. Start immediately with { and end with }`;

        res.json({ prompt: aiPrompt });

    } catch (error) {
        console.error('[AI] Build short prompt error:', error.message);
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

// ==================== SPA Fallback (Production) ====================
// Serve index.html for all non-API routes in production
if (process.env.NODE_ENV === 'production') {
    const distPath = path.join(__dirname, '..', 'dist');
    app.get('{*path}', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
