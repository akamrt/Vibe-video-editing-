/**
 * Resolve paths for yt-dlp, ffmpeg, and vibecut-tracker binaries.
 * Prefers Electron resources, then local bin/ copies, then global PATH.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function isWindows() {
    return process.platform === 'win32';
}

/**
 * Get the bin directory, checking Electron resources first, then local bin/.
 */
function getEffectiveBinDir() {
    // Electron packaged app: binaries are in resources/bin/
    if (process.resourcesPath) {
        const electronBin = path.join(process.resourcesPath, 'bin');
        if (fs.existsSync(electronBin)) return electronBin;
    }
    // Dev mode / non-Electron: use local bin/
    return path.join(__dirname, '..', 'bin');
}

const BIN_DIR = getEffectiveBinDir();

/**
 * Generic binary resolver.
 * Priority: BIN_DIR (Electron resources or local bin/) → global PATH
 */
function resolveBinary(name) {
    const ext = isWindows() ? '.exe' : '';
    const localPath = path.join(BIN_DIR, `${name}${ext}`);

    if (fs.existsSync(localPath)) {
        return localPath;
    }

    // Check global PATH
    try {
        const cmd = isWindows() ? `where ${name}` : `which ${name}`;
        const result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0].trim();
        if (result) return result;
    } catch (e) { /* not found */ }

    // Return local path as default (will error with helpful message if missing)
    return localPath;
}

/**
 * Find the path to yt-dlp binary.
 */
function getYtDlpPath() {
    return resolveBinary('yt-dlp');
}

/**
 * Find the path to ffmpeg binary.
 */
function getFfmpegPath() {
    return resolveBinary('ffmpeg');
}

/**
 * Find the path to the vibecut-tracker Python executable.
 * Returns null if not installed (frontend should fall back to browser tracking).
 */
function getPythonTrackerPath() {
    const ext = isWindows() ? '.exe' : '';
    const localPath = path.join(BIN_DIR, `vibecut-tracker${ext}`);

    if (fs.existsSync(localPath)) return localPath;

    // Also check the other bin dir (if Electron, check local; if local, check Electron)
    if (process.resourcesPath) {
        const devPath = path.join(__dirname, '..', 'bin', `vibecut-tracker${ext}`);
        if (fs.existsSync(devPath)) return devPath;
    }

    return null;
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
    getPythonTrackerPath,
    getBinDir,
    getEnvWithBinPath
};
