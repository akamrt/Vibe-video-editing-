import React, { useState, useEffect, useRef, useMemo } from 'react';
import HotkeysPanel from '../components/HotkeysPanel';
import { contentDB, VideoRecord, TranscriptSegment, Category, GeneratedShort, ShortSegment, ClipReference, generateId } from '../services/contentDatabase';
import { searchTranscripts, generateShort, SearchResult, buildShortPrompt, importManualShort } from '../services/contentAIService';
import { CookieUploadButton } from '../components/CookieUploadButton';
import type { KeywordEmphasis, TrendItem, TrendAnalysis, TrendState } from '../types';
import { getSessionLog, getSessionTotal, clearSession, onCostUpdate, offCostUpdate, initCostTracker, CostEntry } from '../services/costTracker';
import { detectFillersFromTranscript, FillerDetection } from '../services/geminiService';
import { fetchAllTrends, getDefaultTrendState } from '../services/trendsService';
import { TrendsTicker } from '../components/TrendsTicker';
import { RepostRanker } from '../components/RepostRanker';
import { TrendPromptBuilder } from '../components/TrendPromptBuilder';
import { listShortsFiles, saveShortsToFile, loadShortsFromFile, exportAllData, importAllData, createExportBundle, uploadMediaToBundle, readImportBundle, fetchBundleMedia, downloadBundleZip, importBundleFromUrl, SavedShortsInfo } from '../services/saveApi';

// ==================== Types ====================

interface ImportingVideo {
    url: string;
    status: 'pending' | 'fetching' | 'done' | 'error';
    error?: string;
}

// ==================== Shared hook: check local video cache ====================

function useLocalVideoSrc(videoId: string) {
    const [src, setSrc] = useState<string | null>(null);        // null = checking, '' = not cached
    const [thumbnailUrl, setThumbnailUrl] = useState<string>('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // Look up thumbnail from content DB
                const record = await contentDB.getVideo(videoId);
                if (!cancelled && record?.thumbnailUrl) setThumbnailUrl(record.thumbnailUrl);

                // Check if video is locally cached
                const res = await fetch(`/api/local-cache?videoId=${videoId}`);
                const data = await res.json();
                if (!cancelled) setSrc(data.hasVideo ? `/api/local-video?videoId=${videoId}` : '');
            } catch {
                if (!cancelled) setSrc('');
            }
        })();
        return () => { cancelled = true; };
    }, [videoId]);

    return { src, thumbnailUrl };
}

// ==================== Short Detail Player (expanded preview) ====================

const ShortDetailPlayer: React.FC<{
    short: GeneratedShort;
    videoId: string;
    omittedClips?: Set<number>;
    onToggleOmit?: (segIdx: number) => void;
    clipPadOverrides?: Map<string, { before: number; after: number }>;
    selectedClipForPad?: { shortId: string; segmentIndex: number } | null;
    onSelectClipForPad?: (shortId: string, segIdx: number) => void;
    onSetClipPad?: (shortId: string, segIdx: number, before: number, after: number) => void;
    clipBasket?: ClipReference[];
    onToggleBasket?: (segIdx: number) => void;
}> = ({ short, videoId, omittedClips, onToggleOmit, clipPadOverrides, selectedClipForPad, onSelectClipForPad, onSetClipPad, clipBasket, onToggleBasket }) => {
    const { src, thumbnailUrl } = useLocalVideoSrc(videoId);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentClipIdx, setCurrentClipIdx] = useState(0);
    const [scrubProgress, setScrubProgress] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const animFrameRef = useRef<number>(0);
    const isDraggingRef = useRef(false);

    const totalDuration = short.segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
    const hasVideo = !!src;

    const formatSecs = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const seekToProgress = (pct: number) => {
        const video = videoRef.current;
        if (!video) return;
        const targetTime = pct * totalDuration;
        let accumulated = 0;
        for (let i = 0; i < short.segments.length; i++) {
            const clipDur = short.segments[i].endTime - short.segments[i].startTime;
            if (accumulated + clipDur > targetTime || i === short.segments.length - 1) {
                const offset = Math.min(targetTime - accumulated, clipDur - 0.05);
                video.currentTime = short.segments[i].startTime + Math.max(0, offset);
                setCurrentClipIdx(i);
                setScrubProgress(pct);
                setCurrentTime(targetTime);
                break;
            }
            accumulated += clipDur;
        }
    };

    const handlePlayPause = () => {
        const video = videoRef.current;
        if (!video) return;
        if (isPlaying) {
            video.pause();
            cancelAnimationFrame(animFrameRef.current);
            setIsPlaying(false);
        } else {
            if (scrubProgress === 0) {
                video.currentTime = short.segments[0]?.startTime ?? 0;
                setCurrentClipIdx(0);
            }
            video.play().then(() => setIsPlaying(true)).catch(() => {});
        }
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !isPlaying) return;
        let clipIdx = currentClipIdx;

        const tick = () => {
            if (!video || video.paused || isDraggingRef.current) return;
            const seg = short.segments[clipIdx];
            if (!seg) { video.pause(); setIsPlaying(false); return; }

            if (video.currentTime >= seg.endTime) {
                clipIdx++;
                if (clipIdx >= short.segments.length) {
                    video.pause(); setIsPlaying(false);
                    setScrubProgress(0); setCurrentTime(0); setCurrentClipIdx(0);
                    return;
                }
                setCurrentClipIdx(clipIdx);
                video.currentTime = short.segments[clipIdx].startTime;
            }

            let elapsed = 0;
            for (let i = 0; i < clipIdx; i++) elapsed += short.segments[i].endTime - short.segments[i].startTime;
            elapsed += video.currentTime - short.segments[clipIdx].startTime;
            setScrubProgress(totalDuration > 0 ? elapsed / totalDuration : 0);
            setCurrentTime(elapsed);
            animFrameRef.current = requestAnimationFrame(tick);
        };

        animFrameRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animFrameRef.current);
    }, [isPlaying, currentClipIdx, short.segments, totalDuration]);

    const handleScrubMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        isDraggingRef.current = true;
        const getRect = () => e.currentTarget.getBoundingClientRect();
        const apply = (clientX: number) => {
            const pct = Math.max(0, Math.min(1, (clientX - getRect().left) / getRect().width));
            seekToProgress(pct);
        };
        apply(e.clientX);
        const onMove = (me: MouseEvent) => apply(me.clientX);
        const onUp = () => { isDraggingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };

    const currentSeg = short.segments[currentClipIdx];

    return (
        <div className="bg-[#111] rounded-lg overflow-hidden border border-[#333]">
            <div className="relative bg-black" style={{ aspectRatio: '16/9' }}>
                {src === null && (
                    <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-xs">Checking cache...</div>
                )}
                {src === '' && (
                    <>
                        {thumbnailUrl && <img src={thumbnailUrl} className="w-full h-full object-cover opacity-40" alt="" />}
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                            <span className="text-gray-400 text-xs">Video not cached locally</span>
                            <span className="text-gray-600 text-[10px]">Will download on export</span>
                        </div>
                    </>
                )}
                {hasVideo && (
                    <>
                        <video ref={videoRef} src={src} className="w-full h-full object-contain" playsInline preload="auto" />
                        <button onClick={handlePlayPause} className="absolute inset-0 flex items-center justify-center group">
                            {!isPlaying && (
                                <div className="w-14 h-14 rounded-full bg-black/60 group-hover:bg-black/80 flex items-center justify-center shadow-xl transition-colors">
                                    <span className="text-white text-2xl ml-1">&#9654;</span>
                                </div>
                            )}
                        </button>
                    </>
                )}
                <div className="absolute top-2 left-2 bg-black/70 text-[10px] text-white px-2 py-0.5 rounded">
                    Clip {currentClipIdx + 1} / {short.segments.length}
                </div>
            </div>

            {/* Scrub bar + time — always visible */}
            <div className="px-3 pt-2 pb-1">
                <div
                    className={`relative h-3 bg-[#333] rounded-full group ${hasVideo ? 'cursor-pointer' : 'opacity-40'}`}
                    onMouseDown={hasVideo ? handleScrubMouseDown : undefined}
                >
                    <div className="absolute top-0 left-0 h-full bg-purple-500 rounded-full" style={{ width: `${scrubProgress * 100}%` }} />
                    {(() => {
                        let acc = 0;
                        return short.segments.slice(0, -1).map((seg, i) => {
                            acc += seg.endTime - seg.startTime;
                            const pct = totalDuration > 0 ? (acc / totalDuration) * 100 : 0;
                            return <div key={i} className="absolute top-0 bottom-0 w-0.5 bg-white/30" style={{ left: `${pct}%` }} />;
                        });
                    })()}
                    <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition-opacity" style={{ left: `calc(${scrubProgress * 100}% - 6px)` }} />
                </div>
                <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                    <span>{formatSecs(currentTime)}</span>
                    <span>{formatSecs(totalDuration)}</span>
                </div>
            </div>

            {currentSeg && (
                <div className="px-3 pb-1">
                    <p className="text-[11px] text-gray-400 line-clamp-2">{currentSeg.text}</p>
                </div>
            )}

            {/* Clip strip — omit toggles + per-clip pad selection */}
            {(onToggleOmit || onToggleBasket) && (
                <div className="px-3 pb-2 pt-1 border-t border-[#222] mt-1">
                    <div className="flex flex-wrap gap-1">
                        {short.segments.map((seg, si) => {
                            const isOmitted = omittedClips?.has(si) ?? false;
                            const inBasket = clipBasket?.some(c => c.shortId === short.id && c.segmentIndex === si) ?? false;
                            const padKey = `${short.id}_${si}`;
                            const override = clipPadOverrides?.get(padKey);
                            const isSelectedForPad = selectedClipForPad?.shortId === short.id && selectedClipForPad?.segmentIndex === si;
                            const hasPadOverride = override && (override.before > 0 || override.after > 0);

                            return (
                                <div key={si} className="flex flex-col gap-0.5">
                                    <div className="flex gap-0">
                                        {/* Omit toggle */}
                                        {onToggleOmit && (
                                            <button
                                                onClick={() => onToggleOmit(si)}
                                                className={`px-1.5 py-0.5 text-[9px] rounded-l border transition-colors ${isOmitted ? 'bg-red-900/30 border-red-500/40 text-red-400 line-through' : 'bg-[#222] border-[#444] text-gray-300 hover:border-gray-400'}`}
                                                title={isOmitted ? 'Include this clip' : 'Omit this clip'}
                                            >
                                                C{si + 1} {isOmitted ? '\u2717' : '\u2713'}
                                            </button>
                                        )}
                                        {/* Cart button — always shown */}
                                        {onToggleBasket && (
                                            <button
                                                onClick={() => onToggleBasket(si)}
                                                className={`px-1.5 py-0.5 text-[9px] border-t border-b transition-colors ${onToggleOmit ? '' : 'rounded-l'} ${inBasket ? 'bg-purple-600/30 border-purple-500/50 text-purple-300' : 'bg-[#222] border-[#444] text-gray-500 hover:text-purple-400 hover:border-purple-500/40'}`}
                                                title={inBasket ? 'Remove from cart' : 'Add to export cart'}
                                            >
                                                {inBasket ? '\u{1F6D2}' : '+\u{1F6D2}'}
                                            </button>
                                        )}
                                        {/* Pad selector button */}
                                        <button
                                            onClick={() => onSelectClipForPad?.(short.id, isSelectedForPad ? -1 : si)}
                                            className={`px-1 py-0.5 text-[9px] rounded-r border-t border-r border-b transition-colors ${isSelectedForPad ? 'bg-yellow-600/30 border-yellow-500/50 text-yellow-300' : hasPadOverride ? 'bg-yellow-900/20 border-yellow-700/40 text-yellow-500' : 'bg-[#222] border-[#444] text-gray-500 hover:text-yellow-400 hover:border-yellow-600/40'}`}
                                            title="Set word padding for this clip"
                                        >
                                            {hasPadOverride ? `±${(override!.before || 0) + (override!.after || 0)}` : '±'}
                                        </button>
                                    </div>
                                    {/* Inline pad editor for selected clip */}
                                    {isSelectedForPad && onSetClipPad && (
                                        <div className="flex items-center gap-1 bg-yellow-950/40 border border-yellow-700/30 rounded px-1.5 py-1 text-[9px]">
                                            <span className="text-yellow-500/70">before</span>
                                            <button onClick={() => onSetClipPad(short.id, si, Math.max(-5, (override?.before ?? 0) - 1), override?.after ?? 0)} className="w-3.5 h-3.5 flex items-center justify-center bg-[#333] rounded text-yellow-300 hover:bg-[#444]">-</button>
                                            <span className="w-3 text-center text-yellow-200">{override?.before ?? 0}</span>
                                            <button onClick={() => onSetClipPad(short.id, si, Math.min(5, (override?.before ?? 0) + 1), override?.after ?? 0)} className="w-3.5 h-3.5 flex items-center justify-center bg-[#333] rounded text-yellow-300 hover:bg-[#444]">+</button>
                                            <span className="text-yellow-500/70 ml-1">after</span>
                                            <button onClick={() => onSetClipPad(short.id, si, override?.before ?? 0, Math.max(-5, (override?.after ?? 0) - 1))} className="w-3.5 h-3.5 flex items-center justify-center bg-[#333] rounded text-yellow-300 hover:bg-[#444]">-</button>
                                            <span className="w-3 text-center text-yellow-200">{override?.after ?? 0}</span>
                                            <button onClick={() => onSetClipPad(short.id, si, override?.before ?? 0, Math.min(5, (override?.after ?? 0) + 1))} className="w-3.5 h-3.5 flex items-center justify-center bg-[#333] rounded text-yellow-300 hover:bg-[#444]">+</button>
                                            {(override?.before || override?.after) ? (
                                                <button onClick={() => onSetClipPad(short.id, si, 0, 0)} className="ml-1 text-[8px] text-red-400 hover:text-red-300">clr</button>
                                            ) : null}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

// ==================== Short Thumbnail Player ====================

const ShortThumbnailPlayer: React.FC<{
    short: GeneratedShort;
    videoId: string;
    shortIndex: number;
    omittedClips?: Set<number>;
    clipBasket: ClipReference[];
    clipPadOverrides: Map<string, { before: number; after: number }>;
    selectedClipForPad: { shortId: string; segmentIndex: number } | null;
    onToggleOmit: (segIdx: number) => void;
    onToggleBasket: (segIdx: number) => void;
    onSelectClipForPad: (shortId: string, segIdx: number) => void;
    onSetClipPad: (shortId: string, segIdx: number, before: number, after: number) => void;
    onAddAllToBasket: () => void;
}> = ({ short, videoId, shortIndex, omittedClips, clipBasket, clipPadOverrides, selectedClipForPad, onToggleOmit, onToggleBasket, onSelectClipForPad, onSetClipPad, onAddAllToBasket }) => {
    const { src, thumbnailUrl } = useLocalVideoSrc(videoId);
    const videoRef = useRef<HTMLVideoElement>(null);
    const stripRef = useRef<HTMLDivElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentClipIdx, setCurrentClipIdx] = useState(0);
    const [scrubProgress, setScrubProgress] = useState(0);
    const animFrameRef = useRef<number>(0);
    const [selectedSegIdx, setSelectedSegIdx] = useState<number | null>(null);
    const dragStartRef = useRef<{ x: number; time: number } | null>(null);

    const totalDuration = short.segments.reduce((sum, s) => sum + (s.endTime - s.startTime), 0);
    const hasVideo = !!src;

    const handlePlayPause = (e: React.MouseEvent) => {
        e.stopPropagation();
        const video = videoRef.current;
        if (!video) return;
        if (isPlaying) {
            video.pause();
            cancelAnimationFrame(animFrameRef.current);
            setIsPlaying(false);
        } else {
            setCurrentClipIdx(0);
            video.currentTime = short.segments[0].startTime;
            video.play().then(() => setIsPlaying(true)).catch(() => {});
        }
    };

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !isPlaying) return;
        let clipIdx = currentClipIdx;

        const tick = () => {
            if (!video || video.paused) return;
            const seg = short.segments[clipIdx];
            if (!seg) { video.pause(); setIsPlaying(false); return; }

            if (video.currentTime >= seg.endTime) {
                clipIdx++;
                if (clipIdx >= short.segments.length) {
                    video.pause(); setIsPlaying(false); setScrubProgress(0); setCurrentClipIdx(0); return;
                }
                setCurrentClipIdx(clipIdx);
                video.currentTime = short.segments[clipIdx].startTime;
            }

            let elapsed = 0;
            for (let i = 0; i < clipIdx; i++) elapsed += short.segments[i].endTime - short.segments[i].startTime;
            elapsed += video.currentTime - short.segments[clipIdx].startTime;
            setScrubProgress(totalDuration > 0 ? elapsed / totalDuration : 0);
            animFrameRef.current = requestAnimationFrame(tick);
        };

        animFrameRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animFrameRef.current);
    }, [isPlaying, currentClipIdx, short.segments, totalDuration]);

    const scrubToProgress = (pct: number) => {
        const video = videoRef.current;
        if (!video) return;
        const targetTime = pct * totalDuration;
        let accumulated = 0;
        for (let i = 0; i < short.segments.length; i++) {
            const dur = short.segments[i].endTime - short.segments[i].startTime;
            if (accumulated + dur > targetTime || i === short.segments.length - 1) {
                video.currentTime = short.segments[i].startTime + Math.min(targetTime - accumulated, dur - 0.05);
                setCurrentClipIdx(i);
                setScrubProgress(pct);
                break;
            }
            accumulated += dur;
        }
    };

    const handleStripMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (!hasVideo) return;
        dragStartRef.current = { x: e.clientX, time: Date.now() };

        const onMouseMove = (ev: MouseEvent) => {
            if (!dragStartRef.current || !stripRef.current) return;
            const dx = Math.abs(ev.clientX - dragStartRef.current.x);
            if (dx > 4) {
                const rect = stripRef.current.getBoundingClientRect();
                scrubToProgress(Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)));
            }
        };

        const onMouseUp = (ev: MouseEvent) => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            if (!dragStartRef.current || !stripRef.current) return;
            const dx = Math.abs(ev.clientX - dragStartRef.current.x);
            const dt = Date.now() - dragStartRef.current.time;
            dragStartRef.current = null;

            if (dx < 5 && dt < 300) {
                // Click — find which segment was clicked
                const rect = stripRef.current.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
                let acc = 0;
                for (let i = 0; i < short.segments.length; i++) {
                    const dur = short.segments[i].endTime - short.segments[i].startTime;
                    const segPct = totalDuration > 0 ? dur / totalDuration : 1 / short.segments.length;
                    if (pct <= acc + segPct || i === short.segments.length - 1) {
                        setSelectedSegIdx(prev => prev === i ? null : i);
                        break;
                    }
                    acc += segPct;
                }
            }
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    const selIdx = selectedSegIdx;
    const padKey = selIdx !== null ? `${short.id}_${selIdx}` : '';
    const override = clipPadOverrides.get(padKey);
    const isSelectedForPad = selIdx !== null && selectedClipForPad?.shortId === short.id && selectedClipForPad?.segmentIndex === selIdx;

    return (
        <div className="relative bg-black" style={{ aspectRatio: '16/9' }}>
            {thumbnailUrl && <img src={thumbnailUrl} className="absolute inset-0 w-full h-full object-cover" alt="" />}
            {hasVideo && (
                <video ref={videoRef} src={src} className="absolute inset-0 w-full h-full object-cover" playsInline preload="metadata" />
            )}
            {src === '' && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <span className="text-[9px] text-gray-300 bg-black/60 px-1.5 py-0.5 rounded">Not cached — exports fine</span>
                </div>
            )}

            {hasVideo && !isPlaying && (
                <button onClick={handlePlayPause} className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/10 transition-colors group">
                    <div className="w-8 h-8 rounded-full bg-white/90 group-hover:bg-white flex items-center justify-center shadow">
                        <span className="text-black text-sm ml-0.5">&#9654;</span>
                    </div>
                </button>
            )}
            {isPlaying && <button onClick={handlePlayPause} className="absolute inset-0" />}

            {/* Action row for selected clip — floats just above the strip */}
            {selIdx !== null && (
                <div
                    className="absolute left-0 right-0 flex items-center gap-1 px-2 py-1 bg-black/85"
                    style={{ bottom: 24 }}
                    onClick={e => e.stopPropagation()}
                >
                    <span className="text-[9px] text-gray-400 font-mono mr-1">C{selIdx + 1}</span>
                    <button
                        onClick={() => onToggleOmit(selIdx)}
                        className={`px-1.5 py-0.5 text-[9px] rounded border transition-colors ${omittedClips?.has(selIdx) ? 'bg-red-900/40 border-red-500/50 text-red-400' : 'bg-[#222] border-[#444] text-gray-300 hover:border-red-500/40 hover:text-red-400'}`}
                    >
                        {omittedClips?.has(selIdx) ? '✕ Omitted' : 'Omit'}
                    </button>
                    <button
                        onClick={() => onToggleBasket(selIdx)}
                        className={`px-1.5 py-0.5 text-[9px] rounded border transition-colors ${clipBasket.some(c => c.shortId === short.id && c.segmentIndex === selIdx) ? 'bg-purple-600/30 border-purple-500/50 text-purple-300' : 'bg-[#222] border-[#444] text-gray-500 hover:border-purple-500/40 hover:text-purple-300'}`}
                    >
                        {clipBasket.some(c => c.shortId === short.id && c.segmentIndex === selIdx) ? '🛒 In Cart' : '+🛒'}
                    </button>
                    <button
                        onClick={() => onSelectClipForPad(short.id, isSelectedForPad ? -1 : selIdx)}
                        className={`px-1.5 py-0.5 text-[9px] rounded border transition-colors ${isSelectedForPad ? 'bg-yellow-600/30 border-yellow-500/50 text-yellow-300' : override && (override.before !== 0 || override.after !== 0) ? 'bg-yellow-900/20 border-yellow-700/40 text-yellow-500' : 'bg-[#222] border-[#444] text-gray-500 hover:text-yellow-400'}`}
                    >
                        {override && (override.before !== 0 || override.after !== 0) ? `±${(override.before || 0) + (override.after || 0)}` : '±w'}
                    </button>
                    {isSelectedForPad && (
                        <>
                            <button onClick={() => onSetClipPad(short.id, selIdx, Math.max(-5, (override?.before ?? 0) - 1), override?.after ?? 0)} className="w-4 h-4 flex items-center justify-center bg-[#333] rounded text-[9px] text-yellow-300">−</button>
                            <span className="w-4 text-center text-[9px] text-yellow-200">{override?.before ?? 0}</span>
                            <button onClick={() => onSetClipPad(short.id, selIdx, Math.min(5, (override?.before ?? 0) + 1), override?.after ?? 0)} className="w-4 h-4 flex items-center justify-center bg-[#333] rounded text-[9px] text-yellow-300">+</button>
                            <span className="text-gray-600 text-[9px]">/</span>
                            <button onClick={() => onSetClipPad(short.id, selIdx, override?.before ?? 0, Math.max(-5, (override?.after ?? 0) - 1))} className="w-4 h-4 flex items-center justify-center bg-[#333] rounded text-[9px] text-yellow-300">−</button>
                            <span className="w-4 text-center text-[9px] text-yellow-200">{override?.after ?? 0}</span>
                            <button onClick={() => onSetClipPad(short.id, selIdx, override?.before ?? 0, Math.min(5, (override?.after ?? 0) + 1))} className="w-4 h-4 flex items-center justify-center bg-[#333] rounded text-[9px] text-yellow-300">+</button>
                        </>
                    )}
                    <button onClick={() => setSelectedSegIdx(null)} className="ml-auto text-gray-600 hover:text-white text-[10px]">✕</button>
                </div>
            )}

            {/* Segmented timeline strip */}
            <div
                ref={stripRef}
                className="absolute bottom-0 left-0 right-0 h-6 cursor-pointer select-none"
                style={{ userSelect: 'none' }}
                onMouseDown={handleStripMouseDown}
            >
                {/* Segment blocks */}
                <div className="absolute inset-0 flex">
                    {short.segments.map((seg, i) => {
                        const dur = seg.endTime - seg.startTime;
                        const widthPct = totalDuration > 0 ? (dur / totalDuration) * 100 : 100 / short.segments.length;
                        const isOmitted = omittedClips?.has(i);
                        const inCart = clipBasket.some(c => c.shortId === short.id && c.segmentIndex === i);
                        const isSelected = selectedSegIdx === i;
                        let bg = 'bg-[#2a2a2a]';
                        if (isOmitted) bg = 'bg-red-900/60';
                        else if (inCart) bg = 'bg-purple-800/60';
                        else if (isSelected) bg = 'bg-[#444]';
                        return (
                            <div key={i} className={`${bg} h-full relative border-r border-black/40 transition-colors`} style={{ width: `${widthPct}%` }}>
                                <span className="absolute inset-0 flex items-center justify-center text-[8px] text-white/50 pointer-events-none select-none">{i + 1}</span>
                            </div>
                        );
                    })}
                </div>
                {/* Progress line */}
                <div className="absolute top-0 left-0 h-0.5 bg-purple-400 pointer-events-none" style={{ width: `${scrubProgress * 100}%` }} />
                {/* Playhead */}
                <div className="absolute top-0 bottom-0 w-0.5 bg-white/70 pointer-events-none" style={{ left: `${scrubProgress * 100}%` }} />
            </div>

            <div className="absolute top-1 right-1 bg-black/70 text-[9px] text-white px-1 py-0.5 rounded">
                {Math.round(totalDuration)}s
            </div>
        </div>
    );
};

// ==================== Main Component ====================

export const ContentLibraryPage: React.FC<{
    onNavigateToEditor?: () => void;
    onExportShort?: (short: GeneratedShort) => Promise<void>;
    autoCenterOnImport?: boolean;
    onToggleAutoCenter?: (enabled: boolean) => void;
    project?: any;
    onProjectLoad?: (project: any) => void;
}> = ({ onNavigateToEditor, onExportShort, autoCenterOnImport = false, onToggleAutoCenter, project, onProjectLoad }) => {
    // State
    const [isExporting, setIsExporting] = useState(false);
    const [bundleProgress, setBundleProgress] = useState<string | null>(null);
    const [lastExportBundleId, setLastExportBundleId] = useState<string | null>(null);
    const [bundleUrlInput, setBundleUrlInput] = useState('');
    const importBundleInputRef = useRef<HTMLInputElement>(null);
    const [urlInput, setUrlInput] = useState('');
    const [importing, setImporting] = useState<ImportingVideo[]>([]);
    const [videos, setVideos] = useState<VideoRecord[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
    const [selectedSegments, setSelectedSegments] = useState<TranscriptSegment[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterCategory, setFilterCategory] = useState<string>('all');
    const [isLoading, setIsLoading] = useState(true);
    const [stats, setStats] = useState({ videoCount: 0, segmentCount: 0, categoryCount: 0, shortCount: 0 });

    // Category modal
    const [showCategoryModal, setShowCategoryModal] = useState(false);
    const [newCategoryName, setNewCategoryName] = useState('');
    const [newCategoryColor, setNewCategoryColor] = useState('#6366f1');

    // AI Search State
    const [activeTab, setActiveTab] = useState<'videos' | 'ai-search' | 'shorts' | 'trends'>('videos');
    const [aiSearchQuery, setAiSearchQuery] = useState('');
    const [aiSearchResults, setAiSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [generatedShorts, setGeneratedShorts] = useState<GeneratedShort[]>([]);

    // AI Cost tracking
    const [showCostPanel, setShowCostPanel] = useState(false);
    const [showShortcutsPanel, setShowShortcutsPanel] = useState(false);
    const [costTotal, setCostTotal] = useState(0);
    const [costLog, setCostLog] = useState<CostEntry[]>([]);

    // Short Generation Modal
    const [showShortModal, setShowShortModal] = useState(false);
    const [shortTargetVideo, setShortTargetVideo] = useState<string | null>(null);
    const [shortPrompt, setShortPrompt] = useState('');
    const [shortDuration, setShortDuration] = useState(60);
    const [isGeneratingShort, setIsGeneratingShort] = useState(false);
    const [generatedShort, setGeneratedShort] = useState<GeneratedShort | null>(null);
    const [generatedShortsPreview, setGeneratedShortsPreview] = useState<GeneratedShort[]>([]);
    const [selectedShortIndex, setSelectedShortIndex] = useState<number | null>(null);
    const [expandedBRoll, setExpandedBRoll] = useState<Record<number, boolean>>({});
    const [expandedKeywords, setExpandedKeywords] = useState<Record<number, boolean>>({});
    const [captionMode, setCaptionMode] = useState<'sentences' | 'words'>('sentences');
    const [refinementPrompt, setRefinementPrompt] = useState('');
    const [selectedModel, setSelectedModel] = useState<string>('gemini-2.5-flash');

    // Clip Assembly Workbench
    const [omittedClips, setOmittedClips] = useState<Map<string, Set<number>>>(new Map());
    const [clipBasket, setClipBasket] = useState<ClipReference[]>([]);
    const [wordPadBefore, setWordPadBefore] = useState(0);
    const [wordPadAfter, setWordPadAfter] = useState(0);
    const [assemblyMode, setAssemblyMode] = useState(false);
    // Per-clip padding overrides: key = `${shortId}_${segIdx}`, value = {before, after}
    const [clipPadOverrides, setClipPadOverrides] = useState<Map<string, { before: number; after: number }>>(new Map());
    // Selected clip for per-clip padding editor: {shortId, segmentIndex}
    const [selectedClipForPad, setSelectedClipForPad] = useState<{ shortId: string; segmentIndex: number } | null>(null);

    // External AI Input
    const [externalAiJson, setExternalAiJson] = useState('');
    const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

    // Saved shorts files (on disk)
    const [savedShortsFileList, setSavedShortsFileList] = useState<SavedShortsInfo[]>([]);
    const [shortsSource, setShortsSource] = useState<'indexeddb' | string>('indexeddb');

    // Filler detection (kept for legacy compatibility)
    const [isDetectingFillers, setIsDetectingFillers] = useState(false);
    const [fillerStatus, setFillerStatus] = useState('');

    // AssemblyAI transcription
    const [useAssemblyAI, setUseAssemblyAI] = useState(false);
    const [hasAssemblyAIKey, setHasAssemblyAIKey] = useState(false);
    const [transcriptionJobs, setTranscriptionJobs] = useState<Map<string, { status: string; detail?: string }>>(new Map());

    // TTS Preview State
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewClipIndex, setPreviewClipIndex] = useState(0);
    const [previewCaption, setPreviewCaption] = useState('');
    const [previewKeywords, setPreviewKeywords] = useState<KeywordEmphasis[]>([]);
    const previewStopRef = useRef(false);

    // Trends State
    const [trendState, setTrendState] = useState<TrendState>(getDefaultTrendState);
    const [trendPreSelected, setTrendPreSelected] = useState<TrendItem[]>([]);

    const handleRefreshTrends = async () => {
        setTrendState(prev => ({ ...prev, loading: true, error: null }));
        try {
            const items = await fetchAllTrends(trendState.activeFilters);
            // Save previous ranks for animations
            const previousRanks: Record<string, number> = {};
            for (const item of trendState.items) {
                previousRanks[item.id] = item.rank;
            }
            setTrendState(prev => ({
                ...prev,
                items,
                previousRanks,
                loading: false,
                lastFetched: Date.now(),
            }));
        } catch (err: any) {
            setTrendState(prev => ({ ...prev, loading: false, error: err.message }));
        }
    };

    const handleTrendFiltersChange = (filters: typeof trendState.activeFilters) => {
        setTrendState(prev => ({ ...prev, activeFilters: filters }));
    };

    // Auto-fetch when trends tab is first opened
    const trendsFetchedRef = useRef(false);
    useEffect(() => {
        if (activeTab === 'trends' && !trendsFetchedRef.current && trendState.items.length === 0) {
            trendsFetchedRef.current = true;
            handleRefreshTrends();
        }
    }, [activeTab]);

    // Re-fetch when filters change (if we already have data)
    useEffect(() => {
        if (activeTab === 'trends' && trendState.lastFetched) {
            handleRefreshTrends();
        }
    }, [trendState.activeFilters.source, trendState.activeFilters.category, trendState.activeFilters.region, trendState.activeFilters.timeRange]);

    // Group shorts by video for display
    const shortsByVideo = useMemo(() => {
        const groups: Record<string, GeneratedShort[]> = {};
        generatedShorts.forEach(short => {
            if (!groups[short.videoId]) groups[short.videoId] = [];
            groups[short.videoId].push(short);
        });
        return groups;
    }, [generatedShorts]);

    // Load data on mount
    useEffect(() => {
        loadData();
        initCostTracker().then(() => {
            setCostTotal(getSessionTotal());
            setCostLog(getSessionLog());
        });
        // Check AssemblyAI key availability
        fetch('/api/keys').then(r => r.json()).then(keys => {
            setHasAssemblyAIKey(!!keys.ASSEMBLYAI_API_KEY);
        }).catch(() => {});
    }, []);

    // Subscribe to cost updates
    useEffect(() => {
        const sync = () => { setCostTotal(getSessionTotal()); setCostLog(getSessionLog()); };
        onCostUpdate(sync);
        return () => offCostUpdate(sync);
    }, []);

    const loadData = async () => {
        setIsLoading(true);
        try {
            const [videosData, categoriesData, statsData, shortsData] = await Promise.all([
                contentDB.getAllVideos(),
                contentDB.getAllCategories(),
                contentDB.getStats(),
                contentDB.getAllShorts()
            ]);
            setVideos(videosData);
            setCategories(categoriesData);
            setStats(statsData);
            setGeneratedShorts(shortsData);
        } catch (err) {
            console.error('Failed to load data:', err);
        }
        setIsLoading(false);
    };

    // Load segments when video selected
    useEffect(() => {
        if (selectedVideoId) {
            contentDB.getSegmentsByVideoId(selectedVideoId).then(setSelectedSegments);
        } else {
            setSelectedSegments([]);
        }
    }, [selectedVideoId]);

    // ==================== AI Search ====================

    const handleAiSearch = async () => {
        if (!aiSearchQuery.trim() || videos.length === 0) return;

        setIsSearching(true);
        setAiSearchResults([]);

        try {
            const results = await searchTranscripts(aiSearchQuery);
            setAiSearchResults(results);
        } catch (err: any) {
            console.error('AI Search error:', err);
            alert('Search failed: ' + err.message);
        }

        setIsSearching(false);
    };

    const handleGenerateShort = async () => {
        if (!shortTargetVideo) return;

        setIsGeneratingShort(true);
        setGeneratedShort(null);
        setGeneratedShortsPreview([]);
        setSelectedShortIndex(null);
        setExpandedBRoll({});
        setExpandedKeywords({});

        try {
            // Find existing shorts for this video to avoid duplication
            const existingShorts = generatedShorts
                .filter(s => s.videoId === shortTargetVideo)
                .map(s => ({
                    title: s.title,
                    startTime: s.segments[0]?.startTime || 0,
                    endTime: s.segments[s.segments.length - 1]?.endTime || 0
                }));

            const result = await generateShort(shortTargetVideo, shortPrompt, shortDuration, undefined, existingShorts, selectedModel);
            if (result.success) {
                const allGenerated = result.shorts || (result.short ? [result.short] : []);
                if (allGenerated.length > 0) {
                    setGeneratedShortsPreview(allGenerated);
                    setGeneratedShort(allGenerated[0]); // Keep first as fallback
                    loadData(); // Refresh shorts list
                    // Auto-save shorts to file
                    const videoRecord = videos.find(v => v.id === shortTargetVideo);
                    contentDB.getAllShorts().then(allShorts => {
                        const videoShorts = allShorts.filter(s => s.videoId === shortTargetVideo);
                        saveShortsToFile(shortTargetVideo, videoRecord?.title || shortTargetVideo, videoShorts).catch(e => console.warn('Shorts file save failed:', e));
                    });
                } else {
                    alert('No shorts generated');
                }
            } else {
                alert('Failed to generate short: ' + (result.error || 'Unknown error'));
            }
        } catch (err: any) {
            console.error('Short generation error:', err);
            alert('Generation failed: ' + err.message);
        }

        setIsGeneratingShort(false);
    };

    const handleCopyPrompt = async () => {
        if (!shortTargetVideo) return;
        setIsGeneratingPrompt(true);
        try {
            const existingShorts = generatedShorts
                .filter(s => s.videoId === shortTargetVideo)
                .map(s => ({
                    title: s.title,
                    startTime: s.segments[0]?.startTime || 0,
                    endTime: s.segments[s.segments.length - 1]?.endTime || 0
                }));

            const result = await buildShortPrompt(shortTargetVideo, shortPrompt, shortDuration, refinementPrompt, existingShorts);
            if (result.success && result.prompt) {
                // Try Clipboard API first, fall back to execCommand for permission-denied contexts
                let copied = false;
                try {
                    await navigator.clipboard.writeText(result.prompt);
                    copied = true;
                } catch {
                    // Fallback: textarea + execCommand
                    const ta = document.createElement('textarea');
                    ta.value = result.prompt;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    copied = document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                if (copied) {
                    alert("Prompt copied to clipboard! Paste this into ChatGPT or Claude.");
                } else {
                    console.log('Generated prompt:\n', result.prompt);
                    alert("Could not copy to clipboard. The prompt has been logged to the browser console (F12) — you can copy it from there.");
                }
            } else {
                alert('Failed to generate prompt: ' + (result.error || 'Unknown error'));
            }
        } catch (err: any) {
            console.error('Prompt generation error:', err);
            alert('Generation failed: ' + err.message);
        }
        setIsGeneratingPrompt(false);
    };

    const handleImportJson = async () => {
        if (!shortTargetVideo || !externalAiJson.trim()) return;
        try {
            const result = await importManualShort(shortTargetVideo, externalAiJson, shortPrompt || "External AI (Manual Import)");
            if (result.success) {
                const allImported = result.shorts || (result.short ? [result.short] : []);
                if (allImported.length > 0) {
                    setGeneratedShortsPreview(allImported);
                    setGeneratedShort(allImported[0]);
                    setSelectedShortIndex(null);
                    setExternalAiJson('');
                    loadData();
                    const videoRecord = videos.find(v => v.id === shortTargetVideo);
                    contentDB.getAllShorts().then(allShorts => {
                        const videoShorts = allShorts.filter(s => s.videoId === shortTargetVideo);
                        saveShortsToFile(shortTargetVideo, videoRecord?.title || shortTargetVideo, videoShorts).catch(e => console.warn('Shorts file save failed:', e));
                    });
                }
            } else {
                alert('Failed to import JSON: ' + (result.error || 'Unknown error'));
            }
        } catch (err: any) {
            console.error('JSON import error:', err);
            alert('Import failed: ' + err.message);
        }
    };

    // TTS Preview Functions
    const playPreview = async (short: GeneratedShort) => {
        if (isPreviewPlaying) {
            stopPreview();
            return;
        }

        previewStopRef.current = false;
        setIsPreviewPlaying(true);
        setPreviewClipIndex(0);

        // Get the speech synthesis instance
        const synth = window.speechSynthesis;

        // Play each clip sequentially
        for (let i = 0; i < short.segments.length; i++) {
            // Check if stopped using ref (not state)
            if (previewStopRef.current) break;

            setPreviewClipIndex(i);
            const segment = short.segments[i];
            setPreviewCaption(segment.text);
            setPreviewKeywords(segment.keywords || []);

            // Create utterance
            const utterance = new SpeechSynthesisUtterance(segment.text);
            utterance.rate = 1.0;
            utterance.pitch = 1.0;

            // Wait for speech to complete
            await new Promise<void>((resolve) => {
                utterance.onend = () => resolve();
                utterance.onerror = () => resolve();
                synth.speak(utterance);
            });
        }

        setIsPreviewPlaying(false);
        setPreviewCaption('');
    };

    const stopPreview = () => {
        previewStopRef.current = true;
        window.speechSynthesis.cancel();
        setIsPreviewPlaying(false);
        setPreviewCaption('');
        setPreviewKeywords([]);
        setPreviewClipIndex(0);
    };

    const handleWordClickToAddKeyword = (segIdx: number, wordIndex: number, word: string) => {
        if (!generatedShort) return;
        const updated = { ...generatedShort };
        updated.segments = updated.segments.map((seg, si) => {
            if (si !== segIdx) return seg;
            const existing = seg.keywords || [];
            const found = existing.findIndex(k => k.wordIndex === wordIndex);
            if (found >= 0) {
                // Remove keyword
                return { ...seg, keywords: existing.filter((_, i) => i !== found) };
            } else {
                // Add keyword
                const cleanWord = word.toLowerCase().replace(/[.,!?;:'"()]/g, '');
                return { ...seg, keywords: [...existing, { word: cleanWord, wordIndex, enabled: true }] };
            }
        });
        setGeneratedShort(updated);
        contentDB.updateShort(updated);
    };

    const handleToggleRemoveWord = (segIdx: number, wordIndex: number) => {
        if (!generatedShort) return;
        const updated = { ...generatedShort };
        updated.segments = updated.segments.map((seg, si) => {
            if (si !== segIdx) return seg;
            const removed = seg.removedWordIndices || [];
            const isRemoved = removed.includes(wordIndex);
            return {
                ...seg,
                removedWordIndices: isRemoved
                    ? removed.filter(i => i !== wordIndex)
                    : [...removed, wordIndex],
            };
        });
        setGeneratedShort(updated);
        contentDB.updateShort(updated);
    };

    /** Detect fillers from short transcript text and mark them as removed words */
    const handleRemoveFillers = async () => {
        if (!generatedShort || isDetectingFillers) return;
        setIsDetectingFillers(true);
        setFillerStatus('Analyzing transcript...');

        try {
            // Build transcript from short segments
            const transcript = generatedShort.segments.map(seg => ({
                startTime: seg.startTime,
                endTime: seg.endTime,
                text: seg.text,
            }));

            const detections = await detectFillersFromTranscript(transcript, setFillerStatus);

            if (detections.length === 0) {
                setFillerStatus('No fillers found');
                setTimeout(() => setFillerStatus(''), 2000);
                return;
            }

            // Map detections to word indices in each segment
            const updated = { ...generatedShort };
            updated.segments = updated.segments.map(seg => {
                const segFillers = detections.filter(d =>
                    d.startTime < seg.endTime && d.endTime > seg.startTime
                );
                if (segFillers.length === 0) return seg;

                const words = seg.text.split(/\s+/);
                const newRemoved = new Set(seg.removedWordIndices || []);

                for (const filler of segFillers) {
                    const fillerWords = filler.text.toLowerCase().split(/\s+/);
                    // Find matching word sequence in segment text
                    for (let i = 0; i <= words.length - fillerWords.length; i++) {
                        if (newRemoved.has(i)) continue;
                        const match = fillerWords.every((fw, fi) =>
                            words[i + fi].toLowerCase().replace(/[.,!?;:'"()-]/g, '') === fw.replace(/[.,!?;:'"()-]/g, '')
                        );
                        if (match) {
                            // For repeated words ("the the"), only remove the second occurrence
                            const startIdx = filler.type === 'repeated' ? Math.ceil(fillerWords.length / 2) : 0;
                            for (let fi = startIdx; fi < fillerWords.length; fi++) {
                                newRemoved.add(i + fi);
                            }
                            break;
                        }
                    }
                }

                return { ...seg, removedWordIndices: [...newRemoved] };
            });

            setGeneratedShort(updated);
            contentDB.updateShort(updated);
            setFillerStatus(`Marked ${detections.length} fillers for removal`);
            setTimeout(() => setFillerStatus(''), 3000);
        } catch (e) {
            console.error('[ContentLibrary] Filler detection failed:', e);
            setFillerStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        } finally {
            setIsDetectingFillers(false);
        }
    };

    const renderInteractiveText = (text: string, segIdx: number, keywords?: KeywordEmphasis[], removedWordIndices?: number[]) => {
        const words = text.split(/(\s+)/);
        const removedSet = new Set(removedWordIndices || []);
        let wordIdx = 0;
        return words.map((token, i) => {
            if (/^\s+$/.test(token)) return <span key={i}>{token}</span>;
            const currentIdx = wordIdx++;
            const kw = keywords?.find(k => k.wordIndex === currentIdx && k.enabled);
            const isRemoved = removedSet.has(currentIdx);
            return (
                <span
                    key={i}
                    onClick={(e) => { e.stopPropagation(); handleWordClickToAddKeyword(segIdx, currentIdx, token); }}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); handleToggleRemoveWord(segIdx, currentIdx); }}
                    className={`cursor-pointer hover:bg-white/10 rounded px-0.5 transition-colors ${kw ? 'font-bold' : ''} ${isRemoved ? 'line-through opacity-40' : ''}`}
                    style={{ color: kw ? (kw.color || '#FFD700') : undefined }}
                    title={isRemoved ? 'Right-click to restore' : kw ? 'Click to remove keyword | Right-click to strike out' : 'Click to add keyword | Right-click to strike out'}
                >
                    {token}
                </span>
            );
        });
    };

    const toggleKeyword = (segIdx: number, kwIdx: number) => {
        if (!generatedShort) return;
        const updated = { ...generatedShort };
        updated.segments = updated.segments.map((seg, si) => {
            if (si !== segIdx || !seg.keywords) return seg;
            return {
                ...seg,
                keywords: seg.keywords.map((kw, ki) =>
                    ki === kwIdx ? { ...kw, enabled: !kw.enabled } : kw
                )
            };
        });
        setGeneratedShort(updated);
        contentDB.updateShort(updated);
    };

    const openShortGenerator = (videoId: string, prefillPrompt?: string) => {
        setShortTargetVideo(videoId);
        setShortPrompt(prefillPrompt || '');
        setRefinementPrompt('');
        setGeneratedShort(null);
        setShowShortModal(true);
    };

    const handleDeleteShort = async (shortId: string) => {
        if (!confirm('Delete this generated short?')) return;
        // Find which video this short belongs to before deleting
        const shortToDelete = generatedShorts.find(s => s.id === shortId);
        await contentDB.deleteShort(shortId);
        loadData();
        // Update shorts file on disk
        if (shortToDelete) {
            const videoId = shortToDelete.videoId;
            const videoRecord = videos.find(v => v.id === videoId);
            contentDB.getAllShorts().then(allShorts => {
                const remaining = allShorts.filter(s => s.videoId === videoId);
                saveShortsToFile(videoId, videoRecord?.title || videoId, remaining).catch(e => console.warn('Shorts file save failed:', e));
            });
        }
    };

    // ==================== Import Logic ====================

    const extractVideoId = (url: string): string | null => {
        const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    };

    const handleAddUrls = () => {
        const urls = urlInput.split(/[\n,]/).map(u => u.trim()).filter(u => u.length > 0);
        if (urls.length === 0) return;

        const newImports: ImportingVideo[] = urls.map(url => ({ url, status: 'pending' as const }));
        setImporting(prev => [...prev, ...newImports]);
        setUrlInput('');
        urls.forEach(url => importVideo(url));
    };

    const importVideo = async (url: string) => {
        const videoId = extractVideoId(url);
        if (!videoId) {
            setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'error', error: 'Invalid YouTube URL' } : v));
            return;
        }

        const existing = await contentDB.getVideo(videoId);
        if (existing) {
            setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'error', error: 'Already imported' } : v));
            return;
        }

        setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'fetching' } : v));

        try {
            const transcriptRes = await fetch(`/api/transcript?url=${encodeURIComponent(url)}`);
            if (!transcriptRes.ok) {
                const err = await transcriptRes.json();
                throw new Error(err.error || 'Failed to fetch transcript');
            }
            const transcriptData = await transcriptRes.json();

            let videoInfo = { title: transcriptData.title || `Video ${videoId}`, channelName: '', thumbnailUrl: '' };
            try {
                const infoRes = await fetch(`/api/video-info?url=${encodeURIComponent(url)}`);
                if (infoRes.ok) {
                    const info = await infoRes.json();
                    videoInfo = {
                        title: info.title || videoInfo.title,
                        channelName: info.channel || info.uploader || '',
                        thumbnailUrl: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
                    };
                }
            } catch {
                videoInfo.thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
            }

            const segments = transcriptData.segments || [];
            const duration = segments.length > 0 ? Math.max(...segments.map((s: any) => s.start + (s.duration || 0))) : 0;

            const video: VideoRecord = {
                id: videoId, url, title: videoInfo.title, channelName: videoInfo.channelName,
                thumbnailUrl: videoInfo.thumbnailUrl, duration, importedAt: new Date(), categories: [],
                transcriptSource: segments.length > 0 ? 'youtube' : 'none',
            };

            const dbSegments: TranscriptSegment[] = segments.map((seg: any, index: number) => ({
                id: `${videoId}_${index}`, videoId, start: seg.start || 0, duration: seg.duration || 0, text: seg.text || ''
            }));

            await contentDB.addVideo(video);
            await contentDB.addSegments(dbSegments);
            setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'done' } : v));
            loadData();

            // If AssemblyAI checkbox is on, auto-trigger transcription
            if (useAssemblyAI && hasAssemblyAIKey) {
                transcribeVideo(videoId, url);
            }
        } catch (err: any) {
            console.error('Import error:', err);
            setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'error', error: err.message } : v));
        }
    };

    const clearCompleted = () => setImporting(prev => prev.filter(v => v.status !== 'done' && v.status !== 'error'));

    // ==================== AssemblyAI Transcription ====================

    const transcribeVideo = async (videoId: string, youtubeUrl: string) => {
        setTranscriptionJobs(prev => new Map(prev).set(videoId, { status: 'starting' }));

        try {
            const formData = new FormData();
            formData.append('youtubeUrl', youtubeUrl);

            const response = await fetch('/api/transcribe', { method: 'POST', body: formData });

            if (!response.ok || !response.body) {
                throw new Error('Transcription request failed');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(line.slice(6));

                        if (data.status === 'error') {
                            setTranscriptionJobs(prev => new Map(prev).set(videoId, { status: 'error', detail: data.detail }));
                            return;
                        }

                        if (data.status === 'completed' && data.events) {
                            // Convert AssemblyAI events to TranscriptSegments
                            const newSegments: TranscriptSegment[] = data.events.map((evt: any, idx: number) => ({
                                id: `${videoId}_${idx}`,
                                videoId,
                                start: evt.startTime || 0,
                                duration: (evt.endTime || 0) - (evt.startTime || 0),
                                text: evt.details || evt.text || '',
                                wordTimings: evt.wordTimings || undefined,
                            }));

                            // Clear old segments and replace with AssemblyAI ones
                            await contentDB.deleteSegmentsByVideoId(videoId);
                            await contentDB.addSegments(newSegments);
                            await contentDB.updateVideo(videoId, { transcriptSource: 'assemblyai' });

                            setTranscriptionJobs(prev => new Map(prev).set(videoId, { status: 'completed' }));
                            loadData();
                            // Refresh segments if this video is currently selected
                            if (selectedVideoId === videoId) {
                                contentDB.getSegmentsByVideoId(videoId).then(setSelectedSegments);
                            }
                            // Clear job status after 3 seconds
                            setTimeout(() => {
                                setTranscriptionJobs(prev => { const m = new Map(prev); m.delete(videoId); return m; });
                            }, 3000);
                            return;
                        }

                        // Progress updates
                        setTranscriptionJobs(prev => new Map(prev).set(videoId, {
                            status: data.status,
                            detail: data.detail || data.status,
                        }));
                    } catch { /* skip malformed SSE lines */ }
                }
            }
        } catch (err: any) {
            console.error('[Transcribe] Error:', err);
            setTranscriptionJobs(prev => new Map(prev).set(videoId, { status: 'error', detail: err.message }));
        }
    };

    // ==================== Category Logic ====================

    const handleAddCategory = async () => {
        if (!newCategoryName.trim()) return;
        const category: Category = { id: generateId(), name: newCategoryName.trim(), color: newCategoryColor, description: '' };
        await contentDB.addCategory(category);
        setCategories(prev => [...prev, category]);
        setNewCategoryName('');
        setShowCategoryModal(false);
        loadData();
    };

    const handleDeleteCategory = async (id: string) => {
        await contentDB.deleteCategory(id);
        setCategories(prev => prev.filter(c => c.id !== id));
        loadData();
    };

    const toggleVideoCategory = async (videoId: string, categoryId: string) => {
        const video = videos.find(v => v.id === videoId);
        if (!video) return;
        const newCategories = video.categories.includes(categoryId)
            ? video.categories.filter(c => c !== categoryId) : [...video.categories, categoryId];
        await contentDB.updateVideoCategories(videoId, newCategories);
        setVideos(prev => prev.map(v => v.id === videoId ? { ...v, categories: newCategories } : v));
    };

    const handleDeleteVideo = async (videoId: string) => {
        if (!confirm('Delete this video and all its transcript data?')) return;
        await contentDB.deleteVideo(videoId);
        if (selectedVideoId === videoId) setSelectedVideoId(null);
        loadData();
    };

    // ==================== Filter Logic ====================

    const filteredVideos = videos.filter(video => {
        if (filterCategory !== 'all' && !video.categories.includes(filterCategory)) return false;
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            return video.title.toLowerCase().includes(q) || video.channelName.toLowerCase().includes(q);
        }
        return true;
    });

    // ==================== Helpers ====================

    const formatDuration = (seconds: number): string => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const formatTime = (seconds: number): string => {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    // ==================== Clip Assembly ====================

    // perClipPadKeys: parallel array of pad-override map keys (e.g. "shortId_segIdx") for each segment
    const applyWordPadding = async (
        segments: ShortSegment[],
        videoId: string,
        globalBefore: number,
        globalAfter: number,
        perClipPadKeys?: string[]
    ): Promise<ShortSegment[]> => {
        // Check if any adjustment is needed at all (positive = add words, negative = remove words)
        const anyPad = globalBefore !== 0 || globalAfter !== 0 ||
            (perClipPadKeys?.some(k => { const o = clipPadOverrides.get(k); return o && (o.before !== 0 || o.after !== 0); }) ?? false);
        if (!anyPad) return segments;

        // Fetch all word timings for this video
        const allTranscriptSegs = await contentDB.getSegmentsByVideoId(videoId);
        const allWords: Array<{ text: string; start: number; end: number }> = [];
        for (const seg of allTranscriptSegs) {
            if (seg.wordTimings) {
                for (const wt of seg.wordTimings) {
                    if (wt.text && wt.start != null && wt.end != null) {
                        allWords.push({ text: wt.text, start: wt.start, end: wt.end });
                    }
                }
            }
        }
        if (allWords.length === 0) return segments;
        allWords.sort((a, b) => a.start - b.start);

        return segments.map((clip, idx) => {
            // Per-clip override takes precedence over global
            const padKey = perClipPadKeys?.[idx];
            const override = padKey ? clipPadOverrides.get(padKey) : undefined;
            const padBefore = override ? override.before : globalBefore;
            const padAfter = override ? override.after : globalAfter;
            if (padBefore === 0 && padAfter === 0) return clip;

            const firstIdx = allWords.findIndex(w => w.start >= clip.startTime - 0.05);
            let lastIdx = -1;
            for (let i = allWords.length - 1; i >= 0; i--) {
                if (allWords[i].end <= clip.endTime + 0.05) { lastIdx = i; break; }
            }
            if (firstIdx < 0 || lastIdx < 0) return clip;

            // Positive: expand outward. Negative: trim inward (clamp so start <= end).
            const rawStartIdx = firstIdx - padBefore;  // negative padBefore moves start later (trim)
            const rawEndIdx = lastIdx + padAfter;       // negative padAfter moves end earlier (trim)
            const padStartIdx = Math.max(0, Math.min(rawStartIdx, lastIdx));
            const padEndIdx = Math.min(allWords.length - 1, Math.max(rawEndIdx, firstIdx));

            // Guard: if trimming crossed over, just return original
            if (padStartIdx > padEndIdx) return clip;

            const prependWords = padBefore > 0 ? allWords.slice(padStartIdx, firstIdx).map(w => w.text).join(' ') : '';
            const appendWords = padAfter > 0 ? allWords.slice(lastIdx + 1, padEndIdx + 1).map(w => w.text).join(' ') : '';

            // For trimming: rebuild text from the trimmed word range
            let newText: string;
            if (padBefore < 0 || padAfter < 0) {
                const keptWords = allWords.slice(padStartIdx, padEndIdx + 1).map(w => w.text).join(' ');
                newText = keptWords;
            } else {
                newText = [prependWords, clip.text, appendWords].filter(Boolean).join(' ');
            }

            const prependCount = prependWords ? prependWords.split(/\s+/).length : 0;

            return {
                ...clip,
                startTime: allWords[padStartIdx].start,
                endTime: allWords[padEndIdx].end,
                text: newText,
                keywords: clip.keywords?.map(kw => ({ ...kw, wordIndex: kw.wordIndex + prependCount })),
            };
        });
    };

    const buildExportShort = async (): Promise<GeneratedShort | null> => {
        if (!generatedShortsPreview.length) return null;

        let segments: ShortSegment[];
        let perClipPadKeys: string[];
        let title: string;
        let hook: string;
        let hookTitle: string;

        if (clipBasket.length > 0) {
            // Cart takes priority — export cart contents sorted chronologically
            const sorted = [...clipBasket].sort((a, b) => a.segment.startTime - b.segment.startTime);
            segments = sorted.map(c => ({ ...c.segment }));
            perClipPadKeys = sorted.map(c => `${c.shortId}_${c.segmentIndex}`);
            title = 'Custom Assembly';
            hook = '';
            hookTitle = 'Custom Assembly';
        } else {
            // Fall back to selected short with omissions applied
            if (selectedShortIndex === null) return null;
            const short = generatedShortsPreview[selectedShortIndex];
            const omitted = omittedClips.get(short.id);
            const filtered = short.segments.map((seg, i) => ({ seg, i })).filter(({ i }) => !omitted?.has(i));
            if (filtered.length === 0) return null;
            segments = filtered.map(({ seg }) => seg);
            perClipPadKeys = filtered.map(({ i }) => `${short.id}_${i}`);
            title = short.title;
            hook = short.hook;
            hookTitle = short.hookTitle;
        }

        const videoId = generatedShortsPreview[0].videoId;
        segments = await applyWordPadding(segments, videoId, wordPadBefore, wordPadAfter, perClipPadKeys);

        const baseShort = assemblyMode ? generatedShortsPreview[0] : generatedShortsPreview[selectedShortIndex!];
        return {
            ...baseShort,
            id: `assembly_${Date.now()}`,
            title,
            hook,
            hookTitle,
            segments,
            totalDuration: segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0),
            captionMode,
        };
    };

    // ==================== Render ====================

    return (
        <div className="flex h-screen bg-[#0a0a0a] text-white overflow-hidden">
            {/* Sidebar */}
            <div className="w-64 bg-[#111] border-r border-[#222] flex flex-col">
                <div className="p-4 border-b border-[#222]">
                    <h1 className="text-xl font-bold text-indigo-400">Content Library</h1>
                    <p className="text-xs text-gray-500 mt-1">Sermon Transcript Database</p>
                </div>

                {/* Stats */}
                <div className="p-4 border-b border-[#222]">
                    <div className="grid grid-cols-3 gap-2 text-xs mb-3">
                        <div className="bg-[#1a1a1a] rounded p-2">
                            <div className="text-gray-500">Sermons</div>
                            <div className="text-lg font-bold text-white">{stats.videoCount}</div>
                        </div>
                        <div className="bg-[#1a1a1a] rounded p-2">
                            <div className="text-gray-500">Shorts</div>
                            <div className="text-lg font-bold text-white">{stats.shortCount}</div>
                        </div>
                        <div
                            className={`bg-[#1a1a1a] rounded p-2 cursor-pointer hover:bg-[#222] transition-colors ${costTotal >= 2 ? 'border border-red-500/50' : costTotal >= 0.50 ? 'border border-yellow-500/30' : ''}`}
                            onClick={() => setShowCostPanel(p => !p)}
                            title="Click to see AI cost breakdown"
                        >
                            <div className="text-gray-500">AI Cost</div>
                            <div className={`text-lg font-bold font-mono ${costTotal >= 2 ? 'text-red-400' : costTotal >= 0.50 ? 'text-yellow-400' : 'text-green-400'}`}>
                                ${costTotal.toFixed(2)}
                            </div>
                        </div>
                    </div>
                    {showCostPanel && (
                        <div className="bg-[#111] border border-[#333] rounded-lg mb-3 max-h-48 overflow-y-auto text-xs">
                            <div className="sticky top-0 bg-[#111] p-2 border-b border-[#333] flex items-center justify-between">
                                <span className="font-bold text-white">AI Cost Log</span>
                                <button onClick={() => { clearSession().then(() => { setCostTotal(0); setCostLog([]); }); }} className="text-gray-400 hover:text-red-400 text-[10px]">Clear</button>
                            </div>
                            {costLog.length === 0 ? (
                                <div className="p-2 text-gray-500 text-center">No AI calls yet</div>
                            ) : (
                                <div className="divide-y divide-[#222]">
                                    {[...costLog].reverse().map(e => (
                                        <div key={e.id} className="px-2 py-1 flex items-center gap-2">
                                            <div className="flex-1 min-w-0">
                                                <div className="font-bold text-white truncate">{e.operation}</div>
                                                <div className="text-gray-500 text-[10px]">{e.model} &middot; {e.inputTokens.toLocaleString()} in / {e.outputTokens.toLocaleString()} out</div>
                                            </div>
                                            <div className="font-mono text-green-400 whitespace-nowrap text-[10px]">${e.estimatedCost.toFixed(4)}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <div className="sticky bottom-0 bg-[#111] p-2 border-t border-[#333] flex justify-between font-bold">
                                <span className="text-white">Total</span>
                                <span className={`font-mono ${costTotal >= 2 ? 'text-red-400' : costTotal >= 0.50 ? 'text-yellow-400' : 'text-green-400'}`}>${costTotal.toFixed(4)}</span>
                            </div>
                        </div>
                    )}
                    <div className="flex justify-center">
                        <CookieUploadButton />
                    </div>

                    {/* Keyboard Shortcuts */}
                    <div className="mt-3">
                        <button
                            onClick={() => setShowShortcutsPanel(p => !p)}
                            className="w-full flex items-center justify-between px-2 py-1.5 rounded bg-[#1a1a1a] hover:bg-[#222] transition-colors text-xs text-gray-400 hover:text-white"
                        >
                            <span className="flex items-center gap-1.5">⌨ Keyboard Shortcuts</span>
                            <span className="text-gray-600">{showShortcutsPanel ? '▲' : '▼'}</span>
                        </button>
                        {showShortcutsPanel && (
                            <div className="mt-2 bg-[#111] border border-[#2a2a2a] rounded-lg p-3">
                                <HotkeysPanel />
                            </div>
                        )}
                    </div>

                    {/* Bundle Export / Import (with media files) */}
                    <div className="mt-3 space-y-1.5">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Project Bundle</div>
                        <button
                            disabled={!project || !!bundleProgress}
                            onClick={async () => {
                                if (!project) return;
                                try {
                                    const name = project.library?.[0]?.name?.replace(/\.[^.]+$/, '') || 'vibecut-project';
                                    setBundleProgress('Creating export bundle...');

                                    // Step 1: Create bundle (auto-copies YouTube-cached videos)
                                    const result = await createExportBundle(name, project);

                                    // Step 2: Upload user-imported files that aren't YouTube-cached
                                    const library = project.library || [];
                                    for (let i = 0; i < result.needsUpload.length; i++) {
                                        const item = result.needsUpload[i];
                                        const mediaItem = library.find((m: any) => m.id === item.id);
                                        if (mediaItem?.file) {
                                            setBundleProgress(`Uploading ${item.name} (${i + 1}/${result.needsUpload.length})...`);
                                            await uploadMediaToBundle(result.bundleId, item.id, mediaItem.file, item.isAudioOnly || false);
                                        }
                                    }

                                    setBundleProgress(null);
                                    setLastExportBundleId(result.bundleId);
                                } catch (err: any) {
                                    console.error('Bundle export failed:', err);
                                    setBundleProgress(null);
                                    alert('Export failed: ' + err.message);
                                }
                            }}
                            className="w-full px-2 py-1.5 text-xs rounded bg-green-900/50 text-green-300 hover:text-white hover:bg-green-800/50 font-medium text-center disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {bundleProgress || 'Export Project Bundle'}
                        </button>
                        {/* Post-export: Download as zip */}
                        {lastExportBundleId && !bundleProgress && (
                            <div className="flex gap-1">
                                <button
                                    onClick={() => downloadBundleZip(lastExportBundleId)}
                                    className="flex-1 px-2 py-1.5 text-xs rounded bg-blue-900/50 text-blue-300 hover:text-white hover:bg-blue-800/50 font-medium text-center"
                                    title="Download the exported bundle as a .zip to share or upload elsewhere"
                                >
                                    ⬇ Download .zip
                                </button>
                                <button
                                    onClick={() => setLastExportBundleId(null)}
                                    className="px-2 py-1.5 text-xs rounded bg-[#222] text-gray-500 hover:text-gray-300"
                                    title="Dismiss"
                                >✕</button>
                            </div>
                        )}
                        <>
                        <input
                            ref={importBundleInputRef}
                            type="file"
                            // @ts-ignore - webkitdirectory is non-standard but widely supported
                            webkitdirectory=""
                            multiple
                            style={{ display: 'none' }}
                            onChange={async (e) => {
                                const files = Array.from(e.target.files || []);
                                e.target.value = ''; // reset so same folder can be picked again
                                if (!files.length) return;
                                try {
                                    setBundleProgress('Reading bundle...');

                                    // Find project.json in the selected folder
                                    const projectFile = files.find(f => f.name === 'project.json');
                                    if (!projectFile) throw new Error('No project.json found. Please select the bundle folder (containing project.json and media/).');

                                    const projectText = await projectFile.text();
                                    const rawData = JSON.parse(projectText);
                                    // Support both wrapped { project: {...} } and plain project objects
                                    const projectData = rawData.project || rawData;
                                    const library: any[] = projectData.library || [];

                                    // Read manifest.json if present
                                    let mediaFilesMap: Record<string, { filename: string; originalName: string; isAudioOnly?: boolean }> = {};
                                    const manifestFile = files.find(f => f.name === 'manifest.json');
                                    if (manifestFile) {
                                        const manifestText = await manifestFile.text();
                                        const manifest = JSON.parse(manifestText);
                                        mediaFilesMap = manifest.mediaFiles || {};
                                    }

                                    // All files inside a media/ subfolder
                                    const mediaFiles = files.filter(f => f.webkitRelativePath.includes('/media/') || f.webkitRelativePath.includes('\\media\\'));

                                    const restoredLibrary: any[] = [];
                                    for (let i = 0; i < library.length; i++) {
                                        const item = library[i];
                                        const mediaInfo = mediaFilesMap[item.id];
                                        if (mediaInfo?.filename) {
                                            setBundleProgress(`Loading media ${i + 1}/${library.length}: ${item.name || mediaInfo.originalName}...`);
                                            const mediaFile = mediaFiles.find(f => f.name === mediaInfo.filename);
                                            if (mediaFile) {
                                                const restoredFile = new File([mediaFile], mediaInfo.originalName || mediaFile.name, { type: mediaFile.type || 'video/mp4' });
                                                const url = URL.createObjectURL(restoredFile);
                                                restoredLibrary.push({ ...item, file: restoredFile, url });
                                                // Persist blob so it survives future page reloads
                                                contentDB.saveMediaBlob(item.id, restoredFile).catch(err => console.warn('[MediaBlob] save failed:', err));
                                            } else {
                                                console.warn(`Media file not found: ${mediaInfo.filename}`);
                                                restoredLibrary.push(item);
                                            }
                                        } else {
                                            restoredLibrary.push(item);
                                        }
                                    }

                                    const restoredProject = { ...projectData, library: restoredLibrary };
                                    if (onProjectLoad) {
                                        onProjectLoad(restoredProject);
                                    }

                                    setBundleProgress(null);
                                    const mediaCount = restoredLibrary.filter((m: any) => m.file).length;
                                    alert(`Import complete!\n\n${mediaCount} media files loaded\n\nSwitch to the Editor to see your project.`);
                                } catch (err: any) {
                                    console.error('Bundle import failed:', err);
                                    setBundleProgress(null);
                                    alert('Import failed: ' + err.message);
                                }
                            }}
                        />
                        <button
                            disabled={!!bundleProgress}
                            onClick={() => importBundleInputRef.current?.click()}
                            className="w-full px-2 py-1.5 text-xs rounded bg-green-900/50 text-green-300 hover:text-white hover:bg-green-800/50 font-medium text-center disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {bundleProgress || 'Import Project Bundle'}
                        </button>
                        </>
                        {/* Import from URL (Google Drive, Dropbox, direct link) */}
                        <div className="space-y-1">
                            <input
                                type="text"
                                value={bundleUrlInput}
                                onChange={e => setBundleUrlInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter' && bundleUrlInput.trim() && !bundleProgress) {
                                        e.currentTarget.blur();
                                        // trigger import — handled by button click via shared handler
                                        document.getElementById('bundle-url-import-btn')?.click();
                                    }
                                }}
                                placeholder="Or paste a .zip URL (Drive, Dropbox…)"
                                disabled={!!bundleProgress}
                                className="w-full px-2 py-1.5 text-xs rounded bg-[#1a1a1a] border border-[#333] text-gray-300 placeholder-gray-600 focus:outline-none focus:border-green-700 disabled:opacity-40"
                            />
                            <button
                                id="bundle-url-import-btn"
                                disabled={!bundleUrlInput.trim() || !!bundleProgress}
                                onClick={async () => {
                                    if (!bundleUrlInput.trim()) return;
                                    try {
                                        setBundleProgress('Downloading bundle…');
                                        const { bundlePath } = await importBundleFromUrl(bundleUrlInput.trim());

                                        setBundleProgress('Reading bundle…');
                                        const result = await readImportBundle(bundlePath);

                                        const library: any[] = (result.project as any).library || [];
                                        const mediaFilesMap = result.manifest.mediaFiles || {};

                                        const restoredLibrary: any[] = [];
                                        for (let i = 0; i < library.length; i++) {
                                            const item = library[i];
                                            const mediaInfo = mediaFilesMap[item.id];
                                            if (mediaInfo?.filename) {
                                                setBundleProgress(`Loading media ${i + 1}/${library.length}: ${item.name || mediaInfo.originalName}…`);
                                                try {
                                                    const { file, url } = await fetchBundleMedia(bundlePath, mediaInfo.filename, mediaInfo.originalName || mediaInfo.filename, mediaInfo.isAudioOnly);
                                                    restoredLibrary.push({ ...item, file, url });
                                                    contentDB.saveMediaBlob(item.id, file).catch(err => console.warn('[MediaBlob] save failed:', err));
                                                } catch (mediaErr) {
                                                    console.warn(`Failed to load media ${mediaInfo.filename}:`, mediaErr);
                                                    restoredLibrary.push(item);
                                                }
                                            } else {
                                                restoredLibrary.push(item);
                                            }
                                        }

                                        const restoredProject = { ...result.project, library: restoredLibrary };
                                        if (onProjectLoad) onProjectLoad(restoredProject);

                                        setBundleProgress(null);
                                        setBundleUrlInput('');
                                        const mediaCount = restoredLibrary.filter((m: any) => m.file).length;
                                        alert(`Import complete!\n\n${mediaCount} media files loaded.\n\nSwitch to the Editor to see your project.`);
                                    } catch (err: any) {
                                        console.error('URL bundle import failed:', err);
                                        setBundleProgress(null);
                                        alert('Import from URL failed: ' + err.message);
                                    }
                                }}
                                className="w-full px-2 py-1.5 text-xs rounded bg-green-900/50 text-green-300 hover:text-white hover:bg-green-800/50 font-medium text-center disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {bundleProgress ? bundleProgress : 'Import from URL'}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Categories */}
                <div className="flex-1 overflow-auto p-4">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium text-gray-400">Categories</span>
                        <button onClick={() => setShowCategoryModal(true)} className="text-xs text-indigo-400 hover:text-indigo-300">+ Add</button>
                    </div>
                    <button onClick={() => setFilterCategory('all')} className={`w-full text-left px-2 py-1.5 rounded text-sm mb-1 ${filterCategory === 'all' ? 'bg-indigo-600' : 'hover:bg-[#222]'}`}>All Videos</button>
                    {categories.map(cat => (
                        <div key={cat.id} className="flex items-center group">
                            <button onClick={() => setFilterCategory(cat.id)} className={`flex-1 text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 ${filterCategory === cat.id ? 'bg-indigo-600' : 'hover:bg-[#222]'}`}>
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: cat.color }} />
                                {cat.name}
                            </button>
                            <button onClick={() => handleDeleteCategory(cat.id)} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 px-1">×</button>
                        </div>
                    ))}
                </div>

                {onNavigateToEditor && (
                    <div className="p-4 border-t border-[#222]">
                        <button onClick={onNavigateToEditor} className="w-full px-4 py-2 bg-[#222] hover:bg-[#333] rounded text-sm">← Back to Editor</button>
                    </div>
                )}
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Top Tabs */}
                <div className="flex bg-[#111] border-b border-[#222]">
                    <button onClick={() => setActiveTab('videos')} className={`px-6 py-3 text-sm font-medium border-b-2 ${activeTab === 'videos' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>📹 Videos</button>
                    <button onClick={() => setActiveTab('ai-search')} className={`px-6 py-3 text-sm font-medium border-b-2 ${activeTab === 'ai-search' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>🔍 AI Search</button>
                    <button onClick={() => { setActiveTab('shorts'); listShortsFiles().then(setSavedShortsFileList).catch(() => {}); }} className={`px-6 py-3 text-sm font-medium border-b-2 ${activeTab === 'shorts' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>⚡ Generated Shorts</button>
                    <button onClick={() => setActiveTab('trends')} className={`px-6 py-3 text-sm font-medium border-b-2 ${activeTab === 'trends' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>📈 Trends</button>
                </div>

                {/* Content Area */}
                {activeTab === 'videos' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                        {/* Import Bar */}
                        <div className="p-4 bg-[#111] border-b border-[#222]">
                            <div className="flex gap-2">
                                <textarea value={urlInput} onChange={e => setUrlInput(e.target.value)} placeholder="Paste YouTube URLs here (one per line)" className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg p-3 text-sm resize-none focus:border-indigo-500 outline-none" rows={2} />
                                <button onClick={handleAddUrls} disabled={!urlInput.trim()} className="px-6 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium">Import</button>
                            </div>
                            {hasAssemblyAIKey && (
                                <label className="flex items-center gap-2 mt-2 text-xs cursor-pointer select-none">
                                    <input type="checkbox" checked={useAssemblyAI} onChange={e => setUseAssemblyAI(e.target.checked)} className="accent-green-500" />
                                    <span className="text-gray-300">Transcribe with AssemblyAI</span>
                                    <span className="text-gray-500">(accurate word-level timestamps, downloads video)</span>
                                </label>
                            )}
                            {importing.length > 0 && (
                                <div className="mt-3 space-y-1">
                                    {importing.map((item, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs">
                                            {item.status === 'pending' && <span className="text-gray-500">⏳</span>}
                                            {item.status === 'fetching' && <span className="text-blue-400 animate-pulse">⟳</span>}
                                            {item.status === 'done' && <span className="text-green-400">✓</span>}
                                            {item.status === 'error' && <span className="text-red-400">✗</span>}
                                            <span className="text-gray-400 truncate max-w-md">{item.url}</span>
                                            {item.error && <span className="text-red-400">- {item.error}</span>}
                                        </div>
                                    ))}
                                    {importing.some(i => i.status === 'done' || i.status === 'error') && (
                                        <button onClick={clearCompleted} className="text-xs text-gray-500 hover:text-gray-300">Clear completed</button>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Video List + Transcript */}
                        <div className="flex-1 flex overflow-hidden">
                            <div className="w-1/2 border-r border-[#222] flex flex-col">
                                <div className="p-3 border-b border-[#222]">
                                    <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search videos..." className="w-full bg-[#1a1a1a] border border-[#333] rounded px-3 py-2 text-sm focus:border-indigo-500 outline-none" />
                                </div>
                                <div className="flex-1 overflow-auto p-3 space-y-2">
                                    {isLoading ? (<div className="text-center text-gray-500 py-8">Loading...</div>) : filteredVideos.length === 0 ? (
                                        <div className="text-center text-gray-500 py-8">{videos.length === 0 ? 'No videos yet. Paste YouTube URLs above to import.' : 'No videos match your filter.'}</div>
                                    ) : (
                                        filteredVideos.map(video => (
                                            <div key={video.id} onClick={() => setSelectedVideoId(video.id)} className={`flex gap-3 p-2 rounded-lg cursor-pointer transition-colors ${selectedVideoId === video.id ? 'bg-indigo-600/20 border border-indigo-500' : 'bg-[#1a1a1a] hover:bg-[#222] border border-transparent'}`}>
                                                <img src={video.thumbnailUrl} alt="" className="w-32 h-18 object-cover rounded" />
                                                <div className="flex-1 min-w-0">
                                                    <h3 className="font-medium text-sm truncate">{video.title}</h3>
                                                    <p className="text-xs text-gray-500 truncate">{video.channelName || 'Unknown Channel'}</p>
                                                    <div className="flex items-center gap-1.5 mt-1">
                                                        <span className="text-xs text-gray-500">{formatDuration(video.duration)}</span>
                                                        {video.transcriptSource === 'assemblyai' && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-600/80 text-green-100">AssemblyAI</span>}
                                                        {video.transcriptSource === 'youtube' && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-yellow-600/80 text-yellow-100">YouTube</span>}
                                                        {(!video.transcriptSource || video.transcriptSource === 'none') && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-gray-600/80 text-gray-300">No transcript</span>}
                                                        {transcriptionJobs.get(video.id) && (() => {
                                                            const job = transcriptionJobs.get(video.id)!;
                                                            if (job.status === 'completed') return <span className="text-[9px] text-green-400">Done!</span>;
                                                            if (job.status === 'error') return <span className="text-[9px] text-red-400" title={job.detail}>Error</span>;
                                                            return <span className="text-[9px] text-blue-400 animate-pulse">{job.detail || job.status}</span>;
                                                        })()}
                                                    </div>
                                                    {video.categories.length > 0 && (
                                                        <div className="flex gap-1 mt-1 flex-wrap">
                                                            {video.categories.map(catId => {
                                                                const cat = categories.find(c => c.id === catId);
                                                                return cat ? <span key={catId} className="px-1.5 py-0.5 rounded text-[10px]" style={{ backgroundColor: cat.color + '33', color: cat.color }}>{cat.name}</span> : null;
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex flex-col gap-1">
                                                    <button onClick={e => { e.stopPropagation(); openShortGenerator(video.id); }} className="text-xs bg-purple-600 hover:bg-purple-500 px-2 py-1 rounded" title="Generate Short">⚡</button>
                                                    <button onClick={e => { e.stopPropagation(); handleDeleteVideo(video.id); }} className="text-gray-500 hover:text-red-400 px-1">🗑</button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>

                            {/* Transcript View */}
                            <div className="w-1/2 flex flex-col">
                                {selectedVideoId ? (
                                    <>
                                        <div className="p-3 border-b border-[#222] flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <h2 className="font-medium">Transcript</h2>
                                                {(() => {
                                                    const v = videos.find(v => v.id === selectedVideoId);
                                                    if (v?.transcriptSource === 'assemblyai') return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-600/80 text-green-100">AssemblyAI</span>;
                                                    if (v?.transcriptSource === 'youtube') return <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-yellow-600/80 text-yellow-100">YouTube</span>;
                                                    return null;
                                                })()}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-gray-500">{selectedSegments.length} segments</span>
                                                {(() => {
                                                    const job = transcriptionJobs.get(selectedVideoId);
                                                    const isRunning = job && job.status !== 'completed' && job.status !== 'error';
                                                    return (
                                                        <>
                                                            {hasAssemblyAIKey && !isRunning && (
                                                                <button
                                                                    onClick={() => {
                                                                        const v = videos.find(v => v.id === selectedVideoId);
                                                                        if (v) transcribeVideo(v.id, v.url);
                                                                    }}
                                                                    className="text-xs bg-indigo-600/80 hover:bg-indigo-500 px-2.5 py-1 rounded flex items-center gap-1"
                                                                    title="Transcribe with AssemblyAI for accurate word-level timestamps"
                                                                >
                                                                    🎤 {job?.status === 'error' ? 'Retry' : 'Transcribe'}
                                                                </button>
                                                            )}
                                                            {job && job.status === 'completed' && <span className="text-xs text-green-400">Done!</span>}
                                                            {isRunning && <span className="text-xs text-blue-400 animate-pulse">{job.detail || job.status}...</span>}
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                        </div>
                                        <div className="p-3 border-b border-[#222]">
                                            <div className="text-xs text-gray-500 mb-2">Assign Categories:</div>
                                            <div className="flex gap-2 flex-wrap">
                                                {categories.map(cat => {
                                                    const video = videos.find(v => v.id === selectedVideoId);
                                                    const isAssigned = video?.categories.includes(cat.id);
                                                    return (
                                                        <button key={cat.id} onClick={() => toggleVideoCategory(selectedVideoId, cat.id)} className={`px-2 py-1 rounded text-xs border transition-colors ${isAssigned ? 'border-transparent' : 'border-gray-600 opacity-50 hover:opacity-100'}`} style={{ backgroundColor: isAssigned ? cat.color + '33' : 'transparent', color: cat.color }}>
                                                            {isAssigned ? '✓ ' : ''}{cat.name}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                        <div className="flex-1 overflow-auto p-3 space-y-1">
                                            {selectedSegments.map(seg => (
                                                <div key={seg.id} className="flex gap-2 text-sm hover:bg-[#1a1a1a] p-1 rounded">
                                                    <span className="text-indigo-400 font-mono text-xs w-12 flex-shrink-0">{formatTime(seg.start)}</span>
                                                    <span className="text-gray-300">{seg.text}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                ) : (
                                    <div className="flex-1 flex items-center justify-center text-gray-500">Select a video to view its transcript</div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* AI Search Tab */}
                {activeTab === 'ai-search' && (
                    <div className="flex-1 flex flex-col overflow-hidden">
                        <div className="p-6 bg-gradient-to-b from-[#1a1a2e] to-[#111] border-b border-[#222]">
                            <h2 className="text-xl font-bold mb-2">🔍 AI Content Search</h2>
                            <p className="text-gray-400 text-sm mb-4">Search across all your sermons using natural language. Examples: "stories about God's provision", "testimonies of healing", "teachings on faith"</p>
                            <div className="flex gap-2">
                                <input type="text" value={aiSearchQuery} onChange={e => setAiSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAiSearch()} placeholder="Find stories about God's provision..." className="flex-1 bg-[#1a1a1a] border border-[#333] rounded-lg px-4 py-3 text-sm focus:border-indigo-500 outline-none" />
                                <button onClick={handleAiSearch} disabled={isSearching || !aiSearchQuery.trim() || videos.length === 0} className="px-6 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium">
                                    {isSearching ? '🔄 Searching...' : 'Search'}
                                </button>
                            </div>
                            {videos.length === 0 && <p className="text-yellow-500 text-xs mt-2">⚠️ Import some sermons first before searching.</p>}
                        </div>

                        {/* Search Results */}
                        <div className="flex-1 overflow-auto p-4">
                            {isSearching ? (
                                <div className="text-center py-12">
                                    <div className="text-4xl mb-3">🔍</div>
                                    <div className="text-gray-400">Searching through {videos.length} sermons...</div>
                                </div>
                            ) : aiSearchResults.length === 0 ? (
                                <div className="text-center py-12 text-gray-500">
                                    {aiSearchQuery ? 'No results found. Try a different search.' : 'Enter a search query above to find content in your sermons.'}
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div className="text-sm text-gray-400 mb-4">Found {aiSearchResults.length} relevant sermons</div>
                                    {aiSearchResults.map(result => (
                                        <div key={result.videoId} className="bg-[#1a1a1a] rounded-lg p-4 border border-[#333]">
                                            <div className="flex gap-4">
                                                <img src={result.thumbnailUrl} alt="" className="w-40 h-24 object-cover rounded" />
                                                <div className="flex-1">
                                                    <div className="flex items-start justify-between">
                                                        <div>
                                                            <h3 className="font-medium">{result.videoTitle}</h3>
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <span className="text-xs bg-green-600/20 text-green-400 px-2 py-0.5 rounded">{result.relevanceScore}% match</span>
                                                            </div>
                                                        </div>
                                                        <button onClick={() => openShortGenerator(result.videoId, aiSearchQuery)} className="px-3 py-1 bg-purple-600 hover:bg-purple-500 rounded text-sm font-medium">⚡ Generate Short</button>
                                                    </div>
                                                    <p className="text-sm text-gray-400 mt-2">{result.summary}</p>
                                                    {result.matchingSegments.length > 0 && (
                                                        <div className="mt-3 space-y-1">
                                                            <div className="text-xs text-gray-500">Matching quotes:</div>
                                                            {result.matchingSegments.slice(0, 3).map((seg, i) => (
                                                                <div key={i} className="text-xs bg-[#222] rounded px-2 py-1 text-gray-300">
                                                                    {seg.startTime > 0 && <span className="text-indigo-400 mr-2">[{formatTime(seg.startTime)}]</span>}
                                                                    "{seg.text.substring(0, 150)}{seg.text.length > 150 ? '...' : ''}"
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Generated Shorts Tab */}
                {activeTab === 'shorts' && (
                    <div className="flex-1 overflow-auto p-4">
                        <div className="flex items-center justify-between mb-4">
                            <div className="flex items-center gap-4">
                                <h2 className="text-xl font-bold">⚡ Generated Shorts</h2>
                                {/* Saved shorts files dropdown */}
                                <select
                                    value={shortsSource}
                                    onChange={async (e) => {
                                        const val = e.target.value;
                                        setShortsSource(val);
                                        if (val === 'indexeddb') {
                                            loadData();
                                        } else {
                                            try {
                                                const data = await loadShortsFromFile(val);
                                                if (data && data.shorts) {
                                                    setGeneratedShorts(data.shorts as GeneratedShort[]);
                                                }
                                            } catch (err) {
                                                console.error('Failed to load shorts file:', err);
                                            }
                                        }
                                    }}
                                    className="bg-[#222] border border-[#444] text-xs text-gray-300 rounded px-2 py-1"
                                >
                                    <option value="indexeddb">Current Session (Browser)</option>
                                    {savedShortsFileList.map(sf => (
                                        <option key={sf.videoId} value={sf.videoId}>
                                            {sf.videoTitle || sf.videoId} ({sf.count} shorts)
                                        </option>
                                    ))}
                                </select>
                            </div>
                            {onToggleAutoCenter && (
                                <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={autoCenterOnImport}
                                        onChange={e => onToggleAutoCenter(e.target.checked)}
                                        className="accent-indigo-500"
                                    />
                                    Auto-center person on export
                                </label>
                            )}
                        </div>
                        {generatedShorts.length === 0 ? (
                            <div className="text-center py-12 text-gray-500">
                                <div className="text-4xl mb-3">⚡</div>
                                <div>No shorts generated yet. Use AI Search to find content, then generate shorts.</div>
                            </div>
                        ) : (
                            <div className="space-y-8">
                                {/* Global Export All button — opens each short in its own tab */}
                                {generatedShorts.length > 1 && (
                                    <div className="flex justify-end">
                                        <button
                                            onClick={() => {
                                                const baseUrl = window.location.origin + window.location.pathname;
                                                generatedShorts.forEach(short => {
                                                    window.open(`${baseUrl}?exportShort=${encodeURIComponent(short.id)}`, '_blank');
                                                });
                                            }}
                                            className="text-sm bg-green-600 hover:bg-green-500 text-white px-5 py-2.5 rounded-lg transition-colors flex items-center gap-2 font-medium"
                                        >
                                            Export All {generatedShorts.length} Shorts in New Tabs
                                        </button>
                                    </div>
                                )}
                                {Object.entries(shortsByVideo).map(([videoId, shorts]: [string, GeneratedShort[]]) => {
                                    const video = videos.find(v => v.id === videoId);
                                    return (
                                        <div key={videoId} className="bg-[#1a1a1a]/50 border border-[#333] rounded-xl p-4">
                                            <div className="flex items-center gap-4 mb-4 pb-4 border-b border-[#333]">
                                                <img
                                                    src={video?.thumbnailUrl || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`}
                                                    className="w-24 h-16 object-cover rounded shadow-md bg-black"
                                                    alt=""
                                                />
                                                <div className="flex-1">
                                                    <h3 className="font-bold text-lg text-white">{video?.title || 'Unknown Sermon'}</h3>
                                                    <span className="text-xs bg-indigo-600/20 text-indigo-400 px-2 py-0.5 rounded border border-indigo-600/30">
                                                        {shorts.length} Short{shorts.length !== 1 ? 's' : ''} Generated
                                                    </span>
                                                </div>
                                                {shorts.length > 1 && (
                                                    <button
                                                        onClick={() => {
                                                            const baseUrl = window.location.origin + window.location.pathname;
                                                            shorts.forEach(short => {
                                                                window.open(`${baseUrl}?exportShort=${encodeURIComponent(short.id)}`, '_blank');
                                                            });
                                                        }}
                                                        className="text-sm bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap"
                                                    >
                                                        Export All {shorts.length}
                                                    </button>
                                                )}
                                            </div>

                                            <div className="grid grid-cols-2 gap-4">
                                                {shorts.map(short => (
                                                    <div key={short.id} className="bg-[#1a1a1a] rounded-lg p-4 border border-[#333] hover:border-indigo-500/50 transition-colors">
                                                        <div className="flex items-start justify-between mb-2">
                                                            <h3 className="font-medium text-sm text-white">{short.title}</h3>
                                                            <button onClick={() => handleDeleteShort(short.id)} className="text-gray-500 hover:text-red-400 text-sm p-1">🗑</button>
                                                        </div>
                                                        <p className="text-xs text-gray-400 mb-3 line-clamp-2">Prompt: "{short.prompt}"</p>
                                                        <div className="flex items-center justify-between mt-auto">
                                                            <span className="text-xs text-indigo-400 font-mono">{formatDuration(short.totalDuration)} • {short.segments.length} clips</span>
                                                            <div className="flex gap-2">
                                                                <button onClick={() => { setGeneratedShortsPreview([short]); setGeneratedShort(short); setSelectedShortIndex(0); setShowShortModal(true); }} className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded transition-colors">Preview</button>
                                                                {onExportShort && (
                                                                    <button
                                                                        onClick={async () => {
                                                                            if (isExporting) return;
                                                                            setIsExporting(true);
                                                                            try {
                                                                                await onExportShort(short);
                                                                            } catch (e) {
                                                                                alert('Export failed');
                                                                            } finally {
                                                                                setIsExporting(false);
                                                                            }
                                                                        }}
                                                                        disabled={isExporting}
                                                                        className="text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-1.5 rounded transition-colors"
                                                                    >
                                                                        {isExporting ? '⏳' : 'Export'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Category Modal */}
            {showCategoryModal && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
                    <div className="bg-[#1a1a1a] rounded-xl p-6 w-80 border border-[#333]">
                        <h3 className="text-lg font-bold mb-4">New Category</h3>
                        <input type="text" value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} placeholder="Category name" className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 mb-3 focus:border-indigo-500 outline-none" autoFocus />
                        <div className="flex items-center gap-2 mb-4">
                            <span className="text-sm text-gray-400">Color:</span>
                            <input type="color" value={newCategoryColor} onChange={e => setNewCategoryColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer" />
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setShowCategoryModal(false)} className="px-4 py-2 hover:bg-[#333] rounded">Cancel</button>
                            <button onClick={handleAddCategory} disabled={!newCategoryName.trim()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded">Add</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Short Generation Modal */}
            {showShortModal && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
                    <div className={`bg-[#1a1a1a] rounded-xl w-full ${generatedShortsPreview.length > 0 || generatedShort ? 'max-w-5xl' : 'max-w-3xl'} max-h-[90vh] overflow-hidden border border-[#333] flex flex-col transition-all`}>
                        <div className="p-4 border-b border-[#333] flex items-center justify-between">
                            <h3 className="text-lg font-bold">⚡ Generate Short</h3>
                            <button onClick={() => setShowShortModal(false)} className="text-gray-400 hover:text-white text-xl">×</button>
                        </div>

                        {generatedShortsPreview.length === 0 && !generatedShort ? (
                            <div className="flex-1 overflow-auto p-6">
                                <p className="text-sm text-gray-400 mb-4">Generate 10 viral shorts from: <span className="text-white font-medium">{videos.find(v => v.id === shortTargetVideo)?.title}</span></p>
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">What content to find? <span className="text-gray-600">(optional)</span></label>
                                        <input type="text" value={shortPrompt} onChange={e => setShortPrompt(e.target.value)} placeholder="Leave empty for AI to find the most viral moments..." className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 focus:border-indigo-500 outline-none" />
                                        <p className="text-xs text-gray-600 mt-1">AI will generate 10 different options ranked by viral potential</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">Target Duration</label>
                                        <select value={shortDuration} onChange={e => setShortDuration(Number(e.target.value))} className="w-full bg-[#222] border border-[#333] rounded px-3 py-2">
                                            <option value={30}>30 seconds</option>
                                            <option value={60}>60 seconds (recommended)</option>
                                            <option value={90}>90 seconds</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">AI Model</label>
                                        <select value={selectedModel} onChange={e => setSelectedModel(e.target.value)} className="w-full bg-[#222] border border-[#333] rounded px-3 py-2">
                                            <optgroup label="Gemini (Free Tier)">
                                                <option value="gemini-2.5-flash">Gemini 2.5 Flash (Recommended)</option>
                                                <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Fastest)</option>
                                            </optgroup>
                                            <optgroup label="OpenAI">
                                                <option value="gpt-4o">GPT-4o (Best Quality)</option>
                                                <option value="gpt-4o-mini">GPT-4o Mini (Fast + Cheap)</option>
                                                <option value="o3-mini">o3-mini (Reasoning)</option>
                                            </optgroup>
                                            <optgroup label="Gemini (Paid Key Required)">
                                                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                                                <option value="gemini-3-flash-preview">Gemini 3 Flash (Preview)</option>
                                                <option value="gemini-3-pro-preview">Gemini 3 Pro (Preview)</option>
                                            </optgroup>
                                            <optgroup label="Moonshot AI (Kimi)">
                                                <option value="moonshot-v1-8k">Kimi 8k (Standard)</option>
                                                <option value="moonshot-v1-32k">Kimi 32k (Long Context)</option>
                                                <option value="moonshot-v1-128k">Kimi 128k (Max Context)</option>
                                            </optgroup>
                                            <optgroup label="MiniMax (Coding Plan)">
                                                <option value="MiniMax-M2">MiniMax M2 (Fast)</option>
                                                <option value="MiniMax-M2.5">MiniMax M2.5 (Pro)</option>
                                            </optgroup>
                                        </select>
                                        <p className="text-xs text-gray-600 mt-1">OpenAI and Gemini Pro/3 require paid API keys.</p>
                                    </div>

                                    <button onClick={handleGenerateShort} disabled={isGeneratingShort} className="w-full py-3 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded-lg font-bold">
                                        {isGeneratingShort ? '🔄 Generating 10 shorts...' : shortPrompt.trim() ? '⚡ Generate 10 Shorts' : '✨ Auto-Generate 10 Best Moments'}
                                    </button>
                                </div>

                                <div className="mt-8 pt-6 border-t border-[#333]">
                                    <h4 className="text-sm font-bold text-gray-300 mb-2">Use External AI (ChatGPT / Claude)</h4>
                                    <p className="text-xs text-gray-500 mb-4">
                                        Copy the prompt, generate JSON externally, and paste it back here.
                                    </p>
                                    <div className="space-y-3">
                                        <button
                                            onClick={handleCopyPrompt}
                                            disabled={isGeneratingPrompt}
                                            className="w-full py-2 bg-[#222] border border-[#444] hover:bg-[#333] hover:border-indigo-500 transition-colors disabled:opacity-50 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
                                        >
                                            {isGeneratingPrompt ? 'Formatting Prompt...' : '1. Copy Prompt to Clipboard'}
                                        </button>

                                        <textarea
                                            value={externalAiJson}
                                            onChange={e => setExternalAiJson(e.target.value)}
                                            placeholder="2. Paste the JSON result here..."
                                            className="w-full bg-[#1a1a1a] border border-[#444] rounded-lg px-3 py-2 text-xs font-mono text-green-400 focus:border-indigo-500 outline-none h-24 resize-none"
                                        />

                                        <button
                                            onClick={handleImportJson}
                                            disabled={!externalAiJson.trim()}
                                            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-bold"
                                        >
                                            3. Import & Preview
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            /* ===== Multi-Short Preview Grid ===== */
                            <div className="flex-1 overflow-auto p-4">
                                <div className="flex items-center justify-between mb-4">
                                    <div>
                                        <h4 className="text-sm font-bold text-white">{generatedShortsPreview.length} Shorts Generated</h4>
                                        <p className="text-xs text-gray-500">Select one to export, or export all to render queue</p>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <button onClick={() => { setGeneratedShortsPreview([]); setGeneratedShort(null); setSelectedShortIndex(null); setOmittedClips(new Map()); setClipBasket([]); }} className="px-3 py-1.5 text-xs border border-[#333] hover:bg-[#222] rounded text-gray-400">Start Over</button>
                                        {/* Caption mode selector */}
                                        <div className="flex items-center gap-1 bg-[#222] border border-[#333] rounded overflow-hidden">
                                            <button
                                                onClick={() => setCaptionMode('sentences')}
                                                className={`px-2 py-1.5 text-[10px] font-medium transition-colors ${captionMode === 'sentences' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                                                title="Display captions as groups of words (default)"
                                            >
                                                Sentences
                                            </button>
                                            <button
                                                onClick={() => setCaptionMode('words')}
                                                className={`px-2 py-1.5 text-[10px] font-medium transition-colors ${captionMode === 'words' ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-white'}`}
                                                title="Display one word at a time (TikTok-style)"
                                            >
                                                Word by Word
                                            </button>
                                        </div>
                                        {/* Word padding controls */}
                                        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                                            <span className="text-gray-500">Pad:</span>
                                            <div className="flex items-center gap-0.5">
                                                <button onClick={() => setWordPadBefore(Math.max(-5, wordPadBefore - 1))} className="w-4 h-4 flex items-center justify-center bg-[#222] border border-[#444] rounded text-[9px] hover:bg-[#333]">-</button>
                                                <span className="w-3 text-center text-[10px]">{wordPadBefore}</span>
                                                <button onClick={() => setWordPadBefore(Math.min(5, wordPadBefore + 1))} className="w-4 h-4 flex items-center justify-center bg-[#222] border border-[#444] rounded text-[9px] hover:bg-[#333]">+</button>
                                                <span className="text-gray-600 text-[9px]">before</span>
                                            </div>
                                            <div className="flex items-center gap-0.5">
                                                <button onClick={() => setWordPadAfter(Math.max(-5, wordPadAfter - 1))} className="w-4 h-4 flex items-center justify-center bg-[#222] border border-[#444] rounded text-[9px] hover:bg-[#333]">-</button>
                                                <span className="w-3 text-center text-[10px]">{wordPadAfter}</span>
                                                <button onClick={() => setWordPadAfter(Math.min(5, wordPadAfter + 1))} className="w-4 h-4 flex items-center justify-center bg-[#222] border border-[#444] rounded text-[9px] hover:bg-[#333]">+</button>
                                                <span className="text-gray-600 text-[9px]">after</span>
                                            </div>
                                        </div>
                                        {/* Export button — cart takes priority, falls back to selected short */}
                                        {onExportShort && (clipBasket.length > 0 || selectedShortIndex !== null) && (
                                            <button
                                                onClick={async () => {
                                                    if (isExporting) return;
                                                    setIsExporting(true);
                                                    try {
                                                        const syntheticShort = await buildExportShort();
                                                        if (syntheticShort) {
                                                            await onExportShort(syntheticShort);
                                                            setShowShortModal(false);
                                                        }
                                                    } finally {
                                                        setIsExporting(false);
                                                    }
                                                }}
                                                disabled={isExporting}
                                                className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
                                            >
                                                {isExporting ? 'Exporting...' : clipBasket.length > 0 ? `Export Cart (${clipBasket.length})` : 'Export Selected'}
                                            </button>
                                        )}
                                        {/* Export All button — opens each short in its own tab */}
                                        {generatedShortsPreview.length > 1 && (
                                            <button
                                                onClick={() => {
                                                    const baseUrl = window.location.origin + window.location.pathname;
                                                    generatedShortsPreview.forEach(short => {
                                                        window.open(`${baseUrl}?exportShort=${encodeURIComponent(short.id)}`, '_blank');
                                                    });
                                                }}
                                                className="px-4 py-1.5 text-xs bg-green-600 hover:bg-green-500 rounded font-medium"
                                            >
                                                Export All {generatedShortsPreview.length}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Expanded preview when a card is selected */}
                                {selectedShortIndex !== null && generatedShortsPreview[selectedShortIndex] && (
                                    <div className="mb-4">
                                        {/* Export Cart — always visible when clips have been added */}
                                        {clipBasket.length > 0 && (
                                            <div className="mb-3 bg-[#1a1a1a] border border-purple-500/30 rounded-lg p-3">
                                                <div className="flex items-center justify-between mb-2">
                                                    <h5 className="text-xs font-bold text-purple-300">
                                                        🛒 Export Cart ({clipBasket.length} clip{clipBasket.length !== 1 ? 's' : ''} &middot; {formatDuration(clipBasket.reduce((s, c) => s + (c.segment.endTime - c.segment.startTime), 0))})
                                                    </h5>
                                                    <button onClick={() => setClipBasket([])} className="text-[9px] text-gray-500 hover:text-red-400 transition-colors">Clear All</button>
                                                </div>
                                                <div className="space-y-1 max-h-36 overflow-auto">
                                                    {clipBasket.map((clip, ci) => (
                                                        <div key={`${clip.shortId}_${clip.segmentIndex}`} className="flex items-center gap-2 text-[10px] bg-[#222] rounded px-2 py-1 border border-[#333]">
                                                            <span className="text-gray-500 font-mono w-4">{ci + 1}.</span>
                                                            <span className="text-purple-300 font-medium whitespace-nowrap">#{clip.shortIndex + 1}/C{clip.segmentIndex + 1}</span>
                                                            <span className="text-gray-400 truncate flex-1" title={clip.segment.text}>{clip.segment.text}</span>
                                                            <span className="text-gray-600 text-[9px] whitespace-nowrap">
                                                                {Math.floor(clip.segment.startTime / 60)}:{Math.floor(clip.segment.startTime % 60).toString().padStart(2, '0')}&ndash;{Math.floor(clip.segment.endTime / 60)}:{Math.floor(clip.segment.endTime % 60).toString().padStart(2, '0')}
                                                            </span>
                                                            <button onClick={() => setClipBasket(prev => prev.filter((_, i) => i !== ci))} className="text-gray-500 hover:text-red-400 text-xs transition-colors">&times;</button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                        <div className="text-xs text-gray-500 mb-1 font-bold uppercase tracking-wide">
                                            Preview — #{selectedShortIndex + 1} {generatedShortsPreview[selectedShortIndex].title}
                                        </div>
                                        <ShortDetailPlayer
                                            short={generatedShortsPreview[selectedShortIndex]}
                                            videoId={generatedShortsPreview[selectedShortIndex].videoId}
                                            omittedClips={omittedClips.get(generatedShortsPreview[selectedShortIndex].id)}
                                            onToggleOmit={(si) => {
                                                const short = generatedShortsPreview[selectedShortIndex];
                                                setOmittedClips(prev => {
                                                    const next = new Map(prev);
                                                    const set = new Set(next.get(short.id) || []);
                                                    if (set.has(si)) set.delete(si); else set.add(si);
                                                    next.set(short.id, set);
                                                    return next;
                                                });
                                            }}
                                            clipPadOverrides={clipPadOverrides}
                                            selectedClipForPad={selectedClipForPad}
                                            onSelectClipForPad={(shortId, si) => {
                                                setSelectedClipForPad(si === -1 ? null : { shortId, segmentIndex: si });
                                            }}
                                            onSetClipPad={(shortId, si, before, after) => {
                                                setClipPadOverrides(prev => {
                                                    const next = new Map(prev);
                                                    next.set(`${shortId}_${si}`, { before, after });
                                                    return next;
                                                });
                                            }}
                                            clipBasket={clipBasket}
                                            onToggleBasket={(si) => {
                                                const short = generatedShortsPreview[selectedShortIndex];
                                                const inBasket = clipBasket.some(c => c.shortId === short.id && c.segmentIndex === si);
                                                if (inBasket) {
                                                    setClipBasket(prev => prev.filter(c => !(c.shortId === short.id && c.segmentIndex === si)));
                                                } else {
                                                    setClipBasket(prev => [...prev, { shortId: short.id, shortIndex: selectedShortIndex, segmentIndex: si, shortTitle: short.title, segment: short.segments[si] }]);
                                                }
                                            }}
                                        />
                                    </div>
                                )}

                                {/* Grid of short previews */}
                                <div className="grid grid-cols-2 gap-3">
                                    {generatedShortsPreview.map((short, idx) => (
                                        <div
                                            key={short.id}
                                            onClick={() => setSelectedShortIndex(selectedShortIndex === idx ? null : idx)}
                                            className={`rounded-lg border cursor-pointer transition-all ${selectedShortIndex === idx ? 'border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/50' : 'border-[#333] bg-[#1a1a1a] hover:border-[#555]'}`}
                                        >
                                            {/* Title */}
                                            <div className="px-3 py-2 border-b border-[#333]">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-gray-500 font-mono">#{idx + 1}</span>
                                                    <h5 className="text-xs font-bold text-white truncate flex-1">{short.title}</h5>
                                                </div>
                                                <p className="text-[10px] text-gray-500 mt-0.5">{formatDuration(short.totalDuration)} &middot; {short.segments.length} clips</p>
                                            </div>

                                            {/* Video thumbnail player with integrated segmented timeline */}
                                            <div onClick={e => e.stopPropagation()}>
                                                <ShortThumbnailPlayer
                                                    short={short}
                                                    videoId={short.videoId}
                                                    shortIndex={idx}
                                                    omittedClips={omittedClips.get(short.id)}
                                                    clipBasket={clipBasket}
                                                    clipPadOverrides={clipPadOverrides}
                                                    selectedClipForPad={selectedClipForPad}
                                                    onToggleOmit={(si) => {
                                                        setOmittedClips(prev => {
                                                            const next = new Map(prev);
                                                            const set = new Set(next.get(short.id) || []);
                                                            if (set.has(si)) set.delete(si); else set.add(si);
                                                            next.set(short.id, set);
                                                            return next;
                                                        });
                                                    }}
                                                    onToggleBasket={(si) => {
                                                        const inBasket = clipBasket.some(c => c.shortId === short.id && c.segmentIndex === si);
                                                        if (inBasket) {
                                                            setClipBasket(prev => prev.filter(c => !(c.shortId === short.id && c.segmentIndex === si)));
                                                        } else {
                                                            setClipBasket(prev => [...prev, { shortId: short.id, shortIndex: idx, segmentIndex: si, shortTitle: short.title, segment: short.segments[si] }]);
                                                        }
                                                    }}
                                                    onSelectClipForPad={(shortId, si) => setSelectedClipForPad(si === -1 ? null : { shortId, segmentIndex: si })}
                                                    onSetClipPad={(shortId, si, before, after) => {
                                                        setClipPadOverrides(prev => {
                                                            const next = new Map(prev);
                                                            next.set(`${shortId}_${si}`, { before, after });
                                                            return next;
                                                        });
                                                    }}
                                                    onAddAllToBasket={() => {
                                                        const newClips = short.segments
                                                            .map((seg, si) => ({ shortId: short.id, shortIndex: idx, segmentIndex: si, shortTitle: short.title, segment: seg }))
                                                            .filter(c => !clipBasket.some(b => b.shortId === c.shortId && b.segmentIndex === c.segmentIndex));
                                                        if (newClips.length > 0) setClipBasket(prev => [...prev, ...newClips]);
                                                    }}
                                                />
                                            </div>

                                            {/* Collapsible B-Roll */}
                                            {short.bRollSuggestions && short.bRollSuggestions.length > 0 && (
                                                <div className="px-3 pb-1">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); setExpandedBRoll(prev => ({ ...prev, [idx]: !prev[idx] })); }}
                                                        className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 w-full"
                                                    >
                                                        <span className={`transition-transform ${expandedBRoll[idx] ? 'rotate-90' : ''}`}>&#9656;</span>
                                                        B-Roll ({short.bRollSuggestions.length})
                                                    </button>
                                                    {expandedBRoll[idx] && (
                                                        <div className="mt-1 space-y-1 max-h-32 overflow-auto">
                                                            {short.bRollSuggestions.map((broll) => (
                                                                <div key={broll.id} className="text-[9px] text-gray-500 pl-3 border-l border-indigo-500/30">
                                                                    <span className="text-gray-400">{broll.searchQuery}</span> — {broll.rationale}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}

                                            {/* Collapsible Keywords */}
                                            {short.segments.some(s => s.keywords && s.keywords.length > 0) && (
                                                <div className="px-3 pb-2">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); setExpandedKeywords(prev => ({ ...prev, [idx]: !prev[idx] })); }}
                                                        className="flex items-center gap-1 text-[10px] text-yellow-400 hover:text-yellow-300 w-full"
                                                    >
                                                        <span className={`transition-transform ${expandedKeywords[idx] ? 'rotate-90' : ''}`}>&#9656;</span>
                                                        Keywords ({short.segments.reduce((n, s) => n + (s.keywords?.length || 0), 0)})
                                                    </button>
                                                    {expandedKeywords[idx] && (
                                                        <div className="mt-1 flex flex-wrap gap-1">
                                                            {short.segments.flatMap(seg =>
                                                                (seg.keywords || []).map((kw, ki) => (
                                                                    <span key={ki} className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-600/20 text-yellow-300 border border-yellow-500/30">
                                                                        {kw.word}
                                                                    </span>
                                                                ))
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )
            }

            {/* ==================== TRENDS TAB ==================== */}
            {activeTab === 'trends' && (
                <div className="flex-1 overflow-y-auto p-6">
                    <TrendsTicker
                        items={trendState.items}
                        previousRanks={trendState.previousRanks}
                        loading={trendState.loading}
                        error={trendState.error}
                        filters={trendState.activeFilters}
                        onFiltersChange={handleTrendFiltersChange}
                        onRefresh={handleRefreshTrends}
                        onUseInPrompt={(item) => {
                            setTrendPreSelected(prev => {
                                if (prev.find(t => t.id === item.id)) return prev;
                                return [...prev, item];
                            });
                        }}
                    />

                    <RepostRanker
                        trends={trendState.items}
                        analyses={trendState.analyses}
                        onAnalysesUpdate={(analyses) => {
                            setTrendState(prev => ({
                                ...prev,
                                analyses,
                                analysesTimestamp: Date.now(),
                            }));
                        }}
                        onOpenInEditor={(shortId) => {
                            // Navigate to editor with this short loaded
                            if (onNavigateToEditor) onNavigateToEditor();
                        }}
                        onRegenerateWithTrends={(shortId, trendContext) => {
                            // Open short generation modal with trend context pre-filled
                            const short = generatedShorts.find(s => s.id === shortId);
                            if (short) {
                                setShortTargetVideo(short.videoId);
                                setShortPrompt(short.prompt + `\n\nFocus on alignment with trending topics: ${trendContext}`);
                                setShowShortModal(true);
                            }
                        }}
                    />

                    <TrendPromptBuilder
                        trends={trendState.items}
                        preSelectedTrends={trendPreSelected}
                        onGenerate={(enrichedPrompt, selectedTrends) => {
                            // Open short generation modal with enriched prompt
                            setShortPrompt(enrichedPrompt);
                            setShowShortModal(true);
                            // Store trending topic for the generated short
                            const topicName = selectedTrends.map(t => t.title).join(', ');
                            // This will be available when the short is saved
                        }}
                        onClearPreSelected={() => setTrendPreSelected([])}
                    />
                </div>
            )}
        </div >
    );
};

export default ContentLibraryPage;
