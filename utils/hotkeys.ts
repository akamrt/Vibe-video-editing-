/**
 * VibeCut Hotkeys System
 * Defines all rebindable shortcuts, localStorage persistence, and matching utilities.
 */

const STORAGE_KEY = 'vibecut-hotkeys';

export interface HotkeyBinding {
  key: string;      // e.key value — e.g. ' ', 'j', 'Delete', 'k'
  ctrl?: boolean;   // Ctrl on Windows / Cmd on Mac (matched as e.ctrlKey || e.metaKey)
  shift?: boolean;
  alt?: boolean;
}

export interface HotkeyDef {
  id: string;
  label: string;
  category: string;
  defaultBinding: HotkeyBinding;
  fixed?: boolean;        // Cannot be rebound (system shortcuts)
  fixedDisplay?: string;  // Human-readable label for fixed shortcuts
  description?: string;
}

export const HOTKEY_DEFS: HotkeyDef[] = [
  // Playback
  {
    id: 'play-pause',
    label: 'Play / Pause',
    category: 'Playback',
    defaultBinding: { key: ' ' },
    description: 'Toggle playback',
  },
  {
    id: 'rewind',
    label: 'Rewind 5s',
    category: 'Playback',
    defaultBinding: { key: 'j' },
    description: 'Jump back 5 seconds',
  },
  {
    id: 'forward',
    label: 'Skip Forward 5s',
    category: 'Playback',
    defaultBinding: { key: 'l' },
    description: 'Jump forward 5 seconds',
  },

  // Editing
  {
    id: 'delete-selected',
    label: 'Delete Selected',
    category: 'Editing',
    defaultBinding: { key: 'Delete' },
    description: 'Delete the selected clip or subtitle',
  },

  // Fixed system shortcuts (display only)
  {
    id: 'undo',
    label: 'Undo',
    category: 'Editing',
    defaultBinding: { key: 'z', ctrl: true },
    fixed: true,
    fixedDisplay: '⌘Z / Ctrl+Z',
  },
  {
    id: 'redo',
    label: 'Redo',
    category: 'Editing',
    defaultBinding: { key: 'z', ctrl: true, shift: true },
    fixed: true,
    fixedDisplay: '⌘⇧Z / Ctrl+Y',
  },
  {
    id: 'graph-delete',
    label: 'Delete Keyframe',
    category: 'Graph Editor',
    defaultBinding: { key: 'Delete' },
    fixed: true,
    fixedDisplay: 'Delete / Backspace',
    description: 'Delete selected keyframes in the graph editor',
  },
];

/** Load user-saved overrides from localStorage */
export function loadHotkeyOverrides(): Record<string, HotkeyBinding> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Save overrides to localStorage */
export function saveHotkeyOverrides(overrides: Record<string, HotkeyBinding>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
}

/** Get the effective binding for a given action (override or default) */
export function getBinding(id: string, overrides: Record<string, HotkeyBinding>): HotkeyBinding {
  return overrides[id] ?? HOTKEY_DEFS.find(d => d.id === id)?.defaultBinding ?? { key: '' };
}

/** Get all effective bindings (defaults merged with overrides) */
export function getAllBindings(overrides: Record<string, HotkeyBinding>): Record<string, HotkeyBinding> {
  const result: Record<string, HotkeyBinding> = {};
  for (const def of HOTKEY_DEFS) {
    result[def.id] = overrides[def.id] ?? def.defaultBinding;
  }
  return result;
}

/** Reset a single shortcut to its default */
export function resetBinding(id: string, overrides: Record<string, HotkeyBinding>): Record<string, HotkeyBinding> {
  const next = { ...overrides };
  delete next[id];
  return next;
}

/** Check whether a KeyboardEvent matches a binding */
export function matchesBinding(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  if (!binding.key) return false;

  // Key match — space is special: use e.code so it works regardless of layout
  const keyMatch = binding.key === ' '
    ? e.code === 'Space'
    : e.key === binding.key;

  // Ctrl/Meta are treated as interchangeable (Windows Ctrl = Mac Cmd)
  const wantsCtrl = !!binding.ctrl;
  const hasCtrl = e.ctrlKey || e.metaKey;

  const shiftMatch = !!binding.shift === e.shiftKey;
  const altMatch = !!binding.alt === e.altKey;

  return keyMatch && (wantsCtrl === hasCtrl) && shiftMatch && altMatch;
}

/** Format a binding as a human-readable string */
export function formatBinding(binding: HotkeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.shift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');

  let key = binding.key;
  if (key === ' ') key = 'Space';
  else if (key === 'ArrowUp') key = '↑';
  else if (key === 'ArrowDown') key = '↓';
  else if (key === 'ArrowLeft') key = '←';
  else if (key === 'ArrowRight') key = '→';
  else if (key === 'Escape') key = 'Esc';
  else if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}

/** Check if a binding is the default for its action */
export function isDefaultBinding(id: string, overrides: Record<string, HotkeyBinding>): boolean {
  return !(id in overrides);
}
