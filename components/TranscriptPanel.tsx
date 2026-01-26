import React, { useRef, useEffect } from 'react';
import { VideoAnalysis } from '../types';

interface TranscriptPanelProps {
  analysis: VideoAnalysis | null;
  currentTime: number;
  onSeek: (time: number) => void;
}

const TranscriptPanel: React.FC<TranscriptPanelProps> = ({ analysis, currentTime, onSeek }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filter dialogue events
  const dialogueEvents = analysis?.events.filter(e => e.type === 'dialogue') || [];

  if (!analysis) {
      return (
          <div className="flex flex-col h-full items-center justify-center text-gray-500 p-4 text-center">
              <p className="mb-2">No transcript available.</p>
              <p className="text-xs">Run "Deep Analyze" to generate a transcript.</p>
          </div>
      )
  }

  if (dialogueEvents.length === 0) {
      return (
          <div className="flex flex-col h-full items-center justify-center text-gray-500 p-4 text-center">
              <p>No dialogue detected.</p>
          </div>
      )
  }

  return (
    <div className="flex flex-col h-full bg-[#1e1e1e] overflow-hidden">
        <div className="p-3 border-b border-[#3a3a3a] bg-[#2a2a2a]">
            <h2 className="text-sm font-semibold text-gray-200">Transcript</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {dialogueEvents.map((event, idx) => {
                const isActive = currentTime >= event.startTime && currentTime <= event.endTime;
                return (
                    <div 
                        key={idx}
                        onClick={() => onSeek(event.startTime)}
                        className={`p-3 rounded-lg cursor-pointer transition-all ${isActive ? 'bg-[#3a3a3a] border-l-2 border-blue-500' : 'hover:bg-[#2a2a2a] border-l-2 border-transparent'}`}
                    >
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-bold text-blue-400 uppercase tracking-wider">{event.label}</span>
                            <span className="text-[10px] text-gray-500 font-mono">
                                {new Date(event.startTime * 1000).toISOString().substr(14, 5)}
                            </span>
                        </div>
                        <p className={`text-sm leading-relaxed ${isActive ? 'text-white' : 'text-gray-400'}`}>
                            {event.details}
                        </p>
                    </div>
                )
            })}
        </div>
    </div>
  );
};

export default TranscriptPanel;