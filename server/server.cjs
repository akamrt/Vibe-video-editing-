const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { extractVideoId, getTranscript } = require('./transcript.cjs');

const app = express();
const PORT = 3001; // Changed to 3001 to match Vite proxy

app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// Root route to confirm server status
app.get('/', (req, res) => {
    res.send('Vibe Video Editing API Server is running. Access endpoints at /api/...');
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

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyB1srFICGtx-6D1J6giVDnjz6kcf8AbZoc';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
console.log(`Using Gemini Model: ${GEMINI_MODEL}`);
console.log(`Using Gemini API Key: ${GEMINI_API_KEY ? '******' + GEMINI_API_KEY.slice(-4) : 'Not Set'}`);

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

            try {
                return JSON.parse(text.replace(/```json|```/g, '').trim());
            } catch (parseError) {
                console.error('[Gemini] JSON Parse Error:', parseError.message);
                console.error('[Gemini] Raw Text:', text);
                throw new Error(`Failed to parse AI response: ${parseError.message}. See server logs for raw output.`);
            }

        } catch (error) {
            // If it's the last attempt or not a retryable error that we caught above (unless it's a fetch error which lands here)
            // Actually, fetch network errors land here. We should retry them too.
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
        const { transcript, videoTitle, prompt, targetDuration, refinementInstruction, existingShorts } = req.body;

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

        const autoDetectInstructions = !prompt?.trim() ? `
Since no specific request was given, find the MOST VIRAL content:
- Powerful emotional stories or testimonies
- Surprising/countercultural teachings
- Quotable "mic drop" statements
- Moments of tension and resolution
- Universal truths that resonate with wide audiences
` : '';

        const aiPrompt = `
You are a viral short-form content editor specializing in sermon clips.

TASK: Create a compelling ${targetDuration || 60}-second short from this sermon transcript.

${userPromptSection}
${refinementSection}
${existingShortsSection}
${autoDetectInstructions}

SERMON: "${videoTitle}"

TRANSCRIPT (with timestamps):
${transcript.substring(0, 8000)}

INSTRUCTIONS:
1. Find the most engaging moments that match the user's request.
2. Create a HOOK - an attention-grabbing opening (first 3-5 seconds).
3. Create a HOOK TITLE - a SHORT, PUNCHY title (MAX 5 WORDS) that grabs attention immediately.
   - Examples: "This Changed Everything", "The Truth About...", "Nobody Talks About This", "What If...", "You Won't Believe This"
   - Must be dramatic, intriguing, or provocative
   - Should make viewers want to keep watching
4. Select clips that tell a complete story with a RESOLUTION at the end.
5. The total duration should be approximately ${targetDuration || 60} seconds.
6. Clips must be in chronological order (you cannot rearrange the sermon).
7. Each clip should be at least 3 seconds long.

Return valid, parseable JSON with this exact structure (no markdown formatting, no \`\`\`json wrappers):
{
  "title": "string (catchy title, max 60 chars - ESCAPE QUOTES)",
  "hookTitle": "string (SHORT PUNCHY TITLE, MAX 5 WORDS - ESCAPE QUOTES)",
  "hook": "string (hook text - ESCAPE QUOTES)",
  "resolution": "string (conclusion text - ESCAPE QUOTES)",
  "clips": [
    {
      "startTime": number,
      "endTime": number,
      "text": "string (transcript text - MUST ESCAPE INNER QUOTES)"
    }
  ],
  "totalDuration": number,
  "reasoning": "string"
}

IMPORTANT: Ensure the response is valid JSON. Escape all double quotes within strings (e.g. "text": "He said \"Hello\""). Do not cut off the JSON.
`;

        console.log('[AI] Generating short for:', videoTitle);
        const result = await callGemini(aiPrompt);
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

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
