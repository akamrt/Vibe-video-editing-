import React, { useRef, useState, useMemo } from 'react';
import { VideoAnalysis, RemovedWord } from '../types';

interface TranscriptPanelProps {
    analysis: VideoAnalysis | null;
    mediaId?: string;
    currentTime: number;
    onSeek: (time: number) => void;
    onSelect?: (index: number) => void;
    selectedIndex?: number | null;
    removedWords?: RemovedWord[];
    onRemoveWords?: (words: RemovedWord[]) => void;
    onRestoreWord?: (wordId: string) => void;
    transcriptSource?: 'youtube' | 'assemblyai' | 'gemini' | 'none';
    transcriptionJob?: { status: string; progress?: string; mediaId: string };
    onTranscribe?: () => void;
}

interface ParsedWord {
    id: string;
    text: string;
    startTime: number;
    endTime: number;
    globalEventIndex: number;
}

const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
    analysis, mediaId, currentTime, onSeek, onSelect, selectedIndex,
    removedWords = [], onRemoveWords, onRestoreWord,
    transcriptSource, transcriptionJob, onTranscribe
}) => {
    const [hasAssemblyAIKey, setHasAssemblyAIKey] = useState<boolean | null>(null);

    // Check if AssemblyAI key is configured
    React.useEffect(() => {
        fetch('/api/keys').then(r => r.json()).then(keys => {
            setHasAssemblyAIKey(!!keys.ASSEMBLYAI_API_KEY);
        }).catch(() => setHasAssemblyAIKey(false));
    }, []);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [selectedWordIds, setSelectedWordIds] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState<'transcript' | 'removed'>('transcript');

    const dialogueEvents = useMemo(() => analysis?.events?.filter(e => e.type === 'dialogue') || [], [analysis]);

    // Pre-parse words so we can render them individually
    const wordsByEvent = useMemo(() => {
        return dialogueEvents.map((event, globalIndex) => {
            const rawWords = event.details.split(/\s+/).filter(w => w.trim().length > 0);
            const totalChars = rawWords.join('').length;
            const duration = event.endTime - event.startTime;

            let charsSoFar = 0;
            return rawWords.map((text, wordIndex) => {
                const wordLength = text.length;
                const wordStart = event.startTime + (duration * (charsSoFar / totalChars));
                charsSoFar += wordLength;
                const wordEnd = event.startTime + (duration * (charsSoFar / totalChars));

                return {
                    id: `${mediaId}-${globalIndex}-${wordIndex}`,
                    text,
                    startTime: wordStart,
                    endTime: wordEnd,
                    globalEventIndex: globalIndex
                } as ParsedWord;
            });
        });
    }, [dialogueEvents, mediaId]);

    const handleWordClick = (word: ParsedWord, e: React.MouseEvent) => {
        e.stopPropagation();
        onSeek(word.startTime);

        const newSet = new Set(selectedWordIds);
        if (newSet.has(word.id)) {
            newSet.delete(word.id);
        } else {
            newSet.add(word.id);
        }
        setSelectedWordIds(newSet);
    };

    const handleCutSelected = () => {
        if (!onRemoveWords || !mediaId) return;
        const wordsToRemove: RemovedWord[] = [];

        wordsByEvent.forEach(eventWords => {
            eventWords.forEach(word => {
                if (selectedWordIds.has(word.id)) {
                    wordsToRemove.push({
                        id: word.id,
                        mediaId,
                        text: word.text,
                        startTime: word.startTime,
                        endTime: word.endTime,
                        originalEventIndex: word.globalEventIndex
                    });
                }
            });
        });

        onRemoveWords(wordsToRemove);
        setSelectedWordIds(new Set());
    };

    const isTranscribing = !!transcriptionJob && transcriptionJob.status !== 'completed' && transcriptionJob.status !== 'error';

    const sourceLabel = transcriptSource === 'assemblyai' ? 'AssemblyAI' : transcriptSource === 'youtube' ? 'YouTube' : transcriptSource === 'gemini' ? 'Gemini' : null;
    const sourceColor = transcriptSource === 'assemblyai' ? 'bg-green-600/80 text-green-100' : transcriptSource === 'youtube' ? 'bg-yellow-600/80 text-yellow-100' : transcriptSource === 'gemini' ? 'bg-purple-600/80 text-purple-100' : '';

    const statusText = transcriptionJob?.status === 'extracting_audio' ? 'Extracting audio...'
        : transcriptionJob?.status === 'uploading' ? 'Uploading to AssemblyAI...'
        : transcriptionJob?.status === 'transcribing' ? 'Transcribing...'
        : transcriptionJob?.status === 'starting' ? 'Starting...'
        : transcriptionJob?.status === 'error' ? `Error: ${transcriptionJob.progress || 'Unknown'}`
        : transcriptionJob?.status === 'completed' ? 'Complete!'
        : null;

    if (!analysis || dialogueEvents.length === 0) {
        return (
            <div className="flex flex-col h-full items-center justify-center text-gray-500 p-4 text-center">
                {isTranscribing ? (
                    <>
                        <div className="w-4 h-4 bg-indigo-400 rounded-full animate-pulse mb-3" />
                        <p className="text-indigo-300 font-medium mb-1">{statusText}</p>
                        <p className="text-xs text-gray-500">This may take 30-120 seconds depending on video length.</p>
                    </>
                ) : (
                    <>
                        <p className="mb-3">No transcript available.</p>
                        {onTranscribe && hasAssemblyAIKey ? (
                            <button
                                onClick={onTranscribe}
                                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg transition-colors"
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                                    <line x1="12" y1="19" x2="12" y2="23"/>
                                    <line x1="8" y1="23" x2="16" y2="23"/>
                                </svg>
                                Transcribe with AssemblyAI
                            </button>
                        ) : (
                            <p className="text-xs">Run "Deep Analyze" or configure AssemblyAI key in Settings.</p>
                        )}
                    </>
                )}
            </div>
        )
    }

    const removedIds = new Set(removedWords.map(rw => rw.id));
    const activeWordsCount = wordsByEvent.flat().filter(w => !removedIds.has(w.id)).length;

    return (
        <div className="flex flex-col h-full bg-[#1e1e1e] overflow-hidden relative">
            {/* Transcription toolbar */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#3a3a3a] bg-[#252525]">
                {sourceLabel && (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sourceColor}`}>
                        {sourceLabel}
                    </span>
                )}

                {onTranscribe && hasAssemblyAIKey && !isTranscribing && (
                    <button
                        onClick={onTranscribe}
                        className="ml-auto flex items-center gap-1.5 px-3 py-1 bg-indigo-600/80 hover:bg-indigo-500 text-white text-[11px] font-bold rounded transition-colors"
                        title="Transcribe with AssemblyAI for accurate word-level timestamps"
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                            <line x1="12" y1="19" x2="12" y2="23"/>
                            <line x1="8" y1="23" x2="16" y2="23"/>
                        </svg>
                        Transcribe
                    </button>
                )}

                {onTranscribe && hasAssemblyAIKey === false && (
                    <span className="ml-auto text-[10px] text-gray-500" title="Add ASSEMBLYAI_API_KEY in Settings to enable">
                        No AssemblyAI key
                    </span>
                )}

                {isTranscribing && (
                    <div className="ml-auto flex items-center gap-2">
                        <div className="w-2 h-2 bg-indigo-400 rounded-full animate-pulse" />
                        <span className="text-[11px] text-indigo-300 font-medium">{statusText}</span>
                    </div>
                )}

                {transcriptionJob?.status === 'completed' && (
                    <span className="ml-auto text-[11px] text-green-400 font-bold animate-pulse">✓ Transcription complete!</span>
                )}
            </div>

            <div className="flex border-b border-[#3a3a3a] bg-[#2a2a2a]">
                <button onClick={() => setActiveTab('transcript')} className={`flex-1 py-2 text-xs font-bold transition-colors ${activeTab === 'transcript' ? 'text-blue-400 border-b-2 border-blue-400 bg-[#333]' : 'text-gray-400 hover:bg-[#333]'}`}>
                    TRANSCRIPT ({activeWordsCount})
                </button>
                <button onClick={() => setActiveTab('removed')} className={`flex-1 py-2 text-xs font-bold transition-colors ${activeTab === 'removed' ? 'text-red-400 border-b-2 border-red-400 bg-[#333]' : 'text-gray-400 hover:bg-[#333]'}`}>
                    REMOVED ({removedWords.length})
                </button>
            </div>

            {activeTab === 'transcript' && (
                <div className="flex-1 overflow-y-auto p-6 pb-24 text-[17px] leading-8 text-gray-200 tracking-wide font-medium" ref={scrollRef}>
                    {wordsByEvent.map((words, globalIndex) => {
                        // Filter out words that are removed
                        const visibleWords = words.filter(w => !removedIds.has(w.id));
                        if (visibleWords.length === 0) return null;

                        return (
                            <span key={globalIndex} className="mr-1">
                                {visibleWords.map(word => {
                                    const isWordSelected = selectedWordIds.has(word.id);

                                    // Highlight if current time is within this word's exact timeline duration
                                    const isWordActive = currentTime >= word.startTime && currentTime <= word.endTime;

                                    return (
                                        <span
                                            key={word.id}
                                            onClick={(e) => handleWordClick(word, e)}
                                            className={`px-[2px] py-[2px] rounded transition-colors cursor-text inline-block ${isWordSelected
                                                ? 'bg-red-500 text-white'
                                                : isWordActive
                                                    ? 'bg-blue-500/80 text-white underline decoration-2'
                                                    : 'hover:bg-blue-500/20 text-gray-300'
                                                }`}
                                        >
                                            {word.text}
                                        </span>
                                    );
                                })}
                                <span> </span>
                            </span>
                        )
                    })}
                </div>
            )}

            {activeTab === 'removed' && (
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {removedWords.length === 0 ? (
                        <div className="text-center text-gray-500 text-sm mt-10 p-6 bg-[#252525] rounded-lg">
                            No words have been removed yet.
                            <br /><span className="text-xs text-gray-600 mt-2 block">Select words in the transcript tab to remove them.</span>
                        </div>
                    ) : (
                        removedWords.map((word) => (
                            <div key={word.id} className="flex items-center justify-between bg-[#2a2a2a] p-3 rounded border border-red-900/40 hover:border-red-500/50 transition-colors">
                                <div className="flex flex-col">
                                    <span className="text-gray-300 text-sm font-medium line-through decoration-red-500 decoration-2">{word.text}</span>
                                    <span className="text-[10px] text-gray-500 font-mono mt-1">
                                        {new Date(word.startTime * 1000).toISOString().substr(14, 5)}
                                    </span>
                                </div>
                                <button
                                    onClick={() => onRestoreWord && onRestoreWord(word.id)}
                                    className="px-4 py-1.5 bg-green-600/20 text-green-400 hover:bg-green-600 hover:text-white rounded text-xs font-bold transition-colors"
                                >
                                    Restore
                                </button>
                            </div>
                        ))
                    )}
                </div>
            )}

            {/* Floating Action Bar for Selections */}
            {selectedWordIds.size > 0 && activeTab === 'transcript' && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-[#1a1a1a] border border-[#444] rounded-full shadow-2xl px-5 py-3 flex items-center gap-4 animate-in slide-in-from-bottom-5 z-10 transition-all">
                    <span className="text-sm font-bold text-gray-200">{selectedWordIds.size} word{selectedWordIds.size !== 1 ? 's' : ''} selected</span>
                    <button
                        onClick={handleCutSelected}
                        className="bg-red-600 hover:bg-red-500 text-white px-5 py-1.5 rounded-full text-sm font-bold shadow-lg transition-transform hover:scale-105 active:scale-95"
                    >
                        Cut / Remove
                    </button>
                    <button
                        onClick={() => setSelectedWordIds(new Set())}
                        className="text-gray-400 hover:text-white px-3 py-1.5 rounded-full text-xs font-bold hover:bg-[#333] transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            )}
        </div>
    );
};

export default TranscriptPanel;