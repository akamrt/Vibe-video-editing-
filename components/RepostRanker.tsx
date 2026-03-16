import React, { useState, useRef, useEffect } from 'react';
import type { TrendItem, TrendAnalysis } from '../types';
import { contentDB, GeneratedShort } from '../services/contentDatabase';
import { analyzeShortAgainstTrends } from '../services/trendsService';

// ==================== Number Roll Hook ====================
function useNumberRoll(target: number, duration = 600): number {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const from = display;
    if (from === target) return;
    const startTime = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(2, -10 * progress);
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  return display;
}

// ==================== Score Display ====================
const ScoreBadge: React.FC<{ score: number; rank: number }> = ({ score, rank }) => {
  const display = useNumberRoll(score);
  const medal = rank === 1 ? '🏆' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null;
  const color = score >= 80 ? 'text-green-400' : score >= 50 ? 'text-yellow-400' : 'text-red-400';
  const bg = score >= 80 ? 'bg-green-500/15' : score >= 50 ? 'bg-yellow-500/15' : 'bg-red-500/15';

  return (
    <div className={`flex items-center gap-2 ${bg} rounded-lg px-3 py-2`}>
      {medal && <span className="text-xl">{medal}</span>}
      <span className={`text-2xl font-bold font-mono ${color}`}>{display}</span>
    </div>
  );
};

const TrendMatchBadge: React.FC<{ score: number }> = ({ score }) => {
  if (score >= 80) return <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">✨ Hot Match</span>;
  if (score >= 50) return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">⬆ Rising</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-500/20 text-gray-400">➡ Stable</span>;
};

// ==================== Main Component ====================

interface RepostRankerProps {
  trends: TrendItem[];
  analyses: TrendAnalysis[];
  onAnalysesUpdate: (analyses: TrendAnalysis[]) => void;
  onOpenInEditor: (shortId: string) => void;
  onRegenerateWithTrends: (shortId: string, trendContext: string) => void;
}

export const RepostRanker: React.FC<RepostRankerProps> = ({
  trends,
  analyses,
  onAnalysesUpdate,
  onOpenInEditor,
  onRegenerateWithTrends,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shorts, setShorts] = useState<GeneratedShort[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Load shorts from IndexedDB
  const loadShorts = async () => {
    const allShorts = await contentDB.getAllShorts();
    setShorts(allShorts);
    return allShorts;
  };

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);

    try {
      const allShorts = await loadShorts();
      if (allShorts.length === 0) {
        setError('No shorts generated yet. Generate some shorts first in the Shorts tab.');
        setLoading(false);
        return;
      }

      if (trends.length === 0) {
        setError('No trend data available. Refresh trends first.');
        setLoading(false);
        return;
      }

      const shortSummaries = allShorts.map(s => ({
        id: s.id,
        title: s.title,
        hook: s.hook || '',
        keywords: s.segments.flatMap(seg =>
          (seg.keywords || []).filter(k => k.enabled !== false).map(k => k.word)
        ),
      }));

      const results = await analyzeShortAgainstTrends(shortSummaries, trends);

      // Sort by score descending
      results.sort((a, b) => b.trendScore - a.trendScore);
      onAnalysesUpdate(results);
    } catch (err: any) {
      setError(err.message || 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // Find short details by ID
  const getShort = (id: string) => shorts.find(s => s.id === id);

  return (
    <div className="mt-6">
      <style>{`
        @keyframes scoreSlideIn {
          from { opacity: 0; transform: translateX(-20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <span className="text-gray-400">📊</span>
          Your Shorts × Current Trends
        </h3>
        <button
          onClick={handleAnalyze}
          disabled={loading}
          className="text-xs px-4 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:bg-purple-800 disabled:opacity-50 text-white rounded-md transition-colors font-medium"
        >
          {loading ? 'Analyzing...' : analyses.length > 0 ? 'Re-analyze' : 'Analyze My Shorts'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm p-3 rounded-lg mb-3">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="bg-purple-500/10 border border-purple-500/30 text-purple-300 text-sm p-4 rounded-lg flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin"></div>
          Analyzing {shorts.length || '...'} shorts against {trends.length} trends...
        </div>
      )}

      {/* Empty state */}
      {!loading && analyses.length === 0 && !error && (
        <div className="text-center py-8 text-gray-500 text-sm">
          Click "Analyze My Shorts" to see how your generated shorts match current trends.
        </div>
      )}

      {/* Results */}
      <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
        {analyses.map((analysis, idx) => {
          const short = getShort(analysis.shortId);
          const isExpanded = expanded.has(analysis.shortId);

          return (
            <div
              key={analysis.shortId}
              className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3 cursor-pointer hover:bg-gray-700/60 transition-colors"
              style={{ animation: `scoreSlideIn 0.3s ease-out ${idx * 0.05}s both` }}
              onClick={() => toggleExpand(analysis.shortId)}
            >
              <div className="flex items-start gap-3">
                {/* Score */}
                <ScoreBadge score={analysis.trendScore} rank={idx + 1} />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-white truncate">
                      {short?.title || `Short ${analysis.shortId.slice(0, 8)}`}
                    </span>
                    <TrendMatchBadge score={analysis.trendScore} />
                  </div>

                  {/* Matched trends */}
                  {analysis.matchedTrends.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {analysis.matchedTrends.map((trend, i) => (
                        <span key={i} className="text-[10px] text-blue-300 bg-blue-500/15 px-1.5 py-0.5 rounded">
                          #{trend}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Reasoning */}
                  <p className="text-xs text-gray-400 line-clamp-2">{analysis.reasoning}</p>
                </div>
              </div>

              {/* Expanded Detail */}
              {isExpanded && (
                <div className="mt-3 pt-3 border-t border-gray-700/50">
                  {analysis.suggestedAngle && (
                    <div className="mb-3 bg-blue-500/10 border border-blue-500/20 rounded p-2">
                      <span className="text-xs font-medium text-blue-300">Suggested angle: </span>
                      <span className="text-xs text-blue-200">{analysis.suggestedAngle}</span>
                    </div>
                  )}

                  {short?.hook && (
                    <div className="text-xs text-gray-400 mb-2">
                      <span className="text-gray-500">Hook:</span> "{short.hook}"
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
                      onClick={(e) => { e.stopPropagation(); onOpenInEditor(analysis.shortId); }}
                    >
                      Open in Editor
                    </button>
                    <button
                      className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        const trendContext = analysis.matchedTrends.join(', ');
                        onRegenerateWithTrends(analysis.shortId, trendContext);
                      }}
                    >
                      Regenerate with Trends
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
