import React, { useCallback, useRef, useState } from 'react';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  onDoubleClick?: () => void;
  className?: string;
}

export default function ResizeHandle({ direction, onResize, onDoubleClick, className }: ResizeHandleProps) {
  const lastPosRef = useRef(0);
  const isDraggingRef = useRef(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const pos = direction === 'horizontal' ? e.clientX : e.clientY;
    lastPosRef.current = pos;
    isDraggingRef.current = true;
    setIsDragging(true);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (ev: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = currentPos - lastPosRef.current;
      lastPosRef.current = currentPos;
      if (delta !== 0) onResize(delta);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [direction, onResize]);

  const isHorizontal = direction === 'horizontal';

  return (
    <div
      className={`flex-shrink-0 ${
        isDragging ? 'bg-blue-500' : isHovered ? 'bg-[#555]' : 'bg-[#333]'
      } transition-colors duration-150 ${className ?? ''}`}
      style={{
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        ...(isHorizontal ? { width: 4 } : { height: 4 }),
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { if (!isDraggingRef.current) setIsHovered(false); }}
      onDoubleClick={onDoubleClick}
    />
  );
}
