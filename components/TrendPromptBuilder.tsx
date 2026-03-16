import React, { useState, useMemo } from 'react';
import type { TrendItem } from '../types';
import { buildTrendPromptContext } from '../services/trendsService';

// ==================== Main Component ====================

interface TrendPromptBuilderProps {
  trends: TrendItem[];
  /** Trends pre-selected from the ticker's "Use in Prompt" button */
  preSelectedTrends: TrendItem[];
  onGenerate: (enrichedPrompt: string, selectedTrends: TrendItem[]) => void;
  onClearPreSelected: () => void;
}

export const TrendPromptBuilder: React.FC<TrendPromptBuilderProps> = ({
  trends,
  preSelectedTrends,
  onGenerate,
  onClearPreSelected,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(preSelectedTrends.map(t => t.id))
  );
  const [basePrompt, setBasePrompt] = useState('Find the most emotionally powerful moment');
  const [customSeoTips, setCustomSeoTips] = useState('');
  const [showFullPreview, setShowFullPreview] = useState(false);

  // Sync pre-selected trends
  React.useEffect(() => {
    if (preSelectedTrends.length > 0) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        preSelectedTrends.forEach(t => next.add(t.id));
        return next;
      });
    }
  }, [preSelectedTrends]);

  const toggleTrend = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectedTrends = useMemo(
    () => trends.filter(t => selectedIds.has(t.id)),
    [trends, selectedIds]
  );

  const trendContext = useMemo(
    () => buildTrendPromptContext(selectedTrends),
    [selectedTrends]
  );

  const fullPrompt = useMemo(() => {
    let prompt = basePrompt;
    if (trendContext) prompt += trendContext;
    if (customSeoTips.trim()) prompt += `\n\nADDITIONAL INSTRUCTIONS:\n${customSeoTips}`;
    return prompt;
  }, [basePrompt, trendContext, customSeoTips]);

  const handleGenerate = () => {
    onGenerate(fullPrompt, selectedTrends);
  };

  // Group trends by source for display
  const trendsBySource = useMemo(() => {
    const groups: Record<string, TrendItem[]> = {};
    for (const t of trends.slice(0, 30)) {
      (groups[t.source] ??= []).push(t);
    }
    return groups;
  }, [trends]);

  return (
    <div className="mt-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <span className="text-gray-400">✍️</span>
          Generate Trending Short
        </h3>
        {selectedIds.size > 0 && (
          <button
            onClick={() => { setSelectedIds(new Set()); onClearPreSelected(); }}
            className="text-xs text-gray-400 hover:text-gray-300"
          >
            Clear selection ({selectedIds.size})
          </button>
        )}
      </div>

      {/* Trend Tags */}
      <div className="mb-4">
        <div className="text-xs text-gray-400 mb-2">Select trending topics to target:</div>

        {trends.length === 0 ? (
          <div className="text-xs text-gray-500 py-4 text-center">
            Refresh trends above to see available topics.
          </div>
        ) : (
          <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
            {Object.entries(trendsBySource).map(([source, items]) => (
              <div key={source}>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">
                  {source === 'youtube' ? '▶ YouTube' : source === 'google' ? 'G Google Trends' : '◉ Reddit'}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {items.slice(0, 10).map(trend => {
                    const isSelected = selectedIds.has(trend.id);
                    return (
                      <button
                        key={trend.id}
                        onClick={() => toggleTrend(trend.id)}
                        className={`text-xs px-2.5 py-1 rounded-full transition-all ${
                          isSelected
                            ? 'bg-blue-600/40 text-blue-200 border border-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.3)]'
                            : 'bg-gray-700/40 text-gray-400 border border-gray-600/30 hover:bg-gray-600/40 hover:text-gray-300'
                        }`}
                      >
                        {trend.velocity === 'exploding' && '🔥 '}
                        {trend.title.length > 30 ? trend.title.slice(0, 30) + '...' : trend.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Base Prompt */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Base Prompt:</label>
        <textarea
          value={basePrompt}
          onChange={(e) => setBasePrompt(e.target.value)}
          className="w-full bg-gray-800/80 text-gray-200 text-sm border border-gray-600/50 rounded-lg p-2.5 resize-none focus:outline-none focus:border-blue-500/50"
          rows={2}
          placeholder="Describe what kind of short to find..."
        />
      </div>

      {/* Custom Instructions */}
      <div className="mb-3">
        <label className="text-xs text-gray-400 block mb-1">Additional Instructions (optional):</label>
        <textarea
          value={customSeoTips}
          onChange={(e) => setCustomSeoTips(e.target.value)}
          className="w-full bg-gray-800/80 text-gray-200 text-sm border border-gray-600/50 rounded-lg p-2.5 resize-none focus:outline-none focus:border-blue-500/50"
          rows={2}
          placeholder="E.g., focus on controversy, keep it under 30 seconds..."
        />
      </div>

      {/* Prompt Preview */}
      <div className="mb-4">
        <button
          onClick={() => setShowFullPreview(!showFullPreview)}
          className="text-xs text-gray-400 hover:text-gray-300 mb-1 flex items-center gap-1"
        >
          {showFullPreview ? '▼' : '▶'} Full Prompt Preview
          {selectedTrends.length > 0 && (
            <span className="text-blue-400 ml-1">({selectedTrends.length} trends injected)</span>
          )}
        </button>

        {showFullPreview && (
          <div className="bg-gray-900/80 border border-gray-700/50 rounded-lg p-3 max-h-[300px] overflow-y-auto">
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
              {fullPrompt}
            </pre>
          </div>
        )}

        {!showFullPreview && selectedTrends.length > 0 && (
          <div className="bg-gray-900/60 border border-gray-700/30 rounded-lg p-2 text-xs text-gray-400">
            Base: "{basePrompt.slice(0, 50)}..."
            {' + '}{selectedTrends.length} trend{selectedTrends.length !== 1 ? 's' : ''} + SEO optimization
          </div>
        )}
      </div>

      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={trends.length === 0}
        className="w-full py-2.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:from-gray-700 disabled:to-gray-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-all"
      >
        Generate Trending Short
        {selectedTrends.length > 0 && ` (${selectedTrends.length} trends)`}
      </button>
    </div>
  );
};
