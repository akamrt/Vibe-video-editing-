// Client-side API for file-based save/load via the Express backend

export interface SavedProjectInfo {
  name: string;
  filename: string;
  savedAt: number;
  size: number;
  segmentCount: number;
  duration: number;
}

export interface SavedShortsInfo {
  filename: string;
  videoId: string;
  videoTitle: string;
  count: number;
  savedAt: number;
}

// --- Projects ---

export async function listSavedProjects(): Promise<SavedProjectInfo[]> {
  const res = await fetch('/api/saves/projects');
  if (!res.ok) throw new Error(`Failed to list projects: ${res.statusText}`);
  return res.json();
}

export async function saveProjectToFile(name: string, project: unknown): Promise<string> {
  // Strip file blobs from library items before sending
  const stripped = {
    ...(project as Record<string, unknown>),
    isPlaying: false,
    library: ((project as Record<string, unknown>).library as Array<Record<string, unknown>> || []).map(m => ({
      ...m,
      file: undefined,
      url: undefined,
    })),
  };

  const res = await fetch(`/api/saves/projects/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stripped),
  });
  if (!res.ok) throw new Error(`Failed to save project: ${res.statusText}`);
  const data = await res.json();
  return data.name;
}

export async function loadProjectFromFile(name: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/saves/projects/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load project: ${res.statusText}`);
  return res.json();
}

export async function deleteProjectFile(name: string): Promise<boolean> {
  const res = await fetch(`/api/saves/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete project: ${res.statusText}`);
  const data = await res.json();
  return data.success;
}

// --- Shorts ---

export async function listShortsFiles(): Promise<SavedShortsInfo[]> {
  const res = await fetch('/api/saves/shorts');
  if (!res.ok) throw new Error(`Failed to list shorts: ${res.statusText}`);
  return res.json();
}

export async function saveShortsToFile(videoId: string, videoTitle: string, shorts: unknown[]): Promise<void> {
  const res = await fetch(`/api/saves/shorts/${encodeURIComponent(videoId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoTitle, shorts }),
  });
  if (!res.ok) throw new Error(`Failed to save shorts: ${res.statusText}`);
}

export async function loadShortsFromFile(videoId: string): Promise<{ shorts: unknown[]; videoTitle: string } | null> {
  const res = await fetch(`/api/saves/shorts/${encodeURIComponent(videoId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to load shorts: ${res.statusText}`);
  return res.json();
}

// --- Export/Import All (JSON-only, no media) ---

export async function exportAllData(): Promise<Blob> {
  const res = await fetch('/api/saves/export-all');
  if (!res.ok) throw new Error(`Failed to export: ${res.statusText}`);
  return res.blob();
}

export async function importAllData(bundle: unknown): Promise<{ projectCount: number; shortsCount: number }> {
  const res = await fetch('/api/saves/import-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) throw new Error(`Failed to import: ${res.statusText}`);
  return res.json();
}

// --- Bundle Export/Import (with media files) ---

export interface BundleExportResult {
  bundleId: string;
  bundlePath: string;
  manifest: {
    mediaFiles: Record<string, { filename: string; originalName: string; youtubeVideoId?: string; isAudioOnly?: boolean; transcriptFile?: string }>;
  };
  needsUpload: Array<{ id: string; name: string; isAudioOnly?: boolean }>;
}

export interface BundleImportResult {
  project: Record<string, unknown>;
  manifest: {
    mediaFiles: Record<string, { filename: string; originalName: string; youtubeVideoId?: string; isAudioOnly?: boolean; transcriptFile?: string }>;
  };
  mediaFiles: Array<{ filename: string; size: number }>;
  bundlePath: string;
  shortsImported: number;
}

/**
 * Step 1: Create export bundle on server. Auto-copies YouTube-cached videos.
 * Returns list of media items that need manual upload (user-imported files).
 */
export async function createExportBundle(name: string, project: unknown): Promise<BundleExportResult> {
  // Strip File blobs before sending (can't serialize)
  const stripped = {
    ...(project as Record<string, unknown>),
    isPlaying: false,
    library: ((project as Record<string, unknown>).library as Array<Record<string, unknown>> || []).map(m => ({
      ...m,
      file: undefined,
      url: undefined,
    })),
  };

  const res = await fetch('/api/saves/export-bundle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, project: stripped }),
  });
  if (!res.ok) throw new Error(`Failed to create bundle: ${res.statusText}`);
  return res.json();
}

/**
 * Step 2: Upload a media file to the bundle (for user-imported files not in YouTube cache).
 */
export async function uploadMediaToBundle(bundleId: string, mediaId: string, file: File, isAudioOnly: boolean = false): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('mediaId', mediaId);
  formData.append('originalName', file.name);
  formData.append('isAudioOnly', String(isAudioOnly));

  const res = await fetch(`/api/saves/export-bundle/${encodeURIComponent(bundleId)}/media`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Failed to upload media ${mediaId}: ${res.statusText}`);
}

/**
 * Step 3: Read a bundle folder for import. Returns project data + media file list.
 */
export async function readImportBundle(bundlePath: string): Promise<BundleImportResult> {
  const res = await fetch('/api/saves/import-bundle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundlePath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Failed to read bundle: ${(err as { error: string }).error}`);
  }
  return res.json();
}

/**
 * Trigger a browser download of a bundle as a .zip file.
 */
export function downloadBundleZip(bundleId: string): void {
  const a = document.createElement('a');
  a.href = `/api/saves/export-bundle/${encodeURIComponent(bundleId)}/zip`;
  a.download = `${bundleId}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Import a bundle from a remote URL (Google Drive, Dropbox, or direct .zip link).
 * The server downloads the zip, extracts it, and returns the local bundle path.
 */
export async function importBundleFromUrl(url: string): Promise<{ bundleId: string; bundlePath: string }> {
  const res = await fetch('/api/saves/import-bundle-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || res.statusText);
  }
  return res.json();
}

/**
 * Step 4: Fetch a media file from a bundle folder, return as File object.
 */
export async function fetchBundleMedia(bundlePath: string, filename: string, originalName: string, isAudioOnly?: boolean): Promise<{ file: File; url: string }> {
  const res = await fetch(`/api/saves/import-bundle/media/${encodeURIComponent(filename)}?bundle=${encodeURIComponent(bundlePath)}`);
  if (!res.ok) throw new Error(`Failed to fetch media ${filename}: ${res.statusText}`);
  const blob = await res.blob();
  const mimeType = isAudioOnly ? 'audio/mpeg' : 'video/mp4';
  const file = new File([blob], originalName, { type: blob.type || mimeType });
  const url = URL.createObjectURL(file);
  return { file, url };
}
