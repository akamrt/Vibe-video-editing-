import React, { useState, useEffect, useCallback } from 'react';
import {
  HOTKEY_DEFS,
  HotkeyBinding,
  loadHotkeyOverrides,
  saveHotkeyOverrides,
  resetBinding,
  formatBinding,
  isDefaultBinding,
} from '../utils/hotkeys';

interface HotkeysPanelProps {
  /** Called whenever bindings change, so the app can reload them */
  onBindingsChanged?: () => void;
}

const CATEGORY_ORDER = ['Playback', 'Editing', 'Graph Editor'];

const HotkeysPanel: React.FC<HotkeysPanelProps> = ({ onBindingsChanged }) => {
  const [overrides, setOverrides] = useState<Record<string, HotkeyBinding>>(() => loadHotkeyOverrides());
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null); // id of conflicting action

  // Listen for key when in capture mode
  useEffect(() => {
    if (!capturingId) return;

    const handleKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape = cancel
      if (e.key === 'Escape') {
        setCapturingId(null);
        setConflict(null);
        return;
      }

      // Ignore bare modifier keys
      if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return;

      const newBinding: HotkeyBinding = {
        key: e.key,
        ...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
        ...(e.shiftKey ? { shift: true } : {}),
        ...(e.altKey ? { alt: true } : {}),
      };

      // Check for conflicts with other rebindable actions
      const conflictDef = HOTKEY_DEFS.find(def => {
        if (def.fixed || def.id === capturingId) return false;
        const binding = overrides[def.id] ?? def.defaultBinding;
        return formatBinding(binding) === formatBinding(newBinding);
      });

      if (conflictDef) {
        setConflict(conflictDef.id);
        // Still apply — user can resolve it
      } else {
        setConflict(null);
      }

      const next = { ...overrides, [capturingId]: newBinding };
      setOverrides(next);
      saveHotkeyOverrides(next);
      onBindingsChanged?.();
      setCapturingId(null);
    };

    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [capturingId, overrides, onBindingsChanged]);

  const handleReset = useCallback((id: string) => {
    const next = resetBinding(id, overrides);
    setOverrides(next);
    saveHotkeyOverrides(next);
    onBindingsChanged?.();
    if (conflict === id) setConflict(null);
  }, [overrides, onBindingsChanged, conflict]);

  const handleResetAll = useCallback(() => {
    setOverrides({});
    saveHotkeyOverrides({});
    onBindingsChanged?.();
    setConflict(null);
  }, [onBindingsChanged]);

  const hasAnyOverride = Object.keys(overrides).length > 0;

  // Group defs by category in defined order
  const grouped = CATEGORY_ORDER.map(cat => ({
    category: cat,
    defs: HOTKEY_DEFS.filter(d => d.category === cat),
  })).filter(g => g.defs.length > 0);

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500">Click a key badge to rebind. Press Escape to cancel.</p>
        {hasAnyOverride && (
          <button
            onClick={handleResetAll}
            className="text-xs text-gray-500 hover:text-red-400 transition-colors"
          >
            Reset all
          </button>
        )}
      </div>

      {grouped.map(({ category, defs }) => (
        <div key={category}>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">
            {category}
          </div>
          <div className="space-y-1.5">
            {defs.map(def => {
              const isCapturing = capturingId === def.id;
              const isOverridden = !isDefaultBinding(def.id, overrides);
              const isConflicted = conflict === def.id;
              const binding = overrides[def.id] ?? def.defaultBinding;
              const displayLabel = def.fixed ? (def.fixedDisplay ?? formatBinding(binding)) : formatBinding(binding);

              return (
                <div
                  key={def.id}
                  className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                    isConflicted ? 'bg-red-900/20 border border-red-500/40' : 'bg-[#2a2a2a]'
                  }`}
                >
                  {/* Label */}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-white">{def.label}</span>
                    {def.description && (
                      <span className="ml-2 text-xs text-gray-600">{def.description}</span>
                    )}
                    {isConflicted && (
                      <span className="ml-2 text-xs text-red-400">conflict</span>
                    )}
                  </div>

                  {/* Controls */}
                  <div className="flex items-center gap-2 ml-3 flex-shrink-0">
                    {/* Reset button — only for non-fixed overridden shortcuts */}
                    {!def.fixed && isOverridden && !isCapturing && (
                      <button
                        onClick={() => handleReset(def.id)}
                        className="text-[10px] text-gray-600 hover:text-yellow-400 transition-colors px-1"
                        title="Reset to default"
                      >
                        ↺
                      </button>
                    )}

                    {/* Key badge */}
                    {def.fixed ? (
                      <span className="px-2 py-1 rounded bg-[#333] text-xs text-gray-400 font-mono cursor-default">
                        {displayLabel}
                      </span>
                    ) : isCapturing ? (
                      <span className="px-2 py-1 rounded bg-indigo-600/30 border border-indigo-500 text-xs text-indigo-300 font-mono animate-pulse min-w-[90px] text-center">
                        Press key…
                      </span>
                    ) : (
                      <button
                        onClick={() => { setCapturingId(def.id); setConflict(null); }}
                        className={`px-2 py-1 rounded text-xs font-mono transition-colors ${
                          isOverridden
                            ? 'bg-indigo-900/40 border border-indigo-500/60 text-indigo-300 hover:border-indigo-400'
                            : 'bg-[#333] text-gray-300 hover:bg-[#444] hover:text-white'
                        }`}
                        title="Click to rebind"
                      >
                        {displayLabel}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <p className="text-[10px] text-gray-600 pt-1">
        Bindings are saved locally in your browser.
      </p>
    </div>
  );
};

export default HotkeysPanel;
