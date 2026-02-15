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

function parseVttTimestamp(timestamp) {
    // Format: HH:MM:SS.mmm or MM:SS.mmm
    // Some VTT timestamps have extra settings like "00:00:05.000 align:start"
    // We strictly want the time part by taking the first whitespace-separated token.
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

function parseVttTranscript(vttContent) {
    const lines = vttContent.split(/\r?\n/);
    const wordSegments = [];

    const timeRegex = /^(\d{2}:)?\d{2}:\d{2}\.\d{3} --> (\d{2}:)?\d{2}:\d{2}\.\d{3}/;
    // Helper to convert time string to ms
    const parseTime = (t) => parseVttTimestamp(t);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line === 'WEBVTT' || line.startsWith('Kind:') || line.startsWith('Language:')) continue;

        if (timeRegex.test(line)) {
            // Found a cue start.
            const times = line.split(' --> ');
            const startTime = parseTime(times[0]);

            // Clean weird extra metadata from end time string (e.g. "align:start")
            let endTimeStr = times[1];
            if (endTimeStr.includes(' ')) endTimeStr = endTimeStr.split(' ')[0];
            const endTime = parseTime(endTimeStr);

            // Collect ALL text lines for this cue
            let textLines = [];
            let lineIdx = i + 1;
            while (lines[lineIdx] && lines[lineIdx].trim() !== '') {
                textLines.push(lines[lineIdx].trim());
                lineIdx++;
            }
            i = lineIdx - 1; // Advance loop

            const fullText = textLines.join(' ');

            // PARSE TIMESTAMPS (Karaoke)
            const timestampRegex = /<((?:\d{2}:)?\d{2}:\d{2}\.\d{3})>/g;

            // Strategy:
            // YouTube VTT often has:
            // Line 1: "Some accumulated text" (Plain)
            // Line 2: "word<00:00:01> word<00:00:02>" (Karaoke)
            // If we detect karaoke tags ANYWHERE in this block, we should ONLY parse the karaoke parts 
            // and ignore the plain text "ghosts" that precede/follow it.

            if (!timestampRegex.test(fullText)) {
                // No karaoke tags at all -> Pure block segment.
                const cleanText = fullText.replace(/<[^>]+>/g, '').trim();
                // Check if this block is actually just a duplicate of a previous karaoke segment?
                // We'll leave that to the overlap filter later.
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

            // Karaoke Mode: Parse ONLY the tagged parts
            timestampRegex.lastIndex = 0;
            let cursor = 0;
            let currentStart = startTime;
            let match;

            // Because "fullText" might contain the plain duplicate at the start, we might skip parsing it?
            // Actually, usually the structure is: "Accumulated Text" \n "new<t> words<t>"
            // Matches will only find the <t> tags. 
            // The text *between* tags is what matters.

            // Problem: The "plain text" line usually appears BEFORE the first tag. 
            // e.g. "Hello world" \n "Hello<0:1> world<0:2>"
            // matches will start at index of <0:1>. 
            // uniqueSegments filter handles strict overlaps, but we need to be careful.

            // Updated Strategy:
            // If karaoke tags exist, we treat the WHOLE block as karaoke-driven.
            // We iterate strictly through the Regex matches.

            // However, the *first* word might precede the first timestamp tag.
            // e.g. "word1<00:01> word2" -> "word1" starts at startTime, ends at 00:01.

            // BUT, if there is a "ghost" line before it:
            // "word1 word2" \n "word1<00:01> word2"
            // The first match is <00:01>. The text preceeding it is "word1 word2 word1". 
            // This is BAD. We get duplication.

            // OBSERVATION from VTT Dump:
            // Line 13: We are on our final week of our seek
            // Line 14: first<00:04> series<00:05>...
            // Note that Line 13 is "past tense" (already spoken) relative to Line 14?
            // Actually, in the VTT dump:
            // 6: We<00:00...><c> are</c>... (Karaoke line for "We are...")
            // ...
            // 8: 00:00:03.350 --> 00:00:03.360
            // 9: We are on our final week of our seek (This is a short block)
            // ...
            // 12: 00:00:03.360 --> 00:00:07.190
            // 13: We are on our final week of our seek (Plain)
            // 14: first<00:04> series... (Karaoke)

            // Line 13 is the "context" line (what has been said so far in this sentence).
            // Line 14 is the "new" words being spoken.
            // If we blindly join them, we get "We are... seek first<t>..." 
            // The "We are... seek" part has NO tags, so it falls into the "text before first tag" bucket.

            // REFINED STRATEGY:
            // If we are in Karaoke mode (tags found), we must IDENTIFY and IGNORE the "context" lines.
            // The "new" karaoke lines usually start with a tag or are the lines containing tags.
            // We should only process lines that *contain* tags? 
            // Or, purely rely on the regex?

            // If we rely on regex, the text `substring(cursor, match.index)` catches everything before the first tag.
            // In the case of lines 13+14 joined: "We ... seek first<t>..."
            // The first tag is after "first". So "We... seek first" is captured.

            // VALIDATION:
            // Look at Line 6: "We<00:00><c> are</c>..."
            // This line *starts* with "We" then a tag. 
            // Or "We" is before the tag.

            // Heuristic:
            // If a line has NO tags, and another line in the same block HAS tags, correct YouTube formatting implies the tag-less line is a "roll-up" history duplicate.
            // We should DISCARD lines that have no tags, IF there are other lines with tags.

            const linesWithTags = textLines.filter(l => timestampRegex.test(l));
            const linesWithoutTags = textLines.filter(l => !timestampRegex.test(l));

            if (linesWithTags.length > 0) {
                // Ignore the lines without tags!
                // Only process linesWithTags using the regex logic.
                // Join them just in case there are multiple karaoke lines.
                const activeText = linesWithTags.join(' ');

                timestampRegex.lastIndex = 0;
                cursor = 0;
                currentStart = startTime;

                // IMPORTANT: The `currentStart` for the regex loop should ideally be the start of the *line*, 
                // but YouTube's quirky format means the first word in a karaoke line often implicitly starts at `startTime` of the cue.
                // UNLESS: The karaoke line continues from previous.
                // Actually, `startTime` of the cue (3.360) matches the start of "first" (which likely starts at 3.360).

                // Let's iterate matches on `activeText`
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

                // Remaining text after last tag in `activeText`
                const remaining = activeText.substring(cursor).replace(/<[^>]+>/g, '').trim();
                if (remaining) {
                    wordSegments.push({
                        start: currentStart / 1000,
                        duration: Math.max(0.1, (endTime - currentStart) / 1000),
                        text: remaining,
                        isKaraoke: true
                    });
                }

                continue; // Done with this block (Karaoke handled)
            }

            // Fallback for blocks with NO tags (pure blocks) handled above by `if (!timestampRegex.test(fullText))`
        }
    }

    // Advanced Filtering: Prefer "Karaoke" (granular) over "Block" (whole line) segments
    const karaokeSegments = wordSegments.filter(s => s.isKaraoke);
    const blockSegments = wordSegments.filter(s => !s.isKaraoke);

    // Keep all Karaoke segments (they are ground truth for timing)
    const finalSegments = [...karaokeSegments];

    // Only keep Block segments that represent *unique time ranges* not covered by Karaoke
    for (const block of blockSegments) {
        const blockStart = block.start;
        const blockEnd = block.start + block.duration;

        // check overlap with ANY karaoke segment
        const hasOverlap = karaokeSegments.some(k => {
            const kStart = k.start;
            const kEnd = k.start + k.duration;
            // Check if block effectively contains or is contained by karaoke stream range
            return Math.max(blockStart, kStart) < Math.min(blockEnd, kEnd);
        });

        if (!hasOverlap) {
            finalSegments.push(block);
        }
    }

    // Filter duplicates and invalid segments on the combined list
    const uniqueSegments = [];
    const seenTimes = new Set();

    // Sort first
    finalSegments.sort((a, b) => a.start - b.start);

    for (const seg of finalSegments) {
        // Density Check
        const density = seg.duration > 0 ? seg.text.length / seg.duration : 0;

        // Threshold: 40 chars/sec is ~8 words/sec (extremely fast speech). 
        // Most artifacts are > 100 chars/sec.
        // Also filter very short segments with substantial text.
        if (density > 40) continue;
        if (seg.duration < 0.1 && seg.text.length > 5) continue;

        // Create a unique key
        const key = `${seg.start}-${seg.text}`;
        if (!seenTimes.has(key) && seg.text.length > 0) {
            seenTimes.add(key);
            uniqueSegments.push(seg);
        }
    }

    return uniqueSegments;
}

/**
 * Main function to get transcript logic using yt-dlp
 */
async function getTranscript(videoId) {
    const tempPrefix = path.join(os.tmpdir(), `transcript_${videoId}_${Date.now()}`);

    // Command to download subs
    // --write-subs: write subtitle file
    // --sub-lang en: prefer english
    // --skip-download: do not download video
    // --output: specify output template
    // --write-auto-sub: if no manual subs, get auto-gen

    const cookiesArg = fs.existsSync(COOKIE_FILE) ? `--cookies "${COOKIE_FILE}"` : '';
    const uaArgs = '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --referer "https://www.youtube.com/"';

    const cmd = `yt-dlp --write-subs --write-auto-sub --sub-lang en --skip-download --no-warnings ${cookiesArg} ${uaArgs} --output "${tempPrefix}" https://www.youtube.com/watch?v=${videoId}`;

    try {
        console.log('Fetching transcript with yt-dlp:', cmd);
        execSync(cmd, { stdio: 'pipe' }); // Pipe stdio to avoid leaking to parent but capture errors if needed
        console.log('yt-dlp command finished.');
    } catch (e) {
        console.error('yt-dlp failed:', e.message);
        throw new TranscriptError('Failed to fetch transcript using yt-dlp', 'DOWNLOAD_ERROR');
    }

    // Find the generated file. It might be .en.vtt or .vtt
    // The output template is just the prefix, so yt-dlp appends .en.vtt usually

    const dir = os.tmpdir();
    const files = fs.readdirSync(dir);
    // Filter for files starting with our prefix and ending in .vtt
    const prefixBase = path.basename(tempPrefix);
    console.log(`Looking for files starting with: ${prefixBase} in ${dir}`);
    const vttFile = files.find(f => f.startsWith(prefixBase) && f.endsWith('.vtt'));

    if (!vttFile) {
        console.error('Files found:', files.filter(f => f.startsWith(prefixBase)));
        throw new TranscriptError('No transcript file created by yt-dlp', 'NO_CAPTIONS');
    }

    console.log(`Found VTT file: ${vttFile}`);
    const vttPath = path.join(dir, vttFile);
    const content = fs.readFileSync(vttPath, 'utf8');

    // Clean up
    fs.unlinkSync(vttPath);

    const segments = parseVttTranscript(content);
    console.log(`Parsed ${segments.length} segments.`);

    // Debug: show first few segments
    if (segments.length > 0) {
        console.log('Sample segments:', segments.slice(0, 3));
    }

    return {
        videoId,
        title: 'Video Transcript',
        trackName: 'English',
        language: 'en',
        segments
    };
}

module.exports = {
    extractVideoId,
    getTranscript
};
