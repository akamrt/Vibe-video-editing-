import React, { useState, useEffect, useRef, useMemo } from 'react';
import { contentDB, VideoRecord, TranscriptSegment, Category, GeneratedShort, generateId } from '../services/contentDatabase';
import { searchTranscripts, generateShort, SearchResult, buildShortPrompt, importManualShort } from '../services/contentAIService';
import { CookieUploadButton } from '../components/CookieUploadButton';
import type { KeywordEmphasis } from '../types';
import { getSessionLog, getSessionTotal, clearSession, onCostUpdate, offCostUpdate, initCostTracker, CostEntry } from '../services/costTracker';
import { detectFillersFromTranscript, FillerDetection } from '../services/geminiService';

// ==================== Types ====================

interface ImportingVideo {
    url: string;
    status: 'pending' | 'fetching' | 'done' | 'error';
    error?: string;
}

// ==================== Main Component ====================

export const ContentLibraryPage: React.FC<{
    onNavigateToEditor?: () => void;
    onExportShort?: (short: GeneratedShort) => Promise<void>;
    autoCenterOnImport?: boolean;
    onToggleAutoCenter?: (enabled: boolean) => void;
}> = ({ onNavigateToEditor, onExportShort, autoCenterOnImport = false, onToggleAutoCenter }) => {
    // State
    const [isExporting, setIsExporting] = useState(false);
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
    const [activeTab, setActiveTab] = useState<'videos' | 'ai-search' | 'shorts'>('videos');
    const [aiSearchQuery, setAiSearchQuery] = useState('');
    const [aiSearchResults, setAiSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [generatedShorts, setGeneratedShorts] = useState<GeneratedShort[]>([]);

    // AI Cost tracking
    const [showCostPanel, setShowCostPanel] = useState(false);
    const [costTotal, setCostTotal] = useState(0);
    const [costLog, setCostLog] = useState<CostEntry[]>([]);

    // Short Generation Modal
    const [showShortModal, setShowShortModal] = useState(false);
    const [shortTargetVideo, setShortTargetVideo] = useState<string | null>(null);
    const [shortPrompt, setShortPrompt] = useState('');
    const [shortDuration, setShortDuration] = useState(60);
    const [isGeneratingShort, setIsGeneratingShort] = useState(false);
    const [generatedShort, setGeneratedShort] = useState<GeneratedShort | null>(null);
    const [refinementPrompt, setRefinementPrompt] = useState('');
    const [selectedModel, setSelectedModel] = useState<string>('gemini-2.5-flash');

    // External AI Input
    const [externalAiJson, setExternalAiJson] = useState('');
    const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

    // Filler detection
    const [isDetectingFillers, setIsDetectingFillers] = useState(false);
    const [fillerStatus, setFillerStatus] = useState('');

    // TTS Preview State
    const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
    const [previewClipIndex, setPreviewClipIndex] = useState(0);
    const [previewCaption, setPreviewCaption] = useState('');
    const [previewKeywords, setPreviewKeywords] = useState<KeywordEmphasis[]>([]);
    const previewStopRef = useRef(false);

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

        try {
            // Find existing shorts for this video to avoid duplication
            const existingShorts = generatedShorts
                .filter(s => s.videoId === shortTargetVideo)
                .map(s => ({
                    title: s.title,
                    startTime: s.segments[0]?.startTime || 0,
                    endTime: s.segments[s.segments.length - 1]?.endTime || 0
                }));

            const result = await generateShort(shortTargetVideo, shortPrompt, shortDuration, refinementPrompt, existingShorts, selectedModel);
            if (result.success && result.short) {
                setGeneratedShort(result.short);
                setRefinementPrompt(''); // Clear refinement after success
                loadData(); // Refresh shorts list
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
                await navigator.clipboard.writeText(result.prompt);
                alert("Prompt copied to clipboard! Paste this into ChatGPT or Claude.");
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
            if (result.success && result.short) {
                setGeneratedShort(result.short);
                setExternalAiJson(''); // Clear input after success
                loadData(); // Refresh shorts list
                if (result.shorts && result.shorts.length > 1) {
                    alert(`Successfully imported ${result.shorts.length} shorts! Showing preview for the first one. Close this modal to see all generated shorts in the library.`);
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
        await contentDB.deleteShort(shortId);
        loadData();
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
                thumbnailUrl: videoInfo.thumbnailUrl, duration, importedAt: new Date(), categories: []
            };

            const dbSegments: TranscriptSegment[] = segments.map((seg: any, index: number) => ({
                id: `${videoId}_${index}`, videoId, start: seg.start || 0, duration: seg.duration || 0, text: seg.text || ''
            }));

            await contentDB.addVideo(video);
            await contentDB.addSegments(dbSegments);
            setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'done' } : v));
            loadData();
        } catch (err: any) {
            console.error('Import error:', err);
            setImporting(prev => prev.map(v => v.url === url ? { ...v, status: 'error', error: err.message } : v));
        }
    };

    const clearCompleted = () => setImporting(prev => prev.filter(v => v.status !== 'done' && v.status !== 'error'));

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
                    <button onClick={() => setActiveTab('shorts')} className={`px-6 py-3 text-sm font-medium border-b-2 ${activeTab === 'shorts' ? 'border-indigo-500 text-white' : 'border-transparent text-gray-400 hover:text-white'}`}>⚡ Generated Shorts</button>
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
                                                    <p className="text-xs text-gray-500 mt-1">{formatDuration(video.duration)}</p>
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
                                            <h2 className="font-medium">Transcript</h2>
                                            <span className="text-xs text-gray-500">{selectedSegments.length} segments</span>
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
                            <h2 className="text-xl font-bold">⚡ Generated Shorts</h2>
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
                                                <div>
                                                    <h3 className="font-bold text-lg text-white">{video?.title || 'Unknown Sermon'}</h3>
                                                    <span className="text-xs bg-indigo-600/20 text-indigo-400 px-2 py-0.5 rounded border border-indigo-600/30">
                                                        {shorts.length} Short{shorts.length !== 1 ? 's' : ''} Generated
                                                    </span>
                                                </div>
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
                                                                <button onClick={() => { setGeneratedShort(short); setShowShortModal(true); }} className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded transition-colors">Preview</button>
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
                    <div className="bg-[#1a1a1a] rounded-xl w-full max-w-3xl max-h-[90vh] overflow-hidden border border-[#333] flex flex-col">
                        <div className="p-4 border-b border-[#333] flex items-center justify-between">
                            <h3 className="text-lg font-bold">⚡ Generate Short</h3>
                            <button onClick={() => setShowShortModal(false)} className="text-gray-400 hover:text-white text-xl">×</button>
                        </div>

                        {!generatedShort ? (
                            <div className="p-6">
                                <p className="text-sm text-gray-400 mb-4">Generate a viral short from: <span className="text-white font-medium">{videos.find(v => v.id === shortTargetVideo)?.title}</span></p>
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">What content to find? <span className="text-gray-600">(optional)</span></label>
                                        <input type="text" value={shortPrompt} onChange={e => setShortPrompt(e.target.value)} placeholder="Leave empty for AI to find the most viral moments..." className="w-full bg-[#222] border border-[#333] rounded px-3 py-2 focus:border-indigo-500 outline-none" />
                                        <p className="text-xs text-gray-600 mt-1">💡 If empty, AI will auto-detect: powerful stories, quotable moments, emotional testimonies</p>
                                    </div>
                                    <div>
                                        <label className="block text-sm text-gray-400 mb-1">Target Duration</label>
                                        <select value={shortDuration} onChange={e => setShortDuration(Number(e.target.value))} className="w-full bg-[#222] border border-[#333] rounded px-3 py-2">
                                            <option value={30}>30 seconds</option>
                                            <option value={60}>60 seconds (recommended)</option>
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
                                        {isGeneratingShort ? '🔄 Generating...' : shortPrompt.trim() ? '⚡ Generate Short' : '✨ Auto-Generate Best Moments'}
                                    </button>
                                </div>

                                <div className="mt-8 pt-6 border-t border-[#333]">
                                    <h4 className="text-sm font-bold text-gray-300 mb-2">🤖 Use External AI (ChatGPT / Claude)</h4>
                                    <p className="text-xs text-gray-500 mb-4">
                                        Want to use your own ChatGPT or Claude Plus subscription? Copy the prompt below, generate the JSON on their website, and paste it back here to preview and export!
                                    </p>
                                    <div className="space-y-3">
                                        <button
                                            onClick={handleCopyPrompt}
                                            disabled={isGeneratingPrompt}
                                            className="w-full py-2 bg-[#222] border border-[#444] hover:bg-[#333] hover:border-indigo-500 transition-colors disabled:opacity-50 rounded-lg text-sm font-medium flex items-center justify-center gap-2"
                                        >
                                            {isGeneratingPrompt ? '⏳ Formatting Prompt...' : '📋 1. Copy Prompt to Clipboard'}
                                        </button>

                                        <div className="relative">
                                            <textarea
                                                value={externalAiJson}
                                                onChange={e => setExternalAiJson(e.target.value)}
                                                placeholder="2. Paste the JSON result here from ChatGPT or Claude..."
                                                className="w-full bg-[#1a1a1a] border border-[#444] rounded-lg px-3 py-2 text-xs font-mono text-green-400 focus:border-indigo-500 outline-none h-24 resize-none"
                                            />
                                        </div>

                                        <button
                                            onClick={handleImportJson}
                                            disabled={!externalAiJson.trim()}
                                            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm font-bold"
                                        >
                                            📥 3. Import & Preview Short
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="flex-1 overflow-auto p-6">
                                {/* Hook Title Editor */}
                                <div className="mb-4 bg-[#222] rounded-lg p-3 border border-[#333]">
                                    <label className="block text-xs text-gray-500 mb-1">🎯 HOOK TITLE (appears on first clip)</label>
                                    <input
                                        type="text"
                                        value={generatedShort.hookTitle || ''}
                                        onChange={(e) => setGeneratedShort({ ...generatedShort, hookTitle: e.target.value })}
                                        placeholder="Enter hook title..."
                                        className="w-full bg-[#1a1a1a] border border-[#444] rounded px-3 py-2 text-white font-bold focus:border-purple-500 outline-none"
                                        maxLength={50}
                                    />
                                    <p className="text-xs text-gray-600 mt-1">Max 5 words recommended for impact</p>
                                </div>

                                {/* Preview Player Area */}
                                <div className="bg-black rounded-xl mb-4 relative overflow-hidden" style={{ aspectRatio: '9/16', maxHeight: '400px', margin: '0 auto', width: 'fit-content' }}>
                                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-purple-900/30 to-black/80">
                                        {/* Hook Title Display - appears at top during preview */}
                                        {(previewClipIndex === 0 || !isPreviewPlaying) && generatedShort.hookTitle && (
                                            <div
                                                className="absolute top-12 left-4 right-4 transition-opacity duration-700"
                                                style={{ opacity: isPreviewPlaying ? 1 : 0.7 }}
                                            >
                                                <div className="bg-gradient-to-r from-purple-600/90 to-pink-600/90 rounded-lg p-3 text-center shadow-xl border border-purple-400/30">
                                                    <p className="text-white text-lg font-bold tracking-wide drop-shadow-lg">{generatedShort.hookTitle}</p>
                                                </div>
                                            </div>
                                        )}

                                        {/* Caption display */}
                                        {isPreviewPlaying && previewCaption ? (
                                            <div className="absolute bottom-8 left-4 right-4">
                                                <div className="bg-black/80 rounded-lg p-4 text-center">
                                                    <p className="text-white text-lg font-medium leading-relaxed">{(() => {
                                                        if (!previewKeywords || previewKeywords.length === 0) return previewCaption;
                                                        const words = previewCaption.split(/(\s+)/);
                                                        let wIdx = 0;
                                                        return words.map((tok: string, ti: number) => {
                                                            if (/^\s+$/.test(tok)) return <span key={ti}>{tok}</span>;
                                                            const kw = previewKeywords.find((k: any) => k.wordIndex === wIdx && k.enabled);
                                                            const el = kw ? <span key={ti} className="font-bold" style={{ color: kw.color || '#FFD700' }}>{tok}</span> : <span key={ti}>{tok}</span>;
                                                            wIdx++;
                                                            return el;
                                                        });
                                                    })()}</p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="text-center px-8">
                                                <div className="text-6xl mb-4">🎬</div>
                                                <h4 className="text-xl font-bold mb-2">{generatedShort.title}</h4>
                                                <p className="text-gray-400 text-sm">{formatDuration(generatedShort.totalDuration)} • {generatedShort.segments.length} clips</p>
                                            </div>
                                        )}

                                        {/* Progress indicator */}
                                        {isPreviewPlaying && (
                                            <div className="absolute top-4 left-4 right-4">
                                                <div className="flex gap-1">
                                                    {generatedShort.segments.map((_, i) => (
                                                        <div key={i} className={`flex-1 h-1 rounded-full ${i === previewClipIndex ? 'bg-purple-500' : i < previewClipIndex ? 'bg-purple-300' : 'bg-gray-600'}`} />
                                                    ))}
                                                </div>
                                                <p className="text-xs text-gray-400 mt-2 text-center">Clip {previewClipIndex + 1} of {generatedShort.segments.length}</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Play/Stop overlay button */}
                                    <button
                                        onClick={() => isPreviewPlaying ? stopPreview() : playPreview(generatedShort)}
                                        className="absolute inset-0 flex items-center justify-center hover:bg-black/20 transition-colors group"
                                    >
                                        {!isPreviewPlaying && (
                                            <div className="w-20 h-20 rounded-full bg-purple-600 group-hover:bg-purple-500 flex items-center justify-center shadow-xl">
                                                <span className="text-4xl ml-1">▶</span>
                                            </div>
                                        )}
                                    </button>
                                </div>

                                {/* TTS Preview Controls + Filler Removal */}
                                <div className="flex justify-center gap-4 mb-4">
                                    <button
                                        onClick={() => isPreviewPlaying ? stopPreview() : playPreview(generatedShort)}
                                        className={`px-6 py-2 rounded-lg font-medium flex items-center gap-2 ${isPreviewPlaying ? 'bg-red-600 hover:bg-red-500' : 'bg-purple-600 hover:bg-purple-500'}`}
                                    >
                                        {isPreviewPlaying ? '⏹ Stop Preview' : '🔊 Play with TTS'}
                                    </button>
                                    <button
                                        onClick={handleRemoveFillers}
                                        disabled={isDetectingFillers}
                                        className="px-4 py-2 rounded-lg font-medium bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-sm"
                                        title="AI-detect filler words in transcript and mark them for removal (text-only, low cost)"
                                    >
                                        {isDetectingFillers ? fillerStatus || 'Detecting...' : 'Clean Fillers'}
                                    </button>
                                </div>
                                {fillerStatus && !isDetectingFillers && (
                                    <div className="text-center text-xs text-amber-400 mb-2">{fillerStatus}</div>
                                )}

                                {/* Clips breakdown */}
                                <div className="mb-4">
                                    <div className="text-xs text-gray-500 mb-1">📋 CLIPS BREAKDOWN</div>
                                    <div className="text-[9px] text-gray-600 mb-2">Click word: toggle keyword | Right-click: strike out (removed on export)</div>
                                    <div className="space-y-2 max-h-48 overflow-auto">
                                        {generatedShort.segments.map((seg, i) => (
                                            <div key={i} className={`rounded p-3 border ${isPreviewPlaying && i === previewClipIndex ? 'bg-purple-600/20 border-purple-500' : 'bg-[#222] border-transparent'}`}>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={`text-xs px-2 py-0.5 rounded ${i === 0 ? 'bg-green-600' : i === generatedShort.segments.length - 1 ? 'bg-blue-600' : 'bg-indigo-600'}`}>
                                                        {i === 0 ? '🪝 Hook' : i === generatedShort.segments.length - 1 ? '✨ End' : `Clip ${i + 1}`}
                                                    </span>
                                                    <span className="text-xs text-gray-500">{formatTime(seg.startTime)} - {formatTime(seg.endTime)}</span>
                                                </div>
                                                <p className="text-sm text-gray-300">{renderInteractiveText(seg.text, i, seg.keywords, seg.removedWordIndices)}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {generatedShort.segments.some(s => s.keywords && s.keywords.length > 0) && (
                                    <div className="mb-4">
                                        <div className="text-xs text-gray-500 mb-2">KEYWORD EMPHASIS</div>
                                        <div className="flex flex-wrap gap-2">
                                            {generatedShort.segments.flatMap((seg, segIdx) =>
                                                (seg.keywords || []).map((kw, kwIdx) => (
                                                    <label key={`${segIdx}-${kwIdx}`}
                                                        className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs cursor-pointer ${kw.enabled ? 'bg-yellow-600/20 border-yellow-500/50 text-yellow-300' : 'bg-[#222] border-[#444] text-gray-500 line-through'}`}>
                                                        <input type="checkbox" checked={kw.enabled}
                                                            onChange={() => toggleKeyword(segIdx, kwIdx)}
                                                            className="accent-yellow-500" />
                                                        {kw.word}
                                                    </label>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Refinement UI */}
                                <div className="mb-4 pt-4 border-t border-[#333]">
                                    <label className="block text-xs text-indigo-400 font-bold mb-2">✨ REFINE THIS RESULT</label>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={refinementPrompt}
                                            onChange={e => setRefinementPrompt(e.target.value)}
                                            placeholder="e.g. 'Make the ending punchier', 'Find a better hook'..."
                                            className="flex-1 bg-[#222] border border-[#333] rounded px-3 py-2 text-sm focus:border-indigo-500 outline-none"
                                            onKeyDown={e => e.key === 'Enter' && handleGenerateShort()}
                                        />
                                        <button
                                            onClick={handleGenerateShort}
                                            disabled={isGeneratingShort}
                                            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-2 rounded text-sm font-medium whitespace-nowrap"
                                        >
                                            {isGeneratingShort ? '🔄 Refining...' : '✨ Refine'}
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-gray-500 mt-1">AI will research the transcript again to match your instructions.</p>
                                </div>

                                <div className="flex gap-2">
                                    <button onClick={() => { stopPreview(); setGeneratedShort(null); setRefinementPrompt(''); }} className="flex-1 py-2 border border-[#333] hover:bg-[#222] rounded text-gray-400">Start Over</button>
                                    {onExportShort && (
                                        <button
                                            onClick={async () => {
                                                if (isExporting) return;
                                                stopPreview();
                                                setIsExporting(true);
                                                try {
                                                    await onExportShort(generatedShort);
                                                    setShowShortModal(false);
                                                } finally {
                                                    setIsExporting(false);
                                                }
                                            }}
                                            disabled={isExporting}
                                            className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
                                        >
                                            {isExporting ? 'Exporting...' : 'Export to Editor'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )
            }
        </div >
    );
};

export default ContentLibraryPage;
