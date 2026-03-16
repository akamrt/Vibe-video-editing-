/**
 * Trends Service
 *
 * Fetches trending data from YouTube, Google Trends, and Reddit via server-side proxy.
 * Provides repost analysis via Gemini and trend-aware prompt building.
 */

import type { TrendItem, TrendAnalysis, TrendFilters } from '../types';
import { trackServerUsage } from './costTracker';

const SERVER_BASE = '';  // Same origin

// ==================== Fetch Trends ====================

export async function fetchAllTrends(filters: TrendFilters): Promise<TrendItem[]> {
  const sources = filters.source === 'all'
    ? ['youtube', 'google', 'reddit'] as const
    : [filters.source] as const;

  const results = await Promise.allSettled(
    sources.map(source => {
      switch (source) {
        case 'youtube': return fetchYouTubeTrends(filters.region, filters.category);
        case 'google': return fetchGoogleTrends(filters.region);
        case 'reddit': return fetchRedditTrends(filters.timeRange);
      }
    })
  );

  const items: TrendItem[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else {
      console.warn('Trend source failed:', result.reason);
    }
  }

  // Sort by engagement/viewCount descending, assign ranks
  items.sort((a, b) => (b.viewCount ?? b.engagement ?? 0) - (a.viewCount ?? a.engagement ?? 0));
  items.forEach((item, i) => { item.rank = i + 1; });

  return items;
}

export async function fetchYouTubeTrends(region: string, category: string): Promise<TrendItem[]> {
  const params = new URLSearchParams({ region, category });
  const res = await fetch(`${SERVER_BASE}/api/trends/youtube?${params}`);
  if (!res.ok) throw new Error(`YouTube trends failed: ${res.status}`);
  return res.json();
}

export async function fetchGoogleTrends(geo: string): Promise<TrendItem[]> {
  const params = new URLSearchParams({ geo });
  const res = await fetch(`${SERVER_BASE}/api/trends/google?${params}`);
  if (!res.ok) throw new Error(`Google trends failed: ${res.status}`);
  return res.json();
}

export async function fetchRedditTrends(timeRange: string): Promise<TrendItem[]> {
  const params = new URLSearchParams({ timeRange });
  const res = await fetch(`${SERVER_BASE}/api/trends/reddit?${params}`);
  if (!res.ok) throw new Error(`Reddit trends failed: ${res.status}`);
  return res.json();
}

// ==================== Repost Analysis ====================

interface ShortSummary {
  id: string;
  title: string;
  hook: string;
  keywords: string[];
}

export async function analyzeShortAgainstTrends(
  shorts: ShortSummary[],
  trends: TrendItem[]
): Promise<TrendAnalysis[]> {
  const res = await fetch(`${SERVER_BASE}/api/ai/analyze-trends`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shorts: shorts.map(s => ({
        id: s.id,
        title: s.title,
        hook: s.hook,
        keywords: s.keywords,
      })),
      trends: trends.slice(0, 20).map(t => ({
        title: t.title,
        category: t.category,
        velocity: t.velocity,
        growthPercent: t.growthPercent,
        keywords: t.keywords,
      })),
    }),
  });

  if (!res.ok) throw new Error(`Trend analysis failed: ${res.status}`);
  const data = await res.json();

  // Track cost if server returned usage metadata
  if (data._usageMetadata) {
    trackServerUsage('analyze-trends', 'gemini-2.5-flash', data._usageMetadata);
  }

  return data.analyses as TrendAnalysis[];
}

// ==================== Prompt Builder ====================

const SEO_TIPS = `SEO OPTIMIZATION (2026 YouTube Shorts Algorithm):
- HOOK: Must grab attention in first 0.5 seconds with a provocative, emotional, or surprising statement.
- TITLE: Max 5 words, must include at least one trending keyword.
- COMPLETION: Structure content so viewers watch to the end (>70% completion rate is strongly promoted).
- REPLAY VALUE: End on a cliffhanger, mic-drop, or thought-provoking statement that makes viewers replay.
- SHARES > LIKES: Content that gets shared/saved ranks higher than content that just gets likes.
- EMOTIONAL PEAKS: Counterintuitive, surprising, or deeply emotional moments drive the most engagement.`;

export function buildTrendPromptContext(selectedTrends: TrendItem[]): string {
  if (selectedTrends.length === 0) return '';

  const trendKeywords = selectedTrends.flatMap(t => t.keywords);
  const uniqueKeywords = [...new Set(trendKeywords)];
  const trendTitles = selectedTrends.map(t => t.title).join(', ');

  return `\n\nTREND CONTEXT (align with these for maximum reach):
Current viral topics include: ${trendTitles}.
Trending keywords: ${uniqueKeywords.join(', ')}.
Craft the hook and title to resonate with these themes while staying authentic to the source content.
If the content naturally connects to any of these trends, emphasize that connection in the hook and title.

${SEO_TIPS}`;
}

export function getDefaultTrendState(): import('../types').TrendState {
  return {
    items: [],
    previousRanks: {},
    analyses: [],
    analysesTimestamp: null,
    loading: false,
    error: null,
    lastFetched: null,
    activeFilters: {
      source: 'all',
      category: '0',  // 0 = all categories for YouTube
      region: 'US',
      timeRange: 'today',
    },
  };
}
