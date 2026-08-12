// Minimal WebGL plumbing for the background compositor. One draw call per
// frame — sample the live video texture, sample either a segmentation mask
// texture or compute a chroma-key alpha inline, and blend against the
// background image texture. GPU-side work only; the only CPU cost per frame
// is uploading the current video frame as a texture (native, cheap browser
// operation) and, on the throttled cadence, uploading a fresh mask texture.

export const VERTEX_SHADER_SRC = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = (aPosition + 1.0) * 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

// uMode: 0 = segmentation (alpha from uMask), 1 = chroma-key (alpha computed
// from color distance to uKeyColor).
export const FRAGMENT_SHADER_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uVideo;
uniform sampler2D uBackground;
uniform sampler2D uMask;
uniform int uMode;
uniform vec3 uKeyColor;
uniform float uKeySimilarity;
uniform float uKeySmoothness;

float chromaAlpha(vec3 color) {
  // Distance in a chroma-friendly space: weight luma less than pure
  // hue/saturation distance so brightness variation across the screen
  // (lighting falloff) doesn't punch holes.
  vec3 diff = color - uKeyColor;
  float dist = length(diff);
  return smoothstep(uKeySimilarity, uKeySimilarity + uKeySmoothness, dist);
}

void main() {
  vec4 fg = texture2D(uVideo, vUv);
  vec4 bg = texture2D(uBackground, vUv);
  float alpha;
  if (uMode == 1) {
    alpha = chromaAlpha(fg.rgb);
  } else {
    alpha = texture2D(uMask, vUv).r;
  }
  vec3 outColor = mix(bg.rgb, fg.rgb, alpha);
  gl_FragColor = vec4(outColor, 1.0);
}
`;

export function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

export function createProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  return program;
}

export function createTexture(gl: WebGLRenderingContext, placeholder: [number, number, number, number] = [0, 0, 0, 255]): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("Failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // 1x1 placeholder so the first few frames before real data arrives don't
  // sample garbage. Callers pick the color deliberately — see the mask
  // texture in useBackgroundCompositor, which needs white (not this default
  // black) so an unready mask reads as "fully foreground" instead of
  // silently hiding the person behind the background image.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(placeholder));
  return tex;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r || 0, g || 0, b || 0];
}
