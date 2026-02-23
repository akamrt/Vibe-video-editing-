import React, { useState, useEffect } from 'react';
import type { SubtitleTemplate, TextAnimation, SubtitleStyle } from '../../types';
import AnimationControls from '../AnimationControls';

const STORAGE_KEY = 'vibecut_subtitle_templates';

interface TemplateManagerProps {
  currentSubtitleStyle: SubtitleStyle;
  activeTemplate: SubtitleTemplate | null;
  activeKeywordAnimation?: TextAnimation | null;
  onApplyToKeywords?: (animation: TextAnimation) => void;
  onClearKeywordAnimation?: () => void;
  onApply: (template: SubtitleTemplate) => void;
  onClear: () => void;
}

function loadTemplates(): SubtitleTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTemplates(templates: SubtitleTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

// ────── Preset Categories ──────

type PresetCategory = 'Subtle' | 'Dynamic' | 'Cinematic' | 'Playful' | 'Minimal';

interface PresetEntry {
  label: string;
  category: PresetCategory;
  description: string;
  value: Omit<TextAnimation, 'id' | 'name'>;
}

const PRESET_ANIMATIONS: PresetEntry[] = [
  // ── Subtle ──
  {
    label: 'Fade Up',
    category: 'Subtle',
    description: 'Gentle fade with upward slide, line by line',
    value: {
      duration: 1.5, scope: 'line', stagger: 0.2,
      effects: [
        { id: 'p1a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.6, easing: 'easeOut' },
        { id: 'p1b', type: 'translateY', from: 20, to: 0, startAt: 0, endAt: 0.6, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Soft Appear',
    category: 'Subtle',
    description: 'Simple opacity fade in, whole element',
    value: {
      duration: 1.0, scope: 'element', stagger: 0,
      effects: [
        { id: 'p2a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 1, easing: 'easeInOut' },
      ],
    },
  },
  {
    label: 'Slide In Left',
    category: 'Subtle',
    description: 'Words slide in from the left with fade',
    value: {
      duration: 1.8, scope: 'word', stagger: 0.08,
      effects: [
        { id: 'p3a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.5, easing: 'easeOut' },
        { id: 'p3b', type: 'translateX', from: -30, to: 0, startAt: 0, endAt: 0.6, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Rise & Settle',
    category: 'Subtle',
    description: 'Float upward with gentle scale, word by word',
    value: {
      duration: 2.0, scope: 'word', stagger: 0.1,
      effects: [
        { id: 'p4a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.4, easing: 'easeOut' },
        { id: 'p4b', type: 'translateY', from: 15, to: 0, startAt: 0, endAt: 0.7, easing: 'easeOut' },
        { id: 'p4c', type: 'scale', from: 0.9, to: 1, startAt: 0, endAt: 0.5, easing: 'easeOut' },
      ],
    },
  },

  // ── Dynamic ──
  {
    label: 'Pop Word',
    category: 'Dynamic',
    description: 'Each word pops in with elastic bounce',
    value: {
      duration: 2.0, scope: 'word', stagger: 0.15,
      effects: [
        { id: 'p5a', type: 'scale', from: 0, to: 1, startAt: 0, endAt: 0.5, easing: 'elastic', stiffness: 200, bounciness: 15 },
        { id: 'p5b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.3, easing: 'linear' },
      ],
    },
  },
  {
    label: 'Bounce Drop',
    category: 'Dynamic',
    description: 'Words drop from above with bounce',
    value: {
      duration: 2.5, scope: 'word', stagger: 0.12,
      effects: [
        { id: 'p6a', type: 'translateY', from: -50, to: 0, startAt: 0, endAt: 0.7, easing: 'bounce' },
        { id: 'p6b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.2, easing: 'linear' },
      ],
    },
  },
  {
    label: 'Spring Scale',
    category: 'Dynamic',
    description: 'Lines spring in from small to full size',
    value: {
      duration: 2.0, scope: 'line', stagger: 0.3,
      effects: [
        { id: 'p7a', type: 'scale', from: 0.3, to: 1, startAt: 0, endAt: 0.8, easing: 'spring', stiffness: 180, bounciness: 12 },
        { id: 'p7b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.25, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Whip In',
    category: 'Dynamic',
    description: 'Fast slide from right with overshoot',
    value: {
      duration: 1.5, scope: 'word', stagger: 0.06,
      effects: [
        { id: 'p8a', type: 'translateX', from: 80, to: 0, startAt: 0, endAt: 0.5, easing: 'spring', stiffness: 300, bounciness: 8 },
        { id: 'p8b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.15, easing: 'linear' },
      ],
    },
  },

  // ── Cinematic ──
  {
    label: 'Cinematic Blur',
    category: 'Cinematic',
    description: 'Words emerge from blur with expanded tracking',
    value: {
      duration: 2.5, scope: 'word', stagger: 0.3,
      effects: [
        { id: 'p9a', type: 'blur', from: 10, to: 0, startAt: 0, endAt: 1.0, easing: 'easeOut' },
        { id: 'p9b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.8, easing: 'easeIn' },
        { id: 'p9c', type: 'letterSpacing', from: 10, to: 0, startAt: 0, endAt: 1.0, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Focus Pull',
    category: 'Cinematic',
    description: 'Rack focus effect — blur in then sharp',
    value: {
      duration: 3.0, scope: 'line', stagger: 0.4,
      effects: [
        { id: 'p10a', type: 'blur', from: 15, to: 0, startAt: 0, endAt: 0.6, easing: 'easeInOut' },
        { id: 'p10b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.3, easing: 'easeIn' },
        { id: 'p10c', type: 'scale', from: 1.1, to: 1, startAt: 0, endAt: 0.8, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Title Card',
    category: 'Cinematic',
    description: 'Slow reveal with wide tracking, perfect for titles',
    value: {
      duration: 3.5, scope: 'element', stagger: 0,
      effects: [
        { id: 'p11a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.4, easing: 'easeIn' },
        { id: 'p11b', type: 'letterSpacing', from: 20, to: 2, startAt: 0, endAt: 0.8, easing: 'easeOut' },
        { id: 'p11c', type: 'scale', from: 0.95, to: 1, startAt: 0.2, endAt: 0.9, easing: 'easeInOut' },
      ],
    },
  },
  {
    label: 'Dramatic Zoom',
    category: 'Cinematic',
    description: 'Scale from large to normal with blur clear',
    value: {
      duration: 2.0, scope: 'element', stagger: 0,
      effects: [
        { id: 'p12a', type: 'scale', from: 2, to: 1, startAt: 0, endAt: 0.7, easing: 'easeOut' },
        { id: 'p12b', type: 'blur', from: 8, to: 0, startAt: 0, endAt: 0.5, easing: 'easeOut' },
        { id: 'p12c', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.3, easing: 'linear' },
      ],
    },
  },

  // ── Playful ──
  {
    label: 'Typewriter',
    category: 'Playful',
    description: 'Characters appear one at a time',
    value: {
      duration: 3.0, scope: 'character', stagger: 0.05,
      effects: [
        { id: 'p13a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.1, easing: 'linear' },
      ],
    },
  },
  {
    label: 'Wobble In',
    category: 'Playful',
    description: 'Characters rotate in with spring wobble',
    value: {
      duration: 2.5, scope: 'character', stagger: 0.04,
      effects: [
        { id: 'p14a', type: 'rotate', from: -15, to: 0, startAt: 0, endAt: 0.7, easing: 'spring', stiffness: 150, bounciness: 14 },
        { id: 'p14b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.2, easing: 'linear' },
        { id: 'p14c', type: 'translateY', from: -10, to: 0, startAt: 0, endAt: 0.5, easing: 'spring', stiffness: 150, bounciness: 14 },
      ],
    },
  },
  {
    label: 'Scatter',
    category: 'Playful',
    description: 'Characters fly in from scattered positions',
    value: {
      duration: 2.0, scope: 'character', stagger: 0.03,
      effects: [
        { id: 'p15a', type: 'translateX', from: -40, to: 0, startAt: 0, endAt: 0.6, easing: 'elastic', stiffness: 120, bounciness: 10 },
        { id: 'p15b', type: 'translateY', from: 30, to: 0, startAt: 0, endAt: 0.5, easing: 'easeOut' },
        { id: 'p15c', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.2, easing: 'linear' },
        { id: 'p15d', type: 'rotate', from: 20, to: 0, startAt: 0, endAt: 0.4, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Grow Up',
    category: 'Playful',
    description: 'Each word grows from zero with bounce',
    value: {
      duration: 2.0, scope: 'word', stagger: 0.18,
      effects: [
        { id: 'p16a', type: 'scale', from: 0, to: 1, startAt: 0, endAt: 0.6, easing: 'bounce' },
        { id: 'p16b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.15, easing: 'linear' },
      ],
    },
  },

  // ── Minimal ──
  {
    label: 'Fade Only',
    category: 'Minimal',
    description: 'Clean fade, no movement',
    value: {
      duration: 0.8, scope: 'element', stagger: 0,
      effects: [
        { id: 'p17a', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 1, easing: 'easeOut' },
      ],
    },
  },
  {
    label: 'Quick Pop',
    category: 'Minimal',
    description: 'Fast scale-in for snappy text',
    value: {
      duration: 0.5, scope: 'element', stagger: 0,
      effects: [
        { id: 'p18a', type: 'scale', from: 0.85, to: 1, startAt: 0, endAt: 1, easing: 'easeOut' },
        { id: 'p18b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.6, easing: 'linear' },
      ],
    },
  },
  {
    label: 'Slide Down',
    category: 'Minimal',
    description: 'Subtle slide from above',
    value: {
      duration: 1.0, scope: 'element', stagger: 0,
      effects: [
        { id: 'p19a', type: 'translateY', from: -12, to: 0, startAt: 0, endAt: 0.8, easing: 'easeOut' },
        { id: 'p19b', type: 'opacity', from: 0, to: 1, startAt: 0, endAt: 0.5, easing: 'easeOut' },
      ],
    },
  },
];

const CATEGORIES: PresetCategory[] = ['Subtle', 'Dynamic', 'Cinematic', 'Playful', 'Minimal'];

const CATEGORY_COLORS: Record<PresetCategory, string> = {
  Subtle: '#6ee7b7',
  Dynamic: '#f59e0b',
  Cinematic: '#a78bfa',
  Playful: '#f472b6',
  Minimal: '#9ca3af',
};

// ────── Component ──────

const TemplateManager: React.FC<TemplateManagerProps> = ({
  currentSubtitleStyle,
  activeTemplate,
  activeKeywordAnimation,
  onApplyToKeywords,
  onClearKeywordAnimation,
  onApply,
  onClear,
}) => {
  const [templates, setTemplates] = useState<SubtitleTemplate[]>([]);
  const [newName, setNewName] = useState('');
  const [selectedPresetIdx, setSelectedPresetIdx] = useState(0);
  const [activeCategory, setActiveCategory] = useState<PresetCategory | 'All'>('All');
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(true);

  useEffect(() => {
    setTemplates(loadTemplates());
  }, []);

  const filteredPresets = activeCategory === 'All'
    ? PRESET_ANIMATIONS
    : PRESET_ANIMATIONS.filter(p => p.category === activeCategory);

  const handleSave = () => {
    const name = newName.trim();
    if (!name) return;
    const baseAnim = PRESET_ANIMATIONS[selectedPresetIdx].value;
    const template: SubtitleTemplate = {
      id: `tmpl_${Date.now()}`,
      name,
      style: {
        fontFamily: currentSubtitleStyle.fontFamily,
        fontSize: currentSubtitleStyle.fontSize,
        color: currentSubtitleStyle.color,
        fontWeight: currentSubtitleStyle.bold ? 'bold' : 'normal',
        fontStyle: currentSubtitleStyle.italic ? 'italic' : 'normal',
        backgroundColor: currentSubtitleStyle.backgroundType !== 'none'
          ? currentSubtitleStyle.backgroundColor
          : 'transparent',
        borderRadius: currentSubtitleStyle.boxBorderRadius,
        textAlign: currentSubtitleStyle.textAlign,
      },
      animation: { ...baseAnim, id: `anim_${Date.now()}`, name: `${name} Animation` },
    };
    const updated = [...templates, template];
    setTemplates(updated);
    saveTemplates(updated);
    setNewName('');
  };

  const handleQuickApply = (preset: PresetEntry) => {
    const template: SubtitleTemplate = {
      id: `preset_live_${Date.now()}`,
      name: preset.label,
      style: {
        fontFamily: currentSubtitleStyle.fontFamily,
        fontSize: currentSubtitleStyle.fontSize,
        color: currentSubtitleStyle.color,
        fontWeight: currentSubtitleStyle.bold ? 'bold' : 'normal',
        fontStyle: currentSubtitleStyle.italic ? 'italic' : 'normal',
        backgroundColor: currentSubtitleStyle.backgroundType !== 'none'
          ? currentSubtitleStyle.backgroundColor
          : 'transparent',
        borderRadius: currentSubtitleStyle.boxBorderRadius,
        textAlign: currentSubtitleStyle.textAlign,
      },
      animation: { ...preset.value, id: `anim_${Date.now()}`, name: `${preset.label} Animation` },
    };
    onApply(template);
  };

  const handleDelete = (id: string) => {
    const updated = templates.filter(t => t.id !== id);
    setTemplates(updated);
    saveTemplates(updated);
    if (activeTemplate?.id === id) onClear();
    if (editingTemplate === id) setEditingTemplate(null);
  };

  const handleUpdateAnimation = (templateId: string, anim: TextAnimation) => {
    const updated = templates.map(t => t.id === templateId ? { ...t, animation: anim } : t);
    setTemplates(updated);
    saveTemplates(updated);
    if (activeTemplate?.id === templateId) {
      onApply({ ...activeTemplate, animation: anim });
    }
  };

  const scopeIcon = (scope: string) => {
    switch (scope) {
      case 'element': return '\u25A0'; // ■
      case 'line': return '\u2261';    // ≡
      case 'word': return 'W';
      case 'character': return 'A';
      default: return '?';
    }
  };

  return (
    <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflowY: 'auto' }}>
      {/* ── Keyword Animation Indicator ── */}
      {activeKeywordAnimation && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
          background: '#f59e0b15', border: '1px solid #f59e0b40', borderRadius: 5,
        }}>
          <span style={{ fontSize: 9, fontWeight: 700, color: '#f59e0b' }}>KW FX:</span>
          <span style={{ fontSize: 10, color: '#fbbf24', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeKeywordAnimation.name || 'Custom'}
          </span>
          {onClearKeywordAnimation && (
            <span
              onClick={onClearKeywordAnimation}
              style={{ fontSize: 9, color: '#9ca3af', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, background: '#333' }}
            >
              Clear
            </span>
          )}
        </div>
      )}

      {/* ── Section: Preset Gallery ── */}
      <div>
        <div
          onClick={() => setShowPresets(!showPresets)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', marginBottom: 6 }}
        >
          <span style={{ fontSize: 8, color: '#4f46e5', transform: showPresets ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
            &#9654;
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>
            Preset Gallery ({PRESET_ANIMATIONS.length})
          </span>
        </div>

        {showPresets && (
          <>
            {/* Category filter tabs */}
            <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: 6 }}>
              <button
                onClick={() => setActiveCategory('All')}
                style={{
                  padding: '2px 8px', borderRadius: 10, border: 'none', fontSize: 9, fontWeight: 600,
                  background: activeCategory === 'All' ? '#4f46e5' : '#2a2a2a',
                  color: activeCategory === 'All' ? '#fff' : '#6b7280', cursor: 'pointer',
                }}
              >All</button>
              {CATEGORIES.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  style={{
                    padding: '2px 8px', borderRadius: 10, border: 'none', fontSize: 9, fontWeight: 600,
                    background: activeCategory === cat ? '#4f46e5' : '#2a2a2a',
                    color: activeCategory === cat ? '#fff' : CATEGORY_COLORS[cat], cursor: 'pointer',
                  }}
                >{cat}</button>
              ))}
            </div>

            {/* Preset grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, maxHeight: 200, overflowY: 'auto', paddingRight: 2 }}>
              {filteredPresets.map((preset, i) => {
                const isActive = activeTemplate?.name === preset.label && activeTemplate?.id.startsWith('preset_live');
                return (
                  <div
                    key={i}
                    onClick={() => handleQuickApply(preset)}
                    title={preset.description}
                    style={{
                      padding: '5px 7px', borderRadius: 5, cursor: 'pointer',
                      background: isActive ? '#4f46e520' : '#1e1e1e',
                      border: `1px solid ${isActive ? '#4f46e5' : '#333'}`,
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 9, color: CATEGORY_COLORS[preset.category], fontWeight: 700, width: 12, textAlign: 'center' }}>
                        {scopeIcon(preset.value.scope)}
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#e5e7eb', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {preset.label}
                      </span>
                      {onApplyToKeywords && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            onApplyToKeywords({ ...preset.value, id: `kw_${Date.now()}`, name: `${preset.label} (KW)`, scope: 'word' });
                          }}
                          title="Apply to keywords only"
                          style={{
                            fontSize: 8, fontWeight: 700, color: activeKeywordAnimation?.name === `${preset.label} (KW)` ? '#f59e0b' : '#9ca3af',
                            background: activeKeywordAnimation?.name === `${preset.label} (KW)` ? '#f59e0b20' : '#333',
                            padding: '1px 4px', borderRadius: 3, cursor: 'pointer',
                            border: `1px solid ${activeKeywordAnimation?.name === `${preset.label} (KW)` ? '#f59e0b50' : '#444'}`,
                          }}
                        >
                          KW
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 8, color: '#6b7280', marginTop: 2, lineHeight: 1.2 }}>
                      {preset.value.effects.length} effect{preset.value.effects.length !== 1 ? 's' : ''} &middot; {preset.value.scope} &middot; {preset.value.duration}s
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── Section: Saved Templates ── */}
      <div style={{ borderTop: '1px solid #333', paddingTop: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
          Saved Templates ({templates.length})
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflowY: 'auto' }}>
          {templates.length === 0 && (
            <div style={{ fontSize: 10, color: '#4b5563', textAlign: 'center', padding: 12 }}>
              No saved templates. Use presets above or save your own below.
            </div>
          )}
          {templates.map(t => {
            const isActive = activeTemplate?.id === t.id;
            const isEditing = editingTemplate === t.id;

            return (
              <div key={t.id}>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '5px 7px', borderRadius: 5,
                    background: isActive ? '#4f46e5' : '#2a2a2a',
                    border: `1px solid ${isEditing ? '#a78bfa' : 'transparent'}`,
                    cursor: 'pointer', fontSize: 11, color: '#e5e7eb',
                  }}
                  onClick={() => onApply(t)}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                    <span style={{ fontSize: 9, color: isActive ? '#c4b5fd' : '#6b7280', marginLeft: 4 }}>
                      {t.animation?.scope || 'custom'} &middot; {t.animation?.effects?.length || 0} fx
                    </span>
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); setEditingTemplate(isEditing ? null : t.id); }}
                    title="Edit animation"
                    style={{
                      background: 'none', border: 'none',
                      color: isEditing ? '#a78bfa' : '#6b7280',
                      cursor: 'pointer', fontSize: 11, padding: '0 3px',
                    }}
                  >&#9998;</button>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(t.id); }}
                    title="Delete"
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 13, padding: '0 2px', lineHeight: 1 }}
                  >&times;</button>
                </div>

                {/* Inline animation editor */}
                {isEditing && t.animation && (
                  <div style={{ padding: '6px 4px 8px', borderLeft: '2px solid #4f46e5', marginLeft: 8, marginTop: 2 }}>
                    <AnimationControls
                      animation={t.animation}
                      onChange={(anim) => handleUpdateAnimation(t.id, anim)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Active indicator ── */}
      {activeTemplate && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
          background: '#4f46e510', borderRadius: 5, border: '1px solid #4f46e540',
        }}>
          <span style={{ fontSize: 10, color: '#a78bfa', flex: 1 }}>
            Active: <strong>{activeTemplate.name}</strong>
          </span>
          <button
            onClick={onClear}
            style={{
              background: 'none', border: '1px solid #6b7280', color: '#9ca3af',
              borderRadius: 4, fontSize: 9, cursor: 'pointer', padding: '1px 8px',
            }}
          >Clear</button>
        </div>
      )}

      {/* ── Save New Template ── */}
      <div style={{ borderTop: '1px solid #333', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>
          Save Custom Template
        </div>
        <input
          type="text"
          placeholder="Template name..."
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
          style={{
            background: '#1e1e1e', border: '1px solid #444', borderRadius: 4,
            padding: '4px 8px', fontSize: 11, color: '#e5e7eb', outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <select
            value={selectedPresetIdx}
            onChange={e => setSelectedPresetIdx(Number(e.target.value))}
            style={{
              flex: 1, background: '#1e1e1e', border: '1px solid #444', borderRadius: 4,
              padding: '3px 6px', fontSize: 10, color: '#e5e7eb',
            }}
          >
            {PRESET_ANIMATIONS.map((p, i) => (
              <option key={i} value={i}>[{p.category}] {p.label}</option>
            ))}
          </select>
          <button
            onClick={handleSave}
            disabled={!newName.trim()}
            style={{
              padding: '4px 10px', borderRadius: 4, border: 'none',
              fontSize: 11, fontWeight: 600,
              cursor: newName.trim() ? 'pointer' : 'not-allowed',
              background: newName.trim() ? '#4f46e5' : '#333',
              color: newName.trim() ? '#fff' : '#6b7280',
            }}
          >Save</button>
        </div>
      </div>
    </div>
  );
};

export default TemplateManager;
