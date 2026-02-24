/**
 * Resolve paths for yt-dlp and ffmpeg binaries.
 * Prefers local bin/ copies, falls back to global PATH.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const BIN_DIR = path.join(__dirname, '..', 'bin');

function isWindows() {
    return process.platform === 'win32';
}

/**
 * Find the path to yt-dlp binary.
 * Priority: bin/yt-dlp(.exe) → global yt-dlp
 */
function getYtDlpPath() {
    const ext = isWindows() ? '.exe' : '';
    const localPath = path.join(BIN_DIR, `yt-dlp${ext}`);

    if (fs.existsSync(localPath)) {
        return localPath;
    }

    // Check global
    try {
        const cmd = isWindows() ? 'where yt-dlp' : 'which yt-dlp';
        const result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0].trim();
        if (result) return result;
    } catch (e) { /* not found */ }

    // Return local path as default (will error with helpful message if missing)
    return localPath;
}

/**
 * Find the path to ffmpeg binary.
 * Priority: bin/ffmpeg(.exe) → global ffmpeg
 */
function getFfmpegPath() {
    const ext = isWindows() ? '.exe' : '';
    const localPath = path.join(BIN_DIR, `ffmpeg${ext}`);

    if (fs.existsSync(localPath)) {
        return localPath;
    }

    // Check global
    try {
        const cmd = isWindows() ? 'where ffmpeg' : 'which ffmpeg';
        const result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0].trim();
        if (result) return result;
    } catch (e) { /* not found */ }

    return localPath;
}

/**
 * Get the bin directory path (for setting PATH so yt-dlp can find ffmpeg)
 */
function getBinDir() {
    return BIN_DIR;
}

/**
 * Get environment with bin/ prepended to PATH
 */
function getEnvWithBinPath() {
    const sep = isWindows() ? ';' : ':';
    return {
        ...process.env,
        PATH: `${BIN_DIR}${sep}${process.env.PATH}`
    };
}

module.exports = {
    getYtDlpPath,
    getFfmpegPath,
    getBinDir,
    getEnvWithBinPath
};
