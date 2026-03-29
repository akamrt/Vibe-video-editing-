import React, { useRef, useEffect, useCallback } from 'react';
import type { ColorGrading } from '../types';
import { isGradingDefault } from '../utils/colorGradingDefaults';
import { generateCurveLUT, generateHSLCurveLUT } from '../utils/curveUtils';
import {
  initColorGrading,
  uploadVideoFrame,
  uploadCurveLUT,
  setGradingUniforms,
  renderFrame,
  destroyColorGrading,
  CURVE_TEXTURE_UNITS,
  CURVE_ACTIVE_UNIFORMS,
  type GradingGLContext,
} from '../utils/colorGradingShader';

interface Props {
  videoElement: HTMLVideoElement | null;
  grading: ColorGrading;
  className?: string;
  style?: React.CSSProperties;
  mattePreviewing?: boolean;
}

/**
 * WebGL2 canvas that replaces the <video> element when color grading is active.
 * Draws the video as a texture and applies the full GLSL grading pipeline.
 */
export default function ColorGradingCanvas({ videoElement, grading, className, style, mattePreviewing }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glCtxRef = useRef<GradingGLContext | null>(null);
  const rafRef = useRef<number>(0);
  const gradingRef = useRef(grading);
  gradingRef.current = grading;
  const matteRef = useRef(mattePreviewing ?? false);
  matteRef.current = mattePreviewing ?? false;

  // Upload curve LUTs when grading changes
  const uploadCurves = useCallback((ctx: GradingGLContext, g: ColorGrading) => {
    const { gl, uniformLocations: u } = ctx;

    // RGB curves
    const rgbCurves = ['curveMaster', 'curveRed', 'curveGreen', 'curveBlue'] as const;
    for (const name of rgbCurves) {
      const lut = generateCurveLUT(g[name]);
      uploadCurveLUT(ctx, name, lut, CURVE_TEXTURE_UNITS[name]);
      const activeLoc = u.get(CURVE_ACTIVE_UNIFORMS[name]);
      if (activeLoc) gl.uniform1i(activeLoc, lut ? 1 : 0);
    }

    // HSL curves
    const hslCurves = ['hueVsHue', 'hueVsSat', 'hueVsLum', 'lumVsSat', 'satVsSat'] as const;
    for (const name of hslCurves) {
      const lut = generateHSLCurveLUT(g[name]);
      uploadCurveLUT(ctx, name, lut, CURVE_TEXTURE_UNITS[name]);
      const activeLoc = u.get(CURVE_ACTIVE_UNIFORMS[name]);
      if (activeLoc) gl.uniform1i(activeLoc, lut ? 1 : 0);
    }
  }, []);

  // Initialize WebGL context
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = initColorGrading(canvas);
    if (!ctx) return;
    glCtxRef.current = ctx;

    return () => {
      if (glCtxRef.current) {
        destroyColorGrading(glCtxRef.current);
        glCtxRef.current = null;
      }
    };
  }, []);

  // Animation loop
  useEffect(() => {
    if (!videoElement) return;

    const loop = () => {
      const ctx = glCtxRef.current;
      const canvas = canvasRef.current;
      if (!ctx || !canvas) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // Resize canvas to match video natural size (for crisp rendering)
      const vw = videoElement.videoWidth || 1920;
      const vh = videoElement.videoHeight || 1080;
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }

      // Upload current video frame
      uploadVideoFrame(ctx, videoElement);

      // Set all uniforms
      const g = gradingRef.current;
      setGradingUniforms(ctx, g);

      // Set matte preview uniform
      const matteLoc = ctx.uniformLocations.get('uMattePreviewing');
      if (matteLoc) ctx.gl.uniform1i(matteLoc, matteRef.current ? 1 : 0);

      // Upload curves
      uploadCurves(ctx, g);

      // Render
      renderFrame(ctx, canvas.width, canvas.height);

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [videoElement, uploadCurves]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={style}
    />
  );
}
