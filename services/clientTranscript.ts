/**
 * Client-side YouTube transcript fetcher.
 *
 * Uses YouTube's innertube API to retrieve caption track metadata,
 * then fetches the timedtext XML — all from the user's browser,
 * bypassing datacenter IP blocks on platforms like Render.com.
 *
 * If the innertube API is blocked by CORS, returns null so the caller
 * can fall back to the server-side endpoint.
 */

interface TranscriptSegment {
  start: number;   // seconds
  duration: number; // seconds
  text: string;
  isKaraoke: boolean;
}

interface TranscriptResult {
  videoId: string;
  title: string;
  trackName: string;
  language: string;
  segments: TranscriptSegment[];
}

function extractVideoId(url: string): string | null {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

function decodeHtml(str: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = str;
  return el.value;
}

/**
 * Parse timedtext XML (srv3 format) into TranscriptSegment[].
 */
function parseTimedTextXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const textRegex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;

  while ((match = textRegex.exec(xml)) !== null) {
    const start = parseFloat(match[1]);
    const duration = parseFloat(match[2]);
    const text = decodeHtml(match[3].replace(/<[^>]+>/g, '').trim());

    if (text) {
      segments.push({ start, duration, text, isKaraoke: false });
    }
  }

  return segments;
}

/**
 * Strategy A: Use YouTube's innertube player API.
 * POST to /youtubei/v1/player to get caption track URLs,
 * then fetch the timedtext XML.
 */
async function fetchViaInnertubeApi(videoId: string): Promise<TranscriptResult | null> {
  console.log('[ClientTranscript] Strategy A: innertube API for', videoId);

  const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'en',
        },
      },
    }),
  });

  if (!playerRes.ok) {
    console.warn('[ClientTranscript] Innertube API HTTP error:', playerRes.status);
    return null;
  }

  const playerData = await playerRes.json();

  const title = playerData?.videoDetails?.title || 'YouTube Video';

  const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    console.warn('[ClientTranscript] No caption tracks in innertube response');
    return null;
  }

  // Prefer English, fall back to first available
  const enTrack = captionTracks.find((t: any) =>
    t.languageCode === 'en' || t.languageCode?.startsWith('en')
  );
  const track = enTrack || captionTracks[0];

  console.log('[ClientTranscript] Using track:', track.languageCode, track.name?.simpleText);

  // Fetch the timedtext XML from the caption baseUrl
  let captionUrl = track.baseUrl;
  if (!captionUrl.includes('fmt=')) {
    captionUrl += '&fmt=srv3';
  }

  const captionRes = await fetch(captionUrl);
  if (!captionRes.ok) {
    console.warn('[ClientTranscript] Failed to fetch caption XML:', captionRes.status);
    return null;
  }

  const xml = await captionRes.text();
  const segments = parseTimedTextXml(xml);

  if (segments.length === 0) {
    console.warn('[ClientTranscript] Parsed 0 segments from caption XML');
    return null;
  }

  console.log(`[ClientTranscript] Success via innertube — ${segments.length} segments`);
  return {
    videoId,
    title,
    trackName: track.name?.simpleText || 'English',
    language: track.languageCode || 'en',
    segments,
  };
}

/**
 * Strategy B: Try the direct timedtext API endpoint.
 * Some YouTube videos expose captions via a simpler URL pattern.
 */
async function fetchViaDirectTimedText(videoId: string): Promise<TranscriptResult | null> {
  console.log('[ClientTranscript] Strategy B: direct timedtext API for', videoId);

  // Try common caption URL patterns
  const urls = [
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3`,
    `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=srv3&kind=asr`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;

      const xml = await res.text();
      if (!xml || xml.length < 50) continue;

      const segments = parseTimedTextXml(xml);
      if (segments.length === 0) continue;

      console.log(`[ClientTranscript] Success via direct timedtext — ${segments.length} segments`);

      // Get title via oEmbed (CORS-friendly)
      let title = 'YouTube Video';
      try {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
        );
        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          title = oembedData.title || title;
        }
      } catch {
        // Title fetch is non-critical
      }

      return {
        videoId,
        title,
        trackName: 'English',
        language: 'en',
        segments,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Fetch transcript from the browser using YouTube's APIs.
 * Tries multiple strategies, returns null if all fail
 * (caller should fall back to server endpoint).
 */
export async function fetchTranscriptClientSide(url: string): Promise<TranscriptResult | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    // Strategy A: innertube player API (most reliable, gets all caption tracks)
    const innertubeResult = await fetchViaInnertubeApi(videoId);
    if (innertubeResult) return innertubeResult;
  } catch (err) {
    console.warn('[ClientTranscript] Strategy A (innertube) failed:', err);
  }

  try {
    // Strategy B: direct timedtext endpoint (simpler, may work for some videos)
    const directResult = await fetchViaDirectTimedText(videoId);
    if (directResult) return directResult;
  } catch (err) {
    console.warn('[ClientTranscript] Strategy B (timedtext) failed:', err);
  }

  console.warn('[ClientTranscript] All client-side strategies failed for', videoId);
  return null;
}
