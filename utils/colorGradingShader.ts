/**
 * WebGL2 color grading pipeline.
 * Sets up a fullscreen quad, draws video as texture, applies GLSL color grading.
 */

const VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
  vTexCoord = aPosition * 0.5 + 0.5;
  vTexCoord.y = 1.0 - vTexCoord.y; // Flip Y for video
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 vTexCoord;
out vec4 fragColor;

// Video texture
uniform sampler2D uVideoTexture;

// Basic corrections
uniform float uBrightness;   // 0-2 (1.0 = default)
uniform float uContrast;     // 0-2
uniform float uSaturation;   // 0-2
uniform float uExposure;     // -1 to 1
uniform float uTemperature;  // -0.3 to 0.3
uniform float uTint;         // -0.3 to 0.3
uniform float uHighlights;   // -0.5 to 0.5
uniform float uShadows;      // -0.2 to 0.2
uniform float uHueRotate;    // radians
uniform float uGamma;        // 0.1 to 3.0

// Color wheels (vec4: r, g, b, y)
uniform vec4 uLift;
uniform vec4 uGammaWheel;
uniform vec4 uGain;
uniform vec4 uOffset;

// Curve LUTs (256x1 textures, 0 = not active)
uniform sampler2D uCurveMaster;
uniform sampler2D uCurveRed;
uniform sampler2D uCurveGreen;
uniform sampler2D uCurveBlue;
uniform int uCurveMasterActive;
uniform int uCurveRedActive;
uniform int uCurveGreenActive;
uniform int uCurveBlueActive;

// HSL Curve LUTs
uniform sampler2D uHueVsHue;
uniform sampler2D uHueVsSat;
uniform sampler2D uHueVsLum;
uniform sampler2D uLumVsSat;
uniform sampler2D uSatVsSat;
uniform int uHueVsHueActive;
uniform int uHueVsSatActive;
uniform int uHueVsLumActive;
uniform int uLumVsSatActive;
uniform int uSatVsSatActive;

// HSL Qualifier
uniform int uQualifierEnabled;
uniform vec3 uQualifierHue;    // center, width, softness
uniform vec3 uQualifierSat;    // center, width, softness
uniform vec3 uQualifierLum;    // center, width, softness
uniform int uQualifierInvert;
uniform int uMattePreviewing;

// ---- Color Space Conversions ----

vec3 rgb2hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;

  if (maxC == minC) return vec3(0.0, 0.0, l);

  float d = maxC - minC;
  float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
  float h;

  if (maxC == c.r) {
    h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  } else if (maxC == c.g) {
    h = (c.b - c.r) / d + 2.0;
  } else {
    h = (c.r - c.g) / d + 4.0;
  }
  h /= 6.0;

  return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0/2.0) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  if (hsl.y == 0.0) return vec3(hsl.z);
  float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
  float p = 2.0 * hsl.z - q;
  return vec3(
    hue2rgb(p, q, hsl.x + 1.0/3.0),
    hue2rgb(p, q, hsl.x),
    hue2rgb(p, q, hsl.x - 1.0/3.0)
  );
}

// ---- Basic Corrections ----

vec3 applyBasicCorrections(vec3 color) {
  // Exposure (pre-brightness)
  color *= pow(2.0, uExposure);

  // Brightness
  color *= uBrightness;

  // Contrast (around 0.5 midpoint)
  color = (color - 0.5) * uContrast + 0.5;

  // Temperature (warm/cool shift)
  color.r *= 1.0 + uTemperature;
  color.b *= 1.0 - uTemperature;

  // Tint (green/magenta)
  color.g *= 1.0 + uTint;

  // Gamma
  float gammaExp = 1.0 / max(0.1, uGamma);
  color = pow(max(vec3(0.0), color), vec3(gammaExp));

  // Highlights/Shadows (tone curve)
  float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float highlightMask = smoothstep(0.3, 0.8, lum);
  float shadowMask = 1.0 - smoothstep(0.2, 0.7, lum);
  color += color * uHighlights * highlightMask;
  color += vec3(uShadows) * shadowMask;

  // Saturation
  float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(gray), color, uSaturation);

  // Hue rotation
  if (abs(uHueRotate) > 0.001) {
    float cosA = cos(uHueRotate);
    float sinA = sin(uHueRotate);
    vec3 k = vec3(0.57735);
    color = color * cosA + cross(k, color) * sinA + k * dot(k, color) * (1.0 - cosA);
  }

  return clamp(color, 0.0, 1.0);
}

// ---- Lift/Gamma/Gain/Offset ----

vec3 applyLiftGammaGain(vec3 color) {
  // Gain: scale (affects highlights most)
  color = color * (vec3(1.0) + uGain.rgb);

  // Lift: offset shadows
  color = color + uLift.rgb * (vec3(1.0) - color);

  // Gamma wheel: power curve for midtones
  vec3 gammaExp = max(vec3(0.01), vec3(1.0) - uGammaWheel.rgb);
  color = pow(max(vec3(0.0), color), gammaExp);

  // Offset: global additive
  color += uOffset.rgb;

  // Y (luminance) adjustments per wheel
  float yAdj = uLift.a + uGammaWheel.a + uGain.a + uOffset.a;
  color *= 1.0 + yAdj;

  return clamp(color, 0.0, 1.0);
}

// ---- RGB Curves ----

vec3 applyRGBCurves(vec3 color) {
  // Master curve (applied to all channels)
  if (uCurveMasterActive != 0) {
    float masterR = texture(uCurveMaster, vec2(color.r, 0.5)).r;
    float masterG = texture(uCurveMaster, vec2(color.g, 0.5)).r;
    float masterB = texture(uCurveMaster, vec2(color.b, 0.5)).r;
    color = vec3(masterR, masterG, masterB);
  }

  // Per-channel curves
  if (uCurveRedActive != 0)   color.r = texture(uCurveRed,   vec2(color.r, 0.5)).r;
  if (uCurveGreenActive != 0) color.g = texture(uCurveGreen, vec2(color.g, 0.5)).r;
  if (uCurveBlueActive != 0)  color.b = texture(uCurveBlue,  vec2(color.b, 0.5)).r;

  return color;
}

// ---- HSL Curves ----

vec3 applyHSLCurves(vec3 hsl) {
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;

  // Hue vs Hue: shift hue based on input hue
  if (uHueVsHueActive != 0) {
    float shift = texture(uHueVsHue, vec2(h, 0.5)).r - 0.5;
    h = fract(h + shift);
  }

  // Hue vs Sat: adjust saturation based on hue
  if (uHueVsSatActive != 0) {
    float mult = texture(uHueVsSat, vec2(h, 0.5)).r * 2.0;
    s *= mult;
  }

  // Hue vs Lum: adjust luminance based on hue
  if (uHueVsLumActive != 0) {
    float adj = (texture(uHueVsLum, vec2(h, 0.5)).r - 0.5) * 2.0;
    l = clamp(l + adj * 0.5, 0.0, 1.0);
  }

  // Lum vs Sat: adjust saturation based on luminance
  if (uLumVsSatActive != 0) {
    float mult = texture(uLumVsSat, vec2(l, 0.5)).r * 2.0;
    s *= mult;
  }

  // Sat vs Sat: adjust saturation based on input saturation
  if (uSatVsSatActive != 0) {
    float mult = texture(uSatVsSat, vec2(s, 0.5)).r * 2.0;
    s *= mult;
  }

  return vec3(h, clamp(s, 0.0, 1.0), l);
}

// ---- HSL Qualifier ----

float smoothRange(float value, float center, float width, float soft) {
  float halfW = width * 0.5;
  float low = center - halfW;
  float high = center + halfW;
  float s = max(soft, 0.001);
  return smoothstep(low - s, low + s, value) * (1.0 - smoothstep(high - s, high + s, value));
}

float smoothRangeHue(float value, float center, float width, float soft) {
  // Hue wraps around (0-1), need special handling
  float d = abs(value - center);
  d = min(d, 1.0 - d); // Wrap distance
  float halfW = width * 0.5;
  float s = max(soft, 0.001);
  return 1.0 - smoothstep(halfW - s, halfW + s, d);
}

// ---- Main ----

void main() {
  vec4 texColor = texture(uVideoTexture, vTexCoord);
  vec3 color = texColor.rgb;

  // Stage 1: Basic corrections
  color = applyBasicCorrections(color);

  // Stage 2: Lift/Gamma/Gain/Offset
  color = applyLiftGammaGain(color);

  // Stage 3: RGB Curves
  color = applyRGBCurves(color);

  // Stage 4: HSL Curves
  vec3 hsl = rgb2hsl(color);
  bool anyHSLActive = uHueVsHueActive != 0 || uHueVsSatActive != 0 ||
                      uHueVsLumActive != 0 || uLumVsSatActive != 0 || uSatVsSatActive != 0;
  if (anyHSLActive) {
    hsl = applyHSLCurves(hsl);
    color = hsl2rgb(hsl);
  }

  // Stage 5: HSL Qualifier
  if (uQualifierEnabled != 0) {
    vec3 qHSL = rgb2hsl(color);
    float mask = smoothRangeHue(qHSL.x, uQualifierHue.x, uQualifierHue.y, uQualifierHue.z)
               * smoothRange(qHSL.y, uQualifierSat.x, uQualifierSat.y, uQualifierSat.z)
               * smoothRange(qHSL.z, uQualifierLum.x, uQualifierLum.y, uQualifierLum.z);

    if (uQualifierInvert != 0) mask = 1.0 - mask;

    if (uMattePreviewing != 0) {
      // Show mask as grayscale
      fragColor = vec4(vec3(mask), 1.0);
      return;
    }

    // For now, qualifier just isolates — secondary corrections would be applied here
    // color = mix(originalColor, adjustedColor, mask);
  }

  fragColor = vec4(color, texColor.a);
}
`;

export interface GradingGLContext {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  videoTexture: WebGLTexture;
  curveLUTs: Map<string, WebGLTexture>;
  uniformLocations: Map<string, WebGLUniformLocation>;
}

/** Compile a shader, throwing on error */
function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${log}`);
  }
  return shader;
}

/** Initialize the WebGL2 color grading pipeline */
export function initColorGrading(canvas: HTMLCanvasElement): GradingGLContext | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: false });
  if (!gl) {
    console.warn('[ColorGrading] WebGL2 not available');
    return null;
  }

  // Compile shaders
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

  // Link program
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`Program link error: ${log}`);
  }
  gl.useProgram(program);

  // Setup fullscreen quad
  const posBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Create video texture
  const videoTexture = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Cache all uniform locations
  const uniformNames = [
    'uVideoTexture',
    'uBrightness', 'uContrast', 'uSaturation', 'uExposure',
    'uTemperature', 'uTint', 'uHighlights', 'uShadows', 'uHueRotate', 'uGamma',
    'uLift', 'uGammaWheel', 'uGain', 'uOffset',
    'uCurveMaster', 'uCurveRed', 'uCurveGreen', 'uCurveBlue',
    'uCurveMasterActive', 'uCurveRedActive', 'uCurveGreenActive', 'uCurveBlueActive',
    'uHueVsHue', 'uHueVsSat', 'uHueVsLum', 'uLumVsSat', 'uSatVsSat',
    'uHueVsHueActive', 'uHueVsSatActive', 'uHueVsLumActive', 'uLumVsSatActive', 'uSatVsSatActive',
    'uQualifierEnabled', 'uQualifierHue', 'uQualifierSat', 'uQualifierLum',
    'uQualifierInvert', 'uMattePreviewing',
  ];
  const uniformLocations = new Map<string, WebGLUniformLocation>();
  for (const name of uniformNames) {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) uniformLocations.set(name, loc);
  }

  // Set video texture unit
  const videoTexLoc = uniformLocations.get('uVideoTexture');
  if (videoTexLoc) gl.uniform1i(videoTexLoc, 0);

  // Assign texture units for curve LUTs (1-12)
  const curveSamplers = [
    'uCurveMaster', 'uCurveRed', 'uCurveGreen', 'uCurveBlue',
    'uHueVsHue', 'uHueVsSat', 'uHueVsLum', 'uLumVsSat', 'uSatVsSat',
  ];
  curveSamplers.forEach((name, i) => {
    const loc = uniformLocations.get(name);
    if (loc) gl.uniform1i(loc, i + 1); // Texture units 1-9
  });

  return { gl, program, videoTexture, curveLUTs: new Map(), uniformLocations };
}

/** Upload video frame as texture */
export function uploadVideoFrame(ctx: GradingGLContext, video: HTMLVideoElement): void {
  const { gl, videoTexture } = ctx;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  } catch {
    // Video not ready yet
  }
}

/** Upload or update a 256x1 curve LUT texture */
export function uploadCurveLUT(
  ctx: GradingGLContext,
  name: string,
  data: Uint8Array | Float32Array | null,
  textureUnit: number
): void {
  const { gl, curveLUTs } = ctx;

  gl.activeTexture(gl.TEXTURE0 + textureUnit);

  if (!data) {
    // Deactivate — bind a default texture or just skip
    let tex = curveLUTs.get(name);
    if (tex) {
      gl.deleteTexture(tex);
      curveLUTs.delete(name);
    }
    return;
  }

  let tex = curveLUTs.get(name);
  if (!tex) {
    tex = gl.createTexture()!;
    curveLUTs.set(name, tex);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  } else {
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  if (data instanceof Float32Array) {
    // HSL curves use float data — pack into R channel of RGBA uint8
    const u8 = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
      u8[i * 4] = v;
      u8[i * 4 + 1] = v;
      u8[i * 4 + 2] = v;
      u8[i * 4 + 3] = 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8);
  } else {
    // RGB curves use uint8 data
    const u8 = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      u8[i * 4] = data[i];
      u8[i * 4 + 1] = data[i];
      u8[i * 4 + 2] = data[i];
      u8[i * 4 + 3] = 255;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8);
  }
}

/** Set all color grading uniforms from a ColorGrading object */
export function setGradingUniforms(
  ctx: GradingGLContext,
  g: import('../types').ColorGrading
): void {
  const { gl, uniformLocations: u } = ctx;
  const f1 = (name: string, v: number) => { const loc = u.get(name); if (loc) gl.uniform1f(loc, v); };
  const i1 = (name: string, v: number) => { const loc = u.get(name); if (loc) gl.uniform1i(loc, v); };
  const f4 = (name: string, a: number, b: number, c: number, d: number) => {
    const loc = u.get(name); if (loc) gl.uniform4f(loc, a, b, c, d);
  };
  const f3 = (name: string, a: number, b: number, c: number) => {
    const loc = u.get(name); if (loc) gl.uniform3f(loc, a, b, c);
  };

  // Basic corrections (normalize from UI ranges to shader ranges)
  f1('uBrightness', (g.brightness / 100) + (g.exposure / 200));
  f1('uContrast', g.contrast / 100);
  f1('uSaturation', g.saturation / 100);
  f1('uExposure', g.exposure / 200);
  f1('uTemperature', g.temperature / 333);
  f1('uTint', g.tint / 333);
  f1('uHighlights', g.highlights / 200);
  f1('uShadows', g.shadows / 500);
  f1('uHueRotate', g.hueRotate * Math.PI / 180);
  f1('uGamma', g.gamma);

  // Color wheels
  f4('uLift', g.lift.r, g.lift.g, g.lift.b, g.lift.y);
  f4('uGammaWheel', g.gammaWheel.r, g.gammaWheel.g, g.gammaWheel.b, g.gammaWheel.y);
  f4('uGain', g.gain.r, g.gain.g, g.gain.b, g.gain.y);
  f4('uOffset', g.offset.r, g.offset.g, g.offset.b, g.offset.y);

  // HSL Qualifier
  const q = g.qualifier;
  i1('uQualifierEnabled', q?.enabled ? 1 : 0);
  if (q?.enabled) {
    f3('uQualifierHue', q.hue.center, q.hue.width, q.hue.softness);
    f3('uQualifierSat', q.saturation.center, q.saturation.width, q.saturation.softness);
    f3('uQualifierLum', q.luminance.center, q.luminance.width, q.luminance.softness);
    i1('uQualifierInvert', q.invert ? 1 : 0);
  }
  i1('uMattePreviewing', 0);
}

/** Render one frame */
export function renderFrame(ctx: GradingGLContext, width: number, height: number): void {
  const { gl } = ctx;
  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/** Cleanup WebGL resources */
export function destroyColorGrading(ctx: GradingGLContext): void {
  const { gl, program, videoTexture, curveLUTs } = ctx;
  gl.deleteTexture(videoTexture);
  curveLUTs.forEach(tex => gl.deleteTexture(tex));
  gl.deleteProgram(program);
}

// Curve name → texture unit mapping
export const CURVE_TEXTURE_UNITS: Record<string, number> = {
  curveMaster: 1,
  curveRed: 2,
  curveGreen: 3,
  curveBlue: 4,
  hueVsHue: 5,
  hueVsSat: 6,
  hueVsLum: 7,
  lumVsSat: 8,
  satVsSat: 9,
};

export const CURVE_ACTIVE_UNIFORMS: Record<string, string> = {
  curveMaster: 'uCurveMasterActive',
  curveRed: 'uCurveRedActive',
  curveGreen: 'uCurveGreenActive',
  curveBlue: 'uCurveBlueActive',
  hueVsHue: 'uHueVsHueActive',
  hueVsSat: 'uHueVsSatActive',
  hueVsLum: 'uHueVsLumActive',
  lumVsSat: 'uLumVsSatActive',
  satVsSat: 'uSatVsSatActive',
};
