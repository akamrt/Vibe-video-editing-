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
};
