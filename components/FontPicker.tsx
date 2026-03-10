import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { GOOGLE_FONTS } from '../data/googleFonts';
import { loadGoogleFont, getRecentFonts, addRecentFont, isFontLoaded } from '../services/googleFontsService';

interface FontPickerProps {
  value: string;
  onChange: (fontFamily: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  'sans-serif': 'Sans Serif',
  'serif': 'Serif',
  'display': 'Display',
  'handwriting': 'Handwriting',
  'monospace': 'Monospace',
};

const FontPicker: React.FC<FontPickerProps> = ({ value, onChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Focus search input when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const recentFonts = useMemo(() => {
    if (!isOpen) return [];
    return getRecentFonts();
  }, [isOpen]);

  const filteredFonts = useMemo(() => {
    let fonts = GOOGLE_FONTS;
    if (activeCategory) {
      fonts = fonts.filter(f => f.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      fonts = fonts.filter(f => f.family.toLowerCase().includes(q));
    }
    return fonts;
  }, [search, activeCategory]);

  // Lazy-load fonts as they scroll into view
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const family = (entry.target as HTMLElement).dataset.fontFamily;
            if (family) loadGoogleFont(family);
          }
        }
      },
      { root: listRef.current, rootMargin: '100px' }
    );

    const items = listRef.current.querySelectorAll('[data-font-family]');
    items.forEach(item => observerRef.current!.observe(item));

    return () => {
      observerRef.current?.disconnect();
    };
  }, [isOpen, filteredFonts, recentFonts]);

  const handleSelect = useCallback((family: string) => {
    loadGoogleFont(family);
    addRecentFont(family);
    onChange(family);
    setIsOpen(false);
    setSearch('');
    setActiveCategory(null);
  }, [onChange]);

  // Load current font on mount if not already loaded
  useEffect(() => {
    if (value && !isFontLoaded(value)) {
      loadGoogleFont(value);
    }
  }, [value]);

  return (
    <div ref={containerRef} className="relative">
      {/* Current font display / trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full text-left bg-[#111] border border-[#333] rounded px-3 py-2 text-[12px] text-gray-200 hover:border-indigo-500 transition-colors flex items-center justify-between gap-2"
        style={{ fontFamily: value }}
      >
        <span className="truncate">{value}</span>
        <svg className={`w-3 h-3 text-gray-500 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-[9999] mt-1 w-64 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-2xl overflow-hidden" style={{ left: 0 }}>
          {/* Search */}
          <div className="p-2 border-b border-[#2a2a2a]">
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search fonts..."
              className="w-full bg-[#111] border border-[#333] rounded px-2.5 py-1.5 text-[11px] text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Category tabs */}
          <div className="flex flex-wrap gap-1 px-2 py-1.5 border-b border-[#2a2a2a]">
            <button
              onClick={() => setActiveCategory(null)}
              className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide transition-colors ${
                activeCategory === null ? 'bg-indigo-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'
              }`}
            >All</button>
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveCategory(activeCategory === key ? null : key)}
                className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide transition-colors ${
                  activeCategory === key ? 'bg-indigo-600 text-white' : 'bg-[#222] text-gray-500 hover:text-gray-300'
                }`}
              >{label}</button>
            ))}
          </div>

          {/* Font list */}
          <div ref={listRef} className="max-h-[280px] overflow-y-auto">
            {/* Recent fonts section */}
            {recentFonts.length > 0 && !search && !activeCategory && (
              <div>
                <div className="px-3 py-1.5 text-[9px] font-bold text-indigo-400/70 uppercase tracking-widest bg-[#1e1e1e]">Recent</div>
                {recentFonts.map(family => (
                  <button
                    key={`recent-${family}`}
                    data-font-family={family}
                    onClick={() => handleSelect(family)}
                    className={`w-full text-left px-3 py-2 text-[12px] hover:bg-[#2a2a2a] transition-colors ${
                      value === family ? 'bg-indigo-600/20 text-indigo-300' : 'text-gray-300'
                    }`}
                    style={{ fontFamily: family }}
                  >
                    {family}
                  </button>
                ))}
                <div className="h-px bg-[#2a2a2a]" />
              </div>
            )}

            {/* All fonts */}
            {filteredFonts.length === 0 ? (
              <div className="px-3 py-4 text-[11px] text-gray-600 text-center">No fonts found</div>
            ) : (
              filteredFonts.map(font => (
                <button
                  key={font.family}
                  data-font-family={font.family}
                  onClick={() => handleSelect(font.family)}
                  className={`w-full text-left px-3 py-2 text-[12px] hover:bg-[#2a2a2a] transition-colors ${
                    value === font.family ? 'bg-indigo-600/20 text-indigo-300' : 'text-gray-300'
                  }`}
                  style={{ fontFamily: font.family }}
                >
                  <span>{font.family}</span>
                  <span className="text-[9px] text-gray-600 ml-2">{CATEGORY_LABELS[font.category]}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default FontPicker;
