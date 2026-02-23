// AI Cost Tracker — estimates Gemini API spend, persisted to IndexedDB

import { contentDB } from './contentDatabase';

export interface CostEntry {
  id: number;
  timestamp: number;
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number; // USD
}

// Pricing per 1M tokens (USD) — preview models estimated from closest GA equivalent
const PRICING: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash':        { input: 0.10, output: 0.40 },
  'gemini-2.5-flash':        { input: 0.30, output: 2.50 },
  'gemini-2.5-flash-lite':   { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':          { input: 1.25, output: 10.00 },
  'gemini-3-flash-preview':  { input: 0.30, output: 2.50 },
  'gemini-3-pro-preview':    { input: 1.25, output: 10.00 },
};

const DEFAULT_PRICING = { input: 0.30, output: 2.50 };

// In-memory state
let log: CostEntry[] = [];
let nextId = 1;
let initialized = false;
const listeners = new Set<() => void>();

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] || DEFAULT_PRICING;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/** Load persisted cost entries from IndexedDB */
export async function initCostTracker(): Promise<void> {
  if (initialized) return;
  try {
    const entries = await contentDB.getAllCostEntries();
    log = entries;
    if (entries.length > 0) {
      nextId = Math.max(...entries.map(e => e.id)) + 1;
    }
    initialized = true;
    console.log(`[CostTracker] Loaded ${entries.length} entries from DB, total $${getSessionTotal().toFixed(4)}`);
    listeners.forEach(cb => cb());
  } catch (e) {
    console.warn('[CostTracker] Failed to load from DB:', e);
    initialized = true;
  }
}

/**
 * Record a Gemini API call's token usage.
 * `usageMetadata` comes directly from the generateContent response.
 */
export function trackUsage(
  operation: string,
  model: string,
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null
): void {
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;

  if (inputTokens === 0 && outputTokens === 0) {
    console.warn(`[CostTracker] No token counts for "${operation}" (${model}) — usageMetadata:`, usageMetadata);
    return;
  }

  const cost = computeCost(model, inputTokens, outputTokens);
  const entry: CostEntry = {
    id: nextId++,
    timestamp: Date.now(),
    operation,
    model,
    inputTokens,
    outputTokens,
    estimatedCost: cost,
  };

  log.push(entry);
  console.log(`[CostTracker] ${operation} (${model}): ${inputTokens} in / ${outputTokens} out → $${cost.toFixed(4)}`);

  // Persist to DB (fire-and-forget)
  contentDB.addCostEntry(entry).catch(e => console.warn('[CostTracker] DB save failed:', e));

  listeners.forEach(cb => cb());
}

/**
 * Track usage from server-side API calls (REST API response format).
 * Server returns { promptTokenCount, candidatesTokenCount } in usageMetadata.
 */
export function trackServerUsage(
  operation: string,
  model: string,
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null
): void {
  trackUsage(operation, model, usageMetadata);
}

export function getSessionLog(): CostEntry[] {
  return [...log];
}

export function getSessionTotal(): number {
  return log.reduce((sum, e) => sum + e.estimatedCost, 0);
}

export async function clearSession(): Promise<void> {
  log = [];
  nextId = 1;
  try {
    await contentDB.clearCostLog();
  } catch (e) {
    console.warn('[CostTracker] Failed to clear DB:', e);
  }
  listeners.forEach(cb => cb());
}

export function onCostUpdate(cb: () => void): void {
  listeners.add(cb);
}

export function offCostUpdate(cb: () => void): void {
  listeners.delete(cb);
}
