const fs = require('fs');
const path = require('path');

// Base saves directory — project root / saves
function getSavesDir() {
    const dir = path.join(__dirname, '..', 'saves');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getProjectsDir() {
    const dir = path.join(getSavesDir(), 'projects');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function getShortsDir() {
    const dir = path.join(getSavesDir(), 'shorts');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// Sanitize filename to prevent path traversal
function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/\.+/g, '_').slice(0, 100);
}

// --- Projects ---

function listProjectFiles() {
    const dir = getProjectsDir();
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        return files.map(filename => {
            const filePath = path.join(dir, filename);
            try {
                const stat = fs.statSync(filePath);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return {
                    name: data._projectName || filename.replace('.json', ''),
                    filename,
                    savedAt: data._savedAt || stat.mtimeMs,
                    size: stat.size,
                    segmentCount: data.segments ? data.segments.length : 0,
                    duration: data.segments ? data.segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0) : 0,
                };
            } catch {
                return { name: filename.replace('.json', ''), filename, savedAt: 0, size: 0, segmentCount: 0, duration: 0 };
            }
        }).sort((a, b) => b.savedAt - a.savedAt);
    } catch {
        return [];
    }
}

function saveProjectFile(name, data) {
    const safeName = sanitizeName(name);
    const filePath = path.join(getProjectsDir(), `${safeName}.json`);
    const toSave = { ...data, _projectName: name, _savedAt: Date.now(), _version: 1 };
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf8');
    console.log(`[SaveStore] Saved project: ${filePath} (${(fs.statSync(filePath).size / 1024).toFixed(1)}KB)`);
    return safeName;
}

function loadProjectFile(name) {
    const safeName = sanitizeName(name);
    const filePath = path.join(getProjectsDir(), `${safeName}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`[SaveStore] Failed to read project ${safeName}:`, err.message);
        return null;
    }
}

function deleteProjectFile(name) {
    const safeName = sanitizeName(name);
    const filePath = path.join(getProjectsDir(), `${safeName}.json`);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`[SaveStore] Deleted project: ${filePath}`);
        return true;
    }
    return false;
}

// --- Shorts ---

function listShortsFiles() {
    const dir = getShortsDir();
    try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        return files.map(filename => {
            const filePath = path.join(dir, filename);
            try {
                const stat = fs.statSync(filePath);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const shorts = data.shorts || [];
                return {
                    filename,
                    videoId: data.videoId || filename.replace('.json', ''),
                    videoTitle: data.videoTitle || filename.replace('.json', ''),
                    count: shorts.length,
                    savedAt: data._savedAt || stat.mtimeMs,
                };
            } catch {
                return { filename, videoId: filename.replace('.json', ''), videoTitle: '', count: 0, savedAt: 0 };
            }
        }).sort((a, b) => b.savedAt - a.savedAt);
    } catch {
        return [];
    }
}

function saveShortsFile(videoId, videoTitle, shorts) {
    const safeName = sanitizeName(videoId);
    const filePath = path.join(getShortsDir(), `${safeName}.json`);
    const toSave = { videoId, videoTitle, shorts, _savedAt: Date.now(), _version: 1 };
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2), 'utf8');
    console.log(`[SaveStore] Saved ${shorts.length} shorts for ${videoId}: ${filePath}`);
    return safeName;
}

function loadShortsFile(videoId) {
    const safeName = sanitizeName(videoId);
    const filePath = path.join(getShortsDir(), `${safeName}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`[SaveStore] Failed to read shorts for ${videoId}:`, err.message);
        return null;
    }
}

// --- Export/Import All ---

function exportAll() {
    const projects = {};
    const projectFiles = listProjectFiles();
    for (const pf of projectFiles) {
        const data = loadProjectFile(pf.filename.replace('.json', ''));
        if (data) projects[pf.filename] = data;
    }

    const shorts = {};
    const shortsFiles = listShortsFiles();
    for (const sf of shortsFiles) {
        const data = loadShortsFile(sf.videoId);
        if (data) shorts[sf.filename] = data;
    }

    return {
        _exportedAt: Date.now(),
        _version: 1,
        projects,
        shorts,
    };
}

function importAll(bundle) {
    let projectCount = 0;
    let shortsCount = 0;

    if (bundle.projects) {
        for (const [filename, data] of Object.entries(bundle.projects)) {
            const name = filename.replace('.json', '');
            const safeName = sanitizeName(name);
            const filePath = path.join(getProjectsDir(), `${safeName}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            projectCount++;
        }
    }

    if (bundle.shorts) {
        for (const [filename, data] of Object.entries(bundle.shorts)) {
            const name = filename.replace('.json', '');
            const safeName = sanitizeName(name);
            const filePath = path.join(getShortsDir(), `${safeName}.json`);
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            shortsCount++;
        }
    }

    console.log(`[SaveStore] Imported ${projectCount} projects, ${shortsCount} shorts files`);
    return { projectCount, shortsCount };
}

// --- Bundle Export/Import (with media files) ---

function getExportsDir() {
    const dir = path.join(__dirname, '..', 'exports');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Create a bundle export folder with project JSON.
 * Returns the bundle ID and folder path.
 * Media files are added separately via addMediaToBundle().
 */
function createExportBundle(bundleName, projectData) {
    const safeName = sanitizeName(bundleName);
    const timestamp = new Date().toISOString().slice(0, 10);
    const bundleId = `${safeName}_${timestamp}_${Date.now()}`;
    const bundleDir = path.join(getExportsDir(), bundleId);
    const mediaDir = path.join(bundleDir, 'media');

    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    // Build a manifest mapping mediaId → filename + metadata
    const manifest = {
        _bundleVersion: 1,
        _exportedAt: Date.now(),
        _projectName: bundleName,
        mediaFiles: {}, // mediaId → { filename, originalName, youtubeVideoId, isAudioOnly }
    };

    // Auto-copy YouTube-cached videos from downloads/
    const localStore = require('./localStore.cjs');
    const library = projectData.library || [];
    for (const item of library) {
        if (item.youtubeVideoId) {
            const cache = localStore.hasLocalCache(item.youtubeVideoId);
            if (cache.hasVideo) {
                const ext = '.mp4';
                const filename = `${sanitizeName(item.id)}${ext}`;
                fs.copyFileSync(cache.videoPath, path.join(mediaDir, filename));
                manifest.mediaFiles[item.id] = {
                    filename,
                    originalName: item.name || `${item.youtubeVideoId}.mp4`,
                    youtubeVideoId: item.youtubeVideoId,
                    isAudioOnly: item.isAudioOnly || false,
                };
                console.log(`[SaveStore] Bundle: copied cached YouTube video ${item.youtubeVideoId} → ${filename}`);
            }
            // Also copy transcript if available
            if (cache.hasTranscript) {
                const transcriptFilename = `${sanitizeName(item.id)}_transcript.json`;
                fs.copyFileSync(cache.transcriptPath, path.join(mediaDir, transcriptFilename));
                manifest.mediaFiles[item.id] = manifest.mediaFiles[item.id] || {};
                manifest.mediaFiles[item.id].transcriptFile = transcriptFilename;
            }
        }
    }

    // Save manifest
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // Save project JSON (stripped of file/url)
    const stripped = {
        ...projectData,
        isPlaying: false,
        library: library.map(m => ({
            ...m,
            file: undefined,
            url: undefined,
        })),
    };
    fs.writeFileSync(path.join(bundleDir, 'project.json'), JSON.stringify(stripped, null, 2), 'utf8');

    // Also include shorts data for any media in the project
    const shortsDir = getShortsDir();
    for (const item of library) {
        if (item.youtubeVideoId) {
            const shortsPath = path.join(shortsDir, `${sanitizeName(item.youtubeVideoId)}.json`);
            if (fs.existsSync(shortsPath)) {
                fs.copyFileSync(shortsPath, path.join(bundleDir, `shorts_${sanitizeName(item.youtubeVideoId)}.json`));
            }
        }
    }

    const bundlePath = path.resolve(bundleDir);
    console.log(`[SaveStore] Created export bundle: ${bundlePath}`);
    return { bundleId, bundlePath, manifest };
}

/**
 * Add a user-uploaded media file to an existing bundle.
 */
function addMediaToBundle(bundleId, mediaId, filePath, originalName, isAudioOnly) {
    const bundleDir = path.join(getExportsDir(), bundleId);
    const mediaDir = path.join(bundleDir, 'media');
    const manifestPath = path.join(bundleDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Bundle ${bundleId} not found`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const ext = path.extname(originalName) || '.mp4';
    const filename = `${sanitizeName(mediaId)}${ext}`;
    const destPath = path.join(mediaDir, filename);

    fs.copyFileSync(filePath, destPath);

    manifest.mediaFiles[mediaId] = {
        ...(manifest.mediaFiles[mediaId] || {}),
        filename,
        originalName,
        isAudioOnly: isAudioOnly || false,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    console.log(`[SaveStore] Bundle ${bundleId}: added media ${mediaId} → ${filename} (${(fs.statSync(destPath).size / 1024 / 1024).toFixed(1)}MB)`);
    return filename;
}

/**
 * Read a bundle folder for import. Returns project JSON + manifest + media file list.
 */
function readImportBundle(bundlePath) {
    const resolvedPath = path.resolve(bundlePath);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Bundle folder not found: ${resolvedPath}`);
    }

    // Look for project.json and manifest.json
    const projectPath = path.join(resolvedPath, 'project.json');
    const manifestPath = path.join(resolvedPath, 'manifest.json');

    if (!fs.existsSync(projectPath)) {
        throw new Error(`No project.json found in ${resolvedPath}`);
    }

    const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
    const manifest = fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        : { mediaFiles: {} };

    // List all media files present
    const mediaDir = path.join(resolvedPath, 'media');
    const mediaFiles = [];
    if (fs.existsSync(mediaDir)) {
        for (const file of fs.readdirSync(mediaDir)) {
            if (file.endsWith('_transcript.json')) continue; // skip transcripts
            const stat = fs.statSync(path.join(mediaDir, file));
            mediaFiles.push({ filename: file, size: stat.size });
        }
    }

    // Import any shorts files into saves/shorts/
    const files = fs.readdirSync(resolvedPath);
    let shortsImported = 0;
    for (const file of files) {
        if (file.startsWith('shorts_') && file.endsWith('.json')) {
            const destPath = path.join(getShortsDir(), file.replace('shorts_', ''));
            fs.copyFileSync(path.join(resolvedPath, file), destPath);
            shortsImported++;
        }
    }

    // Also copy YouTube videos into downloads cache for future use
    const localStore = require('./localStore.cjs');
    for (const [mediaId, info] of Object.entries(manifest.mediaFiles)) {
        if (info.youtubeVideoId && info.filename) {
            const srcVideo = path.join(mediaDir, info.filename);
            if (fs.existsSync(srcVideo)) {
                const destDir = localStore.getVideoDir(info.youtubeVideoId);
                const destVideo = path.join(destDir, 'video.mp4');
                if (!fs.existsSync(destVideo)) {
                    fs.copyFileSync(srcVideo, destVideo);
                    console.log(`[SaveStore] Import: cached YouTube video ${info.youtubeVideoId}`);
                }
            }
            // Also copy transcript to downloads cache
            if (info.transcriptFile) {
                const srcTranscript = path.join(mediaDir, info.transcriptFile);
                if (fs.existsSync(srcTranscript)) {
                    const destDir = localStore.getVideoDir(info.youtubeVideoId);
                    const destTranscript = path.join(destDir, 'transcript.json');
                    if (!fs.existsSync(destTranscript)) {
                        fs.copyFileSync(srcTranscript, destTranscript);
                        console.log(`[SaveStore] Import: cached transcript for ${info.youtubeVideoId}`);
                    }
                }
            }
        }
    }

    console.log(`[SaveStore] Read import bundle: ${resolvedPath} (${mediaFiles.length} media files, ${shortsImported} shorts)`);
    return { project, manifest, mediaFiles, bundlePath: resolvedPath, shortsImported };
}

/**
 * Get the absolute path to a media file in a bundle.
 */
function getBundleMediaPath(bundlePath, filename) {
    const filePath = path.join(path.resolve(bundlePath), 'media', filename);
    if (!fs.existsSync(filePath)) return null;
    return filePath;
}

// --- URL-based Bundle Import/Export ---

/**
 * Convert known share link formats to direct download URLs.
 * Supports Google Drive and Dropbox share links.
 */
function normalizeDownloadUrl(url) {
    // Google Drive file view: https://drive.google.com/file/d/FILE_ID/view?...
    const gdMatch = url.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
    if (gdMatch) {
        return `https://drive.google.com/uc?export=download&id=${gdMatch[1]}&confirm=t`;
    }
    // Google Drive open link: https://drive.google.com/open?id=FILE_ID
    const gdOpenMatch = url.match(/drive\.google\.com\/open\?.*id=([^&]+)/);
    if (gdOpenMatch) {
        return `https://drive.google.com/uc?export=download&id=${gdOpenMatch[1]}&confirm=t`;
    }
    // Dropbox: ensure dl=1 for direct download
    if (url.includes('dropbox.com')) {
        if (url.includes('dl=0')) return url.replace('dl=0', 'dl=1');
        if (!url.includes('dl=1')) return url + (url.includes('?') ? '&' : '?') + 'dl=1';
        return url;
    }
    return url;
}

/**
 * Download a URL to a local file, following redirects.
 */
function downloadUrlToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const http = require('http');
        const file = fs.createWriteStream(destPath);
        let settled = false;

        function done(err) {
            if (settled) return;
            settled = true;
            file.close(() => err ? reject(err) : resolve());
        }

        function doRequest(requestUrl, redirectCount) {
            if (redirectCount > 10) { done(new Error('Too many redirects')); return; }
            let parsed;
            try { parsed = new URL(requestUrl); } catch (e) { done(new Error(`Invalid URL: ${requestUrl}`)); return; }
            const proto = requestUrl.startsWith('https') ? https : http;
            proto.get({
                hostname: parsed.hostname,
                port: parsed.port || undefined,
                path: parsed.pathname + parsed.search,
                headers: {
                    'User-Agent': 'Mozilla/5.0 VibeCut/1.0',
                    'Accept': 'application/zip, application/octet-stream, */*',
                },
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    doRequest(new URL(res.headers.location, requestUrl).toString(), redirectCount + 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    done(new Error(`HTTP ${res.statusCode} downloading bundle`));
                    return;
                }
                res.pipe(file);
                res.on('error', done);
            }).on('error', done);
        }

        file.on('error', done);
        doRequest(url, 0);
    });
}

/**
 * Stream a bundle folder as a zip file to an HTTP response.
 */
function streamBundleZip(bundleId, res) {
    const archiver = require('archiver');
    const bundleDir = path.join(getExportsDir(), bundleId);
    if (!fs.existsSync(bundleDir)) throw new Error(`Bundle ${bundleId} not found`);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${bundleId}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).end(err.message);
    });
    archive.pipe(res);
    // Archive contents directly (no top-level folder) so zip extracts to project.json + media/
    archive.directory(bundleDir, false);
    archive.finalize();
}

/**
 * Download a zip bundle from a URL, extract it, and return the bundle path.
 */
async function downloadAndExtractBundleFromUrl(url) {
    const os = require('os');
    const AdmZip = require('adm-zip');

    const normalizedUrl = normalizeDownloadUrl(url);
    console.log(`[SaveStore] Downloading bundle from: ${normalizedUrl}`);

    const tmpZipPath = path.join(os.tmpdir(), `vibecut-bundle-${Date.now()}.zip`);
    try {
        await downloadUrlToFile(normalizedUrl, tmpZipPath);

        const sizeMB = (fs.statSync(tmpZipPath).size / 1024 / 1024).toFixed(1);
        console.log(`[SaveStore] Downloaded ${sizeMB}MB, extracting...`);

        const zip = new AdmZip(tmpZipPath);
        const entries = zip.getEntries();

        // Find project.json — may be at root or inside a subfolder
        const projectEntry = entries.find(e => !e.isDirectory && /(^|[/\\])project\.json$/.test(e.entryName));
        if (!projectEntry) {
            throw new Error('No project.json found in the zip. Make sure you exported using "Download as .zip" from VibeCut.');
        }

        // Strip top-level folder if present
        const prefix = projectEntry.entryName.replace(/project\.json$/, '');

        const bundleId = `url-import_${Date.now()}`;
        const bundleDir = path.join(getExportsDir(), bundleId);
        fs.mkdirSync(bundleDir, { recursive: true });

        for (const entry of entries) {
            if (entry.isDirectory) continue;
            let relPath = entry.entryName.replace(/\\/g, '/');
            if (prefix && relPath.startsWith(prefix)) relPath = relPath.slice(prefix.length);
            if (!relPath) continue;
            const destPath = path.join(bundleDir, relPath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.writeFileSync(destPath, entry.getData());
        }

        console.log(`[SaveStore] Extracted bundle to: ${bundleDir}`);
        return { bundleId, bundlePath: path.resolve(bundleDir) };
    } finally {
        try { fs.unlinkSync(tmpZipPath); } catch { /* ignore */ }
    }
}

module.exports = {
    getSavesDir,
    getProjectsDir,
    getShortsDir,
    sanitizeName,
    listProjectFiles,
    saveProjectFile,
    loadProjectFile,
    deleteProjectFile,
    listShortsFiles,
    saveShortsFile,
    loadShortsFile,
    exportAll,
    importAll,
    // Bundle export/import
    getExportsDir,
    createExportBundle,
    addMediaToBundle,
    readImportBundle,
    getBundleMediaPath,
    // URL-based zip export/import
    streamBundleZip,
    downloadAndExtractBundleFromUrl,
};
