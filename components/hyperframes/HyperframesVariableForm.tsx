/**
 * HyperframesVariableForm
 *
 * Auto-generates form controls from a composition's HyperframesVariable schema.
 * String  → text input
 * Color   → colour picker + hex text input
 * Number  → number input + range slider
 * Boolean → toggle switch
 * Select  → segmented button row
 * Font    → Google Font picker (reuses main app's FontPicker)
 *
 * Variables are grouped (Text / Animation / Effects / Karaoke) with
 * collapsible section headers.
 */

import React, { useState, useMemo } from 'react';
import type { HyperframesVariable } from '../../types';
import FontPicker from '../FontPicker';

interface Props {
  schema: HyperframesVariable[];
  values: Record<string, string | number | boolean>;
  onChange: (name: string, value: string | number | boolean) => void;
}

const GROUP_ORDER: Array<NonNullable<HyperframesVariable['group']>> = ['Text', 'Animation', 'Effects', 'Karaoke'];

const GROUP_ICONS: Record<string, string> = {
  Text: 'Aa',
  Animation: '▶',
  Effects: '✦',
  Karaoke: '♬',
};

export default function HyperframesVariableForm({ schema, values, onChange }: Props) {
  // Group schema entries
  const grouped = useMemo(() => {
    const by: Record<string, HyperframesVariable[]> = {};
    for (const v of schema) {
      const g = v.group ?? 'Text';
      (by[g] = by[g] || []).push(v);
    }
    return by;
  }, [schema]);

  // Start all sections open; user can collapse
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({
    Text: true, Animation: true, Effects: true, Karaoke: true,
  }));

  if (!schema.length) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {GROUP_ORDER.filter(g => grouped[g]?.length).map(groupName => {
        const isOpen = open[groupName];
        const vars = grouped[groupName];
        return (
          <div key={groupName} style={{ border: '1px solid #222236', borderRadius: 6, overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setOpen(o => ({ ...o, [groupName]: !o[groupName] }))}
              style={{
                width: '100%',
                padding: '6px 10px',
                background: '#161626',
                border: 'none',
                color: '#a89fff',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
              }}
            >
              <span>{GROUP_ICONS[groupName]}  {groupName}  <span style={{ color: '#505070', fontWeight: 400 }}>({vars.length})</span></span>
              <span style={{ color: '#6c63ff', fontSize: 10 }}>{isOpen ? '▾' : '▸'}</span>
            </button>
            {isOpen && (
              <div style={{ padding: '10px 10px 12px', display: 'flex', flexDirection: 'column', gap: 10, background: '#0f0f1c' }}>
                {vars.map(v => {
                  const val = values[v.name] ?? v.defaultValue ?? '';
                  return (
                    <div key={v.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: 10, color: '#a0a0b0', fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>
                        {v.label ?? v.name}
                      </label>
                      <Control variable={v} value={val} onChange={(nv) => onChange(v.name, nv)} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Individual control renderers ────────────────────────────────────────────

interface ControlProps {
  variable: HyperframesVariable;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}

function Control({ variable: v, value, onChange }: ControlProps) {
  switch (v.type) {
    case 'color':   return <ColorControl value={String(value || '#ffffff')} onChange={onChange} />;
    case 'number':  return <NumberControl variable={v} value={Number(value ?? 0)} onChange={onChange} />;
    case 'boolean': return <BooleanControl value={Boolean(value)} onChange={onChange} />;
    case 'select':  return <SelectControl options={v.options ?? []} value={String(value)} onChange={onChange} />;
    case 'font':    return <FontControl value={String(value || 'Inter')} onChange={onChange} />;
    default:        return <StringControl value={String(value ?? '')} onChange={onChange} />;
  }
}

// ── Color ───────────────────────────────────────────────────────────────────
function ColorControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="color"
        value={value.startsWith('#') ? value : '#ffffff'}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 36, height: 28, padding: 2, border: '1px solid #333', borderRadius: 4, background: 'none', cursor: 'pointer', flexShrink: 0 }}
      />
      <input
        type="text" value={value}
        onChange={(e) => onChange(e.target.value)}
        style={textInputStyle}
        maxLength={30}
        placeholder="#ffffff, rgba(...), or transparent"
        spellCheck={false}
      />
    </div>
  );
}

// ── Number (typed input primary, slider secondary) ──────────────────────────
function NumberControl({ variable: v, value, onChange }: { variable: HyperframesVariable; value: number; onChange: (val: number) => void }) {
  const min  = v.min  ?? 0;
  const max  = v.max  ?? 500;
  const step = v.step ?? 1;
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;

  const handleText = (raw: string) => {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number" min={min} max={max} step={step}
          value={value.toFixed ? Number(value).toFixed(decimals) : value}
          onChange={(e) => handleText(e.target.value)}
          style={{ ...textInputStyle, width: 80, fontSize: 13, fontWeight: 600, textAlign: 'center', color: '#c8c4ff', flexShrink: 0 }}
        />
        <span style={{ fontSize: 10, color: '#505070' }}>{min}–{max}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#6c63ff', height: 4, cursor: 'pointer' }}
      />
    </div>
  );
}

// ── Boolean ─────────────────────────────────────────────────────────────────
function BooleanControl({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      style={{
        alignSelf: 'flex-start', width: 44, height: 24,
        borderRadius: 12, border: 'none', cursor: 'pointer',
        background: value ? '#6c63ff' : '#333',
        position: 'relative', transition: 'background 0.2s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: value ? 22 : 3,
        width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s',
      }} />
    </button>
  );
}

// ── Select ──────────────────────────────────────────────────────────────────
function SelectControl({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {options.map((opt) => (
        <button
          key={opt} type="button"
          onClick={() => onChange(opt)}
          style={{
            padding: '3px 10px', borderRadius: 4, border: '1px solid',
            borderColor: value === opt ? '#6c63ff' : '#333',
            background: value === opt ? '#6c63ff22' : 'transparent',
            color: value === opt ? '#a89fff' : '#888',
            fontSize: 12, cursor: 'pointer',
          }}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// ── String ──────────────────────────────────────────────────────────────────
function StringControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text" value={value}
      onChange={(e) => onChange(e.target.value)}
      style={textInputStyle} spellCheck={false}
    />
  );
}

// ── Font (Google Fonts picker) ──────────────────────────────────────────────
function FontControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <FontPicker value={value} onChange={onChange} />;
}

// ── Shared styles ───────────────────────────────────────────────────────────
const textInputStyle: React.CSSProperties = {
  background: '#1a1a2e', border: '1px solid #2a2a3a', borderRadius: 4,
  color: '#e0e0f0', fontSize: 12, padding: '4px 8px', width: '100%', outline: 'none',
};
