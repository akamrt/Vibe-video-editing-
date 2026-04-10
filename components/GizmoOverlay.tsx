import React, { useState, useCallback, useEffect, useRef } from 'react';

interface GizmoOverlayProps {
  targetType: 'clip' | 'subtitle' | 'title';
  transform: {
    translateX: number;
    translateY: number;
    scale: number;
    rotation: number;
    pivotX: number;
    pivotY: number;
  };
  viewportSize: { width: number; height: number };
  cropDims: { width: number; height: number };
  elementBounds: { width: number; height: number };
  elementCenter: { x: number; y: number };
  zoom?: number;
  isPlaying?: boolean;
  onTranslate: (dx: number, dy: number) => void;
  onScale: (newScale: number) => void;
  onRotate: (newRotation: number) => void;
  onPivotMove: (newPivotX: number, newPivotY: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

interface DragState {
  type: 'translate' | 'scale' | 'rotate' | 'pivot';
  startX: number;
  startY: number;
  startTranslateX: number;
  startTranslateY: number;
  startScale: number;
  startRotation: number;
  startPivotX: number;
  startPivotY: number;
  startAngle: number;
  startDistToPivot: number;
}

const HANDLE_SIZE = 8;
const ROTATION_HANDLE_RADIUS = 6;
const ROTATION_HANDLE_OFFSET = 25;
const PIVOT_LINE_LENGTH = 8;
const PIVOT_CIRCLE_RADIUS = 4;

const GizmoOverlay: React.FC<GizmoOverlayProps> = ({
  targetType,
  transform,
  viewportSize,
  cropDims,
  elementBounds,
  elementCenter,
  zoom = 1,
  isPlaying = false,
  onTranslate,
  onScale,
  onRotate,
  onPivotMove,
  onDragStart,
  onDragEnd,
}) => {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Scaled element dimensions
  const scaledWidth = elementBounds.width * transform.scale;
  const scaledHeight = elementBounds.height * transform.scale;

  // Pivot point in screen coordinates
  // The pivot is at (pivotX%, pivotY%) within the element's own bounds
  // The element's top-left in screen space is at (elementCenter - scaledSize/2)
  const pivotScreenX = elementCenter.x - scaledWidth / 2 + (transform.pivotX / 100) * scaledWidth;
  const pivotScreenY = elementCenter.y - scaledHeight / 2 + (transform.pivotY / 100) * scaledHeight;

  // Bounding box half-dimensions
  const halfW = scaledWidth / 2;
  const halfH = scaledHeight / 2;

  // Corner offsets from elementCenter (before rotation)
  const corners = [
    { x: -halfW, y: -halfH }, // top-left
    { x: halfW, y: -halfH },  // top-right
    { x: halfW, y: halfH },   // bottom-right
    { x: -halfW, y: halfH },  // bottom-left
  ];

  // Rotation handle offsets (outside corners, in local space)
  const rotationOffsets = [
    { x: -ROTATION_HANDLE_OFFSET, y: -ROTATION_HANDLE_OFFSET },
    { x: ROTATION_HANDLE_OFFSET, y: -ROTATION_HANDLE_OFFSET },
    { x: ROTATION_HANDLE_OFFSET, y: ROTATION_HANDLE_OFFSET },
    { x: -ROTATION_HANDLE_OFFSET, y: ROTATION_HANDLE_OFFSET },
  ];

  // Get mouse position in SVG viewport space, accounting for zoom
  const getMousePos = useCallback((e: MouseEvent): { x: number; y: number } => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / zoom,
      y: (e.clientY - rect.top) / zoom,
    };
  }, [zoom]);

  // Counter-rotate a screen-space delta into element-local space
  const screenToLocal = useCallback((dx: number, dy: number): { dx: number; dy: number } => {
    const r = -transform.rotation * Math.PI / 180;
    return {
      dx: dx * Math.cos(r) - dy * Math.sin(r),
      dy: dx * Math.sin(r) + dy * Math.cos(r),
    };
  }, [transform.rotation]);

  const handleMouseDown = useCallback((
    e: React.MouseEvent,
    type: DragState['type'],
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const mouseX = (e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0)) / zoom;
    const mouseY = (e.clientY - (svgRef.current?.getBoundingClientRect().top ?? 0)) / zoom;

    const angleToMouse = Math.atan2(mouseY - pivotScreenY, mouseX - pivotScreenX);
    const distToPivot = Math.hypot(mouseX - pivotScreenX, mouseY - pivotScreenY);

    setDragState({
      type,
      startX: mouseX,
      startY: mouseY,
      startTranslateX: transform.translateX,
      startTranslateY: transform.translateY,
      startScale: transform.scale,
      startRotation: transform.rotation,
      startPivotX: transform.pivotX,
      startPivotY: transform.pivotY,
      startAngle: angleToMouse,
      startDistToPivot: distToPivot,
    });

    onDragStart();
  }, [zoom, pivotScreenX, pivotScreenY, transform, onDragStart]);

  // Window-level mousemove/mouseup during drag
  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (e: MouseEvent) => {
      const pos = getMousePos(e);

      switch (dragState.type) {
        case 'translate': {
          // Convert pixel delta to percentage, add to start values → absolute translate
          const dx = pos.x - dragState.startX;
          const dy = pos.y - dragState.startY;
          const dxPct = (dx / cropDims.width) * 100;
          const dyPct = (dy / cropDims.height) * 100;
          onTranslate(dragState.startTranslateX + dxPct, dragState.startTranslateY + dyPct);
          break;
        }
        case 'scale': {
          const currentDist = Math.hypot(pos.x - pivotScreenX, pos.y - pivotScreenY);
          if (dragState.startDistToPivot > 0) {
            const ratio = currentDist / dragState.startDistToPivot;
            const newScale = Math.max(0.05, dragState.startScale * ratio);
            onScale(newScale);
          }
          break;
        }
        case 'rotate': {
          const currentAngle = Math.atan2(pos.y - pivotScreenY, pos.x - pivotScreenX);
          const deltaAngle = (currentAngle - dragState.startAngle) * (180 / Math.PI);
          onRotate(dragState.startRotation + deltaAngle);
          break;
        }
        case 'pivot': {
          // Convert pixel delta to element-local coordinates (counter-rotate)
          const dxScreen = pos.x - dragState.startX;
          const dyScreen = pos.y - dragState.startY;
          const local = screenToLocal(dxScreen, dyScreen);
          // Convert local pixel delta to pivot percentage delta
          const dxPct = (local.dx / scaledWidth) * 100;
          const dyPct = (local.dy / scaledHeight) * 100;
          const newPivotX = Math.max(0, Math.min(100, dragState.startPivotX + dxPct));
          const newPivotY = Math.max(0, Math.min(100, dragState.startPivotY + dyPct));
          onPivotMove(newPivotX, newPivotY);
          break;
        }
      }
    };

    const handleMouseUp = () => {
      setDragState(null);
      onDragEnd();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragState, getMousePos, cropDims, pivotScreenX, pivotScreenY, scaledWidth, scaledHeight, screenToLocal, onTranslate, onScale, onRotate, onPivotMove, onDragEnd]);

  // Pivot position within the bounding box (relative to element center)
  const pivotLocalX = (transform.pivotX / 100 - 0.5) * scaledWidth;
  const pivotLocalY = (transform.pivotY / 100 - 0.5) * scaledHeight;

  // SVG rotation: rotate the entire gizmo group around the pivot screen position
  const rotationTransform = `rotate(${transform.rotation} ${pivotScreenX} ${pivotScreenY})`;

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: viewportSize.width,
        height: viewportSize.height,
        pointerEvents: 'none',
        zIndex: 201,
      }}
    >
      {/* All gizmo elements rotated around the pivot point */}
      <g transform={rotationTransform}>
        {/* Bounding box */}
        <rect
          x={elementCenter.x - halfW}
          y={elementCenter.y - halfH}
          width={scaledWidth}
          height={scaledHeight}
          fill="none"
          stroke="white"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          pointerEvents="none"
        />

        {!isPlaying && (
          <>
            {/* Move zone - transparent interior */}
            <rect
              x={elementCenter.x - halfW}
              y={elementCenter.y - halfH}
              width={scaledWidth}
              height={scaledHeight}
              fill="transparent"
              stroke="none"
              style={{ cursor: 'move', pointerEvents: 'auto' }}
              onMouseDown={(e) => handleMouseDown(e, 'translate')}
            />

            {/* Scale handles - 4 corners */}
            {corners.map((corner, i) => {
              const cx = elementCenter.x + corner.x;
              const cy = elementCenter.y + corner.y;
              const handleId = `scale-${i}`;
              const isHovered = hoveredHandle === handleId;
              const size = isHovered ? HANDLE_SIZE + 2 : HANDLE_SIZE;
              const half = size / 2;
              return (
                <rect
                  key={handleId}
                  x={cx - half}
                  y={cy - half}
                  width={size}
                  height={size}
                  fill={isHovered ? '#e0e0e0' : 'white'}
                  stroke="#333"
                  strokeWidth={1}
                  style={{
                    cursor: i === 0 || i === 2 ? 'nwse-resize' : 'nesw-resize',
                    pointerEvents: 'auto',
                  }}
                  onMouseDown={(e) => handleMouseDown(e, 'scale')}
                  onMouseEnter={() => setHoveredHandle(handleId)}
                  onMouseLeave={() => setHoveredHandle(null)}
                />
              );
            })}

            {/* Rotation handles - offset outside corners */}
            {corners.map((corner, i) => {
              const cx = elementCenter.x + corner.x + rotationOffsets[i].x;
              const cy = elementCenter.y + corner.y + rotationOffsets[i].y;
              const handleId = `rotate-${i}`;
              const isHovered = hoveredHandle === handleId;
              return (
                <circle
                  key={handleId}
                  cx={cx}
                  cy={cy}
                  r={isHovered ? ROTATION_HANDLE_RADIUS + 1 : ROTATION_HANDLE_RADIUS}
                  fill={isHovered ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.5)'}
                  stroke="none"
                  style={{ cursor: 'grab', pointerEvents: 'auto' }}
                  onMouseDown={(e) => handleMouseDown(e, 'rotate')}
                  onMouseEnter={() => setHoveredHandle(handleId)}
                  onMouseLeave={() => setHoveredHandle(null)}
                />
              );
            })}

            {/* Pivot crosshair */}
            <g style={{ pointerEvents: 'auto', cursor: 'crosshair' }}
               onMouseDown={(e) => handleMouseDown(e, 'pivot')}
               onMouseEnter={() => setHoveredHandle('pivot')}
               onMouseLeave={() => setHoveredHandle(null)}
            >
              <line
                x1={elementCenter.x + pivotLocalX - PIVOT_LINE_LENGTH}
                y1={elementCenter.y + pivotLocalY}
                x2={elementCenter.x + pivotLocalX + PIVOT_LINE_LENGTH}
                y2={elementCenter.y + pivotLocalY}
                stroke="#06b6d4"
                strokeWidth={hoveredHandle === 'pivot' ? 2.5 : 2}
              />
              <line
                x1={elementCenter.x + pivotLocalX}
                y1={elementCenter.y + pivotLocalY - PIVOT_LINE_LENGTH}
                x2={elementCenter.x + pivotLocalX}
                y2={elementCenter.y + pivotLocalY + PIVOT_LINE_LENGTH}
                stroke="#06b6d4"
                strokeWidth={hoveredHandle === 'pivot' ? 2.5 : 2}
              />
              <circle
                cx={elementCenter.x + pivotLocalX}
                cy={elementCenter.y + pivotLocalY}
                r={hoveredHandle === 'pivot' ? PIVOT_CIRCLE_RADIUS + 1 : PIVOT_CIRCLE_RADIUS}
                fill="none"
                stroke="#06b6d4"
                strokeWidth={hoveredHandle === 'pivot' ? 2.5 : 2}
              />
            </g>
          </>
        )}
      </g>
    </svg>
  );
};

export default React.memo(GizmoOverlay);
