import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Segment, ClipKeyframe, KeyframeConfig } from '../types';
import { bezierInterp, getInterpolatedTransform } from '../utils/interpolation';

interface GraphEditorProps {
    visible: boolean;
    onClose: () => void;
    segment: Segment | null;
    segmentDuration: number;
    currentTime: number; // Relative to clip start (or timeline time for global)
    onSeek: (clipTime: number) => void;
    onUpdateKeyframes: (keyframes: ClipKeyframe[]) => void;
    keyframes?: ClipKeyframe[]; // External keyframes (for global transform)
    isGlobalMode?: boolean; // True when editing global transform
    fps?: number;
}

// Channel colors
const CHANNEL_COLORS = {
    translateX: '#ff4444',
    translateY: '#44ff44',
    scale: '#3b82f6',
    rotation: '#f97316'
};

const CHANNEL_LABELS = {
    translateX: 'X Position',
    translateY: 'Y Position',
    scale: 'Scale',
    rotation: 'Rotation'
};

type ChannelType = keyof typeof CHANNEL_COLORS;
const ALL_CHANNELS: ChannelType[] = ['translateX', 'translateY', 'scale', 'rotation'];
const CHANNEL_DEFAULTS: Record<ChannelType, number> = { translateX: 0, translateY: 0, scale: 1, rotation: 0 };

// ===== Ramer-Douglas-Peucker Simplification =====
function rdpSimplify(kfs: ClipKeyframe[], tolerance: number, channels: Set<ChannelType>): ClipKeyframe[] {
    if (kfs.length <= 2) return kfs;
    const start = kfs[0], end = kfs[kfs.length - 1];
    const dt = end.time - start.time;
    if (dt <= 0) return [start, end];

    let maxDist = 0, maxIdx = 0;
    for (let i = 1; i < kfs.length - 1; i++) {
        const t = (kfs[i].time - start.time) / dt;
        let err = 0;
        for (const ch of channels) {
            const interp = (start[ch] as number) + t * ((end[ch] as number) - (start[ch] as number));
            err = Math.max(err, Math.abs((kfs[i][ch] as number) - interp));
        }
        if (err > maxDist) { maxDist = err; maxIdx = i; }
    }
    if (maxDist > tolerance) {
        const left = rdpSimplify(kfs.slice(0, maxIdx + 1), tolerance, channels);
        const right = rdpSimplify(kfs.slice(maxIdx), tolerance, channels);
        return [...left.slice(0, -1), ...right];
    }
    return [start, end];
}

// ===== Gaussian Keyframe Smoothing =====
function smoothKeyframeValues(
    keyframes: ClipKeyframe[],
    selectedTimes: Set<string>, // empty = smooth ALL keyframes
    amount: number,             // 0–100
    channels: Set<ChannelType>
): ClipKeyframe[] {
    const sorted = [...keyframes].sort((a, b) => a.time - b.time);
    const n = sorted.length;
    if (n < 3 || amount === 0) return sorted;

    // amount 0–100 → radius 1 to n/3 frames
    const maxRadius = Math.max(2, Math.floor(n / 3));
    const radius = Math.max(1, Math.round((amount / 100) * maxRadius));
    const sigma = radius / 2.0;

    return sorted.map((kf, i) => {
        const key = kf.time.toFixed(3);
        // If specific keys are targeted, skip non-selected ones
        if (selectedTimes.size > 0 && !selectedTimes.has(key)) return kf;

        const newKf = { ...kf };
        for (const ch of channels) {
            let wSum = 0, wTotal = 0;
            for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
                const dist = Math.abs(i - j);
                const w = Math.exp(-(dist * dist) / (2 * sigma * sigma));
                wSum += (sorted[j][ch] as number) * w;
                wTotal += w;
            }
            if (wTotal > 0) (newKf as any)[ch] = wSum / wTotal;
        }
        return newKf;
    });
}

// ===== Value Clamping (snap similar values together) =====
function clampKeyframeValues(
    originals: ClipKeyframe[],
    selectedTimes: Set<string>,
    threshold: number,
    channels: Set<ChannelType>
): ClipKeyframe[] {
    const result = originals.map(kf => ({ ...kf }));
    const selectedIndices: number[] = [];
    result.forEach((kf, i) => { if (selectedTimes.has(kf.time.toFixed(3))) selectedIndices.push(i); });
    if (selectedIndices.length <= 1 || threshold <= 0) return result;

    for (const ch of channels) {
        const indexed = selectedIndices.map(i => ({ idx: i, value: result[i][ch] as number }));
        indexed.sort((a, b) => a.value - b.value);

        // Group with complete-linkage: compare to group min
        const groups: (typeof indexed)[] = [];
        let group = [indexed[0]];
        for (let i = 1; i < indexed.length; i++) {
            if (indexed[i].value - group[0].value <= threshold) {
                group.push(indexed[i]);
            } else {
                groups.push(group);
                group = [indexed[i]];
            }
        }
        groups.push(group);

        for (const g of groups) {
            if (g.length <= 1) continue;
            const avg = g.reduce((s, v) => s + v.value, 0) / g.length;
            for (const v of g) (result[v.idx] as any)[ch] = avg;
        }
    }
    return result;
}

interface GraphPoint {
    time: number;
    value: number;
    channel: ChannelType;
}

/**
 * Graph Editor Component
 * Canvas-based keyframe curve editor for clip animation
 */
const GraphEditor: React.FC<GraphEditorProps> = ({
    visible,
    onClose,
    segment,
    segmentDuration,
    currentTime,
    onSeek,
    onUpdateKeyframes,
    keyframes: externalKeyframes,
    isGlobalMode = false,
    fps = 30
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [offset, setOffset] = useState({ x: 60, y: 20 });
    const [scale, setScale] = useState({ x: 100, y: 2 }); // Pixels per second, pixels per unit
    const [isDragging, setIsDragging] = useState(false);
    const [dragMode, setDragMode] = useState<'pan' | 'edit' | 'marquee' | 'scrub' | 'handle' | null>(null);
    const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
    const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
    const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(null);
    const [hoveredKey, setHoveredKey] = useState<GraphPoint | null>(null);
    const [hoveredHandle, setHoveredHandle] = useState<{ time: number; channel: ChannelType; type: 'in' | 'out' } | null>(null);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [activeChannels, setActiveChannels] = useState<Set<ChannelType>>(
        new Set(['translateX', 'translateY', 'scale', 'rotation'])
    );
    const dragAccumulator = useRef(0);

    // Simplify mode state
    const [simplifyActive, setSimplifyActive] = useState(false);
    const [simplifyAmount, setSimplifyAmount] = useState(30);
    const preSimplifyRef = useRef<ClipKeyframe[] | null>(null);

    // Clamp mode state
    const [clampActive, setClampActive] = useState(false);
    const [clampAmount, setClampAmount] = useState(0);
    const preClampRef = useRef<ClipKeyframe[] | null>(null);
    const clampSelectedRef = useRef<Set<string>>(new Set());

    // Smooth mode state
    const [smoothActive, setSmoothActive] = useState(false);
    const [smoothAmount, setSmoothAmount] = useState(50);
    const preSmoothRef = useRef<ClipKeyframe[] | null>(null);
    const smoothSelectedRef = useRef<Set<string>>(new Set());

    // Use external keyframes if provided, otherwise fall back to segment keyframes
    const keyframes = externalKeyframes ?? segment?.keyframes ?? [];

    // Convert world coordinates to screen
    const worldToScreen = (time: number, value: number): { x: number; y: number } => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const centerY = canvas.height / 2;
        return {
            x: time * scale.x + offset.x,
            y: centerY - value * scale.y + offset.y
        };
    };

    // Convert screen coordinates to world
    const screenToWorld = (sx: number, sy: number): { time: number; value: number } => {
        const canvas = canvasRef.current;
        if (!canvas) return { time: 0, value: 0 };
        const centerY = canvas.height / 2;
        return {
            time: (sx - offset.x) / scale.x,
            value: (centerY + offset.y - sy) / scale.y
        };
    };

    const getSelectionKey = (time: number, channel: ChannelType) => `${time.toFixed(3)}:${channel}`;

    // Render the graph
    const render = useCallback(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const centerY = height / 2;

        // Clear with darker background
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, width, height);

        // Draw editable time range (lighter area)
        const rangeStartX = worldToScreen(0, 0).x;
        const rangeEndX = worldToScreen(segmentDuration, 0).x;
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(Math.max(0, rangeStartX), 0, Math.min(width, rangeEndX) - Math.max(0, rangeStartX), height);

        // Draw range boundaries
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        if (rangeStartX >= 0 && rangeStartX <= width) {
            ctx.beginPath();
            ctx.moveTo(rangeStartX, 0);
            ctx.lineTo(rangeStartX, height);
            ctx.stroke();
        }
        if (rangeEndX >= 0 && rangeEndX <= width) {
            ctx.beginPath();
            ctx.moveTo(rangeEndX, 0);
            ctx.lineTo(rangeEndX, height);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // Draw grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;

        // Vertical grid (time) - extend beyond duration for panning
        const visibleStartTime = -offset.x / scale.x;
        const visibleEndTime = (width - offset.x) / scale.x;
        const timeStep = Math.pow(10, Math.floor(Math.log10(100 / scale.x)));
        const gridStartTime = Math.floor(visibleStartTime / timeStep) * timeStep;
        const gridEndTime = Math.ceil(visibleEndTime / timeStep) * timeStep;

        for (let t = gridStartTime; t <= gridEndTime; t += timeStep) {
            const x = worldToScreen(t, 0).x;
            if (x >= 0 && x <= width) {
                // Lighter grid inside range, darker outside
                ctx.strokeStyle = (t >= 0 && t <= segmentDuration) ? '#333' : '#222';
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();

                // Time label
                ctx.fillStyle = (t >= 0 && t <= segmentDuration) ? '#666' : '#444';
                ctx.font = '10px sans-serif';
                ctx.fillText(`${t.toFixed(1)}s`, x + 2, height - 4);
            }
        }

        // Horizontal grid (value)
        const valueStep = Math.pow(10, Math.floor(Math.log10(50 / scale.y)));
        const startValue = Math.floor((-centerY - offset.y) / scale.y / valueStep) * valueStep;
        const endValue = Math.ceil((centerY - offset.y) / scale.y / valueStep) * valueStep;
        for (let v = startValue; v <= endValue; v += valueStep) {
            const y = worldToScreen(0, v).y;
            if (y >= 0 && y <= height) {
                ctx.strokeStyle = '#333';
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();

                // Value label
                ctx.fillStyle = '#666';
                ctx.font = '10px sans-serif';
                ctx.fillText(`${v}`, 4, y - 2);
            }
        }

        // Draw zero line
        const zeroY = worldToScreen(0, 0).y;
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, zeroY);
        ctx.lineTo(width, zeroY);
        ctx.stroke();

        // Draw curves for each channel
        const channels: ChannelType[] = ['translateX', 'translateY', 'scale', 'rotation'];

        channels.forEach(channel => {
            if (!activeChannels.has(channel)) return;

            const color = CHANNEL_COLORS[channel];
            const defaultVal = CHANNEL_DEFAULTS[channel];
            const points = keyframes
                .filter(kf => kf[channel] !== defaultVal) // Hide dots for channels at default value
                .map(kf => ({ time: kf.time, value: kf[channel] }))
                .sort((a, b) => a.time - b.time);

            if (points.length === 0) return;

            // Draw curve
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();

            // Sample the curve (high resolution)
            const samples = width; // One sample per pixel
            for (let i = 0; i <= samples; i++) {
                const t = (i / samples) * segmentDuration;
                let value = 0;

                // Find surrounding keyframes
                const prev = [...points].reverse().find(p => p.time <= t);
                const next = points.find(p => p.time > t);

                if (prev && next) {
                    // Interpolate
                    const kfPrev = keyframes.find(kf => kf.time === prev.time);
                    const kfNext = keyframes.find(kf => kf.time === next.time);
                    const cfg0 = kfPrev?.keyframeConfig?.[channel];
                    const cfg1 = kfNext?.keyframeConfig?.[channel];
                    value = bezierInterp(prev.value, next.value, prev.time, next.time, t, cfg0, cfg1);
                } else if (prev) {
                    value = prev.value;
                } else if (next) {
                    value = next.value;
                }

                const screen = worldToScreen(t, value);
                if (i === 0) {
                    ctx.moveTo(screen.x, screen.y);
                } else {
                    ctx.lineTo(screen.x, screen.y);
                }
            }
            ctx.stroke();

            // Draw keyframe dots and handles
            points.forEach(pt => {
                const screen = worldToScreen(pt.time, pt.value);
                const selKey = getSelectionKey(pt.time, channel);
                const isSelected = selectedKeys.has(selKey);
                const isHovered = hoveredKey?.time === pt.time && hoveredKey?.channel === channel;

                // Draw Bezier handles for selected keyframes
                if (isSelected) {
                    const kf = keyframes.find(k => Math.abs(k.time - pt.time) < 0.001);
                    const config = kf?.keyframeConfig?.[channel];

                    // Default tangent values if not set
                    const inTangent = config?.inTangent || { x: -0.3, y: 0 };
                    const outTangent = config?.outTangent || { x: 0.3, y: 0 };

                    // Convert tangent to screen coordinates
                    const inHandleScreen = worldToScreen(pt.time + inTangent.x, pt.value + inTangent.y);
                    const outHandleScreen = worldToScreen(pt.time + outTangent.x, pt.value + outTangent.y);

                    // Draw tangent lines
                    ctx.strokeStyle = '#888';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(inHandleScreen.x, inHandleScreen.y);
                    ctx.lineTo(screen.x, screen.y);
                    ctx.lineTo(outHandleScreen.x, outHandleScreen.y);
                    ctx.stroke();

                    // Draw in handle (circle)
                    const inHandleHovered = hoveredHandle?.time === pt.time && hoveredHandle?.channel === channel && hoveredHandle?.type === 'in';
                    ctx.fillStyle = inHandleHovered ? '#fff' : '#f97316';
                    ctx.beginPath();
                    ctx.arc(inHandleScreen.x, inHandleScreen.y, inHandleHovered ? 6 : 4, 0, Math.PI * 2);
                    ctx.fill();

                    // Draw out handle (circle)
                    const outHandleHovered = hoveredHandle?.time === pt.time && hoveredHandle?.channel === channel && hoveredHandle?.type === 'out';
                    ctx.fillStyle = outHandleHovered ? '#fff' : '#3b82f6';
                    ctx.beginPath();
                    ctx.arc(outHandleScreen.x, outHandleScreen.y, outHandleHovered ? 6 : 4, 0, Math.PI * 2);
                    ctx.fill();
                }

                // Draw keyframe diamond
                ctx.fillStyle = isSelected ? '#fff' : color;
                ctx.strokeStyle = isHovered ? '#fff' : '#000';
                ctx.lineWidth = isHovered ? 2 : 1;

                ctx.beginPath();
                // Diamond shape
                const size = isHovered || isSelected ? 8 : 6;
                ctx.moveTo(screen.x, screen.y - size);
                ctx.lineTo(screen.x + size, screen.y);
                ctx.lineTo(screen.x, screen.y + size);
                ctx.lineTo(screen.x - size, screen.y);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            });
        });

        // Draw playhead
        const playheadX = worldToScreen(currentTime, 0).x;
        ctx.strokeStyle = '#f00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, height);
        ctx.stroke();

    }, [keyframes, offset, scale, segmentDuration, currentTime, activeChannels, selectedKeys, hoveredKey, hoveredHandle]);

    useEffect(() => {
        if (visible) render();
    }, [visible, render]);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const resizeObserver = new ResizeObserver(() => {
            canvas.width = container.clientWidth;
            canvas.height = container.clientHeight;
            render();
        });

        resizeObserver.observe(container);
        return () => resizeObserver.disconnect();
    }, [render]);

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const world = screenToWorld(mouseX, mouseY);

        const zoomIntensity = 0.1;
        const delta = -Math.sign(e.deltaY);
        const factor = Math.pow(1 + zoomIntensity, delta);

        let newScaleX = scale.x;
        let newScaleY = scale.y;

        if (e.ctrlKey) {
            newScaleY *= factor;
        } else if (e.shiftKey) {
            newScaleX *= factor;
        } else {
            newScaleX *= factor;
            newScaleY *= factor;
        }

        newScaleX = Math.max(10, Math.min(newScaleX, 1000));
        newScaleY = Math.max(0.1, Math.min(newScaleY, 100));

        // Adjust offset to zoom towards mouse
        const newOffsetX = mouseX - world.time * newScaleX;
        const canvas = canvasRef.current;
        const centerY = canvas ? canvas.height / 2 : 0;
        const newOffsetY = centerY - mouseY - world.value * newScaleY + centerY;

        setScale({ x: newScaleX, y: newScaleY });
        setOffset({ x: newOffsetX, y: offset.y }); // Keep Y offset stable
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        // Ensure the graph editor container has focus for keyboard events (Delete, Escape, etc.)
        wrapperRef.current?.focus();

        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        setIsDragging(true);
        setLastMousePos({ x, y });
        dragAccumulator.current = 0;

        if (e.button === 2 || e.altKey) {
            // Right click or Alt+click = pan
            setDragMode('pan');
        } else if (e.button === 1) {
            // Middle mouse button = marquee selection
            setDragMode('marquee');
            setMarqueeStart({ x, y });
            setMarqueeEnd({ x, y });
        } else if (hoveredHandle) {
            // Start dragging a Bezier handle
            setDragMode('handle');
        } else if (hoveredKey) {
            setDragMode('edit');
            const selKey = getSelectionKey(hoveredKey.time, hoveredKey.channel);
            if (!selectedKeys.has(selKey) && !e.shiftKey) {
                setSelectedKeys(new Set([selKey]));
            } else if (e.shiftKey) {
                const newSet = new Set(selectedKeys);
                newSet.add(selKey);
                setSelectedKeys(newSet);
            }
        } else {
            // Click on empty space - start scrubbing
            setDragMode('scrub');
            const world = screenToWorld(x, y);
            if (world.time >= 0 && world.time <= segmentDuration) {
                onSeek(Math.max(0, Math.min(segmentDuration, world.time)));
            }
            setSelectedKeys(new Set());
        }

        canvasRef.current?.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (isDragging) {
            const dx = x - lastMousePos.x;
            const dy = y - lastMousePos.y;

            if (dragMode === 'pan') {
                setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
            } else if (dragMode === 'scrub') {
                // Continuous scrubbing - update time as we drag
                const world = screenToWorld(x, y);
                const clampedTime = Math.max(0, Math.min(segmentDuration, world.time));
                onSeek(clampedTime);
            } else if (dragMode === 'marquee') {
                // Update marquee selection rectangle
                setMarqueeEnd({ x, y });
            } else if (dragMode === 'handle' && hoveredHandle) {
                // Move Bezier handle
                const timeDelta = dx / scale.x;
                const valueDelta = -dy / scale.y;

                const newKeyframes = keyframes.map(kf => {
                    if (Math.abs(kf.time - hoveredHandle.time) < 0.001) {
                        const config = kf.keyframeConfig || {};
                        const channelConfig = config[hoveredHandle.channel] || { inTangent: { x: -0.3, y: 0 }, outTangent: { x: 0.3, y: 0 } };

                        if (hoveredHandle.type === 'in') {
                            return {
                                ...kf,
                                keyframeConfig: {
                                    ...config,
                                    [hoveredHandle.channel]: {
                                        ...channelConfig,
                                        inTangent: {
                                            x: (channelConfig.inTangent?.x || -0.3) + timeDelta,
                                            y: (channelConfig.inTangent?.y || 0) + valueDelta
                                        }
                                    }
                                }
                            };
                        } else {
                            return {
                                ...kf,
                                keyframeConfig: {
                                    ...config,
                                    [hoveredHandle.channel]: {
                                        ...channelConfig,
                                        outTangent: {
                                            x: (channelConfig.outTangent?.x || 0.3) + timeDelta,
                                            y: (channelConfig.outTangent?.y || 0) + valueDelta
                                        }
                                    }
                                }
                            };
                        }
                    }
                    return kf;
                });

                onUpdateKeyframes(newKeyframes);
            } else if (dragMode === 'edit' && hoveredKey && (segment || isGlobalMode)) {
                // Move selected keyframes (both time and value)
                const timeDelta = dx / scale.x;
                const valueDelta = -dy / scale.y;

                const keysToMove: string[] = selectedKeys.size > 0
                    ? Array.from(selectedKeys)
                    : [getSelectionKey(hoveredKey.time, hoveredKey.channel)];

                // Group keys by time to move entire keyframes together
                const timesToMove = new Set<number>();
                keysToMove.forEach((key: string) => {
                    const [timeStr] = key.split(':');
                    timesToMove.add(parseFloat(timeStr));
                });

                const newKeyframes = keyframes.map(kf => {
                    if (Array.from(timesToMove).some(t => Math.abs(kf.time - t) < 0.001)) {
                        const newTime = Math.max(0, Math.min(segmentDuration, kf.time + timeDelta));
                        const updatedKf = { ...kf, time: newTime };

                        // Update values for selected channels
                        keysToMove.forEach((key: string) => {
                            const parts = key.split(':');
                            const keyTime = parseFloat(parts[0]);
                            const channel = parts[1];
                            if (Math.abs(kf.time - keyTime) < 0.001) {
                                (updatedKf as any)[channel] += valueDelta;
                            }
                        });

                        return updatedKf;
                    }
                    return kf;
                });

                // Update selection keys with new times
                const newSelection = new Set<string>();
                keysToMove.forEach((key: string) => {
                    const parts = key.split(':');
                    const oldTime = parseFloat(parts[0]);
                    const channel = parts[1];
                    const newTime = Math.max(0, Math.min(segmentDuration, oldTime + timeDelta));
                    newSelection.add(getSelectionKey(newTime, channel as ChannelType));
                });
                setSelectedKeys(newSelection);

                // Update hovered key with new time
                if (hoveredKey) {
                    setHoveredKey({
                        ...hoveredKey,
                        time: Math.max(0, Math.min(segmentDuration, hoveredKey.time + timeDelta)),
                        value: hoveredKey.value + valueDelta
                    });
                }

                onUpdateKeyframes(newKeyframes.sort((a, b) => a.time - b.time));
            }

            setLastMousePos({ x, y });
        } else {
            // Hover detection
            const threshold = 10;
            let foundHandle: { time: number; channel: ChannelType; type: 'in' | 'out' } | null = null;
            let foundKey: GraphPoint | null = null;

            // First check for handle hover (only on selected keyframes, skip default values)
            for (const channel of activeChannels) {
                const chDefault = CHANNEL_DEFAULTS[channel as ChannelType];
                for (const [selKey] of selectedKeys) {
                    const kf = keyframes.find(k => {
                        const key = getSelectionKey(k.time, channel);
                        return selectedKeys.has(key);
                    });

                    if (kf) {
                        const value = kf[channel as keyof ClipKeyframe] as number;
                        if (value === chDefault) continue; // Skip handles for default-value channels
                        const config = kf.keyframeConfig?.[channel];
                        const inTangent = config?.inTangent || { x: -0.3, y: 0 };
                        const outTangent = config?.outTangent || { x: 0.3, y: 0 };

                        const inHandleScreen = worldToScreen(kf.time + inTangent.x, value + inTangent.y);
                        const outHandleScreen = worldToScreen(kf.time + outTangent.x, value + outTangent.y);

                        if (Math.abs(x - inHandleScreen.x) < threshold && Math.abs(y - inHandleScreen.y) < threshold) {
                            foundHandle = { time: kf.time, channel: channel as ChannelType, type: 'in' };
                            break;
                        }
                        if (Math.abs(x - outHandleScreen.x) < threshold && Math.abs(y - outHandleScreen.y) < threshold) {
                            foundHandle = { time: kf.time, channel: channel as ChannelType, type: 'out' };
                            break;
                        }
                    }
                }
                if (foundHandle) break;
            }

            // Then check for keyframe hover (skip channels at default value)
            if (!foundHandle) {
                for (const channel of activeChannels) {
                    const chDefault = CHANNEL_DEFAULTS[channel as ChannelType];
                    for (const kf of keyframes) {
                        if (kf[channel as keyof ClipKeyframe] === chDefault) continue; // Skip default-value dots
                        const screen = worldToScreen(kf.time, kf[channel as keyof ClipKeyframe] as number);
                        if (Math.abs(x - screen.x) < threshold && Math.abs(y - screen.y) < threshold) {
                            foundKey = { time: kf.time, value: kf[channel as keyof ClipKeyframe] as number, channel: channel as ChannelType };
                            break;
                        }
                    }
                    if (foundKey) break;
                }
            }

            setHoveredHandle(foundHandle);
            setHoveredKey(foundHandle ? null : foundKey);
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        // Handle marquee selection completion
        if (dragMode === 'marquee' && marqueeStart && marqueeEnd) {
            const minX = Math.min(marqueeStart.x, marqueeEnd.x);
            const maxX = Math.max(marqueeStart.x, marqueeEnd.x);
            const minY = Math.min(marqueeStart.y, marqueeEnd.y);
            const maxY = Math.max(marqueeStart.y, marqueeEnd.y);

            const newSelection = new Set<string>();

            // Find all keyframes within the marquee (skip channels at default value)
            for (const channel of activeChannels) {
                const chDefault = CHANNEL_DEFAULTS[channel as ChannelType];
                for (const kf of keyframes) {
                    if (kf[channel as keyof ClipKeyframe] === chDefault) continue;
                    const screen = worldToScreen(kf.time, kf[channel as keyof ClipKeyframe] as number);
                    if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
                        newSelection.add(getSelectionKey(kf.time, channel as ChannelType));
                    }
                }
            }

            setSelectedKeys(newSelection);
            setMarqueeStart(null);
            setMarqueeEnd(null);
        }

        setIsDragging(false);
        setDragMode(null);
        canvasRef.current?.releasePointerCapture(e.pointerId);
    };

    const handleFlatTangents = () => {
        if (!selectedKeys.size && !segment && !isGlobalMode) return;

        let newKeyframes = [...keyframes].sort((a, b) => a.time - b.time);
        const channels: ChannelType[] = Array.from(activeChannels);

        const timesToUpdate = new Set<string>();
        selectedKeys.forEach(key => {
            const [timeStr] = key.split(':');
            timesToUpdate.add(timeStr);
        });

        if (timesToUpdate.size === 0) return;

        channels.forEach(channel => {
            for (let i = 0; i < newKeyframes.length; i++) {
                const kf = newKeyframes[i];
                if (!timesToUpdate.has(kf.time.toFixed(3))) continue;

                // Find neighbors to determine appropriate handle length
                const prev = i > 0 ? newKeyframes[i - 1] : null;
                const next = i < newKeyframes.length - 1 ? newKeyframes[i + 1] : null;

                const dtPrev = prev ? kf.time - prev.time : 1.0;
                const dtNext = next ? next.time - kf.time : 1.0;

                // Set flat tangents (y = 0), with handle length relative to neighbors (0.33 of distance)
                const inTangent = { x: -Math.min(0.3, dtPrev * 0.33), y: 0 };
                const outTangent = { x: Math.min(0.3, dtNext * 0.33), y: 0 };

                const config = kf.keyframeConfig || {};
                const channelConfig = config[channel] || {};

                newKeyframes[i] = {
                    ...kf,
                    keyframeConfig: {
                        ...config,
                        [channel]: {
                            ...channelConfig,
                            inTangent,
                            outTangent
                        }
                    }
                };
            }
        });

        onUpdateKeyframes(newKeyframes);
    };

    const handleAutoTangents = () => {
        if (!selectedKeys.size && !segment && !isGlobalMode) return;

        // If no keys selected, maybe select all? For now, only act on selection to be safe
        // Or actually, if we want to "fix" the curve, we might want to fix specific parts.

        let newKeyframes = [...keyframes].sort((a, b) => a.time - b.time);
        const channels: ChannelType[] = Array.from(activeChannels);

        // Group selected keys by time to update them
        const timesToUpdate = new Set<string>();
        selectedKeys.forEach(key => {
            const [timeStr] = key.split(':');
            timesToUpdate.add(timeStr);
        });

        // If nothing selected, maybe apply to all keys in visible range?
        // Let's stick to selected keys for precise control.
        if (timesToUpdate.size === 0) return;

        channels.forEach(channel => {
            // We need to look at all keyframes for context
            for (let i = 0; i < newKeyframes.length; i++) {
                const kf = newKeyframes[i];
                if (!timesToUpdate.has(kf.time.toFixed(3))) continue;

                // Find neighbors
                const prev = i > 0 ? newKeyframes[i - 1] : null;
                const next = i < newKeyframes.length - 1 ? newKeyframes[i + 1] : null;

                const currentVal = kf[channel] as number;
                let inTangent = { x: -0.3, y: 0 };
                let outTangent = { x: 0.3, y: 0 };

                if (prev && next) {
                    // Calculate slopes
                    const prevVal = prev[channel] as number;
                    const nextVal = next[channel] as number;

                    const dtPrev = kf.time - prev.time;
                    const dtNext = next.time - kf.time;

                    // Simple slope
                    const slopePrev = (currentVal - prevVal) / dtPrev;
                    const slopeNext = (nextVal - currentVal) / dtNext;

                    // Monotonic-ish handling: if slope changes sign, flatten tangents
                    if (slopePrev * slopeNext < 0) {
                        // Local maxima/minima - flat tangents
                        inTangent = { x: -dtPrev * 0.33, y: 0 };
                        outTangent = { x: dtNext * 0.33, y: 0 };
                    } else {
                        // Average slope or weighted slope?
                        // Standard Catmull-Rom like approach: slope based on neighbors
                        const totalDt = next.time - prev.time;
                        const totalDv = nextVal - prevVal;
                        const avgSlope = totalDv / totalDt;

                        inTangent = { x: -dtPrev * 0.33, y: -dtPrev * 0.33 * avgSlope };
                        outTangent = { x: dtNext * 0.33, y: dtNext * 0.33 * avgSlope };
                    }
                } else if (prev) {
                    // End of curve
                    const prevVal = prev[channel] as number;
                    const dt = kf.time - prev.time;
                    const slope = (currentVal - prevVal) / dt;
                    inTangent = { x: -dt * 0.33, y: -dt * 0.33 * slope };
                    outTangent = { x: 0.33, y: 0 };
                } else if (next) {
                    // Start of curve
                    const nextVal = next[channel] as number;
                    const dt = next.time - kf.time;
                    const slope = (nextVal - currentVal) / dt;
                    inTangent = { x: -0.33, y: 0 };
                    outTangent = { x: dt * 0.33, y: dt * 0.33 * slope };
                }

                // Apply to config
                const config = kf.keyframeConfig || {};
                const channelConfig = config[channel] || {};

                newKeyframes[i] = {
                    ...kf,
                    keyframeConfig: {
                        ...config,
                        [channel]: {
                            ...channelConfig,
                            inTangent,
                            outTangent
                        }
                    }
                };
            }
        });

        onUpdateKeyframes(newKeyframes);
    };

    const handleAddKeyframe = () => {
        // Allow adding keyframes in global mode or when a segment is selected
        if (!segment && !isGlobalMode) return;

        // 1. Get current interpolated values
        const currentVals = getInterpolatedTransform(keyframes, currentTime);

        // 2. Calculate slopes (approximate derivatives) to preserve curve shape
        const dt = 0.05; // look ahead/behind
        const prevVals = getInterpolatedTransform(keyframes, currentTime - dt);
        const nextVals = getInterpolatedTransform(keyframes, currentTime + dt);

        const newKeyframe: ClipKeyframe = {
            time: currentTime,
            translateX: currentVals.translateX,
            translateY: currentVals.translateY,
            scale: currentVals.scale,
            rotation: currentVals.rotation,
            keyframeConfig: {}
        };

        // Calculate tangents for each channel
        const channels: ChannelType[] = ['translateX', 'translateY', 'scale', 'rotation'];
        channels.forEach(channel => {
            const vPrev = prevVals[channel];
            const vNext = nextVals[channel];
            const slope = (vNext - vPrev) / (2 * dt); // Central difference

            // Set tangents based on this slope
            // Standard handle length is rough check, let's use 0.3s or smaller if close to neighbors
            // We'll fix length later or let user adjust, but initial slope is key.
            const handleLen = 0.3;

            // Check neighbors to clamp handle length? 
            // We don't have inserted it yet, so finding neighbors is tricky without sorting.
            // Let's just use reasonable default length 

            newKeyframe.keyframeConfig = {
                ...newKeyframe.keyframeConfig,
                [channel]: {
                    inTangent: { x: -handleLen, y: -handleLen * slope },
                    outTangent: { x: handleLen, y: handleLen * slope }
                }
            };
        });

        // Check if keyframe already exists at this time
        const exists = keyframes.some(kf => Math.abs(kf.time - currentTime) < 0.01);

        let updatedKeyframes;
        if (exists) {
            // Update existing keyframe values
            updatedKeyframes = keyframes.map(kf => {
                if (Math.abs(kf.time - currentTime) < 0.01) {
                    return { ...newKeyframe, time: kf.time }; // Preserve exact time match
                }
                return kf;
            });
        } else {
            updatedKeyframes = [...keyframes, newKeyframe].sort((a, b) => a.time - b.time);
        }

        onUpdateKeyframes(updatedKeyframes);
    };

    // ===== SIMPLIFY =====
    const applySimplify = useCallback((amount: number, source: ClipKeyframe[]) => {
        if (source.length <= 2) return;
        let valueRange = 0;
        for (const ch of activeChannels) {
            const vals = source.map(kf => kf[ch] as number);
            const range = Math.max(...vals) - Math.min(...vals);
            if (range > valueRange) valueRange = range;
        }
        if (valueRange === 0) valueRange = 1;
        const tolerance = (amount / 100) * valueRange * 0.5;
        const sorted = [...source].sort((a, b) => a.time - b.time);
        const simplified = rdpSimplify(sorted, tolerance, activeChannels);
        onUpdateKeyframes(simplified);
    }, [activeChannels, onUpdateKeyframes]);

    const handleSimplifyToggle = useCallback(() => {
        if (simplifyActive) {
            setSimplifyActive(false);
            preSimplifyRef.current = null;
        } else {
            preSimplifyRef.current = [...keyframes];
            setSimplifyActive(true);
            setClampActive(false);
            preClampRef.current = null;
            setSimplifyAmount(30);
            applySimplify(30, keyframes);
        }
    }, [simplifyActive, keyframes, applySimplify]);

    const handleSimplifySlider = useCallback((val: number) => {
        setSimplifyAmount(val);
        if (preSimplifyRef.current) applySimplify(val, preSimplifyRef.current);
    }, [applySimplify]);

    // ===== CLAMP =====
    const applyClamp = useCallback((amount: number, source: ClipKeyframe[], selected: Set<string>) => {
        if (source.length === 0 || selected.size === 0) return;
        let valueRange = 0;
        for (const ch of activeChannels) {
            const vals = source.filter(kf => selected.has(kf.time.toFixed(3))).map(kf => kf[ch] as number);
            if (vals.length === 0) continue;
            const range = Math.max(...vals) - Math.min(...vals);
            if (range > valueRange) valueRange = range;
        }
        if (valueRange === 0) valueRange = 1;
        // Full range at 100% — guarantees all selected values merge into one group
        const threshold = (amount / 100) * valueRange;
        const clamped = clampKeyframeValues(source, selected, threshold, activeChannels);
        onUpdateKeyframes(clamped);
    }, [activeChannels, onUpdateKeyframes]);

    const handleClampToggle = useCallback(() => {
        if (clampActive) {
            // Exiting clamp mode — auto-refresh tangents for affected keys
            setClampActive(false);
            preClampRef.current = null;
            // Trigger auto tangents on the clamped keys
            if (selectedKeys.size > 0) {
                // Use the existing auto tangent logic inline
                let newKfs = [...keyframes].sort((a, b) => a.time - b.time);
                const times = new Set<string>();
                clampSelectedRef.current.forEach(key => { times.add(key.split(':')[0]); });
                for (const channel of activeChannels) {
                    for (let i = 0; i < newKfs.length; i++) {
                        if (!times.has(newKfs[i].time.toFixed(3))) continue;
                        const prev = i > 0 ? newKfs[i - 1] : null;
                        const next = i < newKfs.length - 1 ? newKfs[i + 1] : null;
                        const val = newKfs[i][channel] as number;
                        let inT = { x: -0.3, y: 0 }, outT = { x: 0.3, y: 0 };
                        if (prev && next) {
                            const pv = prev[channel] as number, nv = next[channel] as number;
                            const dtP = newKfs[i].time - prev.time, dtN = next.time - newKfs[i].time;
                            if ((val - pv) * (nv - val) < 0) {
                                inT = { x: -dtP * 0.33, y: 0 };
                                outT = { x: dtN * 0.33, y: 0 };
                            } else {
                                const slope = (nv - pv) / (next.time - prev.time);
                                inT = { x: -dtP * 0.33, y: -dtP * 0.33 * slope };
                                outT = { x: dtN * 0.33, y: dtN * 0.33 * slope };
                            }
                        }
                        const cfg = newKfs[i].keyframeConfig || {};
                        newKfs[i] = { ...newKfs[i], keyframeConfig: { ...cfg, [channel]: { ...(cfg[channel] || {}), inTangent: inT, outTangent: outT } } };
                    }
                }
                onUpdateKeyframes(newKfs);
            }
            clampSelectedRef.current = new Set();
        } else {
            if (selectedKeys.size === 0) return;
            preClampRef.current = [...keyframes];
            clampSelectedRef.current = new Set<string>();
            selectedKeys.forEach(key => { clampSelectedRef.current.add(key.split(':')[0]); });
            setClampActive(true);
            setSimplifyActive(false);
            preSimplifyRef.current = null;
            setClampAmount(0);
        }
    }, [clampActive, selectedKeys, keyframes, activeChannels, onUpdateKeyframes]);

    const handleClampSlider = useCallback((val: number) => {
        setClampAmount(val);
        if (preClampRef.current) applyClamp(val, preClampRef.current, clampSelectedRef.current);
    }, [applyClamp]);

    // ===== SMOOTH =====
    const applySmooth = useCallback((amount: number, source: ClipKeyframe[], selected: Set<string>) => {
        if (source.length < 3) return;
        const smoothed = smoothKeyframeValues(source, selected, amount, activeChannels);
        onUpdateKeyframes(smoothed);
    }, [activeChannels, onUpdateKeyframes]);

    const handleSmoothToggle = useCallback(() => {
        if (smoothActive) {
            setSmoothActive(false);
            preSmoothRef.current = null;
            smoothSelectedRef.current = new Set();
        } else {
            preSmoothRef.current = [...keyframes];
            // No selection → smooth ALL keys; selection → smooth only those
            smoothSelectedRef.current = selectedKeys.size > 0
                ? new Set([...selectedKeys].map(k => k.split(':')[0]))
                : new Set<string>(); // empty = smooth all in smoothKeyframeValues
            setSmoothActive(true);
            setSimplifyActive(false);
            preSimplifyRef.current = null;
            setClampActive(false);
            preClampRef.current = null;
            setSmoothAmount(50);
            applySmooth(50, keyframes, smoothSelectedRef.current);
        }
    }, [smoothActive, selectedKeys, keyframes, applySmooth]);

    const handleSmoothSlider = useCallback((val: number) => {
        setSmoothAmount(val);
        if (preSmoothRef.current) applySmooth(val, preSmoothRef.current, smoothSelectedRef.current);
    }, [applySmooth]);

    const handleDeleteSelected = useCallback(() => {
        if (selectedKeys.size === 0) return;

        // Parse selected keys into time → set of channels
        const channelsByTime = new Map<string, Set<string>>();
        selectedKeys.forEach(key => {
            const [timeStr, channel] = key.split(':');
            if (!channelsByTime.has(timeStr)) channelsByTime.set(timeStr, new Set());
            channelsByTime.get(timeStr)!.add(channel);
        });

        // Per-channel independent delete: only reset the SELECTED channels to defaults.
        // Never remove the entire keyframe just because some channels were deleted.
        // Only remove if ALL 4 channels end up at their default values.
        const newKeyframes = keyframes.map(kf => {
            const timeStr = kf.time.toFixed(3);
            const channels = channelsByTime.get(timeStr);
            if (!channels) return kf;

            // Reset only the selected channels to their defaults — other channels are untouched
            const modified = { ...kf };
            channels.forEach(ch => {
                if (ch in CHANNEL_DEFAULTS) (modified as any)[ch] = CHANNEL_DEFAULTS[ch];
            });
            return modified;
        }).filter(kf => {
            // Only remove keyframes where every channel is at its default (truly empty)
            return kf.translateX !== 0 || kf.translateY !== 0 || kf.scale !== 1 || kf.rotation !== 0;
        });

        onUpdateKeyframes(newKeyframes);
        setSelectedKeys(new Set());
    }, [selectedKeys, keyframes, onUpdateKeyframes]);

    const toggleChannel = (channel: ChannelType) => {
        const newSet = new Set(activeChannels);
        if (newSet.has(channel)) {
            newSet.delete(channel);
        } else {
            newSet.add(channel);
        }
        setActiveChannels(newSet);
    };

    const fitToView = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const padding = 50;
        const newScaleX = (canvas.width - padding * 2) / (segmentDuration || 1);
        setScale(prev => ({ ...prev, x: newScaleX }));
        setOffset({ x: padding, y: 0 });
    };

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            if (simplifyActive) { setSimplifyActive(false); preSimplifyRef.current = null; return; }
            if (clampActive) { handleClampToggle(); return; }
            if (smoothActive) { handleSmoothToggle(); return; }
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedKeys.size > 0) {
                e.preventDefault();
                e.stopPropagation();
                handleDeleteSelected();
            }
        }
    }, [selectedKeys, handleDeleteSelected, simplifyActive, clampActive, handleClampToggle, smoothActive, handleSmoothToggle]);

    if (!visible) return null;

    return (
        <div
            ref={wrapperRef}
            tabIndex={0}
            data-graph-editor
            onKeyDown={handleKeyDown}
            style={{
                height: 250,
                backgroundColor: '#1a1a1a',
                borderTop: '1px solid #333',
                display: 'flex',
                flexDirection: 'column',
                outline: 'none',
            }}>
            {/* Toolbar */}
            <div style={{
                height: 40,
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                borderBottom: '1px solid #333',
                backgroundColor: '#222'
            }}>
                <span style={{ fontWeight: 600, color: '#fff', fontSize: 13 }}>
                    Graph Editor
                </span>

                {segment && (
                    <span style={{ color: '#888', fontSize: 12 }}>
                        — {segment.description}
                    </span>
                )}

                <div style={{ flex: 1 }} />

                {/* Channel toggles */}
                {(Object.keys(CHANNEL_COLORS) as ChannelType[]).map(channel => (
                    <button
                        key={channel}
                        onClick={() => toggleChannel(channel)}
                        style={{
                            padding: '4px 8px',
                            borderRadius: 4,
                            border: 'none',
                            backgroundColor: activeChannels.has(channel) ? CHANNEL_COLORS[channel] + '40' : 'transparent',
                            color: activeChannels.has(channel) ? CHANNEL_COLORS[channel] : '#666',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer'
                        }}
                    >
                        {CHANNEL_LABELS[channel]}
                    </button>
                ))}

                <div style={{ width: 1, height: 20, backgroundColor: '#444' }} />

                <button
                    onClick={handleAddKeyframe}
                    disabled={!segment && !isGlobalMode}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: '#fff',
                        fontSize: 12,
                        cursor: (segment || isGlobalMode) ? 'pointer' : 'not-allowed',
                        opacity: (segment || isGlobalMode) ? 1 : 0.5
                    }}
                >
                    + Key
                </button>

                <button
                    onClick={handleFlatTangents}
                    disabled={selectedKeys.size === 0}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: selectedKeys.size > 0 ? '#3b82f6' : '#666',
                        fontSize: 12,
                        cursor: selectedKeys.size > 0 ? 'pointer' : 'not-allowed'
                    }}
                    title="Flatten Tangents (zero slope)"
                >
                    Flat
                </button>

                <button
                    onClick={handleAutoTangents}
                    disabled={selectedKeys.size === 0}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: selectedKeys.size > 0 ? '#3b82f6' : '#666',
                        fontSize: 12,
                        cursor: selectedKeys.size > 0 ? 'pointer' : 'not-allowed'
                    }}
                    title="Auto Tangents (smooth)"
                >
                    Auto
                </button>

                <button
                    onClick={handleDeleteSelected}
                    disabled={selectedKeys.size === 0}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: selectedKeys.size > 0 ? '#ff4444' : '#666',
                        fontSize: 12,
                        cursor: selectedKeys.size > 0 ? 'pointer' : 'not-allowed'
                    }}
                >
                    Delete
                </button>

                <div style={{ width: 1, height: 20, backgroundColor: '#444' }} />

                <button
                    onClick={handleSimplifyToggle}
                    disabled={keyframes.length <= 2}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: simplifyActive ? '1px solid #22d3ee' : '1px solid #444',
                        backgroundColor: simplifyActive ? '#22d3ee20' : '#333',
                        color: simplifyActive ? '#22d3ee' : keyframes.length > 2 ? '#22d3ee' : '#666',
                        fontSize: 12,
                        cursor: keyframes.length > 2 ? 'pointer' : 'not-allowed'
                    }}
                    title="Simplify curve — reduce keyframes (RDP)"
                >
                    Simplify
                </button>

                <button
                    onClick={handleClampToggle}
                    disabled={!clampActive && selectedKeys.size === 0}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: clampActive ? '1px solid #a78bfa' : '1px solid #444',
                        backgroundColor: clampActive ? '#a78bfa20' : '#333',
                        color: clampActive ? '#a78bfa' : selectedKeys.size > 0 ? '#a78bfa' : '#666',
                        fontSize: 12,
                        cursor: (!clampActive && selectedKeys.size === 0) ? 'not-allowed' : 'pointer'
                    }}
                    title={clampActive ? "Turn off Clamp" : selectedKeys.size > 0 ? "Clamp selected values" : "Clamp (Select keys first)"}
                >
                    Clamp
                </button>

                <button
                    onClick={handleSmoothToggle}
                    disabled={keyframes.length < 3}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: smoothActive ? '1px solid #34d399' : '1px solid #444',
                        backgroundColor: smoothActive ? '#34d39920' : '#333',
                        color: smoothActive ? '#34d399' : keyframes.length >= 3 ? '#34d399' : '#666',
                        fontSize: 12,
                        cursor: keyframes.length < 3 ? 'not-allowed' : 'pointer'
                    }}
                    title={smoothActive
                        ? 'Turn off Smooth'
                        : selectedKeys.size > 0
                            ? 'Smooth selected keyframes (Gaussian)'
                            : 'Smooth all keyframes (Gaussian) — select keys to limit scope'}
                >
                    Smooth
                </button>

                <div style={{ width: 1, height: 20, backgroundColor: '#444' }} />

                <button
                    onClick={() => {
                        // Clear Y: Reset translateY to 0 on ALL keyframes, unconditionally
                        const newKeyframes = keyframes.map(kf => ({
                            ...kf,
                            translateY: 0,
                        })).filter(kf => {
                            // Remove keyframes that are now all-default
                            return kf.translateX !== 0 || kf.translateY !== 0 || kf.scale !== 1 || kf.rotation !== 0;
                        });
                        onUpdateKeyframes(newKeyframes);
                        setSelectedKeys(new Set());
                    }}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: '#ff4444',
                        fontSize: 12,
                        cursor: 'pointer'
                    }}
                    title="Clear all keyframes for active channels"
                >
                    Clear Y
                </button>

                <button
                    onClick={() => {
                        // Match Previous (<)
                        if (selectedKeys.size === 0) return;

                        // Sort keyframes by time
                        const sorted = [...keyframes].sort((a, b) => a.time - b.time);
                        const newKfs = [...keyframes];

                        selectedKeys.forEach(key => {
                            const [timeStr, ch] = key.split(':');
                            const time = parseFloat(timeStr);
                            const kfIndex = newKfs.findIndex(k => Math.abs(k.time - time) < 0.001);
                            if (kfIndex <= 0) return; // No previous

                            // Find previous keyframe index
                            // Since we allow multiselect, we should look at original sorted list
                            // But we act on newKfs. 
                            // Simplest: Find index in sorted, take value from sorted[index-1]
                            const sortedIdx = sorted.findIndex(k => Math.abs(k.time - time) < 0.001);
                            if (sortedIdx > 0) {
                                const prevVal = sorted[sortedIdx - 1][ch as ChannelType];
                                if (kfIndex !== -1) (newKfs[kfIndex] as any)[ch] = prevVal;
                            }
                        });
                        onUpdateKeyframes(newKfs);
                    }}
                    disabled={selectedKeys.size === 0}
                    style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: selectedKeys.size > 0 ? '#fff' : '#666',
                        fontSize: 12,
                        cursor: selectedKeys.size > 0 ? 'pointer' : 'not-allowed'
                    }}
                    title="Match value of previous keyframe"
                >
                    &lt; Match
                </button>

                <button
                    onClick={() => {
                        // Match Next (>)
                        if (selectedKeys.size === 0) return;

                        const sorted = [...keyframes].sort((a, b) => a.time - b.time);
                        const newKfs = [...keyframes];

                        selectedKeys.forEach(key => {
                            const [timeStr, ch] = key.split(':');
                            const time = parseFloat(timeStr);
                            const kfIndex = newKfs.findIndex(k => Math.abs(k.time - time) < 0.001);
                            if (kfIndex === -1) return;

                            const sortedIdx = sorted.findIndex(k => Math.abs(k.time - time) < 0.001);
                            if (sortedIdx !== -1 && sortedIdx < sorted.length - 1) {
                                const nextVal = sorted[sortedIdx + 1][ch as ChannelType];
                                (newKfs[kfIndex] as any)[ch] = nextVal;
                            }
                        });
                        onUpdateKeyframes(newKfs);
                    }}
                    disabled={selectedKeys.size === 0}
                    style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: selectedKeys.size > 0 ? '#fff' : '#666',
                        fontSize: 12,
                        cursor: selectedKeys.size > 0 ? 'pointer' : 'not-allowed'
                    }}
                    title="Match value of next keyframe"
                >
                    Match &gt;
                </button>

                <div style={{ width: 1, height: 20, backgroundColor: '#444' }} />

                <button
                    onClick={fitToView}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 4,
                        border: '1px solid #444',
                        backgroundColor: '#333',
                        color: '#fff',
                        fontSize: 12,
                        cursor: 'pointer'
                    }}
                >
                    Fit
                </button>

                <button
                    onClick={onClose}
                    style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        border: 'none',
                        backgroundColor: 'transparent',
                        color: '#888',
                        fontSize: 16,
                        cursor: 'pointer'
                    }}
                >
                    ✕
                </button>
            </div>

            {/* Simplify / Clamp / Smooth slider bar */}
            {(simplifyActive || clampActive || smoothActive) && (
                <div style={{
                    height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 10,
                    borderBottom: '1px solid #333', backgroundColor: '#1e1e1e', fontSize: 11
                }}>
                    <span style={{
                        color: simplifyActive ? '#22d3ee' : clampActive ? '#a78bfa' : '#34d399',
                        fontWeight: 600, minWidth: 60
                    }}>
                        {simplifyActive ? 'Tolerance' : clampActive ? 'Threshold' : 'Strength'}
                    </span>
                    <input
                        type="range" min={0} max={100} step={1}
                        value={simplifyActive ? simplifyAmount : clampActive ? clampAmount : smoothAmount}
                        onChange={e => {
                            const v = Number(e.target.value);
                            if (simplifyActive) handleSimplifySlider(v);
                            else if (clampActive) handleClampSlider(v);
                            else handleSmoothSlider(v);
                        }}
                        style={{
                            flex: 1,
                            accentColor: simplifyActive ? '#22d3ee' : clampActive ? '#a78bfa' : '#34d399',
                            height: 4
                        }}
                    />
                    <span style={{ color: '#888', fontFamily: 'monospace', minWidth: 30, textAlign: 'right' }}>
                        {simplifyActive ? simplifyAmount : clampActive ? clampAmount : smoothAmount}%
                    </span>
                    <span style={{ color: '#666', fontSize: 10 }}>
                        {simplifyActive
                            ? `${keyframes.length} keys`
                            : clampActive
                                ? `${clampSelectedRef.current.size} keys`
                                : smoothSelectedRef.current.size > 0
                                    ? `${smoothSelectedRef.current.size} keys`
                                    : `${keyframes.length} keys (all)`
                        }
                    </span>
                </div>
            )}

            {/* Canvas */}
            <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
                <canvas
                    ref={canvasRef}
                    style={{
                        display: 'block',
                        cursor: isDragging
                            ? (dragMode === 'marquee' ? 'crosshair' : dragMode === 'edit' || dragMode === 'handle' ? 'move' : 'grabbing')
                            : (hoveredHandle ? 'grab' : hoveredKey ? 'move' : 'crosshair')
                    }}
                    onWheel={handleWheel}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onContextMenu={e => e.preventDefault()}
                />

                {/* Marquee selection rectangle */}
                {dragMode === 'marquee' && marqueeStart && marqueeEnd && (
                    <div style={{
                        position: 'absolute',
                        left: Math.min(marqueeStart.x, marqueeEnd.x),
                        top: Math.min(marqueeStart.y, marqueeEnd.y),
                        width: Math.abs(marqueeEnd.x - marqueeStart.x),
                        height: Math.abs(marqueeEnd.y - marqueeStart.y),
                        border: '1px dashed #3b82f6',
                        backgroundColor: 'rgba(59, 130, 246, 0.15)',
                        pointerEvents: 'none'
                    }} />
                )}

                {/* No segment message - only show when not in global mode */}
                {!segment && !isGlobalMode && (
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#666',
                        fontSize: 14
                    }}>
                        Select a clip to edit keyframes
                    </div>
                )}
            </div>
        </div>
    );
};

export default GraphEditor;
