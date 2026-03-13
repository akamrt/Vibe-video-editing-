const fs = require('fs');
const path = require('path');

// Base downloads directory — project root / downloads
function getDownloadsDir() {
    const dir = path.join(__dirname, '..', 'downloads');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Per-video directory: downloads/{videoId}/
function getVideoDir(videoId) {
    const dir = path.join(getDownloadsDir(), videoId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Check what's cached locally for a given videoId
function hasLocalCache(videoId) {
    const videoDir = path.join(getDownloadsDir(), videoId);
    const videoPath = path.join(videoDir, 'video.mp4');
    const transcriptPath = path.join(videoDir, 'transcript.json');

    const hasVideo = fs.existsSync(videoPath);
    const hasTranscript = fs.existsSync(transcriptPath);

    const result = {
        hasVideo,
        hasTranscript,
        videoPath: hasVideo ? videoPath : null,
        transcriptPath: hasTranscript ? transcriptPath : null,
    };

    if (hasVideo) {
        try {
            result.videoSize = fs.statSync(videoPath).size;
        } catch { /* ignore */ }
    }

    if (hasTranscript) {
        try {
            const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
            result.wordCount = data.words ? data.words.length : 0;
        } catch { /* ignore */ }
    }

    return result;
}

// Copy/move video file to persistent local storage
function saveVideo(videoId, sourcePath) {
    const destPath = path.join(getVideoDir(videoId), 'video.mp4');
    // Copy instead of move — source may still be in use (streaming)
    fs.copyFileSync(sourcePath, destPath);
    console.log(`[LocalStore] Saved video: ${destPath} (${(fs.statSync(destPath).size / 1024 / 1024).toFixed(1)}MB)`);
    return destPath;
}

// Save transcript JSON (AssemblyAI result or YouTube transcript)
function saveTranscript(videoId, transcriptData) {
    const destPath = path.join(getVideoDir(videoId), 'transcript.json');
    fs.writeFileSync(destPath, JSON.stringify(transcriptData, null, 2), 'utf8');
    console.log(`[LocalStore] Saved transcript: ${destPath}`);
    return destPath;
}

// Load cached transcript
function loadTranscript(videoId) {
    const transcriptPath = path.join(getDownloadsDir(), videoId, 'transcript.json');
    if (!fs.existsSync(transcriptPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
    } catch (err) {
        console.error(`[LocalStore] Failed to read transcript for ${videoId}:`, err.message);
        return null;
    }
}

// Get absolute path to cached video
function getLocalVideoPath(videoId) {
    const videoPath = path.join(getDownloadsDir(), videoId, 'video.mp4');
    return fs.existsSync(videoPath) ? videoPath : null;
}

module.exports = {
    getDownloadsDir,
    getVideoDir,
    hasLocalCache,
    saveVideo,
    saveTranscript,
    loadTranscript,
    getLocalVideoPath,
};
