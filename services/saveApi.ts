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

// --- Export/Import All ---

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
