import React, { useState, useEffect } from 'react';
import { ProcessingStatus } from '../types';

interface LocalCacheInfo {
  hasVideo: boolean;
  hasTranscript: boolean;
  videoSize?: number;
  wordCount?: number;
}

interface YoutubeImportModalProps {
  onImport: (url: string, download: boolean, file?: File) => void;
  onCancel: () => void;
  status: ProcessingStatus;
}

// Extract YouTube video ID from URL
const extractVideoId = (url: string): string | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
};

export const YoutubeImportModal: React.FC<YoutubeImportModalProps> = ({ onImport, onCancel, status }) => {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'download' | 'manual'>('download');
  const [manualFile, setManualFile] = useState<File | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<LocalCacheInfo | null>(null);
  const [checkingCache, setCheckingCache] = useState(false);

  // Check local cache when URL changes
  const videoId = extractVideoId(url);

  useEffect(() => {
    if (!videoId) {
      setCacheInfo(null);
      return;
    }

    let cancelled = false;
    setCheckingCache(true);

    fetch(`/api/local-cache?videoId=${videoId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setCacheInfo(data);
      })
      .catch(() => {
        if (!cancelled) setCacheInfo(null);
      })
      .finally(() => {
        if (!cancelled) setCheckingCache(false);
      });

    return () => { cancelled = true; };
  }, [videoId]);

  const isDisabled = status !== ProcessingStatus.IDLE || !url || (mode === 'manual' && !manualFile);

  const handleCookieUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const res = await fetch('/api/update-cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text })
      });
      const data = await res.json();
      if (data.success) {
        alert('Cookies updated successfully! You can now try importing again.');
        setShowAdvanced(false);
      } else {
        alert('Failed to update cookies: ' + data.error);
      }
    } catch (err) {
      alert('Error uploading cookies: ' + err);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-[#1e1e1e] border border-[#333] rounded-xl p-6 w-[500px] shadow-2xl">
        <h2 className="text-xl font-bold mb-4 text-white">Import from YouTube</h2>

        <div className="mb-4">
          <label className="block text-gray-400 text-sm mb-2">YouTube URL</label>
          <input
            type="text"
            className="w-full bg-[#121212] border border-[#333] rounded p-2 text-white focus:border-blue-500 outline-none"
            placeholder="https://www.youtube.com/watch?v=..."
            value={url}
            onChange={e => setUrl(e.target.value)}
          />

          {/* Local cache indicator */}
          {cacheInfo?.hasVideo && (
            <div className="mt-2 flex items-center gap-2 p-2 bg-green-900/30 border border-green-700/50 rounded text-sm">
              <span className="text-green-400 font-bold text-xs">📁 Cached locally</span>
              {cacheInfo.videoSize && (
                <span className="text-green-300/60 text-xs">
                  ({(cacheInfo.videoSize / 1024 / 1024).toFixed(0)}MB)
                </span>
              )}
              {cacheInfo.hasTranscript && (
                <span className="text-green-300/60 text-xs">
                  + transcript ({cacheInfo.wordCount} words)
                </span>
              )}
              <span className="ml-auto text-[10px] text-green-300/50">Will load from cache — no YouTube download needed</span>
            </div>
          )}
          {checkingCache && videoId && (
            <div className="mt-1 text-[10px] text-gray-500">Checking local cache...</div>
          )}
        </div>

        <div className="mb-6 flex gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === 'download'}
              onChange={() => setMode('download')}
            />
            <span className="text-gray-300">Download Video (Best Quality)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="mode"
              checked={mode === 'manual'}
              onChange={() => setMode('manual')}
            />
            <span className="text-gray-300">I have the file</span>
          </label>
        </div>

        {mode === 'download' && (
          <div className="mb-6 p-3 bg-blue-900/20 border border-blue-800 rounded text-sm text-blue-200">
            <p>⚠️ Requires local Transcribe.io server running on port 3000.</p>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-blue-400 underline mt-2 hover:text-blue-300"
            >
              {showAdvanced ? 'Hide Advanced Options' : 'Having download issues? Update Cookies'}
            </button>

            {showAdvanced && (
              <div className="mt-3 p-3 bg-black/30 rounded border border-blue-900">
                <label className="block text-xs font-bold text-gray-400 mb-1">Upload cookies.txt</label>
                <p className="text-[10px] text-gray-500 mb-2">
                  If YouTube is blocking downloads, upload a fresh Netscape-formatted cookies.txt file here.
                </p>
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleCookieUpload}
                  className="w-full text-xs text-gray-300 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-500"
                />
              </div>
            )}
          </div>
        )}

        {mode === 'manual' && (
          <div className="mb-6">
            <label className="block text-gray-400 text-sm mb-2">Video File</label>
            <input
              type="file"
              accept="video/*"
              onChange={(e) => setManualFile(e.target.files?.[0] || null)}
              className="w-full text-gray-300"
            />
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 hover:bg-[#333] rounded text-gray-300"
            disabled={status !== ProcessingStatus.IDLE}
          >
            Cancel
          </button>
          <button
            onClick={() => onImport(url, mode === 'download', manualFile || undefined)}
            disabled={isDisabled}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-white font-medium"
          >
            {status === ProcessingStatus.TRANSCRIBING ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
};
