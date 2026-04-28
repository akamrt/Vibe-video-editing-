/**
 * HyperframesAIGenerator
 *
 * Three modes for generating overlays via copy-paste LLM workflow:
 *   1. PRESET — pick from the 8 built-in compositions, tune their variables
 *   2. CUSTOM DSL — author novel animations via the Hyperframes DSL (preview + export)
 *   3. RAW HTML — paste a full HTML composition (preview only — does not export)
 *
 * No API keys, no server calls — the user is the transport layer.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HYPERFRAMES_COMPOSITIONS,
  inferVariable,
  type HyperframesCompositionMeta,
} from '../../utils/hyperframesUtils';
import type { HyperframesDSL } from '../../types';
import { validateDSL } from '../../utils/hyperframesDSL';

const STORAGE_KEY = 'vibecut_hf_ai_state_v2';
const MAX_COUNT = 6;
const MIN_COUNT = 1;

type GenMode = 'preset' | 'dsl' | 'graphic' | 'html';

interface PresetVariant {
  kind: 'preset';
  compositionId: string;
  name: string;
  rationale?: string;
  variables: Record<string, string | number | boolean>;
}

interface DSLVariant {
  kind: 'dsl';
  name: string;
  rationale?: string;
  dsl: HyperframesDSL;
}

interface HTMLVariant {
  kind: 'html';
  name: string;
  rationale?: string;
  html: string;
}

interface GraphicVariant {
  kind: 'graphic';
  name: string;
  rationale?: string;
  dsl: HyperframesDSL;
}

type AIVariant = PresetVariant | DSLVariant | HTMLVariant | GraphicVariant;

interface PersistedState {
  intent: string;
  count: number;
  mode: GenMode;
  variants: AIVariant[];
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { intent: '', count: 3, mode: 'preset', variants: [] };
}

function saveState(s: PersistedState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

interface Props {
  /** Apply a chosen preset variant (existing behaviour) */
  onApplyPreset: (meta: HyperframesCompositionMeta, variables: Record<string, string | number | boolean>) => void;
  /** Apply a custom DSL variant */
  onApplyDSL: (dsl: HyperframesDSL) => void;
  /** Apply a raw-HTML variant (preview only) */
  onApplyHTML: (html: string, name: string) => void;
  /** Apply a graphic variant — creates an independent GraphicLayer (NOT a subtitle template) */
  onApplyGraphic?: (dsl: HyperframesDSL, name: string) => void;
  /** Dialogue text from the currently selected clip — used as auto-context */
  dialogueText?: string;
}

export default function HyperframesAIGenerator({ onApplyPreset, onApplyDSL, onApplyHTML, onApplyGraphic, dialogueText }: Props) {
  const trimmedDialogue = (dialogueText ?? '').trim();
  const hasDialogue = trimmedDialogue.length > 0;
  const initial = useRef<PersistedState>(loadState());

  const [mode, setMode] = useState<GenMode>(initial.current.mode);
  const [intent, setIntent] = useState<string>(initial.current.intent);
  const [count, setCount] = useState<number>(initial.current.count);
  const [variants, setVariants] = useState<AIVariant[]>(initial.current.variants);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteValue, setPasteValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'plain' | 'launch' | null>(null);

  useEffect(() => {
    saveState({ intent, count, mode, variants });
  }, [intent, count, mode, variants]);

  // Clear stale variants when mode changes (don't show DSL variants in preset mode etc.)
  const visibleVariants = useMemo(() => {
    return variants.filter(v => {
      if (mode === 'preset')  return v.kind === 'preset';
      if (mode === 'dsl')     return v.kind === 'dsl';
      if (mode === 'graphic') return v.kind === 'graphic';
      return v.kind === 'html';
    });
  }, [variants, mode]);

  const prompt = useMemo(() => {
    if (mode === 'preset')  return buildPresetPrompt(intent, count, trimmedDialogue);
    if (mode === 'dsl')     return buildDSLPrompt(intent, count, trimmedDialogue);
    if (mode === 'graphic') return buildGraphicPrompt(intent, count, trimmedDialogue);
    return buildHTMLPrompt(intent, count, trimmedDialogue);
  }, [mode, intent, count, trimmedDialogue]);

  const writeClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      return ok;
    }
  }, []);

  const canGenerate = !!intent.trim() || hasDialogue;

  const handleCopy = useCallback(async () => {
    if (!canGenerate) { setError('Describe the overlay or select a clip with dialogue.'); return; }
    const ok = await writeClipboard(prompt);
    if (ok) { setCopied('plain'); setError(null); setTimeout(() => setCopied(null), 1600); }
    else setError('Clipboard blocked — copy manually.');
  }, [canGenerate, prompt, writeClipboard]);

  const handleCopyAndLaunch = useCallback(async () => {
    if (!canGenerate) { setError('Describe the overlay or select a clip with dialogue.'); return; }
    const ok = await writeClipboard(prompt);
    if (ok) {
      setCopied('launch'); setError(null); setTimeout(() => setCopied(null), 1600);
      window.open('https://claude.ai/new', '_blank', 'noopener,noreferrer');
      setPasteOpen(true);
    } else {
      setError('Clipboard blocked — copy manually.');
    }
  }, [canGenerate, prompt, writeClipboard]);

  // ── Parsers per mode ──────────────────────────────────────────────────────
  const tryParse = useCallback((raw: string): AIVariant[] | string => {
    if (!raw.trim()) return 'Paste the model response first.';
    let text = raw.trim();
    const fence = text.match(/```(?:json|html)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    if (mode === 'html') {
      // HTML mode: response can be a JSON object with variants, OR a single raw HTML string
      if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
        return [{ kind: 'html', name: 'Custom HTML', html: text }];
      }
    }

    let parsed: any;
    try { parsed = JSON.parse(text); }
    catch (e: any) {
      const m = text.match(/[\[{][\s\S]*[\]}]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
      if (!parsed) return `Couldn't parse JSON: ${e?.message ?? 'invalid'}`;
    }
    const arr: any[] = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.variants) ? parsed.variants
      : null as any;
    if (!arr) return 'Expected an array (or { "variants": [...] }).';

    if (mode === 'preset')  return parsePresetVariants(arr);
    if (mode === 'dsl')     return parseDSLVariants(arr);
    if (mode === 'graphic') return parseGraphicVariants(arr);
    return parseHTMLVariants(arr);
  }, [mode]);

  const handlePaste = useCallback(() => {
    const result = tryParse(pasteValue);
    if (typeof result === 'string') { setError(result); return; }
    // Replace variants for this mode, keep other modes' variants
    setVariants(prev => prev.filter(v => {
      if (mode === 'preset')  return v.kind !== 'preset';
      if (mode === 'dsl')     return v.kind !== 'dsl';
      if (mode === 'graphic') return v.kind !== 'graphic';
      return v.kind !== 'html';
    }).concat(result));
    setError(null);
    setPasteOpen(false);
    setPasteValue('');
  }, [pasteValue, tryParse, mode]);

  const handleTextareaPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    setPasteValue(text);
    setTimeout(() => {
      const result = tryParse(text);
      if (typeof result === 'string') { setError(result); return; }
      setVariants(prev => prev.filter(v => {
        if (mode === 'preset') return v.kind !== 'preset';
        if (mode === 'dsl')    return v.kind !== 'dsl';
        return v.kind !== 'html';
      }).concat(result));
      setError(null);
      setPasteOpen(false);
      setPasteValue('');
    }, 0);
    e.preventDefault();
  }, [tryParse, mode]);

  const handleApplyVariant = useCallback((v: AIVariant) => {
    if (v.kind === 'preset') {
      const meta = HYPERFRAMES_COMPOSITIONS.find(c => c.id === v.compositionId);
      if (!meta) return;
      onApplyPreset(meta, v.variables);
    } else if (v.kind === 'dsl') {
      onApplyDSL(v.dsl);
    } else if (v.kind === 'graphic') {
      onApplyGraphic?.(v.dsl, v.name);
    } else {
      onApplyHTML(v.html, v.name);
    }
  }, [onApplyPreset, onApplyDSL, onApplyHTML, onApplyGraphic]);

  const handleClearVariants = useCallback(() => {
    setVariants(prev => prev.filter(v => {
      if (mode === 'preset')  return v.kind !== 'preset';
      if (mode === 'dsl')     return v.kind !== 'dsl';
      if (mode === 'graphic') return v.kind !== 'graphic';
      return v.kind !== 'html';
    }));
  }, [mode]);

  // ── UI ────────────────────────────────────────────────────────────────────
  const intentBlocked = !canGenerate;

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.headerIcon}>🤖</span>
        <span style={S.headerLabel}>AI Overlay Generator</span>
        <span style={S.badge}>copy → paste</span>
      </div>

      {/* Mode tabs */}
      <div style={S.modeTabs}>
        <ModeTab active={mode === 'preset'}  onClick={() => setMode('preset')}  label="Preset"  hint="Tune one of 8 built-ins" />
        <ModeTab active={mode === 'dsl'}     onClick={() => setMode('dsl')}     label="Custom"  hint="Novel caption motion — exports" />
        <ModeTab active={mode === 'graphic'} onClick={() => setMode('graphic')} label="Graphic" hint="Independent shapes/overlays — exports" />
        <ModeTab active={mode === 'html'}    onClick={() => setMode('html')}    label="HTML"    hint="Raw HTML — preview only" />
      </div>

      <div style={S.helpRow}>
        {mode === 'html'
          ? '⚠ HTML mode is preview-only — animations will NOT appear in MP4 export. Use Custom or Graphic for export-safe novel motion.'
          : mode === 'graphic'
            ? 'Generates an independent graphic overlay (shapes, lines, images) on a new GFX track. Plays at the current playhead by default — drag the bar on the GFX track to reposition.'
            : hasDialogue
              ? 'The selected clip’s dialogue is used as context. Optionally add a vibe note to steer the result.'
              : 'Describe the vibe. Copy the prompt into Claude / ChatGPT / Gemini, paste the response back.'}
      </div>

      {hasDialogue && (
        <div style={S.dialogueChip} title={trimmedDialogue}>
          <span style={S.dialogueChipLabel}>💬 From clip</span>
          <span style={S.dialogueChipText}>"{trimmedDialogue.length > 110 ? trimmedDialogue.slice(0, 107) + '…' : trimmedDialogue}"</span>
        </div>
      )}

      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        placeholder={hasDialogue
          ? 'Optional vibe note — e.g. "punchy and bold", "soft cinematic", "neon retro"'
          : 'e.g. "punchy upbeat caption for a cooking reel — bold yellow accents, big and bouncy"'}
        rows={2}
        style={S.intentTextarea}
        spellCheck={false}
      />

      <div style={S.row}>
        <span style={S.smallLabel}>Variants</span>
        <div style={S.countRow}>
          {Array.from({ length: MAX_COUNT - MIN_COUNT + 1 }, (_, i) => i + MIN_COUNT).map((n) => (
            <button
              key={n} type="button"
              onClick={() => setCount(n)}
              style={{ ...S.countBtn, ...(count === n ? S.countBtnActive : null) }}
            >{n}</button>
          ))}
        </div>
      </div>

      <div style={S.btnRow}>
        <button
          type="button" onClick={handleCopyAndLaunch}
          disabled={intentBlocked}
          style={{ ...S.btnPrimary, opacity: intentBlocked ? 0.45 : 1 }}
          title="Copies the prompt and opens claude.ai in a new tab"
        >
          {copied === 'launch' ? '✓ Copied + opened' : '⚡ Copy + Open Claude.ai'}
        </button>
        <button
          type="button" onClick={handleCopy}
          disabled={intentBlocked}
          style={{ ...S.btnSecondary, opacity: intentBlocked ? 0.45 : 1 }}
        >
          {copied === 'plain' ? '✓ Copied' : '📋 Copy'}
        </button>
        <button
          type="button" onClick={() => { setPasteOpen(o => !o); setError(null); }}
          style={{ ...S.btnSecondary, ...(pasteOpen ? S.btnSecondaryActive : null) }}
        >
          📥 Paste Response
        </button>
      </div>

      {pasteOpen && (
        <div style={S.pasteWrap}>
          <textarea
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onPaste={handleTextareaPaste}
            placeholder={mode === 'html'
              ? 'Paste full HTML or a JSON variant array — auto-parses on paste'
              : 'Paste the JSON response here — auto-parses on paste'}
            rows={6}
            style={S.pasteTextarea}
            spellCheck={false}
            autoFocus
          />
          <div style={S.pasteBtnRow}>
            <button type="button" onClick={handlePaste} style={S.btnPrimary}>Parse</button>
            <button type="button" onClick={() => { setPasteValue(''); setError(null); }} style={S.btnSecondary}>Clear</button>
          </div>
        </div>
      )}

      {error && <div style={S.error}>{error}</div>}

      {visibleVariants.length > 0 && (
        <div style={S.variantsWrap}>
          <div style={S.variantsHeader}>
            <span style={S.smallLabel}>{visibleVariants.length} variant{visibleVariants.length === 1 ? '' : 's'} — click to apply</span>
            <button type="button" onClick={handleClearVariants} style={S.clearBtn}>Clear</button>
          </div>
          <div style={S.variantsGrid}>
            {visibleVariants.map((v, i) => (
              <VariantCard key={i} variant={v} onApply={() => handleApplyVariant(v)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Mode tab ───────────────────────────────────────────────────────────────

function ModeTab({ active, onClick, label, hint }: { active: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        flex: 1,
        padding: '5px 6px 4px',
        border: 'none', cursor: 'pointer',
        background: active ? '#6c63ff' : '#0f0d20',
        color: active ? '#fff' : '#7a749c',
        fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
        borderRadius: 4,
        display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center',
      }}
      title={hint}
    >
      <span>{label}</span>
      <span style={{ fontSize: 8, fontWeight: 500, opacity: active ? 0.8 : 0.5, textTransform: 'none', letterSpacing: 0 }}>
        {hint}
      </span>
    </button>
  );
}

// ── Variant card ───────────────────────────────────────────────────────────

function VariantCard({ variant, onApply }: { variant: AIVariant; onApply: () => void }) {
  if (variant.kind === 'preset') {
    const meta = HYPERFRAMES_COMPOSITIONS.find(c => c.id === variant.compositionId);
    return (
      <button type="button" onClick={onApply} style={S.variantCard} title={variant.rationale ?? ''}>
        <div style={S.variantTop}>
          <span style={S.variantName}>{variant.name}</span>
          <span style={S.variantBadge}>{meta?.name ?? variant.compositionId}</span>
        </div>
        {variant.rationale && <div style={S.variantRationale}>{variant.rationale}</div>}
        <div style={S.variantVarCount}>{Object.keys(variant.variables).length} vars set</div>
      </button>
    );
  }
  if (variant.kind === 'dsl') {
    const trackCount = variant.dsl.tracks?.length ?? 0;
    const fxCount = variant.dsl.effects ? Object.keys(variant.dsl.effects).length : 0;
    return (
      <button type="button" onClick={onApply} style={{ ...S.variantCard, borderColor: '#6c63ff60' }} title={variant.rationale ?? ''}>
        <div style={S.variantTop}>
          <span style={S.variantName}>{variant.name}</span>
          <span style={{ ...S.variantBadge, background: '#3a2050', color: '#c4b5fd' }}>DSL · {variant.dsl.split}</span>
        </div>
        {variant.rationale && <div style={S.variantRationale}>{variant.rationale}</div>}
        <div style={S.variantVarCount}>{trackCount} tracks · {fxCount} effects · {variant.dsl.duration}s</div>
      </button>
    );
  }
  if (variant.kind === 'graphic') {
    const nodeCount = variant.dsl.graphics?.length ?? 0;
    return (
      <button type="button" onClick={onApply} style={{ ...S.variantCard, borderColor: '#7c3aed80' }} title={variant.rationale ?? ''}>
        <div style={S.variantTop}>
          <span style={S.variantName}>{variant.name}</span>
          <span style={{ ...S.variantBadge, background: '#5b21b6', color: '#ddd6fe' }}>GFX · {nodeCount} nodes</span>
        </div>
        {variant.rationale && <div style={S.variantRationale}>{variant.rationale}</div>}
        <div style={S.variantVarCount}>{variant.dsl.duration}s · click to add to timeline</div>
      </button>
    );
  }
  return (
    <button type="button" onClick={onApply} style={{ ...S.variantCard, borderColor: '#6a4f20' }} title={variant.rationale ?? ''}>
      <div style={S.variantTop}>
        <span style={S.variantName}>{variant.name}</span>
        <span style={{ ...S.variantBadge, background: '#4a3010', color: '#ffb870' }}>HTML · preview only</span>
      </div>
      {variant.rationale && <div style={S.variantRationale}>{variant.rationale}</div>}
      <div style={S.variantVarCount}>{(variant.html.length / 1024).toFixed(1)}KB · won't export</div>
    </button>
  );
}

// ── Preset parsing (existing) ──────────────────────────────────────────────

function parsePresetVariants(arr: any[]): PresetVariant[] | string {
  const validIds = new Set(HYPERFRAMES_COMPOSITIONS.map(c => c.id));
  const cleaned: PresetVariant[] = [];
  arr.forEach((v) => {
    if (!v || typeof v !== 'object') return;
    const id = String(v.compositionId ?? v.composition ?? '').trim();
    if (!validIds.has(id)) return;
    const meta = HYPERFRAMES_COMPOSITIONS.find(c => c.id === id)!;
    const name = String(v.name ?? meta.name).slice(0, 80);
    const rationale = v.rationale ? String(v.rationale).slice(0, 400) : undefined;
    const rawVars = (v.variables && typeof v.variables === 'object') ? v.variables : {};
    const vars: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(meta.defaults)) {
      if (!(key in rawVars)) continue;
      const incoming = rawVars[key];
      const defVal = meta.defaults[key];
      const schemaEntry = inferVariable(key, defVal);
      const coerced = coerce(incoming, schemaEntry);
      if (coerced !== undefined) vars[key] = coerced;
    }
    cleaned.push({ kind: 'preset', compositionId: id, name, rationale, variables: vars });
  });
  if (!cleaned.length) return 'No valid preset variants found.';
  return cleaned;
}

function coerce(value: any, schema: ReturnType<typeof inferVariable>): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  switch (schema.type) {
    case 'number': {
      const n = typeof value === 'number' ? value : parseFloat(String(value));
      if (!isFinite(n)) return undefined;
      const min = (schema as any).min ?? -Infinity;
      const max = (schema as any).max ?? Infinity;
      return Math.min(max, Math.max(min, n));
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes') return true;
      if (s === 'false' || s === '0' || s === 'no') return false;
      return undefined;
    }
    case 'select': {
      const opts = (schema as any).options as string[] | undefined;
      const s = String(value);
      if (opts && opts.includes(s)) return s;
      return undefined;
    }
    default:
      return String(value).slice(0, 200);
  }
}

// ── DSL parsing ────────────────────────────────────────────────────────────

function parseDSLVariants(arr: any[]): DSLVariant[] | string {
  const cleaned: DSLVariant[] = [];
  const issues: string[] = [];
  arr.forEach((v, i) => {
    if (!v || typeof v !== 'object') return;
    const dslInput = v.dsl ?? v;  // Allow either { dsl: {...} } wrapper or bare DSL
    const result = validateDSL(dslInput);
    if (!result.ok || !result.dsl) {
      issues.push(`#${i + 1}: ${result.errors[0] ?? 'invalid DSL'}`);
      return;
    }
    cleaned.push({
      kind: 'dsl',
      name: String(v.name ?? result.dsl.name ?? 'Custom').slice(0, 80),
      rationale: v.rationale ? String(v.rationale).slice(0, 400) : undefined,
      dsl: result.dsl,
    });
  });
  if (!cleaned.length) return issues.length ? `No valid DSL variants: ${issues.join('; ')}` : 'No valid DSL variants found.';
  return cleaned;
}

// ── Graphic parsing ────────────────────────────────────────────────────────

function parseGraphicVariants(arr: any[]): GraphicVariant[] | string {
  const cleaned: GraphicVariant[] = [];
  const issues: string[] = [];
  arr.forEach((v, i) => {
    if (!v || typeof v !== 'object') return;
    const dslInput = v.dsl ?? v;
    const result = validateDSL(dslInput);
    if (!result.dsl || !(result.dsl.graphics?.length ?? 0)) {
      issues.push(`#${i + 1}: no graphics nodes`);
      return;
    }
    cleaned.push({
      kind: 'graphic',
      name: String(v.name ?? result.dsl.name ?? 'Graphic').slice(0, 80),
      rationale: v.rationale ? String(v.rationale).slice(0, 400) : undefined,
      dsl: result.dsl,
    });
  });
  if (!cleaned.length) return issues.length ? `No valid graphic variants: ${issues.join('; ')}` : 'No valid graphic variants found.';
  return cleaned;
}

// ── HTML parsing ───────────────────────────────────────────────────────────

function parseHTMLVariants(arr: any[]): HTMLVariant[] | string {
  const cleaned: HTMLVariant[] = [];
  arr.forEach((v) => {
    if (!v || typeof v !== 'object') return;
    const html = String(v.html ?? '').trim();
    if (!html.startsWith('<!DOCTYPE') && !html.startsWith('<html')) return;
    if (html.length > 200_000) return;
    cleaned.push({
      kind: 'html',
      name: String(v.name ?? 'Custom').slice(0, 80),
      rationale: v.rationale ? String(v.rationale).slice(0, 400) : undefined,
      html,
    });
  });
  if (!cleaned.length) return 'No valid HTML variants found (each must start with <!DOCTYPE or <html).';
  return cleaned;
}

// ── Prompt builders ────────────────────────────────────────────────────────

function dialogueAndIntentSections(intent: string, dialogue: string): string {
  const di = dialogue.trim();
  const it = intent.trim();
  return `## Spoken line on this clip${di ? ' (the literal dialogue the caption animates over)' : ''}
"""
${di || '(no clip selected)'}
"""

## User vibe note
"""
${it || '(none — infer the energy from the spoken line)'}
"""

Use the meaning, mood, and emphasis of the spoken line to drive your design choices. If the line has natural emphasis (numbers, exclamations, key nouns), highlight them. Match composition, color, and timing to what's actually being said.`;
}

function buildPresetPrompt(intent: string, count: number, dialogue: string): string {
  const compoBlocks = HYPERFRAMES_COMPOSITIONS.map((c) => {
    const lines: string[] = [];
    lines.push(`### "${c.id}" — ${c.name}`);
    lines.push(c.description);
    lines.push('Variables:');
    for (const [name, def] of Object.entries(c.defaults)) {
      const s = inferVariable(name, def);
      let typeInfo: string = s.type;
      if (s.type === 'number') typeInfo = `number ${(s as any).min}–${(s as any).max} step ${(s as any).step}`;
      else if (s.type === 'select') typeInfo = `select: ${(s as any).options?.join(' | ')}`;
      const defStr = typeof def === 'string' ? `"${def}"` : String(def);
      lines.push(`- ${name} (${typeInfo}) — default ${defStr}`);
    }
    return lines.join('\n');
  }).join('\n\n');

  return `You design animated subtitle/caption overlays for a video editor called VibeCut. Pick the best built-in composition(s) and tune their variables.

${dialogueAndIntentSections(intent, dialogue)}

## Task
Return EXACTLY ${count} distinct variant${count === 1 ? '' : 's'} as JSON. Each meaningfully different (different composition, palette, energy, or feel).

## Available compositions
${compoBlocks}

## Output rules
- Return ONLY a JSON object with a "variants" array. No prose, no markdown fences.
- Each variant: { "compositionId": <id>, "name": <60 chars>, "rationale": <1 sentence>, "variables": { ... } }
- "variables": only use keys from that composition's variable list. Numbers within range. Colors as "#RRGGBB" / "rgba(...)" / "transparent". Selects use listed options.
- Omit variables to leave at default. Don't invent keys.

## Output format (example shape — your values will differ)
{
  "variants": [
    {
      "compositionId": "pop-word-caption",
      "name": "Punchy Yellow Pop",
      "rationale": "High-energy stagger with yellow accent every 2 words for a snappy feel.",
      "variables": { "size": 92, "accent-color": "#FFD700", "accent-every": 2, "duration": 0.3, "stagger": 0.05, "text-transform": "uppercase" }
    }
  ]
}

Now produce ${count} variant${count === 1 ? '' : 's'}. JSON only.`;
}

function buildDSLPrompt(intent: string, count: number, dialogue: string): string {
  return `You author animated caption overlays for VibeCut using a JSON DSL. Your output is rendered by a custom interpreter — both in browser preview AND in MP4 export — so all DSL features will work end-to-end.

${dialogueAndIntentSections(intent, dialogue)}

## Your task
Return EXACTLY ${count} variant${count === 1 ? '' : 's'} under "variants". Each variant has a "dsl" object describing a unique animated caption.

Be bold and inventive — push past safe defaults. Use the full toolkit: per-letter motion, loops, staggers, color mixing, RGB split, blur, multi-stage tweens. Match the energy and meaning of the spoken line.

## DSL schema
{
  "name": string,
  "split": "element" | "line" | "word" | "letter",
  "layout": { "bottom": 0-1080, "maxWidth"?: number, "lineHeight"?: 0.8-3, "align"?: "center"|"left"|"right" },
  "style": {
    "fontFamily"?: <Google Fonts: Inter, Impact, Bebas Neue, Anton, Bangers, Permanent Marker, Montserrat, Poppins, Oswald, Archivo Black, Russo One, Big Shoulders Display, etc>,
    "fontWeight"?: "300"-"900",
    "fontSize"?: 10-400 (1920x1080 author space; 80-120 typical for big captions),
    "color"?: "#hex",
    "letterSpacing"?: number,
    "textTransform"?: "none"|"uppercase"|"lowercase"|"capitalize"
  },
  "duration": 0.05-10 (seconds, per-unit animation duration),
  "stagger"?: 0-2 (delay between units),
  "staggerFn"?: "linear"|"wave"|"random"|"fromCenter"|"reverse",
  "tracks": [Track],   // see below
  "effects"?: { "shadow"?, "stroke"?, "glow"?, "rgbSplit"? },
  "karaoke"?: { "enabled": true, "color"?, "scale"?, "glow"?, "background"?, "pastOpacity"?, "stroke"? }
}

## Track formats (pick one mode per track — you can stack many tracks per variant)
Tween mode:  { "prop": <prop>, "from": number, "to": number, "at": [start, end] in 0..1, "easing": <easing> }
Loop mode:   { "prop": <prop>, "loop": "sine"|"cosine"|"sawtooth"|"triangle"|"random", "amplitude": number, "period": seconds, "phasePerUnit": 0..1 }

prop:    "opacity" | "translateX" | "translateY" | "scale" | "scaleX" | "scaleY" | "rotate" | "skewX" | "skewY" | "blur" | "colorMix"
easing:  "linear" | "easeIn" | "easeOut" | "easeInOut" | "power2In" | "power2Out" | "power3In" | "power3Out" | "outBack" | "inBack" | "outElastic" | "outBounce"
"at":    [startProgress, endProgress] within [0, 1]. Default [0, 1]. Tracks can overlap or chain (use multi tracks of same prop with different "at" windows for multi-stage tweens).
phasePerUnit: 0 = all units oscillate together. 0.1 = each unit phase-shifted by 10% of period — creates wave/cascade effects.
colorMix: must include "colors": ["#a", "#b"]; oscillates color between them.

## Effects
shadow: { color, blur, offsetX?, offsetY? }
stroke: { color, width 0-30 }
glow:   { color, blur } — adds a halo
rgbSplit: { redOffset: [x,y], blueOffset: [x,y], jitter?, jitterFreq? } — chromatic aberration with optional time-based shake

## Worked example — bouncy energetic
{
  "name": "Pop Bounce",
  "split": "word",
  "layout": { "bottom": 100, "maxWidth": 1600, "align": "center" },
  "style": { "fontFamily": "Impact", "fontWeight": "900", "fontSize": 92, "color": "#ffffff", "textTransform": "uppercase" },
  "duration": 0.45, "stagger": 0.06,
  "tracks": [
    { "prop": "translateY", "from": 60, "to": 0, "at": [0, 0.7], "easing": "outBack" },
    { "prop": "scale", "from": 0.4, "to": 1, "at": [0, 0.6], "easing": "outBack" },
    { "prop": "rotate", "from": -10, "to": 0, "at": [0, 0.6], "easing": "outBack" },
    { "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.3], "easing": "easeOut" }
  ],
  "effects": { "shadow": { "color": "#000", "blur": 8 }, "stroke": { "color": "#000", "width": 3 } },
  "karaoke": { "enabled": true, "color": "#FFD700", "scale": 1.2, "glow": { "color": "#FFD700", "blur": 14 } }
}

## Worked example — drifting wave with color mix
{
  "name": "Ocean Drift",
  "split": "word",
  "layout": { "bottom": 120, "align": "center" },
  "style": { "fontFamily": "Poppins", "fontWeight": "700", "fontSize": 76, "color": "#ffffff" },
  "duration": 0.6, "stagger": 0.08,
  "tracks": [
    { "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.4] },
    { "prop": "translateY", "from": 30, "to": 0, "at": [0, 0.6], "easing": "power3Out" },
    { "prop": "translateY", "loop": "sine", "amplitude": 8, "period": 2.5, "phasePerUnit": 0.15 },
    { "prop": "colorMix", "loop": "sine", "amplitude": 1, "period": 4, "phasePerUnit": 0.1, "colors": ["#7DD3FC", "#A78BFA"] }
  ],
  "effects": { "shadow": { "color": "rgba(0,0,0,0.6)", "blur": 12 } }
}

## Worked example — glitchy letter shake
{
  "name": "Cyber Glitch",
  "split": "letter",
  "layout": { "bottom": 120, "align": "center" },
  "style": { "fontFamily": "Impact", "fontWeight": "900", "fontSize": 96, "color": "#ffffff", "textTransform": "uppercase", "letterSpacing": 4 },
  "duration": 0.4, "stagger": 0.02, "staggerFn": "random",
  "tracks": [
    { "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.3] },
    { "prop": "translateY", "loop": "random", "amplitude": 4, "period": 0.1, "phasePerUnit": 0.5 },
    { "prop": "translateX", "loop": "random", "amplitude": 3, "period": 0.13, "phasePerUnit": 0.7, "seed": 42 }
  ],
  "effects": { "rgbSplit": { "redOffset": [-3, 0], "blueOffset": [3, 0], "jitter": 2, "jitterFreq": 12 } }
}

## Worked example — multi-stage scale (overshoot + settle)
{
  "name": "Snap Settle",
  "split": "letter",
  "layout": { "bottom": 110, "align": "center" },
  "style": { "fontFamily": "Bebas Neue", "fontWeight": "700", "fontSize": 110, "color": "#ffffff", "textTransform": "uppercase" },
  "duration": 0.7, "stagger": 0.04,
  "tracks": [
    { "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.2] },
    { "prop": "scale", "from": 0, "to": 1.3, "at": [0, 0.5], "easing": "outBack" },
    { "prop": "scale", "from": 1.3, "to": 1, "at": [0.5, 0.8], "easing": "easeInOut" },
    { "prop": "skewX", "from": -8, "to": 0, "at": [0, 0.5], "easing": "outBack" }
  ],
  "effects": { "stroke": { "color": "#000", "width": 4 } }
}

## Output format
{
  "variants": [
    { "name": "...", "rationale": "1-sentence why this fits the dialogue/vibe", "dsl": { ...full DSL... } }
  ]
}

Output ONLY the JSON object. No prose, no markdown fences. Now produce ${count} variant${count === 1 ? '' : 's'}.`;
}

function buildGraphicPrompt(intent: string, count: number, dialogue: string): string {
  return `You author ANIMATED GRAPHIC OVERLAYS for VibeCut — independent decorative elements that play over the video at a specific time. Examples: lower thirds, callout shapes, animated frames, geometric flourishes, decorative text labels, particle bursts, progress bars, info boxes.

Your output is rendered by a custom interpreter — both in browser preview AND in MP4 export — so all features will work end-to-end. NO HTML, NO scripts, just structured JSON.

${dialogueAndIntentSections(intent, dialogue)}

## Your task
Return EXACTLY ${count} variant${count === 1 ? '' : 's'} under "variants". Each variant has a "dsl" object whose "graphics" array describes shapes, lines, paths, images, or decorative text. Be inventive — combine multiple nodes for compound effects (e.g., a backing rect + animated icon + label text). Each node animates independently via its own tracks.

## Schema
{
  "name": "Lower Third",
  "duration": 0.6,                  // base per-node animation duration (seconds)
  "graphics": [GraphicNode, ...]    // 1..64 nodes — combine for richer compositions
}

## Author space
1920x1080. (0,0) = top-left. Center = (960, 540). Lower-third area ~ y=850-1000. Title area ~ y=80-200.

## Node kinds (each gets optional tracks, appearAt, disappearAt, animDuration, origin, opacity)
- rect:   { kind:"rect", x, y, width, height, fill?, stroke?, strokeWidth?, cornerRadius? }
- circle: { kind:"circle", x, y (center), radius, fill?, stroke?, strokeWidth? }
- line:   { kind:"line", x, y, x2, y2, stroke, strokeWidth, lineCap?, drawProgress? (0..1) }
- path:   { kind:"path", x, y, d (SVG d, absolute coords), fill?, stroke?, strokeWidth? }
- image:  { kind:"image", x, y, width, height, src ("data:image/svg+xml;base64,..." preferred for export safety) }
- text:   { kind:"text", x, y, text, fontFamily?, fontWeight?, fontSize?, color?, align?, stroke?, shadow?, glow? }

Common extras on every node:
  appearAt:      number (s within layer lifecycle, default 0)
  disappearAt:   number (s)
  animDuration:  number (s — override the dsl.duration for this node)
  origin:        { x: 0..1, y: 0..1 } — transform pivot within bounding box (default 0.5,0.5)
  opacity:       0..1 — static multiplier
  tracks:        [Track, ...] — see below

## Track formats (pick one mode per track — stack multiple tracks for compound motion)
Tween: { "prop": <prop>, "from": number, "to": number, "at": [start, end] in 0..1, "easing": <easing> }
Loop:  { "prop": <prop>, "loop": "sine"|"cosine"|"sawtooth"|"triangle"|"random", "amplitude": number, "period": seconds, "phasePerUnit": 0..1 }

prop:    "opacity" | "translateX" | "translateY" | "scale" | "scaleX" | "scaleY" | "rotate" | "skewX" | "skewY" | "blur" | "colorMix"
easing:  "linear" | "easeIn" | "easeOut" | "easeInOut" | "power2In" | "power2Out" | "power3In" | "power3Out" | "outBack" | "inBack" | "outElastic" | "outBounce"

## Worked example — animated lower third
{
  "name": "Lower Third — Bold Bar",
  "duration": 0.7,
  "graphics": [
    { "kind": "rect", "x": 80, "y": 880, "width": 800, "height": 70, "fill": "#0f172a",
      "tracks": [
        { "prop": "scaleX", "from": 0, "to": 1, "at": [0, 0.5], "easing": "outBack" },
        { "prop": "opacity", "from": 0, "to": 0.92, "at": [0, 0.3] }
      ],
      "origin": { "x": 0, "y": 0.5 }
    },
    { "kind": "rect", "x": 80, "y": 880, "width": 12, "height": 70, "fill": "#facc15",
      "tracks": [
        { "prop": "scaleY", "from": 0, "to": 1, "at": [0.4, 0.7], "easing": "outBack" }
      ],
      "appearAt": 0.2, "origin": { "x": 0.5, "y": 1 }
    },
    { "kind": "text", "x": 110, "y": 928, "text": "BREAKING NEWS",
      "fontFamily": "Bebas Neue", "fontSize": 44, "color": "#ffffff", "align": "left",
      "tracks": [
        { "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.4] },
        { "prop": "translateX", "from": -20, "to": 0, "at": [0, 0.5], "easing": "outBack" }
      ],
      "appearAt": 0.4
    }
  ]
}

## Worked example — burst of geometric circles
{
  "name": "Pop Burst",
  "duration": 0.8,
  "graphics": [
    { "kind": "circle", "x": 960, "y": 540, "radius": 60, "fill": "#fbbf24",
      "tracks": [
        { "prop": "scale", "from": 0, "to": 1.4, "at": [0, 0.5], "easing": "outBack" },
        { "prop": "scale", "from": 1.4, "to": 1, "at": [0.5, 0.8], "easing": "easeInOut" },
        { "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.2] }
      ]
    },
    { "kind": "circle", "x": 860, "y": 480, "radius": 30, "fill": "#06b6d4",
      "appearAt": 0.15,
      "tracks": [
        { "prop": "scale", "from": 0, "to": 1, "at": [0, 0.6], "easing": "outElastic" },
        { "prop": "translateX", "loop": "sine", "amplitude": 8, "period": 1.5 },
        { "prop": "opacity", "from": 0, "to": 0.85, "at": [0, 0.3] }
      ]
    },
    { "kind": "circle", "x": 1060, "y": 480, "radius": 24, "fill": "#a78bfa",
      "appearAt": 0.3,
      "tracks": [
        { "prop": "scale", "from": 0, "to": 1, "at": [0, 0.6], "easing": "outElastic" },
        { "prop": "translateY", "loop": "sine", "amplitude": 6, "period": 1.2, "phasePerUnit": 0.3 },
        { "prop": "opacity", "from": 0, "to": 0.85, "at": [0, 0.3] }
      ]
    }
  ]
}

## Worked example — animated callout with line + label
{
  "name": "Pin Callout",
  "duration": 1.0,
  "graphics": [
    { "kind": "circle", "x": 1200, "y": 400, "radius": 14, "fill": "#ef4444",
      "tracks": [
        { "prop": "scale", "from": 0, "to": 1, "at": [0, 0.4], "easing": "outBack" },
        { "prop": "scale", "loop": "sine", "amplitude": 0.15, "period": 1.2 }
      ]
    },
    { "kind": "line", "x": 1200, "y": 400, "x2": 1500, "y2": 250, "stroke": "#ef4444", "strokeWidth": 3,
      "appearAt": 0.3,
      "tracks": [
        { "prop": "scaleX", "from": 0, "to": 1, "at": [0, 0.5], "easing": "easeOut" }
      ]
    },
    { "kind": "rect", "x": 1490, "y": 220, "width": 280, "height": 60, "fill": "#1e293b", "cornerRadius": 6,
      "appearAt": 0.7,
      "tracks": [
        { "prop": "opacity", "from": 0, "to": 0.95, "at": [0, 0.3] },
        { "prop": "translateY", "from": -10, "to": 0, "at": [0, 0.4], "easing": "outBack" }
      ]
    },
    { "kind": "text", "x": 1630, "y": 258, "text": "0:32", "fontFamily": "Inter", "fontWeight": "700",
      "fontSize": 32, "color": "#ffffff", "align": "center",
      "appearAt": 0.85,
      "tracks": [{ "prop": "opacity", "from": 0, "to": 1, "at": [0, 0.3] }]
    }
  ]
}

## Output format
{
  "variants": [
    { "name": "...", "rationale": "1-sentence why this fits", "dsl": { "duration": 0.7, "graphics": [...] } }
  ]
}

The DSL can include "split", "tracks", "layout", "style", "stagger" fields too — but for pure graphics, only "graphics" + "duration" are required. Output ONLY the JSON object. No prose, no markdown fences. Now produce ${count} variant${count === 1 ? '' : 's'}.`;
}

function buildHTMLPrompt(intent: string, count: number, dialogue: string): string {
  return `You author animated caption overlays as raw HTML files for VibeCut. ⚠ HTML mode is PREVIEW ONLY — your output won't appear in MP4 export, only in the editor preview.

${dialogueAndIntentSections(intent, dialogue)}

## Constraints
- Single self-contained HTML file (no external assets except a CDN GSAP/anime.js if needed)
- Sandboxed iframe: no top navigation, no parent access, no localStorage
- Composition canvas is 1920x1080. Set body width/height accordingly. Background must be transparent
- Must expose two globals on window for VibeCut to drive it:
    - window.__hyInit(text)            — called when subtitle text changes
    - window.__hySetActiveWord(idx)    — called every frame with active word index (-1 if none)
    - window.__timelines = { '<id>': gsapTimeline }   — for seek-based playback
- Time semantics: timeline must be paused; VibeCut calls .seek(timeOffset) for every frame

## Task
Return EXACTLY ${count} variant${count === 1 ? '' : 's'} as JSON: { "variants": [ { "name", "rationale", "html": "<!DOCTYPE...full file..." } ] }

Output ONLY the JSON object. No prose, no markdown fences.`;
}

// ── Styles ─────────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 8,
    padding: 10,
    background: 'linear-gradient(180deg, #1a1530 0%, #14122a 100%)',
    border: '1px solid #3a2f6a', borderRadius: 8,
  },
  header: { display: 'flex', alignItems: 'center', gap: 6 },
  headerIcon: { fontSize: 14 },
  headerLabel: { fontSize: 11, fontWeight: 700, color: '#c4b5fd', letterSpacing: 0.6, textTransform: 'uppercase' },
  badge: {
    marginLeft: 'auto', fontSize: 9, color: '#7c6cd0', background: '#2a2050',
    padding: '2px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: 0.5,
  },
  modeTabs: {
    display: 'flex', gap: 4,
    padding: 3,
    background: '#0a0918', border: '1px solid #2d2456', borderRadius: 6,
  },
  helpRow: { fontSize: 10, color: '#7a749c', lineHeight: 1.4 },
  dialogueChip: {
    display: 'flex', alignItems: 'flex-start', gap: 6,
    padding: '6px 8px', background: '#0d1a2a',
    border: '1px solid #1f4060', borderRadius: 5,
  },
  dialogueChipLabel: { fontSize: 9, fontWeight: 700, color: '#7ec4ff', flexShrink: 0, letterSpacing: 0.4, paddingTop: 1 },
  dialogueChipText: { fontSize: 11, color: '#cfe4ff', fontStyle: 'italic', lineHeight: 1.35 },
  intentTextarea: {
    background: '#0f0d20', border: '1px solid #2d2456', borderRadius: 5,
    color: '#e0d8ff', fontSize: 12, padding: '6px 8px', outline: 'none',
    resize: 'vertical', fontFamily: 'inherit',
  },
  row: { display: 'flex', alignItems: 'center', gap: 8 },
  smallLabel: { fontSize: 10, color: '#8a82b0', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' },
  countRow: { display: 'flex', gap: 3, marginLeft: 'auto' },
  countBtn: {
    width: 24, height: 22, borderRadius: 4, border: '1px solid #2d2456',
    background: '#0f0d20', color: '#7a749c', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  },
  countBtnActive: { background: '#6c63ff', color: '#fff', borderColor: '#6c63ff' },
  btnRow: { display: 'flex', gap: 5 },
  btnPrimary: {
    flex: 1, padding: '7px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
    background: '#6c63ff', color: '#fff', fontSize: 11, fontWeight: 700,
  },
  btnSecondary: {
    flex: 1, padding: '7px 10px', borderRadius: 5, border: '1px solid #3a2f6a',
    background: '#1a1530', color: '#c4b5fd', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  },
  btnSecondaryActive: { background: '#2a2050', borderColor: '#6c63ff' },
  pasteWrap: {
    display: 'flex', flexDirection: 'column', gap: 5,
    padding: 8, background: '#0a0918', border: '1px solid #2d2456', borderRadius: 5,
  },
  pasteTextarea: {
    background: '#0f0d20', border: '1px solid #2d2456', borderRadius: 4,
    color: '#c8c4ff', fontSize: 11, padding: '6px 8px', outline: 'none',
    resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  pasteBtnRow: { display: 'flex', gap: 5 },
  error: {
    fontSize: 10, color: '#ff8080', padding: '5px 8px',
    background: '#3a1020', border: '1px solid #6a2030', borderRadius: 4,
  },
  variantsWrap: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 },
  variantsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  clearBtn: {
    background: 'none', border: '1px solid #444', color: '#888',
    borderRadius: 4, fontSize: 9, cursor: 'pointer', padding: '1px 8px',
  },
  variantsGrid: { display: 'grid', gridTemplateColumns: '1fr', gap: 5 },
  variantCard: {
    display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 9px',
    background: '#0f0d20', border: '1px solid #2d2456', borderRadius: 5,
    cursor: 'pointer', textAlign: 'left', transition: 'border-color 0.15s, background 0.15s',
  },
  variantTop: { display: 'flex', alignItems: 'center', gap: 6 },
  variantName: { fontSize: 11, fontWeight: 700, color: '#e0d8ff', flex: 1 },
  variantBadge: {
    fontSize: 9, color: '#a89fff', background: '#2a2050',
    padding: '2px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: 0.4,
  },
  variantRationale: { fontSize: 10, color: '#8a82b0', lineHeight: 1.35 },
  variantVarCount: { fontSize: 9, color: '#5a527a', fontStyle: 'italic' },
};
