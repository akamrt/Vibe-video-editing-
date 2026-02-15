import React from 'react';
import { MediaItem } from '../types';

interface MediaBinProps {
  items: MediaItem[];
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAddToTimeline: (item: MediaItem) => void;
  onSelect: (item: MediaItem) => void;
  onYoutubeClick: () => void;
}

const MediaBin: React.FC<MediaBinProps> = ({ items, onUpload, onAddToTimeline, onSelect, onYoutubeClick }) => {
  return (
    <div className="h-full flex flex-col bg-[#1e1e1e] border-r border-[#333]">
      <div className="p-4 border-b border-[#333] flex justify-between items-center bg-[#252525]">
        <h2 className="font-bold text-gray-200">Media Bin</h2>
        <div className="flex gap-2">
          <button
            onClick={onYoutubeClick}
            className="p-1.5 hover:bg-[#333] rounded text-gray-400 hover:text-white"
            title="Import from YouTube"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l8 3.993-8 4.007z" /></svg>
          </button>
          <label className="cursor-pointer p-1.5 hover:bg-[#333] rounded text-gray-400 hover:text-white">
            <input type="file" multiple accept="video/*,audio/*" className="hidden" onChange={onUpload} />
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {items.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-gray-600 text-[10px] text-center p-4">
            <svg className="w-8 h-8 mb-2 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" /></svg>
            Import clips to start
          </div>
        )}
        {items.map(item => (
          <div
            key={item.id}
            className="group relative bg-[#2a2a2a] border border-[#333] rounded p-2 hover:border-blue-500 transition-all cursor-pointer"
            onClick={() => onSelect(item)}
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-8 bg-black rounded flex items-center justify-center overflow-hidden">
                <video src={item.url} className="w-full h-full object-cover opacity-60" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium truncate text-gray-200">{item.name}</div>
                <div className="text-[9px] text-gray-500 font-mono">{item.duration.toFixed(1)}s</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onAddToTimeline(item); }}
                className="opacity-0 group-hover:opacity-100 p-1 bg-blue-600 rounded hover:bg-blue-500 transition-all"
                title="Add to sequence"
              >
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
              </button>
            </div>
            {item.analysis && (
              <div className="absolute top-1 right-1">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full" title="Analyzed" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MediaBin;