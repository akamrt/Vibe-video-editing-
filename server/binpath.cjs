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
 * Checks: BIN_DIR, git worktree main repo bin/, Electron resources, global PATH.
 */
function getPythonTrackerPath() {
    const ext = isWindows() ? '.exe' : '';
    const name = `vibecut-tracker${ext}`;

    // 1. Standard BIN_DIR (Electron resources or local bin/)
    const localPath = path.join(BIN_DIR, name);
    if (fs.existsSync(localPath)) return localPath;

    // 2. If in a git worktree, BIN_DIR might not have bin/ — check the main repo
    //    Git worktrees store the real repo path in .git file
    try {
        const dotGit = path.join(__dirname, '..', '.git');
        if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
            const content = fs.readFileSync(dotGit, 'utf8').trim();
            const match = content.match(/gitdir:\s*(.+)/);
            if (match) {
                // .git file points to e.g. /repo/.git/worktrees/name → main repo is 3 levels up
                const mainRepo = path.resolve(path.dirname(dotGit), match[1], '..', '..', '..');
                const mainBinPath = path.join(mainRepo, 'bin', name);
                if (fs.existsSync(mainBinPath)) return mainBinPath;
            }
        }
    } catch { /* ignore */ }

    // 3. Electron resources fallback
    if (process.resourcesPath) {
        const devPath = path.join(__dirname, '..', 'bin', name);
        if (fs.existsSync(devPath)) return devPath;
    }

    // 4. Global PATH
    try {
        const cmd = isWindows() ? `where ${name}` : `which ${name}`;
        const result = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n')[0].trim();
        if (result && fs.existsSync(result)) return result;
    } catch { /* not found */ }

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
