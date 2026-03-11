const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const { getYtDlpPath, getEnvWithBinPath } = require('./binpath.cjs');

// Resolve yt-dlp path once at startup
const YT_DLP = getYtDlpPath();
const childEnv = getEnvWithBinPath();

class TranscriptError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

/**
 * Extracts the video ID from a YouTube URL
 */
function extractVideoId(url) {
    const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

const COOKIE_FILE = path.join(__dirname, '..', 'www.youtube.com_cookies.txt');
const getCookieArg = () => fs.existsSync(COOKIE_FILE) ? ` --cookies "${COOKIE_FILE}"` : '';

// Helper to run yt-dlp commands synchronously with cookie fallback strategy
function runYtDlpSyncWithFallback(cmdBuilder, execOptions) {
    const cmdNoCookies = cmdBuilder(false);
    try {
        console.log('[Transcript] Running yt-dlp (no cookies):', cmdNoCookies);
        return execSync(cmdNoCookies, execOptions);
    } catch (error) {
        const stderr = (error.stderr || error.message || '').toString().toLowerCase();
        
        if (stderr.includes('sign in to confirm you') || stderr.includes('bot') || stderr.includes('login')) {
            console.log('[Transcript] Bot protection detected. Retrying with cookies if available...');
            
            if (!fs.existsSync(COOKIE_FILE)) {
                throw new Error('YouTube bot protection blocked the subtitle download. Please add a valid www.youtube.com_cookies.txt file.');
            }

            const cmdWithCookies = cmdBuilder(true);
            try {
                console.log('[Transcript] Running yt-dlp (with cookies):', cmdWithCookies);
                return execSync(cmdWithCookies, execOptions);
            } catch (cookieError) {
                const cookieStderr = (cookieError.stderr || cookieError.message || '').toString().toLowerCase();
                if (cookieStderr.includes('requested format is not available') || cookieStderr.includes('sign in')) {
                    throw new Error('Your YouTube cookies appear to be expired or invalid. Please update www.youtube.com_cookies.txt by exporting a fresh Netscape cookie file from your browser.');
                }
                throw cookieError;
            }
        }
        throw error;
    }
}

// ─── HTML entity decoder ───────────────────────────────────────────────────
function decodeHtml(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n/g, ' ')
        .trim();
}

// ─── VTT timestamp parser ──────────────────────────────────────────────────
function parseVttTimestamp(timestamp) {
    const timeOnly = timestamp.trim().split(/\s+/)[0];
    const parts = timeOnly.split(':');
    let ms = 0;
    if (parts.length === 3) {
        ms += parseInt(parts[0]) * 3600000;
        ms += parseInt(parts[1]) * 60000;
        ms += parseFloat(parts[2]) * 1000;
    } else if (parts.length === 2) {
        ms += parseInt(parts[0]) * 60000;
        ms += parseFloat(parts[1]) * 1000;
    }
    return Math.round(ms);
}

// ─── VTT file parser (yt-dlp fallback) ────────────────────────────────────
function parseVttTranscript(vttContent) {
    const lines = vttContent.split(/\r?\n/);
    const wordSegments = [];

    const timeRegex = /^(\d{2}:)?\d{2}:\d{2}\.\d{3} --> (\d{2}:)?\d{2}:\d{2}\.\d{3}/;
    const parseTime = (t) => parseVttTimestamp(t);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line === 'WEBVTT' || line.startsWith('Kind:') || line.startsWith('Language:')) continue;

        if (timeRegex.test(line)) {
            const times = line.split(' --> ');
            const startTime = parseTime(times[0]);

            let endTimeStr = times[1];
            if (endTimeStr.includes(' ')) endTimeStr = endTimeStr.split(' ')[0];
            const endTime = parseTime(endTimeStr);

            let textLines = [];
            let lineIdx = i + 1;
            while (lines[lineIdx] && lines[lineIdx].trim() !== '') {
                textLines.push(lines[lineIdx].trim());
                lineIdx++;
            }
            i = lineIdx - 1;

            const fullText = textLines.join(' ');
            const timestampRegex = /<((?:\d{2}:)?\d{2}:\d{2}\.\d{3})>/g;

            if (!timestampRegex.test(fullText)) {
                const cleanText = fullText.replace(/<[^>]+>/g, '').trim();
                if (cleanText) {
                    wordSegments.push({
                        start: startTime / 1000,
                        duration: Math.max(0, endTime - startTime) / 1000,
                        text: cleanText,
                        isKaraoke: false
                    });
                }
                continue;
            }

            const linesWithTags = textLines.filter(l => timestampRegex.test(l));

            if (linesWithTags.length > 0) {
                const activeText = linesWithTags.join(' ');
                timestampRegex.lastIndex = 0;
                let cursor = 0;
                let currentStart = startTime;
                let match;

                while ((match = timestampRegex.exec(activeText)) !== null) {
                    const tagTime = parseTime(match[1]);
                    const textPart = activeText.substring(cursor, match.index);
                    const wordText = textPart.replace(/<[^>]+>/g, '').trim();

                    if (wordText) {
                        wordSegments.push({
                            start: currentStart / 1000,
                            duration: Math.max(0.1, (tagTime - currentStart) / 1000),
                            text: wordText,
                            isKaraoke: true
                        });
                    }

                    currentStart = tagTime;
                    cursor = match.index + match[0].length;
                }

                const remaining = activeText.substring(cursor).replace(/<[^>]+>/g, '').trim();
                if (remaining) {
                    wordSegments.push({
                        start: currentStart / 1000,
                        duration: Math.max(0.1, (endTime - currentStart) / 1000),
                        text: remaining,
                        isKaraoke: true
                    });
                }
                continue;
            }
        }
    }

    // Prefer karaoke over block segments
    const karaokeSegments = wordSegments.filter(s => s.isKaraoke);
    const blockSegments = wordSegments.filter(s => !s.isKaraoke);
    const finalSegments = [...karaokeSegments];

    for (const block of blockSegments) {
        const blockStart = block.start;
        const blockEnd = block.start + block.duration;
        const hasOverlap = karaokeSegments.some(k => {
            const kStart = k.start;
            const kEnd = k.start + k.duration;
            return Math.max(blockStart, kStart) < Math.min(blockEnd, kEnd);
        });
        if (!hasOverlap) finalSegments.push(block);
    }

    const uniqueSegments = [];
    const seenTimes = new Set();
    finalSegments.sort((a, b) => a.start - b.start);

    for (const seg of finalSegments) {
        const density = seg.duration > 0 ? seg.text.length / seg.duration : 0;
        if (density > 40) continue;
        if (seg.duration < 0.1 && seg.text.length > 5) continue;

        const key = `${seg.start}-${seg.text}`;
        if (!seenTimes.has(key) && seg.text.length > 0) {
            seenTimes.add(key);
            uniqueSegments.push(seg);
        }
    }

    return uniqueSegments;
}

// ─── Get video title via oEmbed (no auth needed) ───────────────────────────
async function fetchVideoTitle(videoId) {
    try {
        const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (res.ok) {
            const data = await res.json();
            return data.title || null;
        }
    } catch (e) { /* ignore */ }
    return null;
}

// ─── Strategy 1: youtube-transcript npm package ────────────────────────────
async function getTranscriptViaPackage(videoId) {
    const { YoutubeTranscript } = require('youtube-transcript');

    let items = null;
    try {
        // Try English first
        items = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    } catch (langErr) {
        console.log(`[Transcript] en-lang fetch failed (${langErr.message}), trying without lang filter`);
        // Fall back to any available language
        items = await YoutubeTranscript.fetchTranscript(videoId);
    }

    if (!items || items.length === 0) {
        throw new TranscriptError('No transcript items returned by youtube-transcript', 'NO_CAPTIONS');
    }

    const segments = items
        .map(item => ({
            start: item.offset,     // seconds
            duration: item.duration, // seconds
            text: decodeHtml(item.text),
            isKaraoke: false
        }))
        .filter(s => s.text && s.text.length > 0);

    console.log(`[Transcript] youtube-transcript: ${segments.length} segments`);
    return segments;
}

// ─── Strategy 2: yt-dlp VTT download ──────────────────────────────────────
async function getTranscriptViaYtDlp(videoId) {
    const tempPrefix = path.join(os.tmpdir(), `transcript_${videoId}_${Date.now()}`);

    const cmdBuilder = (useCookies) => `"${YT_DLP}" --write-subs --write-auto-sub --write-auto-subs --sub-lang "en" --skip-download --no-warnings${useCookies ? getCookieArg() : ''} --output "${tempPrefix}" https://www.youtube.com/watch?v=${videoId}`;

    try {
        console.log('[Transcript] Running yt-dlp...');
        runYtDlpSyncWithFallback(cmdBuilder, { stdio: 'pipe', encoding: 'utf8', env: childEnv });
        console.log('[Transcript] yt-dlp finished.');
    } catch (e) {
        throw new TranscriptError(`yt-dlp failed: ${e.message}`, 'DOWNLOAD_ERROR');
    }

    const dir = os.tmpdir();
    const files = fs.readdirSync(dir);
    const prefixBase = path.basename(tempPrefix);
    const vttFile = files.find(f => f.startsWith(prefixBase) && f.endsWith('.vtt'));

    if (!vttFile) {
        console.error('[Transcript] No VTT file found. Files with prefix:', files.filter(f => f.startsWith(prefixBase)));
        throw new TranscriptError('No transcript file created by yt-dlp', 'NO_CAPTIONS');
    }

    console.log(`[Transcript] Found VTT: ${vttFile}`);
    const vttPath = path.join(dir, vttFile);
    const content = fs.readFileSync(vttPath, 'utf8');
    fs.unlinkSync(vttPath);

    const segments = parseVttTranscript(content);
    console.log(`[Transcript] yt-dlp parsed ${segments.length} segments`);

    if (segments.length === 0) {
        // Log first 500 chars of VTT for debugging
        console.warn('[Transcript] VTT content (first 500 chars):', content.substring(0, 500));
        throw new TranscriptError('VTT file had no parseable segments', 'EMPTY_TRANSCRIPT');
    }

    return segments;
}

// ─── Main exported function ────────────────────────────────────────────────
async function getTranscript(videoId) {
    // Fetch title in parallel (non-blocking, uses public oEmbed)
    const titlePromise = fetchVideoTitle(videoId);

    let segments = null;
    let method = '';

    // Try Strategy 1 first (youtube-transcript package — fast, no VTT parsing)
    try {
        segments = await getTranscriptViaPackage(videoId);
        method = 'youtube-transcript';
    } catch (err) {
        console.warn(`[Transcript] Strategy 1 failed: ${err.message} — trying yt-dlp`);
    }

    // Strategy 2 fallback (yt-dlp VTT download)
    if (!segments || segments.length === 0) {
        try {
            segments = await getTranscriptViaYtDlp(videoId);
            method = 'yt-dlp';
        } catch (err) {
            console.error(`[Transcript] Strategy 2 failed: ${err.message}`);
            throw err; // Re-throw — both strategies failed
        }
    }

    const title = (await titlePromise) || 'YouTube Video';
    console.log(`[Transcript] Done — ${segments.length} segments via ${method}, title: "${title}"`);

    return {
        videoId,
        title,
        trackName: 'English',
        language: 'en',
        segments
    };
}

module.exports = {
    extractVideoId,
    getTranscript
};
