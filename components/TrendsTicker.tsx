import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { TrendItem, TrendFilters } from '../types';

// ==================== Animation Styles ====================
const TICKER_STYLES = `
@keyframes slideToPosition {
  from { transform: translateY(var(--slide-from)); }
  to { transform: translateY(0); }
}
@keyframes risingGlow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
  50% { box-shadow: 0 0 12px 2px rgba(34,197,94,0.4); }
}
@keyframes fallingShake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-3px); }
  40% { transform: translateX(3px); }
  60% { transform: translateX(-2px); }
  80% { transform: translateX(2px); }
}
@keyframes fadeInSlideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes pulseGlow {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
`;

// ==================== Number Roll Hook ====================
function useNumberRoll(target: number, duration = 400): number {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef<number>(0);
  const startRef = useRef({ value: target, time: 0 });

  useEffect(() => {
    const from = display;
    if (from === target) return;
    startRef.current = { value: from, time: performance.now() };

    const animate = (now: number) => {
      const elapsed = now - startRef.current.time;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out expo
      const eased = 1 - Math.pow(2, -10 * progress);
      setDisplay(Math.round(from + (target - from) * eased));
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);

  return display;
}

// ==================== Category Constants ====================
const YOUTUBE_CATEGORIES: Record<string, string> = {
  '0': 'All',
  '1': 'Film',
  '10': 'Music',
  '15': 'Animals',
  '17': 'Sports',
  '20': 'Gaming',
  '22': 'People',
  '23': 'Comedy',
  '24': 'Entertainment',
  '25': 'News',
  '26': 'How-to',
  '27': 'Education',
  '28': 'Science',
};

const REGIONS = ['US', 'GB', 'CA', 'AU', 'IN', 'DE', 'FR', 'JP', 'BR', 'MX'];

// ==================== Sub-components ====================

const VelocityBadge: React.FC<{ velocity: TrendItem['velocity']; growthPercent?: number }> = ({ velocity, growthPercent }) => {
  const config = {
    exploding: { icon: '🔥', color: 'text-orange-400', bg: 'bg-orange-500/20', label: 'Exploding' },
    rising: { icon: '⬆', color: 'text-green-400', bg: 'bg-green-500/20', label: 'Rising' },
    stable: { icon: '➡', color: 'text-gray-400', bg: 'bg-gray-500/20', label: 'Stable' },
    falling: { icon: '⬇', color: 'text-red-400', bg: 'bg-red-500/20', label: 'Falling' },
  }[velocity];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.color}`}>
      <span style={velocity === 'exploding' ? { animation: 'pulseGlow 1.5s infinite' } : undefined}>
        {config.icon}
      </span>
      {growthPercent != null ? `+${growthPercent.toLocaleString()}%` : config.label}
    </span>
  );
};

const RankChange: React.FC<{ rank: number; previousRank: number | null }> = ({ rank, previousRank }) => {
  if (previousRank === null) {
    return <span className="text-xs font-bold text-yellow-400 bg-yellow-500/20 px-1.5 py-0.5 rounded">NEW</span>;
  }
  const diff = previousRank - rank;
  if (diff > 0) {
    return <span className="text-green-400 font-bold text-sm">▲{diff}</span>;
  }
  if (diff < 0) {
    return <span className="text-red-400 font-bold text-sm">▼{Math.abs(diff)}</span>;
  }
  return <span className="text-gray-500 text-sm">—</span>;
};

const ViewCount: React.FC<{ count: number }> = ({ count }) => {
  const display = useNumberRoll(count);
  const formatted = display >= 1000000
    ? `${(display / 1000000).toFixed(1)}M`
    : display >= 1000
    ? `${(display / 1000).toFixed(0)}K`
    : display.toLocaleString();
  return <span className="font-mono text-sm">{formatted}</span>;
};

// ==================== TrendCard ====================

interface TrendCardProps {
  item: TrendItem;
  previousRank: number | null;
  onUseInPrompt: (item: TrendItem) => void;
}

const CARD_HEIGHT = 88; // px, for slide calculations

const TrendCard: React.FC<TrendCardProps> = ({ item, previousRank, onUseInPrompt }) => {
  const [expanded, setExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Calculate animation
  const actualPreviousRank = previousRank ?? item.previousRank;
  const rankDelta = actualPreviousRank != null ? actualPreviousRank - item.rank : 0;
  const isRising = rankDelta > 0;
  const isFalling = rankDelta < 0;
  const isNew = item.previousRank === null && actualPreviousRank === null;

  const animStyle: React.CSSProperties = {};
  let animClass = '';

  if (rankDelta !== 0) {
    animStyle['--slide-from' as any] = `${-rankDelta * CARD_HEIGHT}px`;
    animStyle.animation = 'slideToPosition 0.4s ease-out';
  }
  if (isRising) animClass = 'rising-glow';
  if (isFalling) animClass = 'falling-shake';
  if (isNew) animStyle.animation = 'fadeInSlideUp 0.5s ease-out';

  const sourceIcon = {
    youtube: '▶',
    google: 'G',
    reddit: '◉',
  }[item.source];

  const sourceColor = {
    youtube: 'text-red-400',
    google: 'text-blue-400',
    reddit: 'text-orange-400',
  }[item.source];

  return (
    <div
      ref={cardRef}
      className={`group relative bg-gray-800/80 hover:bg-gray-700/80 border border-gray-700/50 rounded-lg p-3 cursor-pointer transition-colors ${animClass}`}
      style={{
        ...animStyle,
        ...(isRising ? { animation: `${animStyle.animation || ''}, risingGlow 0.6s ease-out`.replace(/^,\s*/, '') } : {}),
        ...(isFalling ? { animation: `${animStyle.animation || ''}, fallingShake 0.4s ease-out`.replace(/^,\s*/, '') } : {}),
      }}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-3">
        {/* Rank */}
        <div className="flex flex-col items-center w-10 shrink-0">
          <span className="text-lg font-bold text-white">#{item.rank}</span>
          <RankChange rank={item.rank} previousRank={actualPreviousRank} />
        </div>

        {/* Thumbnail */}
        {item.thumbnailUrl && (
          <div className="w-14 h-14 rounded overflow-hidden shrink-0 bg-gray-900">
            <img
              src={item.thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate">{item.title}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-xs font-bold ${sourceColor}`}>{sourceIcon}</span>
            <span className="text-xs text-gray-400">{item.source === 'youtube' ? 'YouTube' : item.source === 'google' ? 'Google Trends' : 'Reddit'}</span>
            <span className="text-xs text-gray-500">·</span>
            <span className="text-xs text-gray-400">{item.category}</span>
          </div>
          {item.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {item.keywords.slice(0, 3).map((kw, i) => (
                <span key={i} className="text-[10px] text-gray-300 bg-gray-700/60 px-1.5 py-0.5 rounded">#{kw}</span>
              ))}
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <VelocityBadge velocity={item.velocity} growthPercent={item.growthPercent ?? undefined} />
          {item.viewCount != null && (
            <div className="text-gray-400">
              <ViewCount count={item.viewCount} />
              <span className="text-xs text-gray-500 ml-1">{item.source === 'reddit' ? 'score' : 'views'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Expanded Detail */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-gray-700/50">
          <div className="flex flex-wrap gap-1 mb-2">
            {item.keywords.map((kw, i) => (
              <span key={i} className="text-xs text-blue-300 bg-blue-500/20 px-2 py-0.5 rounded-full">#{kw}</span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors"
              onClick={(e) => { e.stopPropagation(); onUseInPrompt(item); }}
            >
              Use in Prompt
            </button>
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-md transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                View Source ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ==================== Main Component ====================

interface TrendsTickerProps {
  items: TrendItem[];
  previousRanks: Record<string, number>;
  loading: boolean;
  error: string | null;
  filters: TrendFilters;
  onFiltersChange: (filters: TrendFilters) => void;
  onRefresh: () => void;
  onUseInPrompt: (item: TrendItem) => void;
}

export const TrendsTicker: React.FC<TrendsTickerProps> = ({
  items,
  previousRanks,
  loading,
  error,
  filters,
  onFiltersChange,
  onRefresh,
  onUseInPrompt,
}) => {
  return (
    <div>
      <style>{TICKER_STYLES}</style>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
          </span>
          <h2 className="text-lg font-bold text-white">Trending Now</h2>
          {items.length > 0 && (
            <span className="text-xs text-gray-400 bg-gray-700/60 px-2 py-0.5 rounded-full">{items.length} trends</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Region */}
          <select
            value={filters.region}
            onChange={(e) => onFiltersChange({ ...filters, region: e.target.value })}
            className="text-xs bg-gray-800 text-gray-300 border border-gray-600 rounded px-2 py-1"
          >
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>

          {/* Source */}
          <select
            value={filters.source}
            onChange={(e) => onFiltersChange({ ...filters, source: e.target.value as TrendFilters['source'] })}
            className="text-xs bg-gray-800 text-gray-300 border border-gray-600 rounded px-2 py-1"
          >
            <option value="all">All Sources</option>
            <option value="youtube">YouTube</option>
            <option value="google">Google Trends</option>
            <option value="reddit">Reddit</option>
          </select>

          {/* Refresh */}
          <button
            onClick={onRefresh}
            disabled={loading}
            className="text-xs px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors disabled:opacity-50"
          >
            {loading ? '⟳ Loading...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Category Pills */}
      <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1 scrollbar-thin">
        {Object.entries(YOUTUBE_CATEGORIES).map(([id, label]) => (
          <button
            key={id}
            onClick={() => onFiltersChange({ ...filters, category: id })}
            className={`text-xs px-3 py-1 rounded-full whitespace-nowrap transition-colors ${
              filters.category === id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700/60 text-gray-400 hover:bg-gray-600/60'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Time Range */}
      <div className="flex gap-1 mb-4">
        {(['today', 'week', 'month'] as const).map(range => (
          <button
            key={range}
            onClick={() => onFiltersChange({ ...filters, timeRange: range })}
            className={`text-xs px-3 py-1 rounded transition-colors ${
              filters.timeRange === range
                ? 'bg-gray-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {range === 'today' ? 'Today' : range === 'week' ? 'This Week' : 'This Month'}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm p-3 rounded-lg mb-3">
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && items.length === 0 && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-gray-800/60 rounded-lg p-3 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded bg-gray-700"></div>
                <div className="w-14 h-14 rounded bg-gray-700"></div>
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-gray-700 rounded w-3/4"></div>
                  <div className="h-3 bg-gray-700 rounded w-1/2"></div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Trend Cards */}
      {!loading && items.length === 0 && !error && (
        <div className="text-center py-12 text-gray-400">
          <div className="text-4xl mb-3">📈</div>
          <div className="text-sm">No trends loaded yet. Click Refresh to fetch trending data.</div>
        </div>
      )}

      <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
        {items.map(item => (
          <TrendCard
            key={item.id}
            item={item}
            previousRank={previousRanks[item.id] ?? null}
            onUseInPrompt={onUseInPrompt}
          />
        ))}
      </div>
    </div>
  );
};
