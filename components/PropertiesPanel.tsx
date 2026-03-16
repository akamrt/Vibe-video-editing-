import React, { useState } from 'react';
import { Segment, Transition, TransitionType, TransitionEasing, VideoAnalysis, SubtitleStyle, TitleLayer, TitleStyle, SubtitleTemplate, TextAnimation, KeywordEmphasis, GradientStop } from '../types';
import { migrateGradientColors } from '../utils/gradientUtils';
import { TRANSITION_CATALOG, TRANSITION_CATEGORIES, getTransitionDef } from '../utils/transitionCatalog';
import AnimationControls from './AnimationControls';
import GradientEditor from './GradientEditor';
import FontPicker from './FontPicker';

interface PropertiesPanelProps {
  selectedSegment: Segment | null;
  selectedTransition: { segId: string; side: 'in' | 'out' } | null;
  selectedDialogue?: { mediaId: string; index: number } | null;
  selectedDialogueText?: string | null;
  subtitleStyle?: SubtitleStyle;
  isSubtitleUnlinked?: boolean;
  mediaAnalysis?: VideoAnalysis | null;
  isTitleSelected?: boolean;
  titleLayer?: TitleLayer | null;
  activeSubtitleTemplate?: SubtitleTemplate | null;
  onUpdateSegment: (seg: Segment) => void;
  onUpdateTransition: (segId: string, side: 'in' | 'out', transition: Transition | undefined) => void;
  onUpdateDialogueText?: (text: string) => void;
  onUpdateSubtitleStyle?: (style: Partial<SubtitleStyle>) => void;
  onToggleSubtitleUnlink?: () => void;
  onUpdateTitleLayer?: (updates: Partial<TitleLayer>) => void;
  onUpdateSubtitleTemplate?: (template: SubtitleTemplate) => void;
  isTemplateUnlinked?: boolean;
  onToggleTemplateUnlink?: () => void;
  onAnalyze?: (mediaId: string, prompt: string) => void;
  isProcessing?: boolean;
  wordEmphases?: KeywordEmphasis[];
  onUpdateWordEmphases?: (emphases: KeywordEmphasis[]) => void;
  activeKeywordAnimation?: TextAnimation | null;
  onUpdateKeywordAnimation?: (animation: TextAnimation | null) => void;
  currentVolume?: number; // Interpolated volume at current playback position (0-1)
  onAddVolumeKey?: (segId: string, volume: number) => void;
}

const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion'
];

const LAYER_BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity'
];

const Accordion: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({ title, defaultOpen = true, children }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-[#2a2a2a] rounded-lg shadow-sm bg-[#1a1a1a] overflow-hidden transition-all duration-300">
      <button
        className="w-full flex items-center justify-between p-3 bg-[#222] hover:bg-[#282828] transition-colors border-b border-transparent focus:outline-none"
        onClick={() => setIsOpen(!isOpen)}
        style={{ borderBottomColor: isOpen ? '#2a2a2a' : 'transparent' }}
      >
        <span className="text-[11px] font-bold text-gray-300 uppercase tracking-wider">{title}</span>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="p-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
          {children}
        </div>
      )}
    </div>
  );
};

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="space-y-2">
    <div className="text-[10px] font-bold text-indigo-400/80 uppercase tracking-widest">{title}</div>
    <div className="space-y-3">{children}</div>
  </div>
);

const Field: React.FC<{ label: string; rightLabel?: React.ReactNode; children: React.ReactNode; stack?: boolean }> = ({ label, rightLabel, children, stack = false }) => (
  <div className={`flex ${stack ? 'flex-col gap-1.5' : 'items-center justify-between gap-3'}`}>
    <div className="flex justify-between items-center w-full">
      <label className="text-[11px] text-gray-400 font-medium">{label}</label>
      {rightLabel && <div className="text-[10px] text-gray-500 font-mono">{rightLabel}</div>}
    </div>
    <div className={stack ? 'w-full' : 'flex-1 max-w-[65%]'}>{children}</div>
  </div>
);

const ColorPicker: React.FC<{ value: string; onChange: (val: string) => void }> = ({ value, onChange }) => (
  <div className="flex items-center gap-2 bg-[#121212] border border-[#333] rounded px-2 py-1 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500/50 transition-all">
    <input
      type="color"
      value={value || '#ffffff'}
      onChange={(e) => onChange(e.target.value)}
      className="w-5 h-5 bg-transparent border-none cursor-pointer rounded-sm color-picker-swatch"
    />
    <input
      type="text"
      value={value || '#ffffff'}
      onChange={(e) => onChange(e.target.value)}
      className="bg-transparent border-none text-[11px] text-gray-300 font-mono w-full focus:outline-none uppercase"
    />
  </div>
);


const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedSegment,
  selectedTransition,
  selectedDialogue,
  selectedDialogueText,
  subtitleStyle,
  isSubtitleUnlinked,
  mediaAnalysis,
  isTitleSelected,
  titleLayer,
  activeSubtitleTemplate,
  onUpdateSegment,
  onUpdateTransition,
  onUpdateDialogueText,
  onUpdateSubtitleStyle,
  onToggleSubtitleUnlink,
  onUpdateTitleLayer,
  onUpdateSubtitleTemplate,
  isTemplateUnlinked,
  onToggleTemplateUnlink,
  onAnalyze,
  isProcessing,
  wordEmphases,
  onUpdateWordEmphases,
  activeKeywordAnimation,
  onUpdateKeywordAnimation,
  currentVolume,
  onAddVolumeKey,
}) => {
  const [analysisFocus, setAnalysisFocus] = useState('');
  const [volumeSlider, setVolumeSlider] = useState(100);

  if (!selectedSegment && !selectedTransition && !selectedDialogue && !isTitleSelected) {
    return (
      <div className="h-full bg-[#151515] p-5 flex flex-col items-center justify-center text-center border-l border-[#222]">
        <div className="w-12 h-12 mb-3 rounded-full bg-[#222] flex items-center justify-center border border-[#333]">
          <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
        </div>
        <p className="text-sm font-medium text-gray-300">No Selection</p>
        <p className="text-xs text-gray-500 mt-1">Select a clip, transition, title, or dialogue bubble to view properties.</p>
      </div>
    );
  }

  const currentTransition = selectedTransition && selectedSegment
    ? (selectedTransition.side === 'in' ? selectedSegment.transitionIn : selectedSegment.transitionOut)
    : null;

  const handleTransitionChange = (updates: Partial<Transition>) => {
    if (!selectedSegment || !selectedTransition) return;
    const newTrans = {
      type: 'FADE' as TransitionType,
      duration: 0.5,
      blendMode: 'normal',
      color: '#000000',
      ...currentTransition,
      ...updates
    };
    onUpdateTransition(selectedTransition.segId, selectedTransition.side, newTrans);
  };

  const removeTransition = () => {
    if (!selectedSegment || !selectedTransition) return;
    onUpdateTransition(selectedTransition.segId, selectedTransition.side, undefined);
  };

  const handleTitleStyleUpdate = (updates: Partial<TitleStyle>) => {
    if (!onUpdateTitleLayer || !titleLayer) return;
    onUpdateTitleLayer({ style: { ...titleLayer.style!, ...updates } });
  };

  const inputClass = "w-full bg-[#121212] border border-[#333] rounded text-[11px] text-white p-2 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 outline-none transition-all";
  const rangeClass = "w-full accent-indigo-500 h-1.5 bg-[#333] rounded-lg appearance-none cursor-pointer";

  return (
    <div className="h-full bg-[#151515] flex flex-col font-sans border-l border-[#222]">
      <div className="p-4 border-b border-[#222] bg-[#1a1a1a] flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-300 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse"></span>
          {selectedTransition ? 'Transition' : selectedDialogue ? 'Subtitle' : isTitleSelected ? 'Title' : 'Clip'} Properties
        </h2>
      </div>

      <div className="p-4 space-y-4 overflow-y-auto flex-1 pb-20">

        {/* SUBTITLE MODE */}
        {selectedDialogue && subtitleStyle && onUpdateDialogueText && onUpdateSubtitleStyle && (
          <div className="space-y-4">
            <Accordion title="Content" defaultOpen={true}>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-[11px] text-gray-400 font-medium">Text Content</label>
                  {onToggleSubtitleUnlink && (
                    <label className="flex items-center gap-1.5 cursor-pointer bg-[#222] px-2 py-1 rounded border border-[#333] hover:border-indigo-500 transition-colors">
                      <input type="checkbox" checked={!!isSubtitleUnlinked} onChange={onToggleSubtitleUnlink} className="rounded bg-[#111] border-[#444] text-indigo-500 focus:ring-0 w-3 h-3" />
                      <span className={`text-[9px] font-bold uppercase ${isSubtitleUnlinked ? 'text-indigo-400' : 'text-gray-500'}`}>Unlink Style</span>
                    </label>
                  )}
                </div>
                <textarea
                  value={selectedDialogueText || ''}
                  onChange={(e) => onUpdateDialogueText(e.target.value)}
                  className={`${inputClass} min-h-[80px] text-sm`}
                  placeholder="Edit subtitle text..."
                />
              </div>
            </Accordion>

            <Accordion title="Typography" defaultOpen={true}>
              <div className="space-y-4">
                <div className="flex gap-3">
                  <Field label="Font" stack={true}>
                    <FontPicker value={subtitleStyle.fontFamily} onChange={(f) => onUpdateSubtitleStyle({ fontFamily: f })} />
                  </Field>
                  <div className="w-20">
                    <Field label="Size" stack={true}>
                      <input type="number" value={subtitleStyle.fontSize} onChange={(e) => onUpdateSubtitleStyle({ fontSize: parseInt(e.target.value) })} className={inputClass} />
                    </Field>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button onClick={() => onUpdateSubtitleStyle({ bold: !subtitleStyle.bold })} className={`flex-1 py-1.5 rounded text-[11px] font-medium transition-colors border ${subtitleStyle.bold ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-[#222] border-[#333] text-gray-400 hover:bg-[#2a2a2a]'}`}>Bold</button>
                  <button onClick={() => onUpdateSubtitleStyle({ italic: !subtitleStyle.italic })} className={`flex-1 py-1.5 rounded text-[11px] font-medium transition-colors border ${subtitleStyle.italic ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-[#222] border-[#333] text-gray-400 hover:bg-[#2a2a2a]'}`}>Italic</button>
                </div>

                <div className="flex bg-[#222] p-1 rounded border border-[#333]">
                  {([
                    { value: 'none' as const, label: 'Aa' },
                    { value: 'uppercase' as const, label: 'AA' },
                    { value: 'lowercase' as const, label: 'aa' },
                    { value: 'capitalize' as const, label: 'Ab' },
                  ]).map(opt => (
                    <button key={opt.value} onClick={() => onUpdateSubtitleStyle({ textTransform: opt.value })} className={`flex-1 py-1.5 rounded text-[10px] font-bold transition-colors ${(subtitleStyle.textTransform || 'none') === opt.value ? 'bg-[#333] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}>{opt.label}</button>
                  ))}
                </div>

                <div className="flex bg-[#222] p-1 rounded border border-[#333]">
                  {['left', 'center', 'right'].map((align: any) => (
                    <button key={align} onClick={() => onUpdateSubtitleStyle({ textAlign: align })} className={`flex-1 py-1.5 rounded text-[10px] font-bold uppercase transition-colors ${subtitleStyle.textAlign === align ? 'bg-[#333] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}>
                      {align}
                    </button>
                  ))}
                </div>

                <Field label="Text Color" stack={true}>
                  <ColorPicker value={subtitleStyle.color || '#ffffff'} onChange={(v) => onUpdateSubtitleStyle({ color: v })} />
                </Field>
              </div>
            </Accordion>

            <Accordion title="Background" defaultOpen={false}>
              <div className="space-y-5">
                <Field label="Style" stack={true}>
                  <select value={subtitleStyle.backgroundType} onChange={(e) => onUpdateSubtitleStyle({ backgroundType: e.target.value as any })} className={inputClass}>
                    <option value="none">None / Transparent</option>
                    <option value="outline">Text Outline</option>
                    <option value="box">Solid Box</option>
                    <option value="rounded">Rounded Box</option>
                    <option value="stripe">Full Width Stripe</option>
                  </select>
                </Field>

                {subtitleStyle.backgroundType !== 'none' && subtitleStyle.backgroundType !== 'outline' && (
                  <>
                    <Field label="Color" stack={true}>
                      <ColorPicker value={subtitleStyle.backgroundColor || '#000000'} onChange={(v) => onUpdateSubtitleStyle({ backgroundColor: v })} />
                    </Field>

                    <Field label="Opacity" rightLabel={`${Math.round(subtitleStyle.backgroundOpacity * 100)}%`} stack={true}>
                      <input type="range" min="0" max="1" step="0.05" value={subtitleStyle.backgroundOpacity} onChange={(e) => onUpdateSubtitleStyle({ backgroundOpacity: parseFloat(e.target.value) })} className={rangeClass} />
                    </Field>
                  </>
                )}

                {(subtitleStyle.backgroundType === 'box' || subtitleStyle.backgroundType === 'rounded' || subtitleStyle.backgroundType === 'stripe') && (
                  <Group title="Borders">
                    <Field label="Border Color" stack={true}>
                      <ColorPicker value={subtitleStyle.boxBorderColor || '#ffffff'} onChange={(v) => onUpdateSubtitleStyle({ boxBorderColor: v })} />
                    </Field>
                    <Field label="Border Width" rightLabel={`${subtitleStyle.boxBorderWidth || 0}px`} stack={true}>
                      <input type="range" min="0" max="20" step="1" value={subtitleStyle.boxBorderWidth || 0} onChange={(e) => onUpdateSubtitleStyle({ boxBorderWidth: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    {subtitleStyle.backgroundType === 'rounded' && (
                      <Field label="Corner Radius" rightLabel={`${subtitleStyle.boxBorderRadius || 0}px`} stack={true}>
                        <input type="range" min="0" max="50" step="1" value={subtitleStyle.boxBorderRadius || 0} onChange={(e) => onUpdateSubtitleStyle({ boxBorderRadius: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                    )}
                  </Group>
                )}

                {subtitleStyle.backgroundType === 'outline' && (
                  <Group title="Stroke Settings">
                    <Field label="Outline Color" stack={true}>
                      <ColorPicker value={subtitleStyle.outlineColor || '#000000'} onChange={(v) => onUpdateSubtitleStyle({ outlineColor: v })} />
                    </Field>
                    <Field label="Stroke Width" rightLabel={`${subtitleStyle.outlineWidth || 2}px`} stack={true}>
                      <input type="range" min="1" max="10" step="1" value={subtitleStyle.outlineWidth || 2} onChange={(e) => onUpdateSubtitleStyle({ outlineWidth: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                  </Group>
                )}

                {(subtitleStyle.backgroundType === 'box' || subtitleStyle.backgroundType === 'rounded' || subtitleStyle.backgroundType === 'stripe') && (
                  <Group title="Backdrop Effects">
                    <Field label="Backdrop Blend" stack={true}>
                      <select value={subtitleStyle.backdropBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ backdropBlendMode: e.target.value })} className={inputClass}>
                        {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                      </select>
                    </Field>
                    <div className="grid grid-cols-2 gap-4 pt-2">
                      <Field label="Drop Shadow" stack={true}>
                        <ColorPicker value={subtitleStyle.backdropShadowColor || '#000000'} onChange={(v) => onUpdateSubtitleStyle({ backdropShadowColor: v })} />
                      </Field>
                      <Field label="Outer Glow" stack={true}>
                        <ColorPicker value={subtitleStyle.backdropGlowColor || '#00ff00'} onChange={(v) => onUpdateSubtitleStyle({ backdropGlowColor: v })} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Shadow Blend" stack={true}>
                        <select value={subtitleStyle.backdropShadowBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ backdropShadowBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                      <Field label="Glow Blend" stack={true}>
                        <select value={subtitleStyle.backdropGlowBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ backdropGlowBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </div>

                    <div className="space-y-4 pt-2">
                      <Field label="Shadow Blur" rightLabel={`${subtitleStyle.backdropShadowBlur || 0}px`} stack={true}>
                        <input type="range" min="0" max="20" step="1" value={subtitleStyle.backdropShadowBlur || 0} onChange={(e) => onUpdateSubtitleStyle({ backdropShadowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Shadow X Offset" rightLabel={`${subtitleStyle.backdropShadowOffsetX || 0}px`} stack={true}>
                        <input type="range" min="-20" max="20" step="1" value={subtitleStyle.backdropShadowOffsetX || 0} onChange={(e) => onUpdateSubtitleStyle({ backdropShadowOffsetX: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Shadow Y Offset" rightLabel={`${subtitleStyle.backdropShadowOffsetY || 0}px`} stack={true}>
                        <input type="range" min="-20" max="20" step="1" value={subtitleStyle.backdropShadowOffsetY || 0} onChange={(e) => onUpdateSubtitleStyle({ backdropShadowOffsetY: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <div className="border-t border-[#2a2a2a] pt-3"></div>
                      <Field label="Glow Amount" rightLabel={`${subtitleStyle.backdropGlowBlur || 0}px`} stack={true}>
                        <input type="range" min="0" max="50" step="1" value={subtitleStyle.backdropGlowBlur || 0} onChange={(e) => onUpdateSubtitleStyle({ backdropGlowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <div className="border-t border-[#2a2a2a] pt-3"></div>
                      <Field label="Inner Glow" stack={true}>
                        <ColorPicker value={subtitleStyle.innerGlowColor || '#ffffff'} onChange={(v) => onUpdateSubtitleStyle({ innerGlowColor: v })} />
                      </Field>
                      <Field label="Inner Glow Blur" rightLabel={`${subtitleStyle.innerGlowBlur || 0}px`} stack={true}>
                        <input type="range" min="0" max="30" step="1" value={subtitleStyle.innerGlowBlur || 0} onChange={(e) => onUpdateSubtitleStyle({ innerGlowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Inner Glow Blend" stack={true}>
                        <select value={subtitleStyle.innerGlowBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ innerGlowBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </div>
                  </Group>
                )}
              </div>
            </Accordion>

            <Accordion title="Text Effects" defaultOpen={false}>
              <div className="space-y-6">
                <Group title="Gradients">
                  <Field label="Type" stack={true}>
                    <select value={subtitleStyle.gradientType || 'none'} onChange={(e) => {
                      const type = e.target.value as any;
                      if (type !== 'none' && !subtitleStyle.gradientStops && (!subtitleStyle.gradientColors || subtitleStyle.gradientColors.length === 0)) {
                        onUpdateSubtitleStyle({ gradientType: type, gradientStops: [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 100 }] });
                      } else {
                        onUpdateSubtitleStyle({ gradientType: type });
                      }
                    }} className={inputClass}>
                      <option value="none">None</option>
                      <option value="linear">Linear</option>
                      <option value="radial">Radial</option>
                    </select>
                  </Field>
                  {subtitleStyle.gradientType && subtitleStyle.gradientType !== 'none' && (
                    <>
                      <GradientEditor
                        stops={subtitleStyle.gradientStops || (subtitleStyle.gradientColors ? migrateGradientColors(subtitleStyle.gradientColors) : [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 100 }])}
                        type={subtitleStyle.gradientType as 'linear' | 'radial'}
                        angle={subtitleStyle.gradientAngle || 0}
                        onChange={(stops) => onUpdateSubtitleStyle({ gradientStops: stops, gradientColors: [stops[0].color, stops[stops.length - 1].color] })}
                        onTypeChange={(type) => onUpdateSubtitleStyle({ gradientType: type })}
                        onAngleChange={(angle) => onUpdateSubtitleStyle({ gradientAngle: angle })}
                      />
                      <Field label="Gradient Blend" stack={true}>
                        <select value={subtitleStyle.gradientBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ gradientBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </>
                  )}
                </Group>

                <Group title="Shadow & Glow">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Drop Shadow" stack={true}>
                      <ColorPicker value={subtitleStyle.textShadowColor || '#000000'} onChange={(v) => onUpdateSubtitleStyle({ textShadowColor: v })} />
                    </Field>
                    <Field label="Outer Glow" stack={true}>
                      <ColorPicker value={subtitleStyle.glowColor || '#00ff00'} onChange={(v) => onUpdateSubtitleStyle({ glowColor: v })} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Shadow Blend" stack={true}>
                      <select value={subtitleStyle.shadowBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ shadowBlendMode: e.target.value })} className={inputClass}>
                        {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                      </select>
                    </Field>
                    <Field label="Glow Blend" stack={true}>
                      <select value={subtitleStyle.glowBlendMode || 'normal'} onChange={(e) => onUpdateSubtitleStyle({ glowBlendMode: e.target.value })} className={inputClass}>
                        {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                      </select>
                    </Field>
                  </div>

                  <div className="space-y-4 pt-2">
                    <Field label="Shadow Blur" rightLabel={`${subtitleStyle.textShadowBlur || 0}px`} stack={true}>
                      <input type="range" min="0" max="20" step="1" value={subtitleStyle.textShadowBlur || 0} onChange={(e) => onUpdateSubtitleStyle({ textShadowBlur: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    <Field label="Shadow X Offset" rightLabel={`${subtitleStyle.textShadowOffsetX || 0}px`} stack={true}>
                      <input type="range" min="-20" max="20" step="1" value={subtitleStyle.textShadowOffsetX || 0} onChange={(e) => onUpdateSubtitleStyle({ textShadowOffsetX: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    <Field label="Shadow Y Offset" rightLabel={`${subtitleStyle.textShadowOffsetY || 0}px`} stack={true}>
                      <input type="range" min="-20" max="20" step="1" value={subtitleStyle.textShadowOffsetY || 0} onChange={(e) => onUpdateSubtitleStyle({ textShadowOffsetY: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    <div className="border-t border-[#2a2a2a] pt-3"></div>
                    <Field label="Glow Amount" rightLabel={`${subtitleStyle.glowBlur || 0}px`} stack={true}>
                      <input type="range" min="0" max="50" step="1" value={subtitleStyle.glowBlur || 0} onChange={(e) => onUpdateSubtitleStyle({ glowBlur: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                  </div>
                </Group>
              </div>
            </Accordion>

            <Accordion title="Word Highlight" defaultOpen={false}>
              <div className="space-y-4">
                {/* Enable toggle */}
                <Field label="Enable Word Highlight" stack={false}>
                  <label className="relative inline-flex items-center cursor-pointer ml-auto">
                    <input
                      type="checkbox"
                      checked={!!subtitleStyle.wordHighlightEnabled}
                      onChange={(e) => onUpdateSubtitleStyle({ wordHighlightEnabled: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-[#333] rounded-full peer peer-checked:bg-indigo-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4"></div>
                  </label>
                </Field>

                {subtitleStyle.wordHighlightEnabled && (
                  <div className="space-y-4">
                    <Group title="Box Style">
                      <Field label="Color" stack={true}>
                        <ColorPicker
                          value={subtitleStyle.wordHighlightColor || '#FFD700'}
                          onChange={(v) => onUpdateSubtitleStyle({ wordHighlightColor: v })}
                        />
                      </Field>
                      <Field label="Opacity" rightLabel={`${Math.round((subtitleStyle.wordHighlightOpacity ?? 0.85) * 100)}%`} stack={true}>
                        <input type="range" min="0" max="1" step="0.05" value={subtitleStyle.wordHighlightOpacity ?? 0.85} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightOpacity: parseFloat(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Border Radius" rightLabel={`${subtitleStyle.wordHighlightBorderRadius ?? 4}px`} stack={true}>
                        <input type="range" min="0" max="24" step="1" value={subtitleStyle.wordHighlightBorderRadius ?? 4} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightBorderRadius: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Scale" rightLabel={`${(subtitleStyle.wordHighlightScale ?? 1.0).toFixed(2)}×`} stack={true}>
                        <input type="range" min="0.5" max="2.0" step="0.05" value={subtitleStyle.wordHighlightScale ?? 1.0} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightScale: parseFloat(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Blend Mode" stack={true}>
                        <select
                          value={subtitleStyle.wordHighlightBlendMode || 'normal'}
                          onChange={(e) => onUpdateSubtitleStyle({ wordHighlightBlendMode: e.target.value })}
                          className="w-full bg-[#121212] border border-[#333] text-gray-300 text-[11px] rounded px-2 py-1.5 focus:outline-none focus:border-indigo-500"
                        >
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </Group>

                    <Group title="Padding">
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Horizontal" rightLabel={`${subtitleStyle.wordHighlightPaddingH ?? 4}px`} stack={true}>
                          <input type="range" min="0" max="20" step="1" value={subtitleStyle.wordHighlightPaddingH ?? 4} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightPaddingH: parseInt(e.target.value) })} className={rangeClass} />
                        </Field>
                        <Field label="Vertical" rightLabel={`${subtitleStyle.wordHighlightPaddingV ?? 2}px`} stack={true}>
                          <input type="range" min="0" max="20" step="1" value={subtitleStyle.wordHighlightPaddingV ?? 2} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightPaddingV: parseInt(e.target.value) })} className={rangeClass} />
                        </Field>
                      </div>
                    </Group>

                    <Group title="Text Override">
                      <Field label="Active Word Color" stack={true}>
                        <div className="flex items-center gap-2">
                          <ColorPicker
                            value={subtitleStyle.wordHighlightActiveColor || '#ffffff'}
                            onChange={(v) => onUpdateSubtitleStyle({ wordHighlightActiveColor: v })}
                          />
                          {subtitleStyle.wordHighlightActiveColor && (
                            <button
                              className="text-[10px] text-gray-500 hover:text-red-400 whitespace-nowrap"
                              onClick={() => onUpdateSubtitleStyle({ wordHighlightActiveColor: '' })}
                            >None</button>
                          )}
                        </div>
                      </Field>
                      <Field label="Idle Word Opacity" rightLabel={`${Math.round((subtitleStyle.wordHighlightIdleOpacity ?? 1.0) * 100)}%`} stack={true}>
                        <input type="range" min="0" max="1" step="0.05" value={subtitleStyle.wordHighlightIdleOpacity ?? 1.0} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightIdleOpacity: parseFloat(e.target.value) })} className={rangeClass} />
                      </Field>
                    </Group>

                    <Group title="Transition">
                      <Field label="Slide Duration" rightLabel={`${subtitleStyle.wordHighlightTransitionMs ?? 150}ms`} stack={true}>
                        <input type="range" min="0" max="500" step="10" value={subtitleStyle.wordHighlightTransitionMs ?? 150} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightTransitionMs: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                    </Group>

                    <Group title="Shadow &amp; Glow">
                      <Field label="Shadow Color" stack={true}>
                        <ColorPicker
                          value={subtitleStyle.wordHighlightShadowColor || '#000000'}
                          onChange={(v) => onUpdateSubtitleStyle({ wordHighlightShadowColor: v })}
                        />
                      </Field>
                      <Field label="Shadow Blur" rightLabel={`${subtitleStyle.wordHighlightShadowBlur ?? 0}px`} stack={true}>
                        <input type="range" min="0" max="20" step="1" value={subtitleStyle.wordHighlightShadowBlur ?? 0} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightShadowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Shadow X" rightLabel={`${subtitleStyle.wordHighlightShadowOffsetX ?? 0}px`} stack={true}>
                          <input type="range" min="-10" max="10" step="1" value={subtitleStyle.wordHighlightShadowOffsetX ?? 0} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightShadowOffsetX: parseInt(e.target.value) })} className={rangeClass} />
                        </Field>
                        <Field label="Shadow Y" rightLabel={`${subtitleStyle.wordHighlightShadowOffsetY ?? 0}px`} stack={true}>
                          <input type="range" min="-10" max="10" step="1" value={subtitleStyle.wordHighlightShadowOffsetY ?? 0} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightShadowOffsetY: parseInt(e.target.value) })} className={rangeClass} />
                        </Field>
                      </div>
                      <Field label="Glow Color" stack={true}>
                        <ColorPicker
                          value={subtitleStyle.wordHighlightGlowColor || '#FFD700'}
                          onChange={(v) => onUpdateSubtitleStyle({ wordHighlightGlowColor: v })}
                        />
                      </Field>
                      <Field label="Glow Blur" rightLabel={`${subtitleStyle.wordHighlightGlowBlur ?? 0}px`} stack={true}>
                        <input type="range" min="0" max="30" step="1" value={subtitleStyle.wordHighlightGlowBlur ?? 0} onChange={(e) => onUpdateSubtitleStyle({ wordHighlightGlowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                    </Group>
                  </div>
                )}
              </div>
            </Accordion>

            <Accordion title="Layout & Rules" defaultOpen={false}>
              <div className="space-y-4">
                <Field label="Vertical Position" rightLabel={`${subtitleStyle.bottomOffset}%`} stack={true}>
                  <input type="range" min="0" max="90" step="1" value={subtitleStyle.bottomOffset} onChange={(e) => onUpdateSubtitleStyle({ bottomOffset: parseInt(e.target.value) })} className={rangeClass} />
                </Field>
              </div>
            </Accordion>

            <Accordion title="Animation & Dynamics" defaultOpen={true}>
              {/* Subtitle Template Link */}
              {activeSubtitleTemplate && onUpdateSubtitleTemplate ? (
                <div className="space-y-3">
                  <div className="flex justify-between items-center mb-1">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Base Effect</span>
                      <span className="text-[11px] text-indigo-400 font-medium">{activeSubtitleTemplate.name}</span>
                    </div>
                    {onToggleTemplateUnlink && (
                      <label className="flex items-center gap-1.5 cursor-pointer bg-[#222] px-2 py-1 rounded border border-[#333] hover:border-indigo-500 transition-colors">
                        <input type="checkbox" checked={!!isTemplateUnlinked} onChange={onToggleTemplateUnlink} className="rounded bg-[#111] border-[#444] text-indigo-500 focus:ring-0 w-3 h-3" />
                        <span className={`text-[9px] font-bold uppercase ${isTemplateUnlinked ? 'text-indigo-400' : 'text-gray-500'}`}>Unlink Effect</span>
                      </label>
                    )}
                  </div>
                  <div className="p-3 bg-[#111] border border-[#222] rounded-md">
                    <AnimationControls animation={activeSubtitleTemplate.animation} onChange={(newAnim: TextAnimation) => onUpdateSubtitleTemplate({ ...activeSubtitleTemplate, animation: newAnim })} />
                  </div>
                </div>
              ) : (
                <div className="text-[11px] text-gray-400 bg-[#222] border border-[#333] rounded p-3 text-center">
                  Select a template from the Templates tab.
                </div>
              )}

              {/* Keyword Emphases */}
              {onUpdateWordEmphases && selectedDialogueText && (
                <div className="pt-4 mt-4 border-t border-[#2a2a2a] space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-[10px] text-amber-500/80 font-bold uppercase tracking-widest">Keywords Highlights</span>
                  </div>
                  <p className="text-[10px] text-gray-500 leading-tight">Click words in the video viewport to highlight them, then assign colors below.</p>

                  {wordEmphases && wordEmphases.length > 0 ? (
                    <div className="space-y-2">
                      {wordEmphases.map((kw, i) => (
                        <div key={`${kw.wordIndex}-${kw.word}`} className="flex items-center gap-2 bg-[#222] border border-[#333] rounded-md px-2 py-1.5">
                          <input type="checkbox" checked={kw.enabled} onChange={() => { const updated = wordEmphases.map((k, j) => j === i ? { ...k, enabled: !k.enabled } : k); onUpdateWordEmphases(updated); }} className="rounded bg-[#111] border-[#444] text-amber-500 focus:ring-0 w-3 h-3" />
                          <span className={`text-[11px] flex-1 truncate ${kw.enabled ? 'text-white font-medium' : 'text-gray-500 line-through'}`}>{kw.word} <span className="opacity-40 ml-1">#{kw.wordIndex}</span></span>
                          <div className="w-16">
                            <ColorPicker value={kw.color || '#FFD700'} onChange={(v) => { const updated = wordEmphases.map((k, j) => j === i ? { ...k, color: v } : k); onUpdateWordEmphases(updated); }} />
                          </div>
                          <button onClick={() => onUpdateWordEmphases(wordEmphases.filter((_, j) => j !== i))} className="text-gray-500 hover:text-red-400 p-1"><svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-gray-500 italic bg-[#151515] p-2 rounded text-center border border-[#222]">No assigned keywords.</div>
                  )}

                  {onUpdateKeywordAnimation && wordEmphases && wordEmphases.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-amber-900/30">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] text-amber-500/80 font-bold uppercase tracking-widest">Keyword Entrance Popup</span>
                        {activeKeywordAnimation && <button onClick={() => onUpdateKeywordAnimation(null)} className="text-[9px] text-red-400 hover:text-red-300">Clear</button>}
                      </div>
                      {activeKeywordAnimation ? (
                        <div className="p-3 bg-[#111] border border-amber-900/40 rounded-md">
                          <div className="text-[10px] text-amber-400 mb-2 font-medium">{activeKeywordAnimation.name || 'Custom'}</div>
                          <AnimationControls animation={activeKeywordAnimation} onUpdate={(updated) => onUpdateKeywordAnimation(updated)} />
                        </div>
                      ) : (
                        <div className="text-[10px] text-gray-500 italic bg-[#151515] p-2 rounded text-center border border-[#222]">No keyword animation chosen. Use the Templates tab to set one.</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Accordion>
          </div>
        )}

        {/* TITLE MODE */}
        {isTitleSelected && titleLayer && onUpdateTitleLayer && titleLayer.style && (
          <div className="space-y-4">
            <Accordion title="Content & Timing" defaultOpen={true}>
              <div className="space-y-4">
                <Field label="Text Content" stack={true}>
                  <textarea value={titleLayer.text} onChange={(e) => onUpdateTitleLayer({ text: e.target.value })} className={`${inputClass} min-h-[60px] text-sm`} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Start (s)" stack={true}>
                    <input type="number" step="0.1" value={titleLayer.startTime} onChange={e => onUpdateTitleLayer({ startTime: parseFloat(e.target.value) })} className={inputClass} />
                  </Field>
                  <Field label="End (s)" stack={true}>
                    <input type="number" step="0.1" value={titleLayer.endTime} onChange={e => onUpdateTitleLayer({ endTime: parseFloat(e.target.value) })} className={inputClass} />
                  </Field>
                </div>
              </div>
            </Accordion>

            <Accordion title="Typography" defaultOpen={true}>
              <div className="space-y-4">
                <div className="flex gap-3">
                  <Field label="Font" stack={true}>
                    <FontPicker value={titleLayer.style.fontFamily} onChange={(f) => handleTitleStyleUpdate({ fontFamily: f })} />
                  </Field>
                  <div className="w-20">
                    <Field label="Size" stack={true}>
                      <input type="number" value={titleLayer.style.fontSize} onChange={(e) => handleTitleStyleUpdate({ fontSize: parseInt(e.target.value) })} className={inputClass} />
                    </Field>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button onClick={() => handleTitleStyleUpdate({ bold: !titleLayer.style!.bold })} className={`flex-1 py-1.5 rounded text-[11px] font-medium transition-colors border ${titleLayer.style!.bold ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-[#222] border-[#333] text-gray-400 hover:bg-[#2a2a2a]'}`}>Bold</button>
                  <button onClick={() => handleTitleStyleUpdate({ italic: !titleLayer.style!.italic })} className={`flex-1 py-1.5 rounded text-[11px] font-medium transition-colors border ${titleLayer.style!.italic ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-[#222] border-[#333] text-gray-400 hover:bg-[#2a2a2a]'}`}>Italic</button>
                </div>

                <div className="flex bg-[#222] p-1 rounded border border-[#333]">
                  {([
                    { value: 'none' as const, label: 'Aa' },
                    { value: 'uppercase' as const, label: 'AA' },
                    { value: 'lowercase' as const, label: 'aa' },
                    { value: 'capitalize' as const, label: 'Ab' },
                  ]).map(opt => (
                    <button key={opt.value} onClick={() => handleTitleStyleUpdate({ textTransform: opt.value })} className={`flex-1 py-1.5 rounded text-[10px] font-bold transition-colors ${(titleLayer.style!.textTransform || 'none') === opt.value ? 'bg-[#333] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}>{opt.label}</button>
                  ))}
                </div>

                <div className="flex bg-[#222] p-1 rounded border border-[#333]">
                  {['left', 'center', 'right'].map((align: any) => (
                    <button key={align} onClick={() => handleTitleStyleUpdate({ textAlign: align })} className={`flex-1 py-1.5 rounded text-[10px] font-bold uppercase transition-colors ${titleLayer.style!.textAlign === align ? 'bg-[#333] text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}>{align}</button>
                  ))}
                </div>

                <Field label="Text Color" stack={true}>
                  <ColorPicker value={titleLayer.style.color || '#ffffff'} onChange={(v) => handleTitleStyleUpdate({ color: v })} />
                </Field>
              </div>
            </Accordion>

            <Accordion title="Background" defaultOpen={false}>
              <div className="space-y-5">
                <Field label="Style" stack={true}>
                  <select value={titleLayer.style.backgroundType} onChange={(e) => handleTitleStyleUpdate({ backgroundType: e.target.value as any })} className={inputClass}>
                    <option value="none">None / Transparent</option>
                    <option value="outline">Text Outline</option>
                    <option value="box">Solid Box</option>
                    <option value="rounded">Rounded Box</option>
                    <option value="stripe">Full Width Stripe</option>
                  </select>
                </Field>

                {titleLayer.style.backgroundType !== 'none' && titleLayer.style.backgroundType !== 'outline' && (
                  <>
                    <Field label="Color" stack={true}>
                      <ColorPicker value={titleLayer.style.backgroundColor || '#000000'} onChange={(v) => handleTitleStyleUpdate({ backgroundColor: v })} />
                    </Field>
                  </>
                )}

                {(titleLayer.style.backgroundType === 'box' || titleLayer.style.backgroundType === 'rounded' || titleLayer.style.backgroundType === 'stripe') && (
                  <Group title="Borders">
                    <Field label="Border Color" stack={true}>
                      <ColorPicker value={titleLayer.style.boxBorderColor || '#ffffff'} onChange={(v) => handleTitleStyleUpdate({ boxBorderColor: v })} />
                    </Field>
                    <Field label="Border Width" rightLabel={`${titleLayer.style.boxBorderWidth || 0}px`} stack={true}>
                      <input type="range" min="0" max="20" step="1" value={titleLayer.style.boxBorderWidth || 0} onChange={(e) => handleTitleStyleUpdate({ boxBorderWidth: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    {titleLayer.style.backgroundType === 'rounded' && (
                      <Field label="Corner Radius" rightLabel={`${titleLayer.style.boxBorderRadius || 0}px`} stack={true}>
                        <input type="range" min="0" max="50" step="1" value={titleLayer.style.boxBorderRadius || 0} onChange={(e) => handleTitleStyleUpdate({ boxBorderRadius: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                    )}
                  </Group>
                )}

                {titleLayer.style.backgroundType === 'outline' && (
                  <Group title="Stroke Settings">
                    <Field label="Outline Color" stack={true}>
                      <ColorPicker value={titleLayer.style.outlineColor || '#000000'} onChange={(v) => handleTitleStyleUpdate({ outlineColor: v })} />
                    </Field>
                    <Field label="Stroke Width" rightLabel={`${titleLayer.style.outlineWidth || 2}px`} stack={true}>
                      <input type="range" min="1" max="10" step="1" value={titleLayer.style.outlineWidth || 2} onChange={(e) => handleTitleStyleUpdate({ outlineWidth: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                  </Group>
                )}

                {(titleLayer.style.backgroundType === 'box' || titleLayer.style.backgroundType === 'rounded' || titleLayer.style.backgroundType === 'stripe') && (
                  <Group title="Backdrop Effects">
                    <Field label="Backdrop Blend" stack={true}>
                      <select value={titleLayer.style.backdropBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ backdropBlendMode: e.target.value })} className={inputClass}>
                        {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                      </select>
                    </Field>
                    <div className="grid grid-cols-2 gap-4 pt-2">
                      <Field label="Drop Shadow" stack={true}>
                        <ColorPicker value={titleLayer.style.backdropShadowColor || '#000000'} onChange={(v) => handleTitleStyleUpdate({ backdropShadowColor: v })} />
                      </Field>
                      <Field label="Outer Glow" stack={true}>
                        <ColorPicker value={titleLayer.style.backdropGlowColor || '#00ff00'} onChange={(v) => handleTitleStyleUpdate({ backdropGlowColor: v })} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Shadow Blend" stack={true}>
                        <select value={titleLayer.style.backdropShadowBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ backdropShadowBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                      <Field label="Glow Blend" stack={true}>
                        <select value={titleLayer.style.backdropGlowBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ backdropGlowBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </div>

                    <div className="space-y-4 pt-2">
                      <Field label="Shadow Blur" rightLabel={`${titleLayer.style.backdropShadowBlur || 0}px`} stack={true}>
                        <input type="range" min="0" max="20" step="1" value={titleLayer.style.backdropShadowBlur || 0} onChange={(e) => handleTitleStyleUpdate({ backdropShadowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Shadow X Offset" rightLabel={`${titleLayer.style.backdropShadowOffsetX || 0}px`} stack={true}>
                        <input type="range" min="-20" max="20" step="1" value={titleLayer.style.backdropShadowOffsetX || 0} onChange={(e) => handleTitleStyleUpdate({ backdropShadowOffsetX: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Shadow Y Offset" rightLabel={`${titleLayer.style.backdropShadowOffsetY || 0}px`} stack={true}>
                        <input type="range" min="-20" max="20" step="1" value={titleLayer.style.backdropShadowOffsetY || 0} onChange={(e) => handleTitleStyleUpdate({ backdropShadowOffsetY: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <div className="border-t border-[#2a2a2a] pt-3"></div>
                      <Field label="Glow Amount" rightLabel={`${titleLayer.style.backdropGlowBlur || 0}px`} stack={true}>
                        <input type="range" min="0" max="50" step="1" value={titleLayer.style.backdropGlowBlur || 0} onChange={(e) => handleTitleStyleUpdate({ backdropGlowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <div className="border-t border-[#2a2a2a] pt-3"></div>
                      <Field label="Inner Glow" stack={true}>
                        <ColorPicker value={titleLayer.style.innerGlowColor || '#ffffff'} onChange={(v) => handleTitleStyleUpdate({ innerGlowColor: v })} />
                      </Field>
                      <Field label="Inner Glow Blur" rightLabel={`${titleLayer.style.innerGlowBlur || 0}px`} stack={true}>
                        <input type="range" min="0" max="30" step="1" value={titleLayer.style.innerGlowBlur || 0} onChange={(e) => handleTitleStyleUpdate({ innerGlowBlur: parseInt(e.target.value) })} className={rangeClass} />
                      </Field>
                      <Field label="Inner Glow Blend" stack={true}>
                        <select value={titleLayer.style.innerGlowBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ innerGlowBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </div>
                  </Group>
                )}
              </div>
            </Accordion>

            <Accordion title="Text Effects" defaultOpen={false}>
              <div className="space-y-6">
                <Group title="Gradients">
                  <Field label="Type" stack={true}>
                    <select value={titleLayer.style.gradientType || 'none'} onChange={(e) => {
                      const type = e.target.value as any;
                      if (type !== 'none' && !titleLayer.style.gradientStops && (!titleLayer.style.gradientColors || titleLayer.style.gradientColors.length === 0)) {
                        handleTitleStyleUpdate({ gradientType: type, gradientStops: [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 100 }] });
                      } else {
                        handleTitleStyleUpdate({ gradientType: type });
                      }
                    }} className={inputClass}>
                      <option value="none">None</option>
                      <option value="linear">Linear</option>
                      <option value="radial">Radial</option>
                    </select>
                  </Field>
                  {titleLayer.style.gradientType && titleLayer.style.gradientType !== 'none' && (
                    <>
                      <GradientEditor
                        stops={titleLayer.style.gradientStops || (titleLayer.style.gradientColors ? migrateGradientColors(titleLayer.style.gradientColors) : [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 100 }])}
                        type={titleLayer.style.gradientType as 'linear' | 'radial'}
                        angle={titleLayer.style.gradientAngle || 0}
                        onChange={(stops) => handleTitleStyleUpdate({ gradientStops: stops, gradientColors: [stops[0].color, stops[stops.length - 1].color] })}
                        onTypeChange={(type) => handleTitleStyleUpdate({ gradientType: type })}
                        onAngleChange={(angle) => handleTitleStyleUpdate({ gradientAngle: angle })}
                      />
                      <Field label="Gradient Blend" stack={true}>
                        <select value={titleLayer.style.gradientBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ gradientBlendMode: e.target.value })} className={inputClass}>
                          {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                        </select>
                      </Field>
                    </>
                  )}
                </Group>

                <Group title="Shadow & Glow">
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Drop Shadow" stack={true}>
                      <ColorPicker value={titleLayer.style.textShadowColor || '#000000'} onChange={(v) => handleTitleStyleUpdate({ textShadowColor: v })} />
                    </Field>
                    <Field label="Outer Glow" stack={true}>
                      <ColorPicker value={titleLayer.style.glowColor || '#00ff00'} onChange={(v) => handleTitleStyleUpdate({ glowColor: v })} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Shadow Blend" stack={true}>
                      <select value={titleLayer.style.shadowBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ shadowBlendMode: e.target.value })} className={inputClass}>
                        {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                      </select>
                    </Field>
                    <Field label="Glow Blend" stack={true}>
                      <select value={titleLayer.style.glowBlendMode || 'normal'} onChange={(e) => handleTitleStyleUpdate({ glowBlendMode: e.target.value })} className={inputClass}>
                        {LAYER_BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1).replace('-', ' ')}</option>)}
                      </select>
                    </Field>
                  </div>

                  <div className="space-y-4 pt-2">
                    <Field label="Shadow Blur" rightLabel={`${titleLayer.style.textShadowBlur || 0}px`} stack={true}>
                      <input type="range" min="0" max="20" step="1" value={titleLayer.style.textShadowBlur || 0} onChange={(e) => handleTitleStyleUpdate({ textShadowBlur: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    <Field label="Shadow X Offset" rightLabel={`${titleLayer.style.textShadowOffsetX || 0}px`} stack={true}>
                      <input type="range" min="-20" max="20" step="1" value={titleLayer.style.textShadowOffsetX || 0} onChange={(e) => handleTitleStyleUpdate({ textShadowOffsetX: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    <Field label="Shadow Y Offset" rightLabel={`${titleLayer.style.textShadowOffsetY || 0}px`} stack={true}>
                      <input type="range" min="-20" max="20" step="1" value={titleLayer.style.textShadowOffsetY || 0} onChange={(e) => handleTitleStyleUpdate({ textShadowOffsetY: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                    <div className="border-t border-[#2a2a2a] pt-3"></div>
                    <Field label="Glow Amount" rightLabel={`${titleLayer.style.glowBlur || 0}px`} stack={true}>
                      <input type="range" min="0" max="50" step="1" value={titleLayer.style.glowBlur || 0} onChange={(e) => handleTitleStyleUpdate({ glowBlur: parseInt(e.target.value) })} className={rangeClass} />
                    </Field>
                  </div>
                </Group>
              </div>
            </Accordion>

            <Accordion title="Layout" defaultOpen={false}>
              <div className="space-y-4">
                <Field label="Top Position" rightLabel={`${titleLayer.style.topOffset}%`} stack={true}>
                  <input type="range" min="0" max="90" step="1" value={titleLayer.style.topOffset} onChange={(e) => handleTitleStyleUpdate({ topOffset: parseInt(e.target.value) })} className={rangeClass} />
                </Field>
              </div>
            </Accordion>

            <Accordion title="Animation Effect" defaultOpen={true}>
              <div className="p-3 bg-[#111] border border-[#222] rounded-md">
                <AnimationControls animation={titleLayer.animation || { id: 'custom', name: 'Custom', duration: (titleLayer.endTime - titleLayer.startTime), scope: 'element', stagger: 0.05, effects: [] }} onChange={(newAnim) => onUpdateTitleLayer!({ animation: newAnim })} />
              </div>
            </Accordion>
          </div>
        )}

        {/* TRANSITION MODE */}
        {!isTitleSelected && !selectedDialogue && selectedTransition && selectedSegment && (() => {
          const def = currentTransition ? getTransitionDef(currentTransition.type) : null;
          return (
          <Accordion title="Transition Settings" defaultOpen={true}>
            <div className="space-y-5">
              {/* Type — grouped by category */}
              <Field label="Type" stack={true}>
                <select value={currentTransition?.type || 'FADE'} onChange={(e) => {
                  const newType = e.target.value as TransitionType;
                  const newDef = getTransitionDef(newType);
                  handleTransitionChange({ type: newType, ...(newDef?.defaultParams || {}) });
                }} className={inputClass}>
                  {TRANSITION_CATEGORIES.map(cat => (
                    <optgroup key={cat} label={cat}>
                      {TRANSITION_CATALOG.filter(t => t.category === cat).map(t => (
                        <option key={t.id} value={t.id}>{t.icon} {t.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>

              {/* Duration */}
              <Field label="Duration" rightLabel={`${currentTransition?.duration?.toFixed(2) || 0.5}s`} stack={true}>
                <input type="range" min="0.1" max="3.0" step="0.1" value={currentTransition?.duration || 0.5} onChange={(e) => handleTransitionChange({ duration: parseFloat(e.target.value) })} className={rangeClass} />
              </Field>

              {/* Easing */}
              <Field label="Easing" stack={true}>
                <select value={currentTransition?.easing || 'linear'} onChange={(e) => handleTransitionChange({ easing: e.target.value as TransitionEasing })} className={inputClass}>
                  <option value="linear">Linear</option>
                  <option value="easeIn">Ease In</option>
                  <option value="easeOut">Ease Out</option>
                  <option value="easeInOut">Ease In-Out</option>
                  <option value="bounce">Bounce</option>
                </select>
              </Field>

              {/* Blend Mode */}
              <Field label="Blend Mode" stack={true}>
                <select value={currentTransition?.blendMode || 'normal'} onChange={(e) => handleTransitionChange({ blendMode: e.target.value })} className={inputClass}>
                  {BLEND_MODES.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                </select>
              </Field>

              {/* Dynamic parameters from catalog */}
              {def?.paramSchema.map(param => (
                <React.Fragment key={param.key}>
                  {param.type === 'range' && (
                    <Field label={param.label} rightLabel={`${(currentTransition as any)?.[param.key] ?? param.default ?? param.min ?? 0}`} stack={true}>
                      <input type="range" min={param.min ?? 0} max={param.max ?? 100} step={param.step ?? 1}
                        value={(currentTransition as any)?.[param.key] ?? param.default ?? param.min ?? 0}
                        onChange={(e) => handleTransitionChange({ [param.key]: parseFloat(e.target.value) } as any)}
                        className={rangeClass} />
                    </Field>
                  )}
                  {param.type === 'select' && (
                    <Field label={param.label} stack={true}>
                      <select value={(currentTransition as any)?.[param.key] ?? param.default ?? ''} onChange={(e) => handleTransitionChange({ [param.key]: e.target.value } as any)} className={inputClass}>
                        {param.options?.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </Field>
                  )}
                  {param.type === 'color' && (
                    <Field label={param.label} stack={true}>
                      <ColorPicker value={(currentTransition as any)?.[param.key] ?? param.default ?? '#000000'} onChange={(v) => handleTransitionChange({ [param.key]: v } as any)} />
                    </Field>
                  )}
                </React.Fragment>
              ))}

              <div className="pt-4 border-t border-[#333]">
                <button onClick={removeTransition} className="w-full py-2 bg-red-900/20 text-red-400 border border-red-900/50 rounded-md hover:bg-red-900/40 text-[11px] font-bold tracking-widest uppercase transition-colors">
                  Remove Transition
                </button>
                <p className="text-[9px] text-gray-500 mt-2 text-center">Selected: {selectedTransition.side.toUpperCase()} of {selectedSegment.description}</p>
              </div>
            </div>
          </Accordion>
          );
        })()}

        {/* CLIP MODE */}
        {!isTitleSelected && !selectedDialogue && !selectedTransition && selectedSegment && (
          <div className="space-y-4">
            <Accordion title="Clip Settings" defaultOpen={true}>
              <div className="space-y-4">
                <Field label="Name" stack={true}>
                  <input type="text" value={selectedSegment.description} onChange={(e) => onUpdateSegment({ ...selectedSegment, description: e.target.value })} className={inputClass} />
                </Field>

                {selectedSegment.type === 'blank' && (
                  <Field label="Blank Card Text" stack={true}>
                    <textarea value={selectedSegment.customText || ''} onChange={(e) => onUpdateSegment({ ...selectedSegment, customText: e.target.value })} className={`${inputClass} min-h-[60px] text-sm`} placeholder="Display text..." />
                  </Field>
                )}

                <Field label="Timeline Color" stack={true}>
                  <div className="flex gap-2 flex-wrap">
                    {['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#78716c', '#444444'].map(c => (
                      <button key={c} onClick={() => onUpdateSegment({ ...selectedSegment, color: c })} className={`w-6 h-6 rounded-full border border-white/10 transition-transform hover:scale-110 ${selectedSegment.color === c ? 'ring-2 ring-white scale-110 shadow-lg' : ''}`} style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </Field>

                <div className="grid grid-cols-3 gap-2 pt-2">
                  <div className="bg-[#222] p-2 rounded border border-[#333]">
                    <div className="text-[9px] text-gray-500 uppercase font-bold text-center">In</div>
                    <div className="text-[11px] font-mono text-gray-300 text-center">{selectedSegment.startTime.toFixed(2)}s</div>
                  </div>
                  <div className="bg-[#222] p-2 rounded border border-[#333]">
                    <div className="text-[9px] text-gray-500 uppercase font-bold text-center">Out</div>
                    <div className="text-[11px] font-mono text-gray-300 text-center">{selectedSegment.endTime.toFixed(2)}s</div>
                  </div>
                  <div className="bg-[#1e1a2d] p-2 rounded border border-indigo-900/50 shadow-inner">
                    <div className="text-[9px] text-indigo-400/80 uppercase font-bold text-center">Duration</div>
                    <div className="text-[11px] font-mono text-indigo-300 text-center">{(selectedSegment.endTime - selectedSegment.startTime).toFixed(2)}s</div>
                  </div>
                </div>
              </div>
            </Accordion>

            {selectedSegment.type !== 'blank' && (
              <Accordion title="Audio" defaultOpen={true}>
                <div className="space-y-4">
                  {currentVolume !== undefined && (
                    <div className="flex items-center justify-between text-[10px] text-gray-400">
                      <span>Current: {Math.round(currentVolume * 100)}%</span>
                    </div>
                  )}
                  <Field label={`Volume: ${volumeSlider}%`} stack={true}>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={volumeSlider}
                      onChange={(e) => setVolumeSlider(parseInt(e.target.value))}
                      className="w-full accent-amber-400"
                    />
                  </Field>
                  <button
                    onClick={() => onAddVolumeKey && selectedSegment && onAddVolumeKey(selectedSegment.id, volumeSlider / 100)}
                    className="w-full py-2 bg-amber-600/20 text-amber-400 border border-amber-600/50 rounded-md hover:bg-amber-600/30 text-[11px] font-bold uppercase tracking-widest transition-colors"
                  >
                    Add Volume Key
                  </button>
                  <p className="text-[9px] text-gray-500 text-center">Set volume slider, then add a keyframe at the current time. Use Graph Editor for full curve control.</p>
                </div>
              </Accordion>
            )}

            {selectedSegment.type !== 'blank' && (
              <Accordion title="AI Analysis" defaultOpen={false}>
                <div className="space-y-4">
                  {mediaAnalysis && (
                    <div className="bg-green-900/20 border border-green-900/50 rounded p-2 flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full bg-green-500 blink"></span>
                      <span className="text-[10px] text-green-400 font-medium">Analysis Completed</span>
                    </div>
                  )}
                  <Field label="Analysis Focus" stack={true}>
                    <textarea value={analysisFocus} onChange={(e) => setAnalysisFocus(e.target.value)} placeholder="Focus on objects, faces, specific actions..." className={`${inputClass} min-h-[60px] text-sm`} />
                  </Field>

                  <button onClick={() => onAnalyze && onAnalyze(selectedSegment.mediaId, analysisFocus)} disabled={isProcessing} className="w-full py-2.5 bg-indigo-600/20 text-indigo-400 border border-indigo-600/50 rounded-md hover:bg-indigo-600/30 text-[11px] font-bold uppercase tracking-widest disabled:opacity-50 flex items-center justify-center gap-2 transition-colors">
                    {isProcessing ? (
                      <><span className="w-3.5 h-3.5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></span> Analyzing...</>
                    ) : (mediaAnalysis ? 'Refine / Re-Analyze' : 'Run Deep Analysis')}
                  </button>
                  <p className="text-[9px] text-gray-500 text-center leading-relaxed max-w-[90%] mx-auto">Use focus to ask AI to find exact frames matching specific descriptions.</p>
                </div>
              </Accordion>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PropertiesPanel;