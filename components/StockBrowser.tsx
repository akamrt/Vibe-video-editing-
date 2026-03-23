import React, { useState, useRef, useCallback } from 'react';

interface StockResult {
  type: 'video' | 'photo';
  id: number;
  thumbnailUrl: string;
  duration?: number;
  downloadUrl: string;
  photographer?: string;
  pexelsUrl: string;
}

interface StockBrowserProps {
  transcript: string;
  onAddToLibrary: (url: string, name: string, duration: number, isPhoto: boolean) => void;
}

export default function StockBrowser({ transcript, onAddToLibrary }: StockBrowserProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [suggestedQueries, setSuggestedQueries] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<Set<number>>(new Set());
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const searchRef = useRef<HTMLInputElement>(null);

  const doSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setResults([]);
    try {
      const [videoRes, photoRes] = await Promise.all([
        fetch(`/api/pexels/search?query=${encodeURIComponent(searchQuery)}&per_page=12&orientation=${orientation}`),
        fetch(`/api/pexels/photos?query=${encodeURIComponent(searchQuery)}&per_page=8&orientation=${orientation}`),
      ]);

      const merged: StockResult[] = [];

      if (videoRes.ok) {
        const vData = await videoRes.json();
        for (const v of (vData.videos || [])) {
          merged.push({
            type: 'video',
            id: v.id,
            thumbnailUrl: v.thumbnailUrl,
            duration: v.duration,
            downloadUrl: v.videoFileUrl,
            pexelsUrl: v.url,
          });
        }
      }

      if (photoRes.ok) {
        const pData = await photoRes.json();
        for (const p of (pData.photos || [])) {
          merged.push({
            type: 'photo',
            id: p.id,
            thumbnailUrl: p.thumbnailUrl,
            downloadUrl: p.fullUrl,
            photographer: p.photographer,
            pexelsUrl: p.url,
          });
        }
      }

      setResults(merged);
    } catch (err) {
      console.error('Stock search error:', err);
    } finally {
      setLoading(false);
    }
  }, [orientation]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(query);
  };

  const handleSuggest = async () => {
    if (!transcript.trim()) return;
    setSuggestLoading(true);
    try {
      const res = await fetch('/api/ai/suggest-stock-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcript.substring(0, 3000) }),
      });
      if (res.ok) {
        const data = await res.json();
        setSuggestedQueries(data.queries || []);
      }
    } catch (err) {
      console.error('Suggest error:', err);
    } finally {
      setSuggestLoading(false);
    }
  };

  const handleChipClick = (q: string) => {
    setQuery(q);
    doSearch(q);
  };

  const handleAdd = async (item: StockResult) => {
    setDownloadingIds(prev => new Set(prev).add(item.id));
    try {
      const name = `${item.type === 'photo' ? 'Photo' : 'Video'}_${item.id}`;
      const duration = item.type === 'video' ? (item.duration || 5) : 3;
      onAddToLibrary(item.downloadUrl, name, duration, item.type === 'photo');
    } finally {
      setDownloadingIds(prev => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col h-full text-white">
      {/* Search bar */}
      <form onSubmit={handleSearch} className="p-2 border-b border-[#333]">
        <div className="flex gap-1">
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search stock clips..."
            className="flex-1 bg-[#2a2a2a] border border-[#444] rounded px-2 py-1.5 text-xs text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="px-2 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded text-xs font-bold transition-colors"
          >
            {loading ? '...' : 'Go'}
          </button>
        </div>
        {/* Orientation toggle */}
        <div className="flex gap-1 mt-1.5">
          <button
            type="button"
            onClick={() => setOrientation('portrait')}
            className={`flex-1 py-1 text-[10px] rounded ${orientation === 'portrait' ? 'bg-green-600/40 text-green-300 border border-green-500/50' : 'bg-[#2a2a2a] text-gray-400 border border-[#444]'}`}
          >
            Portrait
          </button>
          <button
            type="button"
            onClick={() => setOrientation('landscape')}
            className={`flex-1 py-1 text-[10px] rounded ${orientation === 'landscape' ? 'bg-green-600/40 text-green-300 border border-green-500/50' : 'bg-[#2a2a2a] text-gray-400 border border-[#444]'}`}
          >
            Landscape
          </button>
        </div>
      </form>

      {/* AI Suggestions */}
      {transcript.trim() && (
        <div className="p-2 border-b border-[#333]">
          <button
            onClick={handleSuggest}
            disabled={suggestLoading}
            className="w-full py-1.5 bg-purple-600/30 hover:bg-purple-600/50 border border-purple-500/40 rounded text-[10px] text-purple-300 font-bold transition-colors disabled:opacity-50"
          >
            {suggestLoading ? 'Analyzing transcript...' : 'Suggest Clips from Video'}
          </button>
          {suggestedQueries.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {suggestedQueries.map((q, i) => (
                <button
                  key={i}
                  onClick={() => handleChipClick(q)}
                  className="px-2 py-0.5 bg-purple-600/20 hover:bg-purple-600/40 border border-purple-500/30 rounded-full text-[10px] text-purple-200 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Results grid */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-green-400 border-t-transparent rounded-full" />
          </div>
        )}

        {!loading && results.length === 0 && (
          <div className="text-center py-8 text-gray-500 text-xs">
            {query ? 'No results found' : 'Search for stock videos & photos'}
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {results.map(item => (
              <div
                key={`${item.type}-${item.id}`}
                className="group relative rounded overflow-hidden bg-[#2a2a2a] border border-[#444] hover:border-green-500/50 transition-colors cursor-pointer"
                onClick={() => handleAdd(item)}
              >
                {/* Thumbnail */}
                <div className="aspect-[3/4] relative">
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-cover"
                  />
                  {/* Type badge */}
                  {item.type === 'video' ? (
                    <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/70 rounded text-[9px] text-green-300 font-bold">
                      {item.duration}s
                    </div>
                  ) : (
                    <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/70 rounded text-[9px] text-blue-300 font-bold">
                      PHOTO
                    </div>
                  )}
                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    {downloadingIds.has(item.id) ? (
                      <div className="animate-spin w-6 h-6 border-2 border-white border-t-transparent rounded-full" />
                    ) : (
                      <div className="flex flex-col items-center gap-1">
                        <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        <span className="text-[10px] text-white font-bold">Add to Timeline</span>
                      </div>
                    )}
                  </div>
                </div>
                {/* Photographer credit for photos */}
                {item.photographer && (
                  <div className="px-1.5 py-1 text-[9px] text-gray-400 truncate">
                    by {item.photographer}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pexels attribution */}
      <div className="p-1.5 border-t border-[#333] text-center">
        <span className="text-[9px] text-gray-500">Powered by Pexels</span>
      </div>
    </div>
  );
}
