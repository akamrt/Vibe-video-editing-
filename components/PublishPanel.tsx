import React, { useState } from 'react';
import { SocialPackage, InstagramPackage, TikTokPackage, YouTubePackage } from '../services/contentDatabase';

/**
 * Copy text to the clipboard with a textarea/execCommand fallback for
 * permission-denied contexts. Mirrors the pattern in ContentLibraryPage.
 */
async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch {
            return false;
        }
    }
}

interface CopyFieldProps {
    label: string;
    value: string;
    copyId: string;
    copiedId: string | null;
    onCopy: (id: string, text: string) => void;
    multiline?: boolean;
}

const CopyField: React.FC<CopyFieldProps> = ({ label, value, copyId, copiedId, onCopy, multiline }) => (
    <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-2">
        <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{label}</span>
            <button
                onClick={() => onCopy(copyId, value)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${copiedId === copyId
                    ? 'bg-green-600/20 border-green-500/50 text-green-400'
                    : 'bg-[#222] border-[#333] hover:bg-[#333] text-gray-300'
                    }`}
            >
                {copiedId === copyId ? 'Copied!' : 'Copy'}
            </button>
        </div>
        {multiline ? (
            <div className="text-xs text-gray-200 whitespace-pre-wrap break-words">{value || <em className="text-gray-600">(empty)</em>}</div>
        ) : (
            <div className="text-xs text-gray-200 break-words">{value || <em className="text-gray-600">(empty)</em>}</div>
        )}
    </div>
);

interface CopyListProps {
    label: string;
    items: string[];
    copyId: string;
    copiedId: string | null;
    onCopy: (id: string, text: string) => void;
    joinWith?: string; // Character used when copying all items at once
    prefixEach?: string; // Prefix each item with this string (e.g. "#" for hashtags)
}

const CopyList: React.FC<CopyListProps> = ({ label, items, copyId, copiedId, onCopy, joinWith = '\n', prefixEach = '' }) => {
    const joinedForCopy = (items || []).map(item => `${prefixEach}${item}`).join(joinWith);
    return (
        <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded px-3 py-2">
            <div className="flex items-start justify-between gap-2 mb-1">
                <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{label}</span>
                <button
                    onClick={() => onCopy(copyId, joinedForCopy)}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${copiedId === copyId
                        ? 'bg-green-600/20 border-green-500/50 text-green-400'
                        : 'bg-[#222] border-[#333] hover:bg-[#333] text-gray-300'
                        }`}
                >
                    {copiedId === copyId ? 'Copied!' : 'Copy All'}
                </button>
            </div>
            {(items || []).length === 0 ? (
                <div className="text-xs text-gray-600 italic">(none)</div>
            ) : (
                <div className="flex flex-wrap gap-1">
                    {items.map((item, i) => (
                        <span key={i} className="text-[10px] bg-[#222] border border-[#333] rounded px-1.5 py-0.5 text-gray-300">
                            {prefixEach}{item}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
};

interface InstagramSectionProps {
    pkg: InstagramPackage;
    copiedId: string | null;
    onCopy: (id: string, text: string) => void;
    keyPrefix: string;
}

const InstagramSection: React.FC<InstagramSectionProps> = ({ pkg, copiedId, onCopy, keyPrefix }) => (
    <div className="space-y-2">
        <CopyField label="Hook" value={pkg.hook} copyId={`${keyPrefix}-ig-hook`} copiedId={copiedId} onCopy={onCopy} />
        <CopyField label="Caption" value={pkg.caption} copyId={`${keyPrefix}-ig-caption`} copiedId={copiedId} onCopy={onCopy} multiline />
        <CopyField label="CTA" value={pkg.cta} copyId={`${keyPrefix}-ig-cta`} copiedId={copiedId} onCopy={onCopy} />
        <CopyList label={`Hashtags (${pkg.hashtags?.length || 0})`} items={pkg.hashtags || []} copyId={`${keyPrefix}-ig-tags`} copiedId={copiedId} onCopy={onCopy} joinWith=" " prefixEach="#" />
    </div>
);

interface TikTokSectionProps {
    pkg: TikTokPackage;
    copiedId: string | null;
    onCopy: (id: string, text: string) => void;
    keyPrefix: string;
}

const TikTokSection: React.FC<TikTokSectionProps> = ({ pkg, copiedId, onCopy, keyPrefix }) => (
    <div className="space-y-2">
        <CopyField label="Hook" value={pkg.hook} copyId={`${keyPrefix}-tt-hook`} copiedId={copiedId} onCopy={onCopy} />
        <CopyField label={`Caption (${pkg.caption?.length || 0} chars)`} value={pkg.caption} copyId={`${keyPrefix}-tt-caption`} copiedId={copiedId} onCopy={onCopy} multiline />
        <CopyList label="On-Screen Text" items={pkg.onScreenText || []} copyId={`${keyPrefix}-tt-ost`} copiedId={copiedId} onCopy={onCopy} />
        <CopyField label="CTA" value={pkg.cta} copyId={`${keyPrefix}-tt-cta`} copiedId={copiedId} onCopy={onCopy} />
        <CopyList label={`Hashtags (${pkg.hashtags?.length || 0})`} items={pkg.hashtags || []} copyId={`${keyPrefix}-tt-tags`} copiedId={copiedId} onCopy={onCopy} joinWith=" " prefixEach="#" />
    </div>
);

interface YouTubeSectionProps {
    pkg: YouTubePackage;
    copiedId: string | null;
    onCopy: (id: string, text: string) => void;
    keyPrefix: string;
}

const YouTubeSection: React.FC<YouTubeSectionProps> = ({ pkg, copiedId, onCopy, keyPrefix }) => (
    <div className="space-y-2">
        <CopyList label="Title Variations" items={pkg.titles || []} copyId={`${keyPrefix}-yt-titles`} copiedId={copiedId} onCopy={onCopy} />
        <CopyField label="Description" value={pkg.description} copyId={`${keyPrefix}-yt-desc`} copiedId={copiedId} onCopy={onCopy} multiline />
        <CopyField label="Hook Script" value={pkg.hook} copyId={`${keyPrefix}-yt-hook`} copiedId={copiedId} onCopy={onCopy} />
        <CopyList label="Thumbnail Text Ideas" items={pkg.thumbnailText || []} copyId={`${keyPrefix}-yt-thumb`} copiedId={copiedId} onCopy={onCopy} />
        <CopyField label="CTA" value={pkg.cta} copyId={`${keyPrefix}-yt-cta`} copiedId={copiedId} onCopy={onCopy} />
        <CopyList label={`Tags (${pkg.tags?.length || 0})`} items={pkg.tags || []} copyId={`${keyPrefix}-yt-tags`} copiedId={copiedId} onCopy={onCopy} joinWith=", " />
    </div>
);

export interface PublishPanelProps {
    socialPackage?: SocialPackage;
    title?: string;
    shortTitle?: string;
    isGenerating?: boolean;
    onGenerate?: () => void;
    onRegenerate?: () => void;
    keyPrefix?: string; // Unique prefix for copy-button ids when rendered in lists
    compact?: boolean;
    emptyMessage?: string;
}

export const PublishPanel: React.FC<PublishPanelProps> = ({
    socialPackage,
    title,
    shortTitle,
    isGenerating,
    onGenerate,
    onRegenerate,
    keyPrefix = 'pp',
    compact = false,
    emptyMessage,
}) => {
    const [activePlatform, setActivePlatform] = useState<'instagram' | 'tiktok' | 'youtube'>('instagram');
    const [copiedId, setCopiedId] = useState<string | null>(null);

    const handleCopy = async (id: string, text: string) => {
        const ok = await copyToClipboard(text);
        if (ok) {
            setCopiedId(id);
            setTimeout(() => setCopiedId(null), 1500);
        }
    };

    if (!socialPackage) {
        return (
            <div className={`${compact ? 'p-3' : 'p-6'} bg-[#111] border border-[#2a2a2a] rounded-lg text-center`}>
                {title && <h4 className="text-xs font-bold text-gray-300 mb-2">{title}</h4>}
                <p className="text-xs text-gray-500 mb-3">
                    {emptyMessage || 'No social media package generated yet.'}
                </p>
                {onGenerate && (
                    <button
                        onClick={onGenerate}
                        disabled={isGenerating}
                        className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 rounded text-xs font-bold"
                    >
                        {isGenerating ? 'Generating...' : 'Generate Social Package'}
                    </button>
                )}
            </div>
        );
    }

    return (
        <div className={compact ? '' : 'bg-[#111] border border-[#2a2a2a] rounded-lg p-3'}>
            {(title || shortTitle) && (
                <div className="flex items-center justify-between mb-2">
                    <div>
                        {title && <h4 className="text-xs font-bold text-gray-300">{title}</h4>}
                        {shortTitle && <div className="text-[10px] text-gray-500 truncate max-w-[280px]">{shortTitle}</div>}
                    </div>
                    {onRegenerate && (
                        <button
                            onClick={onRegenerate}
                            disabled={isGenerating}
                            className="text-[10px] px-2 py-1 bg-[#222] border border-[#333] hover:bg-[#333] disabled:opacity-50 rounded text-gray-400"
                            title="Regenerate social package"
                        >
                            {isGenerating ? '...' : '⟳ Regenerate'}
                        </button>
                    )}
                </div>
            )}

            {/* Platform sub-tabs */}
            <div className="flex items-center gap-1 mb-2 border-b border-[#2a2a2a]">
                <button
                    onClick={() => setActivePlatform('instagram')}
                    className={`px-3 py-1.5 text-[10px] font-bold transition-colors ${activePlatform === 'instagram' ? 'text-pink-400 border-b-2 border-pink-400' : 'text-gray-500 hover:text-white'}`}
                >
                    INSTAGRAM
                </button>
                <button
                    onClick={() => setActivePlatform('tiktok')}
                    className={`px-3 py-1.5 text-[10px] font-bold transition-colors ${activePlatform === 'tiktok' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-500 hover:text-white'}`}
                >
                    TIKTOK
                </button>
                <button
                    onClick={() => setActivePlatform('youtube')}
                    className={`px-3 py-1.5 text-[10px] font-bold transition-colors ${activePlatform === 'youtube' ? 'text-red-400 border-b-2 border-red-400' : 'text-gray-500 hover:text-white'}`}
                >
                    YOUTUBE
                </button>
            </div>

            {activePlatform === 'instagram' && (
                <InstagramSection pkg={socialPackage.instagram} copiedId={copiedId} onCopy={handleCopy} keyPrefix={keyPrefix} />
            )}
            {activePlatform === 'tiktok' && (
                <TikTokSection pkg={socialPackage.tiktok} copiedId={copiedId} onCopy={handleCopy} keyPrefix={keyPrefix} />
            )}
            {activePlatform === 'youtube' && (
                <YouTubeSection pkg={socialPackage.youtube} copiedId={copiedId} onCopy={handleCopy} keyPrefix={keyPrefix} />
            )}

            {socialPackage.sourceVideoUrl && (
                <div className="mt-2 text-[9px] text-gray-600">
                    Source video URL included in prompt: <span className="font-mono break-all">{socialPackage.sourceVideoUrl}</span>
                </div>
            )}
        </div>
    );
};

export default PublishPanel;
