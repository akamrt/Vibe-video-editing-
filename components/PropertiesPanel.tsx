import React, { useState } from 'react';
import { Segment, Transition, TransitionType, VideoAnalysis, SubtitleStyle, TitleLayer, TitleStyle, SubtitleTemplate, TextAnimation } from '../types';
import AnimationControls from './AnimationControls';

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
}

const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion'
];

const FONTS = ['Arial', 'Verdana', 'Helvetica', 'Times New Roman', 'Courier New', 'Georgia', 'Impact', 'Inter', 'Roboto'];

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
  isProcessing
}) => {
  const [analysisFocus, setAnalysisFocus] = useState('');

  if (!selectedSegment && !selectedTransition && !selectedDialogue && !isTitleSelected) {
    return (
      <div className="h-full bg-[#1e1e1e] border-l border-[#333] p-4 flex items-center justify-center text-gray-500 text-xs text-center">
        Select a clip, transition, title, or dialogue bubble to view properties
      </div>
    );
  }

  // Helper to get current transition object if a transition is selected
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
    onUpdateTitleLayer({
      style: { ...titleLayer.style!, ...updates }
    });
  };

  return (
    <div className="h-full bg-[#1e1e1e] border-l border-[#333] flex flex-col font-sans">
      <div className="p-3 border-b border-[#333] bg-[#252525]">
        <h2 className="text-xs font-bold uppercase tracking-widest text-gray-300">
          {selectedTransition ? 'Transition' : selectedDialogue ? 'Subtitle' : isTitleSelected ? 'Title' : 'Clip'} Properties
        </h2>
      </div>

      <div className="p-4 space-y-6 overflow-y-auto flex-1">

        {/* SUBTITLE MODE */}
        {selectedDialogue && subtitleStyle && onUpdateDialogueText && onUpdateSubtitleStyle ? (
          <div className="space-y-6">
            {/* Content Editor */}
            <div className="space-y-2">
              <label className="text-xs text-gray-400">Content</label>
              <textarea
                value={selectedDialogueText || ''}
                onChange={(e) => onUpdateDialogueText(e.target.value)}
                className="w-full bg-[#121212] border border-[#333] rounded text-sm text-white p-2 focus:border-purple-500 outline-none min-h-[80px]"
                placeholder="Edit subtitle text..."
              />
            </div>

            {/* Appearance Controls */}
            <div className="space-y-4 pt-4 border-t border-[#333]">
              <div className="flex justify-between items-center">
                <div className="text-[10px] font-bold text-gray-500 uppercase">Subtitle Appearance</div>
                {onToggleSubtitleUnlink && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!isSubtitleUnlinked} onChange={onToggleSubtitleUnlink} className="rounded bg-[#333] border-[#555] text-blue-600 focus:ring-0" />
                    <span className={`text-[10px] ${isSubtitleUnlinked ? 'text-blue-400 font-bold' : 'text-gray-500'}`}>Unlink Style</span>
                  </label>
                )}
              </div>
              {isSubtitleUnlinked && <div className="text-[9px] text-blue-500/80 -mt-2">Changes affect only this subtitle.</div>}
              {!isSubtitleUnlinked && <div className="text-[9px] text-gray-600 -mt-2">Changes affect all subtitles.</div>}

              {/* Font & Size */}
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <label className="text-[10px] text-gray-400">Font</label>
                  <select
                    value={subtitleStyle.fontFamily}
                    onChange={(e) => onUpdateSubtitleStyle({ fontFamily: e.target.value })}
                    className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-1"
                  >
                    {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="w-16 space-y-1">
                  <label className="text-[10px] text-gray-400">Size</label>
                  <input
                    type="number"
                    value={subtitleStyle.fontSize}
                    onChange={(e) => onUpdateSubtitleStyle({ fontSize: parseInt(e.target.value) })}
                    className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-1"
                  />
                </div>
              </div>

              {/* Style Toggles & Alignment */}
              <div className="flex gap-2">
                <button
                  onClick={() => onUpdateSubtitleStyle({ bold: !subtitleStyle.bold })}
                  className={`flex-1 py-1 rounded text-xs border ${subtitleStyle.bold ? 'bg-blue-600 border-blue-600 text-white' : 'bg-[#2a2a2a] border-[#333] text-gray-400'}`}
                >
                  Bold
                </button>
                <button
                  onClick={() => onUpdateSubtitleStyle({ italic: !subtitleStyle.italic })}
                  className={`flex-1 py-1 rounded text-xs border ${subtitleStyle.italic ? 'bg-blue-600 border-blue-600 text-white' : 'bg-[#2a2a2a] border-[#333] text-gray-400'}`}
                >
                  Italic
                </button>
              </div>
              <div className="flex gap-1 bg-[#2a2a2a] p-1 rounded border border-[#333]">
                {['left', 'center', 'right'].map((align: any) => (
                  <button
                    key={align}
                    onClick={() => onUpdateSubtitleStyle({ textAlign: align })}
                    className={`flex-1 py-1 rounded text-xs uppercase ${subtitleStyle.textAlign === align ? 'bg-[#444] text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    {align}
                  </button>
                ))}
              </div>

              {/* Colors */}
              <div className="flex gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-400">Text Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={subtitleStyle.color}
                      onChange={(e) => onUpdateSubtitleStyle({ color: e.target.value })}
                      className="w-8 h-8 bg-transparent border-none cursor-pointer"
                    />
                    <span className="text-[10px] text-gray-500 font-mono">{subtitleStyle.color}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-400">Bg Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={subtitleStyle.backgroundColor}
                      onChange={(e) => onUpdateSubtitleStyle({ backgroundColor: e.target.value })}
                      className="w-8 h-8 bg-transparent border-none cursor-pointer"
                    />
                    <span className="text-[10px] text-gray-500 font-mono">{subtitleStyle.backgroundColor}</span>
                  </div>
                </div>
              </div>

              {/* Background Type */}
              <div className="space-y-1">
                <label className="text-[10px] text-gray-400">Background Style</label>
                <select
                  value={subtitleStyle.backgroundType}
                  onChange={(e) => onUpdateSubtitleStyle({ backgroundType: e.target.value as any })}
                  className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-2"
                >
                  <option value="none">None (Text Shadow)</option>
                  <option value="outline">Outline</option>
                  <option value="box">Box</option>
                  <option value="rounded">Rounded Box</option>
                  <option value="stripe">Stripe</option>
                </select>
              </div>

              {/* Border & Shape (New) */}
              {(subtitleStyle.backgroundType === 'box' || subtitleStyle.backgroundType === 'rounded' || subtitleStyle.backgroundType === 'stripe') && (
                <div className="space-y-3 pt-2 border-t border-[#333]">
                  <div className="text-[10px] font-bold text-gray-500 uppercase">Border & Shape</div>

                  <div className="flex gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-gray-400">Border Color</label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={subtitleStyle.boxBorderColor || '#ffffff'}
                          onChange={(e) => onUpdateSubtitleStyle({ boxBorderColor: e.target.value })}
                          className="w-8 h-8 bg-transparent border-none cursor-pointer"
                        />
                        <span className="text-[10px] text-gray-500 font-mono">{subtitleStyle.boxBorderColor}</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400">
                      <span>Border Width</span>
                      <span>{subtitleStyle.boxBorderWidth || 0}px</span>
                    </div>
                    <input
                      type="range" min="0" max="20" step="1"
                      value={subtitleStyle.boxBorderWidth || 0}
                      onChange={(e) => onUpdateSubtitleStyle({ boxBorderWidth: parseInt(e.target.value) })}
                      className="w-full accent-blue-500 h-1 bg-[#333] rounded-lg cursor-pointer"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400">
                      <span>Corner Radius</span>
                      <span>{subtitleStyle.boxBorderRadius || 0}px</span>
                    </div>
                    <input
                      type="range" min="0" max="50" step="1"
                      value={subtitleStyle.boxBorderRadius || 0}
                      onChange={(e) => onUpdateSubtitleStyle({ boxBorderRadius: parseInt(e.target.value) })}
                      className="w-full accent-blue-500 h-1 bg-[#333] rounded-lg cursor-pointer"
                    />
                  </div>
                </div>
              )}

              {/* Sliders */}
              <div className="space-y-3 pt-2 border-t border-[#333]">
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-gray-400">
                    <span>Background Opacity</span>
                    <span>{Math.round(subtitleStyle.backgroundOpacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0" max="1" step="0.05"
                    value={subtitleStyle.backgroundOpacity}
                    onChange={(e) => onUpdateSubtitleStyle({ backgroundOpacity: parseFloat(e.target.value) })}
                    className="w-full accent-blue-500 h-1 bg-[#333] rounded-lg cursor-pointer"
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-gray-400">
                    <span>Vertical Position</span>
                    <span>{subtitleStyle.bottomOffset}%</span>
                  </div>
                  <input
                    type="range"
                    min="0" max="90" step="1"
                    value={subtitleStyle.bottomOffset}
                    onChange={(e) => onUpdateSubtitleStyle({ bottomOffset: parseInt(e.target.value) })}
                    className="w-full accent-blue-500 h-1 bg-[#333] rounded-lg cursor-pointer"
                  />
                </div>
              </div>

              {/* Subtitle Animation Controls */}
              {activeSubtitleTemplate && onUpdateSubtitleTemplate && (
                <div className="space-y-4 pt-4 border-t border-[#333]">
                  <div className="flex justify-between items-center">
                    <div className="text-[10px] font-bold text-gray-500 uppercase">Animation</div>
                    <div className="flex items-center gap-3">
                      <span className="text-[9px] text-purple-400">{activeSubtitleTemplate.name}</span>
                      {onToggleTemplateUnlink && (
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={!!isTemplateUnlinked} onChange={onToggleTemplateUnlink} className="rounded bg-[#333] border-[#555] text-purple-600 focus:ring-0" />
                          <span className={`text-[10px] ${isTemplateUnlinked ? 'text-purple-400 font-bold' : 'text-gray-500'}`}>Unlink</span>
                        </label>
                      )}
                    </div>
                  </div>
                  {isTemplateUnlinked && <div className="text-[9px] text-purple-500/80 -mt-2">Animation affects only this subtitle.</div>}
                  {!isTemplateUnlinked && <div className="text-[9px] text-gray-600 -mt-2">Animation affects all subtitles.</div>}
                  <AnimationControls
                    animation={activeSubtitleTemplate.animation}
                    onChange={(newAnim: TextAnimation) => onUpdateSubtitleTemplate({ ...activeSubtitleTemplate, animation: newAnim })}
                  />
                </div>
              )}
              {!activeSubtitleTemplate && (
                <div className="pt-4 border-t border-[#333]">
                  <div className="text-[10px] text-gray-600 text-center py-2">
                    Select a template in the TEMPLATES tab to add animation effects.
                  </div>
                </div>
              )}

            </div>
          </div>
        ) : isTitleSelected && titleLayer && onUpdateTitleLayer && titleLayer.style ? (
          /* TITLE MODE */
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs text-gray-400">Title Text</label>
              <textarea
                value={titleLayer.text}
                onChange={(e) => onUpdateTitleLayer({ text: e.target.value })}
                className="w-full bg-[#121212] border border-[#333] rounded text-sm text-white p-2 focus:border-indigo-500 outline-none min-h-[60px]"
              />
            </div>

            {/* NEW ANIMATION CONTROLS */}
            <div className="space-y-4 pt-4 border-t border-[#333]">
              <div className="text-[10px] font-bold text-gray-500 uppercase">Animation</div>

              <AnimationControls
                animation={titleLayer.animation || {
                  id: 'custom',
                  name: 'Custom',
                  duration: (titleLayer.endTime - titleLayer.startTime),
                  scope: 'element',
                  stagger: 0.05,
                  effects: []
                }}
                onChange={(newAnim) => onUpdateTitleLayer!({ animation: newAnim })}
              />

              {/* Basic Timing (Start/End only, duration derived from animation or explicit) */}
              <div className="grid grid-cols-2 gap-2 pt-2">
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-400">Start (s)</label>
                  <input type="number" step="0.1" value={titleLayer.startTime} onChange={e => onUpdateTitleLayer({ startTime: parseFloat(e.target.value) })} className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-1" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-400">End (s)</label>
                  <input type="number" step="0.1" value={titleLayer.endTime} onChange={e => onUpdateTitleLayer({ endTime: parseFloat(e.target.value) })} className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-1" />
                </div>
              </div>
            </div>

            <div className="space-y-4 pt-4 border-t border-[#333]">
              <div className="text-[10px] font-bold text-gray-500 uppercase">Appearance</div>
              {/* Font & Size */}
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <label className="text-[10px] text-gray-400">Font</label>
                  <select
                    value={titleLayer.style.fontFamily}
                    onChange={(e) => handleTitleStyleUpdate({ fontFamily: e.target.value })}
                    className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-1"
                  >
                    {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div className="w-16 space-y-1">
                  <label className="text-[10px] text-gray-400">Size</label>
                  <input
                    type="number"
                    value={titleLayer.style.fontSize}
                    onChange={(e) => handleTitleStyleUpdate({ fontSize: parseInt(e.target.value) })}
                    className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-1"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={() => handleTitleStyleUpdate({ bold: !titleLayer.style!.bold })} className={`flex-1 py-1 rounded text-xs border ${titleLayer.style!.bold ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-[#2a2a2a] border-[#333] text-gray-400'}`}>Bold</button>
                <button onClick={() => handleTitleStyleUpdate({ italic: !titleLayer.style!.italic })} className={`flex-1 py-1 rounded text-xs border ${titleLayer.style!.italic ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-[#2a2a2a] border-[#333] text-gray-400'}`}>Italic</button>
              </div>

              <div className="flex gap-1 bg-[#2a2a2a] p-1 rounded border border-[#333]">
                {['left', 'center', 'right'].map((align: any) => (
                  <button
                    key={align}
                    onClick={() => handleTitleStyleUpdate({ textAlign: align })}
                    className={`flex-1 py-1 rounded text-xs uppercase ${titleLayer.style!.textAlign === align ? 'bg-[#444] text-white' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    {align}
                  </button>
                ))}
              </div>

              {/* Colors */}
              <div className="flex gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-400">Text Color</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={titleLayer.style.color} onChange={(e) => handleTitleStyleUpdate({ color: e.target.value })} className="w-8 h-8 bg-transparent border-none cursor-pointer" />
                    <span className="text-[10px] text-gray-500 font-mono">{titleLayer.style.color}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-gray-400">Bg Color</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={titleLayer.style.backgroundColor} onChange={(e) => handleTitleStyleUpdate({ backgroundColor: e.target.value })} className="w-8 h-8 bg-transparent border-none cursor-pointer" />
                    <span className="text-[10px] text-gray-500 font-mono">{titleLayer.style.backgroundColor}</span>
                  </div>
                </div>
              </div>

              {/* Background Type */}
              <div className="space-y-1">
                <label className="text-[10px] text-gray-400">Background Style</label>
                <select
                  value={titleLayer.style.backgroundType}
                  onChange={(e) => handleTitleStyleUpdate({ backgroundType: e.target.value as any })}
                  className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-2"
                >
                  <option value="none">None (Text Shadow)</option>
                  <option value="outline">Outline</option>
                  <option value="box">Box</option>
                  <option value="rounded">Rounded Box</option>
                  <option value="stripe">Stripe</option>
                </select>
              </div>

              {/* Borders */}
              {(titleLayer.style.backgroundType === 'box' || titleLayer.style.backgroundType === 'rounded' || titleLayer.style.backgroundType === 'stripe') && (
                <div className="space-y-3 pt-2 border-t border-[#333]">
                  <div className="flex gap-4">
                    <div className="space-y-1">
                      <label className="text-[10px] text-gray-400">Border Color</label>
                      <div className="flex items-center gap-2">
                        <input type="color" value={titleLayer.style.boxBorderColor || '#ffffff'} onChange={(e) => handleTitleStyleUpdate({ boxBorderColor: e.target.value })} className="w-8 h-8 bg-transparent border-none cursor-pointer" />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400"><span>Border Width</span><span>{titleLayer.style.boxBorderWidth || 0}px</span></div>
                    <input type="range" min="0" max="20" step="1" value={titleLayer.style.boxBorderWidth || 0} onChange={(e) => handleTitleStyleUpdate({ boxBorderWidth: parseInt(e.target.value) })} className="w-full accent-indigo-500 h-1 bg-[#333] rounded-lg cursor-pointer" />
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-gray-400"><span>Corner Radius</span><span>{titleLayer.style.boxBorderRadius || 0}px</span></div>
                    <input type="range" min="0" max="50" step="1" value={titleLayer.style.boxBorderRadius || 0} onChange={(e) => handleTitleStyleUpdate({ boxBorderRadius: parseInt(e.target.value) })} className="w-full accent-indigo-500 h-1 bg-[#333] rounded-lg cursor-pointer" />
                  </div>
                </div>
              )}

              <div className="space-y-3 pt-2 border-t border-[#333]">
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-gray-400"><span>Top Position</span><span>{titleLayer.style.topOffset}%</span></div>
                  <input type="range" min="0" max="90" step="1" value={titleLayer.style.topOffset} onChange={(e) => handleTitleStyleUpdate({ topOffset: parseInt(e.target.value) })} className="w-full accent-indigo-500 h-1 bg-[#333] rounded-lg cursor-pointer" />
                </div>
              </div>

            </div>
          </div>
        ) : selectedTransition && selectedSegment ? (
          /* TRANSITION MODE */
          <>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <label className="text-xs text-gray-400">Type</label>
                <button onClick={removeTransition} className="text-[10px] text-red-400 hover:text-red-300">Remove</button>
              </div>
              <select
                value={currentTransition?.type || 'FADE'}
                onChange={(e) => handleTransitionChange({ type: e.target.value as TransitionType })}
                className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-2 focus:border-blue-500 outline-none"
              >
                <option value="FADE">Opacity Fade</option>
                <option value="CROSSFADE">Crossfade</option>
                <option value="WASH_WHITE">Wash White</option>
                <option value="WASH_BLACK">Wash Black</option>
                <option value="WASH_COLOR">Wash Color</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-gray-400 flex justify-between">
                <span>Duration</span>
                <span className="text-gray-200">{currentTransition?.duration?.toFixed(2) || 0.5}s</span>
              </label>
              <input
                type="range"
                min="0.1"
                max="3.0"
                step="0.1"
                value={currentTransition?.duration || 0.5}
                onChange={(e) => handleTransitionChange({ duration: parseFloat(e.target.value) })}
                className="w-full accent-blue-500 h-1 bg-[#333] rounded-lg appearance-none cursor-pointer"
              />
            </div>

            {/* Blend Mode (Available for all transitions) */}
            <div className="space-y-1">
              <label className="text-xs text-gray-400">Blend Mode</label>
              <select
                value={currentTransition?.blendMode || 'normal'}
                onChange={(e) => handleTransitionChange({ blendMode: e.target.value })}
                className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-2 outline-none"
              >
                {BLEND_MODES.map(m => (
                  <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
                ))}
              </select>
              <p className="text-[9px] text-gray-600">Apply standard CSS blend modes to the transition.</p>
            </div>

            {/* Overlay Options (Only for Wash types) */}
            {currentTransition?.type?.startsWith('WASH') && (
              <div className="p-3 bg-[#2a2a2a] rounded border border-[#333] space-y-3 mt-4">
                <div className="text-[10px] font-bold text-gray-500 uppercase">Wash Color Settings</div>

                {currentTransition.type === 'WASH_COLOR' && (
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-gray-400">Color</label>
                    <input
                      type="color"
                      value={currentTransition.color || '#ff0000'}
                      onChange={(e) => handleTransitionChange({ color: e.target.value })}
                      className="bg-transparent border-none w-8 h-8 cursor-pointer"
                    />
                  </div>
                )}
              </div>
            )}

            <div className="text-[10px] text-gray-500 mt-4">
              Selected: {selectedTransition.side.toUpperCase()} of {selectedSegment.description}
            </div>
          </>
        ) : (
          /* CLIP MODE */
          selectedSegment && (
            <>
              <div className="space-y-3">
                <label className="text-xs text-gray-400">Name</label>
                <input
                  type="text"
                  value={selectedSegment.description}
                  onChange={(e) => onUpdateSegment({ ...selectedSegment, description: e.target.value })}
                  className="w-full bg-[#121212] border border-[#333] rounded text-xs text-white p-2 focus:border-blue-500 outline-none"
                />
              </div>

              <div className="space-y-3">
                <label className="text-xs text-gray-400">Clip Color</label>
                <div className="flex gap-2 flex-wrap">
                  {['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#78716c'].map(c => (
                    <button
                      key={c}
                      onClick={() => onUpdateSegment({ ...selectedSegment, color: c })}
                      className={`w-5 h-5 rounded-full border border-white/10 ${selectedSegment.color === c ? 'ring-2 ring-white' : ''}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-[#333]">
                <div>
                  <label className="text-[10px] text-gray-500">In Point</label>
                  <div className="text-sm font-mono text-gray-300">{selectedSegment.startTime.toFixed(2)}s</div>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500">Out Point</label>
                  <div className="text-sm font-mono text-gray-300">{selectedSegment.endTime.toFixed(2)}s</div>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500">Duration</label>
                  <div className="text-sm font-mono text-gray-300">{(selectedSegment.endTime - selectedSegment.startTime).toFixed(2)}s</div>
                </div>
              </div>

              <div className="pt-4 border-t border-[#333]">
                <div className="flex justify-between items-center mb-2">
                  <label className="text-xs text-gray-400">AI Analysis</label>
                  {mediaAnalysis && <span className="text-[10px] text-green-400">Done</span>}
                </div>

                <textarea
                  value={analysisFocus}
                  onChange={(e) => setAnalysisFocus(e.target.value)}
                  placeholder="E.g. Focus on specific objects, actions, or details..."
                  className="w-full bg-[#121212] border border-[#333] rounded p-2 text-xs text-white mb-2 outline-none focus:border-purple-500 min-h-[60px]"
                />

                <button
                  onClick={() => onAnalyze && onAnalyze(selectedSegment.mediaId, analysisFocus)}
                  disabled={isProcessing}
                  className="w-full py-1.5 bg-purple-600/20 text-purple-400 border border-purple-600/50 rounded hover:bg-purple-600/30 text-xs font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isProcessing ? (
                    <>
                      <span className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin"></span>
                      Analyzing...
                    </>
                  ) : (mediaAnalysis ? 'Refine / Re-Analyze' : 'Deep Analyze Media')}
                </button>
                <p className="text-[9px] text-gray-600 mt-2">
                  Use custom focus to ask AI to identify specific people, objects, or context in this clip.
                </p>
              </div>

            </>
          )
        )}
      </div>
    </div>
  );
};

export default PropertiesPanel;