const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

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

// Resolve yt-dlp binary: check project root first (Render deploy), then global PATH
const LOCAL_YTDLP = path.join(__dirname, '..', 'yt-dlp');
const YTDLP_BIN = fs.existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp';

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

// ─── Parse timedtext XML (srv3 format) into segments ────────────────────
function parseTimedTextXml(xml) {
    const segments = [];
    const textRegex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let match;

    while ((match = textRegex.exec(xml)) !== null) {
        const start = parseFloat(match[1]);
        const duration = parseFloat(match[2]);
        const text = decodeHtml(match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

        if (text) {
            segments.push({ start, duration, text, isKaraoke: false });
        }
    }
    return segments;
}

// ─── Innertube helper: try a specific client config ─────────────────────
async function tryInnertubeClient(videoId, clientConfig) {
    const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': clientConfig.userAgent || 'Mozilla/5.0',
        },
        body: JSON.stringify({
            videoId,
            context: {
                client: clientConfig.client,
            },
        }),
    });

    if (!playerRes.ok) {
        throw new Error(`HTTP ${playerRes.status}`);
    }

    const playerData = await playerRes.json();
    const status = playerData?.playabilityStatus?.status;

    if (status !== 'OK') {
        const reason = playerData?.playabilityStatus?.reason || status || 'Unknown';
        throw new Error(`Playability: ${reason}`);
    }

    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
        throw new Error('No caption tracks');
    }

    return { captionTracks, playerData };
}

// ─── Strategy 0: YouTube innertube API with multiple client types ────────
async function getTranscriptViaInnertube(videoId) {
    console.log('[Transcript] Trying innertube API for', videoId);

    // Try multiple YouTube client types — some are less likely to be
    // blocked from datacenter IPs. Order: embedded player → Android → iOS → Web
    const clients = [
        {
            name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
            client: {
                clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
                clientVersion: '2.0',
                hl: 'en',
            },
            userAgent: 'Mozilla/5.0',
        },
        {
            name: 'ANDROID',
            client: {
                clientName: 'ANDROID',
                clientVersion: '19.09.37',
                androidSdkVersion: 30,
                hl: 'en',
            },
            userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip',
        },
        {
            name: 'IOS',
            client: {
                clientName: 'IOS',
                clientVersion: '19.09.3',
                deviceModel: 'iPhone14,3',
                hl: 'en',
            },
            userAgent: 'com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 15_6 like Mac OS X)',
        },
        {
            name: 'WEB',
            client: {
                clientName: 'WEB',
                clientVersion: '2.20240101.00.00',
                hl: 'en',
            },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        },
    ];

    for (const clientConfig of clients) {
        try {
            console.log(`[Transcript] Innertube: trying ${clientConfig.name} client...`);
            const { captionTracks } = await tryInnertubeClient(videoId, clientConfig);

            // Prefer English, fall back to first available
            const enTrack = captionTracks.find(t =>
                t.languageCode === 'en' || (t.languageCode && t.languageCode.startsWith('en'))
            );
            const track = enTrack || captionTracks[0];

            console.log(`[Transcript] Innertube ${clientConfig.name}: using track`, track.languageCode);

            // Fetch the timedtext XML
            let captionUrl = track.baseUrl;
            if (!captionUrl.includes('fmt=')) {
                captionUrl += '&fmt=srv3';
            }

            const captionRes = await fetch(captionUrl);
            if (!captionRes.ok) {
                console.warn(`[Transcript] Innertube ${clientConfig.name}: caption XML HTTP ${captionRes.status}`);
                continue;
            }

            const xml = await captionRes.text();
            const segments = parseTimedTextXml(xml);

            if (segments.length === 0) {
                console.warn(`[Transcript] Innertube ${clientConfig.name}: parsed 0 segments`);
                continue;
            }

            console.log(`[Transcript] Innertube ${clientConfig.name}: ${segments.length} segments ✓`);
            return segments;
        } catch (err) {
            console.warn(`[Transcript] Innertube ${clientConfig.name} failed: ${err.message}`);
        }
    }

    throw new TranscriptError('All innertube client types failed', 'INNERTUBE_ERROR');
}

// ─── Strategy 0b: Direct timedtext endpoint (no innertube needed) ───────
async function getTranscriptViaDirectTimedText(videoId) {
    console.log('[Transcript] Trying direct timedtext API for', videoId);

    // Try fetching captions directly without needing innertube API first
    const urls = [
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`,
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`,
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3&tlang=en`,
    ];

    for (const url of urls) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
                },
            });
            if (!res.ok) continue;

            const xml = await res.text();
            if (!xml || xml.length < 50) continue;

            const segments = parseTimedTextXml(xml);
            if (segments.length === 0) continue;

            console.log(`[Transcript] Direct timedtext: ${segments.length} segments ✓`);
            return segments;
        } catch (err) {
            console.warn(`[Transcript] Direct timedtext failed for ${url}: ${err.message}`);
        }
    }

    throw new TranscriptError('Direct timedtext API returned no captions', 'DIRECT_TIMEDTEXT_ERROR');
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

    // Use cookies.txt if available; otherwise run anonymously (NOT --cookies-from-browser
    // because Chrome locks its cookie DB while it's running, causing yt-dlp to fail)
    let cookiesArg = '';
    // Only use cookies in development — on Render/production the file is stale or absent
    if (process.env.NODE_ENV !== 'production' && fs.existsSync(COOKIE_FILE)) {
        console.log('[Transcript] Using cookies.txt for yt-dlp auth');
        cookiesArg = `--cookies "${COOKIE_FILE}"`;
    } else {
        console.log('[Transcript] Running yt-dlp anonymously (no cookies)');
    }

    const uaArgs = '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --referer "https://www.youtube.com/"';
    const cmd = `"${YTDLP_BIN}" --write-subs --write-auto-sub --write-auto-subs --sub-lang "en" --skip-download --no-check-formats --no-warnings ${cookiesArg} ${uaArgs} --output "${tempPrefix}" https://www.youtube.com/watch?v=${videoId}`;

    try {
        console.log('[Transcript] Running yt-dlp...');
        execSync(cmd, { stdio: 'pipe' });
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
    const failures = []; // Collect all strategy failure reasons for debugging

    // Strategy 0: innertube API with multiple client types
    try {
        segments = await getTranscriptViaInnertube(videoId);
        method = 'innertube';
    } catch (err) {
        failures.push(`innertube: ${err.message}`);
        console.warn(`[Transcript] Strategy 0 (innertube) failed: ${err.message}`);
    }

    // Strategy 0b: direct timedtext endpoint
    if (!segments || segments.length === 0) {
        try {
            segments = await getTranscriptViaDirectTimedText(videoId);
            method = 'direct-timedtext';
        } catch (err) {
            failures.push(`direct-timedtext: ${err.message}`);
            console.warn(`[Transcript] Strategy 0b (direct timedtext) failed: ${err.message}`);
        }
    }

    // Strategy 1: youtube-transcript package
    if (!segments || segments.length === 0) {
        try {
            segments = await getTranscriptViaPackage(videoId);
            method = 'youtube-transcript';
        } catch (err) {
            failures.push(`youtube-transcript: ${err.message}`);
            console.warn(`[Transcript] Strategy 1 failed: ${err.message}`);
        }
    }

    // Strategy 2: yt-dlp VTT download (last resort)
    if (!segments || segments.length === 0) {
        try {
            segments = await getTranscriptViaYtDlp(videoId);
            method = 'yt-dlp';
        } catch (err) {
            failures.push(`yt-dlp: ${err.message}`);
            console.error(`[Transcript] Strategy 2 failed: ${err.message}`);
            // All strategies failed — throw with aggregated info
            throw new TranscriptError(
                `All transcript strategies failed for ${videoId}. Tried: ${failures.join(' | ')}`,
                'ALL_STRATEGIES_FAILED'
            );
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
