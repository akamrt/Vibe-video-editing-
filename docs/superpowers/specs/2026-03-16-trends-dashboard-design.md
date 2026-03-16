# Trends Dashboard — Design Spec

## Context

VibeCut Pro generates short-form video clips from longer content (sermons, podcasts, lectures) using AI. Currently, the Content Library has three tabs: Videos, AI Search, and Shorts. Users want to maximize the viral potential of their generated shorts by aligning them with current trends.

**Problem:** There's no way to know what's trending when generating or reposting shorts. Users are flying blind on timing and topic alignment.

**Solution:** A new "Trends" tab in the Content Library that surfaces real-time trending data, ranks existing shorts against current trends, and enriches the AI prompt with trend-aware context and SEO best practices.

**Scope:** YouTube-first (free APIs), with architecture ready for future platform expansion.

---

## 1. Data Sources & Service Layer

### 1.1 APIs (All Free)

| Source | Endpoint | Cost | Data |
|--------|----------|------|------|
| YouTube Data API v3 | `videos.list?chart=mostPopular` | 1 unit / 10K daily | Trending videos by category + region |
| YouTube Data API v3 | `search.list` | 100 units / 10K daily | Keyword search for trend validation |
| Google Trends | `google-trends-api` npm | Free, no key | Daily trending searches, interest over time |
| Reddit | `r/{subreddit}.json` | Free, no auth | Trending posts from configurable subreddits |

**Reliability notes:**
- `google-trends-api` is an **unofficial scraping library**, not a real API. It frequently breaks when Google changes their HTML. Treat as least reliable source; always wrap in try/catch with graceful fallback.
- Reddit public `.json` endpoints may rate-limit without OAuth. Handle 429 responses with backoff.
- YouTube Data API v3 is the most reliable — official, well-documented, stable.

**YouTube API quota budget (10,000 units/day):**
- `videos.list?chart=mostPopular`: 1 unit per call → ~20 calls/day for different categories = 20 units
- `search.list`: 100 units per call → **limit to 10 on-demand searches/day** for expanded card detail
- Reserve: ~9,880 units for other app features
- Expanded card detail (Section 2.4) caches YouTube search results for 2 hours to avoid redundant calls

**YouTube API key:** Free via Google Cloud Console. Stored in `.env` as `YOUTUBE_API_KEY`.

### 1.2 Server Endpoints (Express, in `server.cjs`)

```
GET /api/trends/youtube?region=US&category=0    → TrendItem[]
GET /api/trends/google?geo=US                   → TrendItem[]
GET /api/trends/reddit?subreddits=videos,viral   → TrendItem[]
GET /api/trends/all?region=US                    → TrendItem[] (aggregated)
```

- Server-side proxy to avoid CORS and protect API keys
- In-memory cache: 1-hour TTL per endpoint+params combo
- Error handling: graceful degradation if one source fails

### 1.3 Types

```typescript
interface TrendItem {
  id: string;
  title: string;
  source: 'youtube' | 'google' | 'reddit';
  category: string;
  rank: number;
  previousRank: number | null;  // null = new entry
  velocity: 'exploding' | 'rising' | 'stable' | 'falling';
  viewCount?: number;
  engagement?: number;         // likes, upvotes, etc.
  growthPercent?: number;       // % change
  keywords: string[];
  thumbnailUrl?: string;
  url?: string;
  fetchedAt: number;           // timestamp
}

interface TrendAnalysis {
  shortId: string;
  trendScore: number;          // 0-100
  matchedTrends: string[];
  reasoning: string;
  suggestedAngle?: string;
  analyzedAt: number;
}

interface TrendState {
  items: TrendItem[];
  previousRanks: Map<string, number>;  // id -> previous rank for position animations
  analyses: TrendAnalysis[];           // cached repost ranker results
  analysesTimestamp: number | null;    // when analyses were last computed
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
  activeFilters: {
    source: 'all' | 'youtube' | 'google' | 'reddit';
    category: string;
    region: string;
    timeRange: 'today' | 'week' | 'month';
    // timeRange mapping per source:
    // - YouTube: mostPopular has no time filter (always "now"), ignored
    // - Google Trends: maps to dailyTrends (today) or interestOverTime (week/month)
    // - Reddit: maps to ?t=day | ?t=week | ?t=month on .json endpoint
  };
}
```

### 1.4 Client Service

New file: `services/trendsService.ts`

```
fetchTrends(filters) → TrendItem[]
fetchYouTubeTrends(region, category) → TrendItem[]
fetchGoogleTrends(geo) → TrendItem[]
fetchRedditTrends(subreddits) → TrendItem[]
analyzeShortAgainstTrends(short, trends) → TrendAnalysis
buildTrendPromptContext(selectedTrends) → string
```

---

## 2. Dashboard UI — Trend Ticker

The main visual section. A ranked, animated list of trending topics.

### 2.1 Layout

```
┌─ Trends Tab ─────────────────────────────────────────────┐
│                                                           │
│  ● Trending Now          [Refresh ↻]  [Region ▾] [All ▾] │
│                                                           │
│  [Entertainment] [Music] [Gaming] [News] [Education] ...  │
│                                                           │
│  ┌───────────────────────────────────────────────────┐   │
│  │ ▲2  [thumb]  "AI in Education"    🔥 1.2M views   │   │
│  │              YouTube · Education   ▲ +340%         │   │
│  │              #ai  #learning  #tech                 │   │
│  ├───────────────────────────────────────────────────┤   │
│  │ ▼1  [thumb]  "Morning Routines"   ⬆ 890K views    │   │
│  │              Google · Lifestyle    ▲ +120%         │   │
│  │              #routine  #wellness                   │   │
│  ├───────────────────────────────────────────────────┤   │
│  │ NEW [thumb]  "Stoic Philosophy"   ⬆ 450K views    │   │
│  │              Reddit · Philosophy   NEW             │   │
│  │              #stoicism  #mindset                   │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  ─── Your Shorts × Current Trends ───────────────────    │
│  [Analyze My Shorts]                                      │
│  ...                                                      │
│                                                           │
│  ─── Generate Trending Short ────────────────────────    │
│  ...                                                      │
└───────────────────────────────────────────────────────────┘
```

### 2.2 Animations (Ported from Scoreboard App)

All animations use CSS keyframes + JS orchestration, matching the scoreboard's patterns:

**Position slide (`slideToPosition`):**
- When trends re-rank on refresh, each card calculates `--slide-from = (oldRank - newRank) * cardHeight`
- CSS: `animation: slideToPosition 0.4s ease-out`
- Cards visually slide up or down to their new position

**Rising/falling indicators:**
- Rising cards: `.rising-star` class → green glow pulse (`risingGlow` keyframe, 0.6s)
- Falling cards: `.falling-shake` class → subtle horizontal shake
- Stable cards: no animation

**Number roll (`numberRollUp`):**
- View counts and growth percentages animate from old value to new value
- `requestAnimationFrame` with ease-out-expo easing
- Duration: 0.4s

**New entry animation:**
- Cards with `previousRank === null` get gold highlight entrance
- `animation: fadeInSlideUp 0.5s ease-out` + gold border flash

**Velocity badges (animated):**
- 🔥 Exploding (>500% growth): pulsing fire glow
- ⬆ Rising (>50%): green upward arrow
- ➡ Stable: grey neutral
- ⬇ Falling: red downward arrow

### 2.3 Filtering

- **Category pills**: Horizontal scrollable row, toggleable, multi-select
- **Region dropdown**: US (default), UK, CA, AU, IN, etc. (YouTube API supports region codes)
- **Source toggle**: All / YouTube / Google Trends / Reddit
- **Time range**: Today / This Week / This Month

### 2.4 Expandable Card Detail

Clicking a trend card expands it to show:
- Related keywords (from Google Trends `relatedQueries`)
- Top videos in this trend (YouTube search results)
- Suggested content angles
- "Use in Prompt" button → adds keywords to Prompt Builder

---

## 3. Repost Ranker

### 3.1 Flow

1. User clicks "Analyze My Shorts" button
2. System loads all `GeneratedShort[]` from IndexedDB
3. Batches shorts (5 at a time) and sends to Gemini with current top 20 trends
4. Gemini returns `TrendAnalysis` per short: score (0-100), matched trends, reasoning, suggested re-angle
5. Results displayed as ranked list with scoreboard animations

### 3.2 AI Prompt for Analysis

```
You are a social media trend analyst. Given these currently trending topics:
{top 20 trends with categories and growth rates}

Score each of the following short-form video clips on how well they
could perform if posted/reposted right now (0-100):
{short titles, hooks, keywords}

For each, return:
- trendScore: 0-100
- matchedTrends: which current trends it aligns with
- reasoning: one sentence explaining the score
- suggestedAngle: how to reframe/re-title for better trend alignment
```

### 3.3 Display

```
┌────────────────────────────────────────────────────┐
│ 🏆 92  "The Power Within"              ✨ Hot Match │
│        Matches: #motivation #mindset                │
│        "Hook aligns with trending self-improvement  │
│         wave. Consider adding 'morning routine'     │
│         angle for extra reach."                     │
│        [Open in Editor]  [Regenerate]  [View]       │
├────────────────────────────────────────────────────┤
│ 🥈 78  "Breaking Free"                 ⬆ Rising    │
│        ...                                          │
├────────────────────────────────────────────────────┤
│ 🥉 65  "Finding Purpose"               ➡ Stable    │
│        ...                                          │
└────────────────────────────────────────────────────┘
```

- Score counter animates with number-roll effect
- Position animations when re-analyzed (shorts can change rank)
- Medal emojis for top 3
- Color-coded scores: 80+ green, 50-79 yellow, <50 red
- Actions: Open in Editor (loads short into main editor), Regenerate (re-run with trend context), View (preview modal)

---

## 4. Trend-Aware Prompt Builder

### 4.1 Trend Tag Selection

- Clickable pills showing top trending keywords from the ticker
- Selected tags glow/highlight with a border color change
- Tags show source icon (YouTube/Google/Reddit) and growth indicator
- Multi-select: user picks which trends to target

### 4.2 Live Prompt Preview

As tags are selected, a preview area shows the complete prompt that will be sent:

```
Base prompt: "Find the most emotionally powerful moment"

+ Trend context (auto-injected):
  "Current viral topics include: #mindset, #motivation,
   #personalgrowth. Craft the hook and title to resonate
   with these themes while staying authentic to the content."

+ SEO optimization (auto-injected):
  "HOOK: Must grab attention in first 0.5 seconds.
   TITLE: Max 5 words, include at least one trending keyword.
   STRUCTURE: End on cliffhanger or mic-drop for replay value.
   COMPLETION: Aim for content that viewers watch to the end."
```

The user can edit any section before generating.

### 4.3 Integration with Existing Flow

- Select a video from the Videos tab (or use current video)
- Select trend tags
- Click "Generate Trending Short"
- Calls existing `/api/ai/generate-short` with enriched prompt
- Short appears in Shorts tab as usual, but with `trendingTopic` field populated

### 4.4 SEO Tips (Injected into Prompt)

Based on 2026 algorithm research:

**YouTube Shorts:**
- Completion rate >70% strongly promoted
- Hook in first 0.5s
- 5-word max title with trending keyword
- End on peak/cliffhanger for replay

**General viral factors:**
- Shares/saves > likes for algorithmic boost
- Original content preferred over reposts
- Emotional peaks drive engagement
- Counterintuitive or surprising openings

---

## 5. File Structure

```
New files:
  services/trendsService.ts        — Client: fetch trends, analyze shorts, build prompts
  components/TrendsTicker.tsx       — Trend cards with scoreboard-style animations
  components/RepostRanker.tsx       — AI-scored shorts ranking
  components/TrendPromptBuilder.tsx — Tag selection + live prompt preview

Modified files:
  server/server.cjs                 — Add /api/trends/* endpoints + /api/ai/analyze-trends
  pages/ContentLibraryPage.tsx      — Add 'trends' to activeTab union, tab button, render block
  types.ts                          — Add TrendItem, TrendAnalysis, TrendState types
  .env.example                      — Add YOUTUBE_API_KEY placeholder

Notes:
  - NO css/ directory — project uses Tailwind via CDN. All animations use inline
    styles, Tailwind utilities, or <style> blocks within components for @keyframes.
  - GeneratedShort type lives in services/contentDatabase.ts (not types.ts).
    Import from there when loading shorts for the Repost Ranker.
  - Trends tab position: rightmost tab (after Shorts), labeled "Trends"
  - Repost Ranker AI calls go through server (/api/ai/analyze-trends) to match
    existing pattern and enable cost tracking via server-side _usageMetadata.
  - Model: gemini-2.5-flash (same as short generation, balances cost vs quality)
```

---

## 6. Error Handling

- **No API key**: Show setup instructions inline (link to Google Cloud Console)
- **API quota exceeded**: Show cached data with "quota exceeded" banner, suggest waiting
- **Network failure**: Show last cached trends with "offline" indicator
- **Single source failure**: Other sources still display, failed source shows error chip
- **No shorts to analyze**: Repost Ranker shows "Generate some shorts first" with link to Shorts tab

---

## 7. Verification Plan

1. **Manual test trend data normalization**: Mock API responses → verify TrendItem[] output (no test framework exists in the project)
2. **Server endpoints**: Hit each `/api/trends/*` endpoint, verify JSON shape
3. **Animations**: Refresh trends with mock data that changes rankings → verify cards slide to new positions
4. **Repost Ranker**: Generate a few shorts, run analysis → verify scores and ranking display
5. **Prompt Builder**: Select tags → verify prompt preview updates → generate short → verify trend context appears in AI prompt
6. **Error states**: Remove API key → verify graceful error message
7. **Visual**: Screenshot the ticker with 10+ trends, verify layout doesn't overflow
