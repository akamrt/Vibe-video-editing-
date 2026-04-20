import React, { useState } from 'react';
import { ExportSettings, AspectRatioPreset } from '../types';
import { ASPECT_RATIO_PRESETS } from '../utils/interpolation';

interface ExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onExport: (settings: ExportSettings) => void;
    duration: number;
}

const RESOLUTION_OPTIONS = {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '4K': { width: 3840, height: 2160 }
};

/**
 * Export Modal Component
 * Allows users to configure export settings including aspect ratio, resolution, and quality
 */
const ExportModal: React.FC<ExportModalProps> = ({
    isOpen,
    onClose,
    onExport,
    duration
}) => {
    const [aspectRatio, setAspectRatio] = useState<AspectRatioPreset>('9:16');
    const [resolution, setResolution] = useState<'720p' | '1080p' | '4K'>('1080p');
    const [bitrateMbps, setBitrateMbps] = useState(8);
    const [fps, setFps] = useState(30);
    const [format, setFormat] = useState<'mp4' | 'webm'>('mp4');
    if (!isOpen) return null;

    const handleExport = () => {
        const settings: ExportSettings = {
            aspectRatio,
            resolution,
            format,
            bitrateMbps,
            fps
        };

        onExport(settings);
        onClose();
    };

    const getOutputDimensions = () => {
        const baseRes = RESOLUTION_OPTIONS[resolution];
        const aspect = ASPECT_RATIO_PRESETS[aspectRatio];

        if (!aspect) return baseRes;

        // Adjust based on aspect ratio
        if (aspect.ratio > 1) {
            // Landscape
            return { width: baseRes.width, height: Math.round(baseRes.width / aspect.ratio) };
        } else {
            // Portrait or square
            return { width: Math.round(baseRes.height * aspect.ratio), height: baseRes.height };
        }
    };

    const outputDims = getOutputDimensions();

    return (
        <div style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            backdropFilter: 'blur(4px)'
        }}>
            <div style={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: 12,
                width: 480,
                overflow: 'hidden',
                boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)'
            }}>
                {/* Header */}
                <div style={{
                    padding: '16px 20px',
                    borderBottom: '1px solid #333',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    background: 'linear-gradient(180deg, #252525 0%, #1a1a1a 100%)'
                }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 20 }}>📹</span> Export Video
                    </h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            color: '#888',
                            fontSize: 20,
                            cursor: 'pointer',
                            padding: 4
                        }}
                    >
                        ✕
                    </button>
                </div>

                {/* Content */}
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {/* Aspect Ratio */}
                    <div>
                        <label style={{ display: 'block', marginBottom: 12, fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
                            Aspect Ratio
                        </label>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                            {(['16:9', '9:16', '1:1', '4:5'] as AspectRatioPreset[]).map(ar => (
                                <button
                                    key={ar}
                                    onClick={() => setAspectRatio(ar)}
                                    style={{
                                        padding: '12px 8px',
                                        borderRadius: 8,
                                        border: ar === aspectRatio ? '2px solid #3b82f6' : '1px solid #444',
                                        backgroundColor: ar === aspectRatio ? 'rgba(59, 130, 246, 0.15)' : '#252525',
                                        color: ar === aspectRatio ? '#3b82f6' : '#ccc',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: 4,
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    <span style={{ fontSize: 14, fontWeight: 600 }}>{ar}</span>
                                    <span style={{ fontSize: 10, opacity: 0.7 }}>
                                        {ar === '16:9' && 'Landscape'}
                                        {ar === '9:16' && 'Portrait'}
                                        {ar === '1:1' && 'Square'}
                                        {ar === '4:5' && 'Instagram'}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Format */}
                    <div>
                        <label style={{ display: 'block', marginBottom: 12, fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
                            Format
                        </label>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                            {([
                                { id: 'mp4' as const, label: 'MP4', sub: 'TikTok / Universal' },
                                { id: 'webm' as const, label: 'WebM', sub: 'Web / Smaller' },
                            ]).map(opt => (
                                <button
                                    key={opt.id}
                                    onClick={() => setFormat(opt.id)}
                                    style={{
                                        padding: '12px 8px',
                                        borderRadius: 8,
                                        border: opt.id === format ? '2px solid #3b82f6' : '1px solid #444',
                                        backgroundColor: opt.id === format ? 'rgba(59, 130, 246, 0.15)' : '#252525',
                                        color: opt.id === format ? '#3b82f6' : '#ccc',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        gap: 4,
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    <span style={{ fontSize: 14, fontWeight: 600 }}>{opt.label}</span>
                                    <span style={{ fontSize: 10, opacity: 0.7 }}>{opt.sub}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Resolution & FPS */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        <div>
                            <label style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
                                Resolution
                            </label>
                            <select
                                value={resolution}
                                onChange={e => setResolution(e.target.value as any)}
                                style={{
                                    width: '100%',
                                    padding: '10px 12px',
                                    borderRadius: 6,
                                    border: '1px solid #444',
                                    backgroundColor: '#252525',
                                    color: '#fff',
                                    fontSize: 14,
                                    cursor: 'pointer'
                                }}
                            >
                                <option value="720p">720p HD</option>
                                <option value="1080p">1080p Full HD</option>
                                <option value="4K">4K Ultra HD</option>
                            </select>
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
                                Frame Rate
                            </label>
                            <select
                                value={fps}
                                onChange={e => setFps(parseInt(e.target.value))}
                                style={{
                                    width: '100%',
                                    padding: '10px 12px',
                                    borderRadius: 6,
                                    border: '1px solid #444',
                                    backgroundColor: '#252525',
                                    color: '#fff',
                                    fontSize: 14,
                                    cursor: 'pointer'
                                }}
                            >
                                <option value={24}>24 fps (Cinema)</option>
                                <option value={30}>30 fps</option>
                                <option value={60}>60 fps</option>
                            </select>
                        </div>
                    </div>

                    {/* Bitrate */}
                    <div>
                        <label style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 1 }}>
                            <span>Quality (Bitrate)</span>
                            <span style={{ color: '#fff' }}>{bitrateMbps} Mbps</span>
                        </label>
                        <input
                            type="range"
                            min={5}
                            max={50}
                            value={bitrateMbps}
                            onChange={e => setBitrateMbps(parseInt(e.target.value))}
                            style={{
                                width: '100%',
                                accentColor: '#3b82f6'
                            }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666', marginTop: 4 }}>
                            <span>Lower size</span>
                            <span>Higher quality</span>
                        </div>
                    </div>

                    {/* Output Preview */}
                    <div style={{
                        padding: 16,
                        backgroundColor: '#252525',
                        borderRadius: 8,
                        border: '1px solid #333'
                    }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                            Output Preview
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ fontSize: 16, fontWeight: 600, color: '#fff' }}>
                                    {outputDims.width} × {outputDims.height}
                                </div>
                                <div style={{ fontSize: 12, color: '#888' }}>
                                    {format === 'mp4' ? 'MP4 (H.264/AAC)' : 'WebM (VP9/Opus)'} • {fps} fps • ~{Math.round(duration * bitrateMbps / 8)} MB
                                </div>
                            </div>
                            <div style={{
                                width: 48,
                                height: 48 * (outputDims.height / outputDims.width),
                                backgroundColor: '#3b82f6',
                                borderRadius: 4,
                                border: '2px solid #fff',
                                maxHeight: 60
                            }} />
                        </div>
                    </div>

                </div>

                {/* Footer */}
                <div style={{
                    padding: '16px 24px',
                    borderTop: '1px solid #333',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 12
                }}>
                    <button
                        onClick={onClose}
                        style={{
                            padding: '10px 20px',
                            borderRadius: 6,
                            border: '1px solid #444',
                            backgroundColor: 'transparent',
                            color: '#ccc',
                            fontSize: 14,
                            cursor: 'pointer',
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleExport}
                        style={{
                            padding: '10px 24px',
                            borderRadius: 6,
                            border: 'none',
                            backgroundColor: '#3b82f6',
                            color: '#fff',
                            fontSize: 14,
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8
                        }}
                    >
                        🎬 Add to Render Queue
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ExportModal;
