import React from 'react';
import { AspectRatioPreset } from '../types';
import { ASPECT_RATIO_PRESETS } from '../utils/interpolation';

interface ViewportOverlayProps {
    containerWidth: number;
    containerHeight: number;
    aspectRatio: AspectRatioPreset;
    opacity: number;
    visible: boolean;
}

/**
 * Viewport Overlay Component
 * Displays a semi-transparent mask showing the safe zone for the selected aspect ratio
 * Uses SVG with a rectangular cutout for reliable rendering
 */
const ViewportOverlay: React.FC<ViewportOverlayProps> = ({
    containerWidth,
    containerHeight,
    aspectRatio,
    opacity,
    visible
}) => {
    // Debug logging
    console.log('[ViewportOverlay] Props:', { visible, aspectRatio, containerWidth, containerHeight, opacity });

    if (!visible || aspectRatio === 'custom') return null;
    if (containerWidth <= 0 || containerHeight <= 0) {
        console.log('[ViewportOverlay] Skipping render - invalid dimensions');
        return null;
    }

    const preset = ASPECT_RATIO_PRESETS[aspectRatio];
    if (!preset) return null;

    // Calculate the safe zone dimensions
    const containerRatio = containerWidth / containerHeight;
    const targetRatio = preset.ratio;

    let safeWidth: number, safeHeight: number, safeX: number, safeY: number;

    if (containerRatio > targetRatio) {
        // Container is wider - pillarbox (bars on left/right)
        safeHeight = containerHeight;
        safeWidth = containerHeight * targetRatio;
        safeX = (containerWidth - safeWidth) / 2;
        safeY = 0;
    } else {
        // Container is taller - letterbox (bars on top/bottom)
        safeWidth = containerWidth;
        safeHeight = containerWidth / targetRatio;
        safeX = 0;
        safeY = (containerHeight - safeHeight) / 2;
    }

    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                zIndex: 10
            }}
        >
            {/* SVG Mask - black overlay with transparent cutout */}
            <svg
                width={containerWidth}
                height={containerHeight}
                style={{ position: 'absolute', top: 0, left: 0 }}
            >
                <defs>
                    <mask id="viewport-mask">
                        {/* White = visible, black = hidden */}
                        <rect x="0" y="0" width={containerWidth} height={containerHeight} fill="white" />
                        <rect x={safeX} y={safeY} width={safeWidth} height={safeHeight} fill="black" />
                    </mask>
                </defs>
                {/* Dark overlay with cutout */}
                <rect
                    x="0"
                    y="0"
                    width={containerWidth}
                    height={containerHeight}
                    fill={`rgba(0, 0, 0, ${opacity})`}
                    mask="url(#viewport-mask)"
                />
            </svg>

            {/* Safe zone border */}
            <div
                style={{
                    position: 'absolute',
                    left: safeX,
                    top: safeY,
                    width: safeWidth,
                    height: safeHeight,
                    border: '2px solid rgba(255, 255, 255, 0.8)',
                    boxSizing: 'border-box',
                    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.5)'
                }}
            />

            {/* Aspect ratio label */}
            <div
                style={{
                    position: 'absolute',
                    left: safeX + 8,
                    top: safeY + 8,
                    padding: '4px 10px',
                    backgroundColor: 'rgba(0, 0, 0, 0.85)',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#fff',
                    fontWeight: 'bold',
                    border: '1px solid rgba(255, 255, 255, 0.3)'
                }}
            >
                {aspectRatio} • {Math.round(safeWidth)}×{Math.round(safeHeight)}
            </div>

            {/* Rule of thirds grid */}
            <svg
                width={safeWidth}
                height={safeHeight}
                style={{
                    position: 'absolute',
                    left: safeX,
                    top: safeY,
                    pointerEvents: 'none'
                }}
            >
                {/* Vertical lines */}
                <line x1={safeWidth / 3} y1="0" x2={safeWidth / 3} y2={safeHeight} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
                <line x1={safeWidth * 2 / 3} y1="0" x2={safeWidth * 2 / 3} y2={safeHeight} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
                {/* Horizontal lines */}
                <line x1="0" y1={safeHeight / 3} x2={safeWidth} y2={safeHeight / 3} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
                <line x1="0" y1={safeHeight * 2 / 3} x2={safeWidth} y2={safeHeight * 2 / 3} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
                {/* Center crosshair */}
                <circle cx={safeWidth / 2} cy={safeHeight / 2} r="4" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                <line x1={safeWidth / 2 - 10} y1={safeHeight / 2} x2={safeWidth / 2 + 10} y2={safeHeight / 2} stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                <line x1={safeWidth / 2} y1={safeHeight / 2 - 10} x2={safeWidth / 2} y2={safeHeight / 2 + 10} stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
            </svg>
        </div>
    );
};

export default ViewportOverlay;
