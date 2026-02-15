import React, { useRef, useEffect } from 'react';
import { VideoAnalysis } from '../types';

interface TranscriptPanelProps {
    analysis: VideoAnalysis | null;
    currentTime: number;
    onSeek: (time: number) => void;
    onSelect?: (index: number) => void;
    selectedIndex?: number | null;
}

const TranscriptPanel: React.FC<TranscriptPanelProps> = ({ analysis, currentTime, onSeek, onSelect, selectedIndex }) => {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Filter dialogue events
    // Use loose check for type to handle imported transcripts that might be labeled differently in future
    const dialogueEvents = analysis?.events?.filter(e => e.type === 'dialogue') || [];

    // Debug render
    // console.log('[TranscriptPanel] Render. Events:', dialogueEvents.length);

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
                {dialogueEvents
                    .filter(event => Math.abs(event.startTime - currentTime) < 60) // Virtualization: Only show events within 1 min window
                    .map((event, idx) => {
                        // Note: idx is local index after filter. 
                        // We need to find the original index for 'onSelect'.
                        // Since 'dialogueEvents' is the source, let's find the index in THAT array.
                        // This is slow (O(N*M)). Better to keep original index in the event object?
                        // The App.tsx passes 'index' to onSelect.
                        // Let's use `indexOf` or just pass the time to seek.
                        // Wait, `onSelect` takes an index.
                        // We need the GLOBAL index.
                        const globalIndex = dialogueEvents.indexOf(event);

                        const isActive = currentTime >= event.startTime && currentTime <= event.endTime;
                        const isSelected = selectedIndex === globalIndex;

                        return (
                            <div
                                key={globalIndex}
                                onClick={() => {
                                    onSeek(event.startTime);
                                    if (onSelect) onSelect(globalIndex);
                                }}
                                className={`p-3 rounded-lg cursor-pointer transition-all border-l-2 
                                ${isSelected ? 'bg-purple-900/40 border-purple-500 shadow-md' :
                                        isActive ? 'bg-[#3a3a3a] border-blue-500' : 'hover:bg-[#2a2a2a] border-transparent'}`}
                            >
                                <div className="flex items-center justify-between mb-1">
                                    <span className={`text-xs font-bold uppercase tracking-wider ${isSelected ? 'text-purple-300' : 'text-blue-400'}`}>
                                        {event.label}
                                    </span>
                                    <span className="text-[10px] text-gray-500 font-mono">
                                        {new Date(event.startTime * 1000).toISOString().substr(14, 5)}
                                    </span>
                                </div>
                                <p className={`text-sm leading-relaxed ${isActive || isSelected ? 'text-white' : 'text-gray-400'}`}>
                                    {event.details}
                                </p>
                            </div>
                        )
                    })}
                {dialogueEvents.length > 0 && Math.abs(dialogueEvents[dialogueEvents.length - 1].startTime - currentTime) > 60 && (
                    <div className="text-center text-xs text-gray-600 py-2">
                        ... seeking to browse more ...
                    </div>
                )}
            </div>
        </div>
    );
};

export default TranscriptPanel;