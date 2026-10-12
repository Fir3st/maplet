/**
 * WebGL 1 backend (also used on WebGL 2 contexts through the same GLSL ES 1.00
 * program set). Implements the shared frame plan with:
 * - instanced draws when `ANGLE_instanced_arrays` is available, otherwise a CPU
 *   expansion into ordinary vertex buffers (no silent degradation, GPU-02/GPU-04);
 * - fragment-shader anti-aliasing from the DPR uniform (no derivatives);
 * - picking via an RGBA8 offscreen pass and `readPixels` on a small region;
 * - a bounded LRU tile texture cache with per-revision request cancellation.
 */

import { fail, MapletError } from './../../api/errors.ts';
import type { ScreenPoint } from './../../api/types.ts';
import type { Scene } from './../../scene/scene.ts';
import type { MediaElement, MediaSourceImpl } from './../../scene/media-source.ts';
import {
  buildFramePlan,
  FILL_STRIDE,
  FLAG_INTERACTIVE,
  LINE_STRIDE,
  POINT_STRIDE,
  type FramePlan,
  type MediaPlacement,
  type PlanBatch,
} from './../frame-plan.ts';
import { monotonicNow, PickStallRecorder, type PickResult } from './../picking.ts';
import { QUAD_UVS, quadBounds, quadVertices } from './../quad.ts';
import type { BackendInitOptions, MapBackend } from './../backends.ts';

const POINT_VERTEX = `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aPos;
attribute vec4 aFill;
attribute vec4 aStroke;
attribute vec4 aMeta;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uPickMode;
uniform vec2 uOffset;
uniform float uPickBase;
varying vec2 vLocal;
varying vec4 vFill;
varying vec4 vStroke;
varying vec4 vMeta;
varying vec2 vRadius;
void main() {
  vec2 radius = max(aPos.zw, vec2(0.01));
  float strokePad = aStroke.a > 0.0 ? aMeta.y * 0.5 : 0.0;
  vec2 offset = aCorner * (radius + strokePad);
  vec2 cssPos = aPos.xy + uOffset + offset;
  vec2 device = cssPos * uDpr;
  vec2 clip = vec2(device.x / uViewport.x * 2.0 - 1.0, 1.0 - device.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  if (aMeta.w >= 2.0) gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  vLocal = offset / max(radius, vec2(0.01));
  vFill = aFill;
  vStroke = aStroke;
  vMeta = vec4(aMeta.xy, aMeta.z + uPickBase, aMeta.w);
  vRadius = radius;
}
`;

const PICK_ENCODE = `
vec4 encodePick(float index) {
  float r = floor(index / 65536.0);
  float g = floor(mod(index / 256.0, 256.0));
  float b = mod(index, 256.0);
  return vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
}
`;

const POINT_FRAGMENT = `
precision highp float;
varying vec2 vLocal;
varying vec4 vFill;
varying vec4 vStroke;
varying vec4 vMeta;
varying vec2 vRadius;
uniform float uDpr;
uniform float uPickMode;
${PICK_ENCODE}
float shapeDistance(vec2 local, float shape) {
  float d;
  if (shape < 0.5) {
    d = length(local);
  } else if (shape < 1.5) {
    d = max(abs(local.x), abs(local.y));
  } else if (shape < 2.5) {
    d = abs(local.x) + abs(local.y);
  } else {
    d = max(abs(local.x) * 1.15 + local.y * 0.58, -local.y + 0.58);
  }
  return d;
}
void main() {
  if (uPickMode > 0.5) {
    if (mod(vMeta.w, 2.0) < 0.5) discard;
    gl_FragColor = encodePick(vMeta.z);
    return;
  }
  float shape = vMeta.x;
  float strokeWidth = vMeta.y;
  float d = shapeDistance(vLocal, shape);
  float radiusPx = max(min(vRadius.x, vRadius.y), 0.5);
  float aa = (1.5 / (radiusPx * uDpr)) + 0.002;
  float fillAlpha = clamp((1.0 - d) / aa, 0.0, 1.0);
  vec4 color = vec4(vFill.rgb, vFill.a * fillAlpha);
  if (strokeWidth > 0.0 && vStroke.a > 0.0) {
    float strokeLocal = clamp(strokeWidth * 0.5 / radiusPx, 0.02, 0.98);
    float inner = 1.0 - strokeLocal;
    float strokeAlpha = clamp((d - inner) / aa, 0.0, 1.0) * clamp((1.0 - d) / aa, 0.0, 1.0);
    vec4 strokeColor = vec4(vStroke.rgb, vStroke.a * strokeAlpha);
    color = mix(color, strokeColor, step(d, 1.0) * strokeAlpha);
    color.a = max(color.a, strokeColor.a);
  }
  if (color.a <= 0.001) discard;
  gl_FragColor = color;
}
`;

const LINE_VERTEX = `
precision highp float;
attribute vec2 aCorner;
attribute vec4 aSeg;
attribute vec4 aLine;
attribute vec4 aFill;
uniform vec2 uViewport;
uniform float uDpr;
varying vec2 vPos;
varying vec4 vSeg;
varying vec4 vLine;
varying vec4 vFill;
varying float vArc;
void main() {
  vec2 p0 = aSeg.xy;
  vec2 p1 = aSeg.zw;
  vec2 delta = p1 - p0;
  float segLen = length(delta);
  vec2 dir;
  if (segLen < 0.0001) {
    dir = vec2(1.0, 0.0);
    segLen = 0.0;
  } else {
    dir = delta / segLen;
  }
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = aLine.x * 0.5 + 1.0;
  float extend = aLine.y > 0.5 ? halfWidth : 0.0;
  vec2 base = p0 - dir * extend;
  float total = segLen + extend * 2.0;
  float along = aCorner.x * total;
  vec2 cssPos = base + dir * along + normal * ((aCorner.y * 2.0 - 1.0) * halfWidth);
  vec2 device = cssPos * uDpr;
  vec2 clip = vec2(device.x / uViewport.x * 2.0 - 1.0, 1.0 - device.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vPos = cssPos;
  vSeg = aSeg;
  vLine = aLine;
  vFill = aFill;
  // Arc position inside the whole line for a continuous dash phase.
  vArc = aSeg.w + clamp(along - extend, 0.0, segLen);
}
`;

const LINE_FRAGMENT = `
precision highp float;
varying vec2 vPos;
varying vec4 vSeg;
varying vec4 vLine;
varying vec4 vFill;
varying float vArc;
uniform float uDpr;
uniform float uPickMode;
uniform float uDashCount;
uniform float uDashPattern[8];
uniform float uDashOffset;
${PICK_ENCODE}
float dashAlpha() {
  if (uDashCount < 1.0) return 1.0;
  float period = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) < uDashCount) period += uDashPattern[i];
  }
  if (period <= 0.0) return 1.0;
  float phase = mod(vArc + uDashOffset, period);
  if (phase < 0.0) phase += period;
  float cursor = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) < uDashCount) {
      float step = uDashPattern[i];
      if (phase >= cursor && phase < cursor + step) {
        return mod(float(i), 2.0) < 0.5 ? 1.0 : 0.0;
      }
      cursor += step;
    }
  }
  return 1.0;
}
void main() {
  if (uPickMode > 0.5) {
    if (mod(vLine.w, 2.0) < 0.5) discard;
    if (uDashCount > 0.5 && dashAlpha() < 0.5) discard;
    gl_FragColor = encodePick(vLine.z);
    return;
  }
  vec2 p0 = vSeg.xy;
  vec2 p1 = vSeg.zw;
  float edgeLen = length(p1 - p0);
  vec2 dir;
  float t;
  if (edgeLen < 0.0001) {
    // Zero-length round segment: a disc centred on the point.
    dir = vec2(1.0, 0.0);
    t = 0.5;
    edgeLen = 0.0001;
  } else {
    dir = (p1 - p0) / edgeLen;
    t = dot(vPos - p0, dir) / edgeLen;
  }
  float width = vLine.x;
  float halfWidth = max(width * 0.5, 0.35);
  float center = length(vPos - p0);
  vec2 closest = p0 + dir * clamp(t, 0.0, 1.0) * edgeLen;
  float segmentDistance = length(vPos - closest) - halfWidth;
  float distance;
  if (edgeLen < 0.0002) {
    distance = vLine.y > 0.5 ? center - halfWidth : 1.0;
  } else if (vLine.y > 0.5) {
    distance = segmentDistance;
  } else {
    if (t < 0.0) distance = max(segmentDistance, -t * edgeLen);
    else if (t > 1.0) distance = max(segmentDistance, (t - 1.0) * edgeLen);
    else distance = segmentDistance;
  }
  float aa = 1.0 / uDpr;
  float alpha = clamp(0.5 - distance / aa, 0.0, 1.0);
  float dash = uDashCount > 0.5 ? dashAlpha() : 1.0;
  alpha *= dash;
  if (alpha <= 0.001) discard;
  gl_FragColor = vec4(vFill.rgb, vFill.a * alpha);
}
`;

const FILL_VERTEX = `
precision highp float;
attribute vec4 aPos;
attribute vec4 aFill;
attribute vec4 aMeta;
uniform vec2 uViewport;
uniform float uDpr;
varying vec4 vFill;
varying vec4 vMeta;
void main() {
  vec2 device = aPos.xy * uDpr;
  vec2 clip = vec2(device.x / uViewport.x * 2.0 - 1.0, 1.0 - device.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vFill = aFill;
  vMeta = aMeta;
}
`;

const FILL_FRAGMENT = `
precision highp float;
varying vec4 vFill;
varying vec4 vMeta;
uniform float uPickMode;
${PICK_ENCODE}
void main() {
  if (uPickMode > 0.5) {
    if (mod(vMeta.y, 2.0) < 0.5) discard;
    gl_FragColor = encodePick(vMeta.x);
    return;
  }
  gl_FragColor = vFill;
}
`;

const RASTER_VERTEX = `
precision highp float;
attribute vec4 aPos;
attribute vec4 aUV;
attribute vec4 aPick;
uniform vec2 uViewport;
uniform float uDpr;
varying vec2 vUV;
varying float vOpacity;
varying vec4 vPick;
void main() {
  vec2 device = aPos.xy * uDpr;
  vec2 clip = vec2(device.x / uViewport.x * 2.0 - 1.0, 1.0 - device.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = aUV.xy;
  vOpacity = aUV.z;
  vPick = aPick;
}
`;

const RASTER_FRAGMENT = `
precision highp float;
varying vec2 vUV;
varying float vOpacity;
varying vec4 vPick;
uniform sampler2D uTexture;
uniform float uPickMode;
${PICK_ENCODE}
void main() {
  if (uPickMode > 0.5) {
    // Media quads are one pick record per source, not per pixel (MEDIA-05).
    if (mod(vPick.y, 2.0) < 0.5) discard;
    gl_FragColor = encodePick(vPick.x);
    return;
  }
  vec4 color = texture2D(uTexture, vUV);
  // The texture is premultiplied: scaling rgb and alpha by the layer opacity
  // fades it against what is below instead of darkening it.
  color.rgb *= vOpacity;
  color.a *= vOpacity;
  gl_FragColor = color;
}
`;

const LABEL_VERTEX = `
precision highp float;
attribute vec4 aPos;
attribute vec4 aUV;
attribute vec4 aFill;
attribute vec4 aMeta;
uniform vec2 uViewport;
uniform float uDpr;
varying vec2 vUV;
varying vec4 vFill;
varying vec4 vMeta;
void main() {
  vec2 device = aPos.xy * uDpr;
  vec2 clip = vec2(device.x / uViewport.x * 2.0 - 1.0, 1.0 - device.y / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vUV = aUV.xy;
  vFill = aFill;
  vMeta = aMeta;
}
`;

/**
 * Textured quads shared by labels (glyph atlas) and sprites (image assets):
 * the texture is sampled for rgb and alpha, the attribute tints it. Picking
 * discards texels below `uPickThreshold`, so fully transparent icon areas are
 * not hits (PICK-05); labels use a near-zero threshold.
 */
const LABEL_FRAGMENT = `
precision highp float;
varying vec2 vUV;
varying vec4 vFill;
varying vec4 vMeta;
uniform sampler2D uTexture;
uniform float uPickMode;
uniform float uPickThreshold;
${PICK_ENCODE}
void main() {
  vec4 texel = texture2D(uTexture, vUV);
  if (uPickMode > 0.5) {
    if (texel.a < uPickThreshold || vMeta.y < 0.5) discard;
    gl_FragColor = encodePick(vMeta.x);
    return;
  }
  float alpha = texel.a * vFill.a;
  if (alpha <= 0.004) discard;
  gl_FragColor = vec4(texel.rgb * vFill.rgb, alpha);
}
`;

interface ProgramBundle {
  program: WebGLProgram;
  attribs: Record<string, number>;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface TileEntry {
  state: 'loading' | 'ready' | 'error';
  texture: WebGLTexture | null;
  image: HTMLImageElement | null;
  lastUsed: number;
}

/**
 * One glyph-atlas page: a canvas with the label rendered in white (the shader
 * tints it) plus its size in CSS px. Reconstruction after eviction is just
 * another `labelEntry` call (TEXT-08).
 */
interface LabelEntry {
  canvas: HTMLCanvasElement;
  texture: WebGLTexture | null;
  cssWidth: number;
  cssHeight: number;
  lastUsed: number;
}

/** GPU copy of a registered image asset; re-uploaded when its version changes. */
interface SpriteEntry {
  assetVersion: number;
  texture: WebGLTexture;
  width: number;
  height: number;
  lastUsed: number;
}

/**
 * GPU copy of a media source. `element` is the identity of the uploaded
 * bitmap (`<img>`/`<canvas>`/`<video>`); `pixelVersion` guards partial uploads
 * so two region updates between two uploads are both transferred (MEDIA-03).
 */
interface MediaEntry {
  texture: WebGLTexture | null;
  element: MediaElement | null;
  width: number;
  height: number;
  pixelVersion: number;
  lastUsed: number;
}

const MAX_LABELS = 256;



const MAX_TILES = 256;
const MAX_MEDIA = 16;
/** Raster quad vertex stride: aPos(4) + aUV(4) + aPick(4). */
const RASTER_STRIDE = 12;
const PICK_RADIUS = 2;
const CORNERS_QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
// The same quad in TRIANGLES order (six vertices) for the CPU-expanded path:
// drawing the four-vertex strip as TRIANGLES with `count * 6` mixed corners of
// neighbouring instances and read past the buffer.
const CORNERS_QUAD_TRI = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]);
const CORNERS_TRI = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

export class WebGl1Backend implements MapBackend {
  readonly kind = 'webgl1' as const;
  readonly notes: string[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly instanced: {
    drawArraysInstancedANGLE(mode: number, first: number, count: number, instances: number): void;
    vertexAttribDivisorANGLE(index: number, divisor: number): void;
  } | null;
  private readonly programs = new Map<string, ProgramBundle>();
  private readonly batchBuffers = new Map<Float32Array, { buffer: WebGLBuffer; version: number; bytes: number }>();
  private readonly buffers = {
    quad: null as WebGLBuffer | null,
    tri: null as WebGLBuffer | null,
    tiles: null as WebGLBuffer | null,
    media: null as WebGLBuffer | null,
    labels: null as WebGLBuffer | null,
  };
  private readonly tileCache = new Map<string, TileEntry>();
  private readonly labelCache = new Map<string, LabelEntry>();
  private readonly spriteCache = new Map<string, SpriteEntry>();
  private readonly mediaTextures = new Map<string, MediaEntry>();
  /** Per layer: tileKey -> URL of the previously drawn template. */
  private readonly heldTiles = new Map<string, Map<string, string>>();
  private scene: Scene | null = null;
  private plan: FramePlan | null = null;
  private rafHandle: number | null = null;
  private pickTarget: { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number } | null = null;
  private readonly pickStall = new PickStallRecorder('blocking');
  private destroyed = false;
  private lost = false;
  private lostListener: ((message: string) => void) | null = null;
  private frameCounter = 0;
  private dpr: number;
  private readonly highpFragment: boolean;
  /** Context loss stops rendering; the map replaces this backend (GPU-08/09). */
  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.noteLost('webgl context lost');
  };
  constructor(options: BackendInitOptions) {
    this.canvas = document.createElement('canvas');
    this.dpr = options.dpr;
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    options.container.appendChild(this.canvas);
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) {
      this.canvas.remove();
      throw new MapletError('gpu-unavailable', 'a WebGL 1 context could not be created');
    }
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.instanced = gl.getExtension('ANGLE_instanced_arrays');
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    this.highpFragment = (precision?.precision ?? 0) > 0;
    if (!this.highpFragment) {
      this.notes.push('fragment highp is unavailable; pick ids, dashes and shared uniforms fall back to mediump');
    }
    if (!this.instanced) {
      this.notes.push('ANGLE_instanced_arrays is unavailable; instances are expanded on the CPU');
    }
    this.resize(options.width, options.height);
  }

  attach(scene: Scene): void {
    this.scene = scene;
    scene.setPickStats(this.pickStall.snapshot());
  }

  onLost(listener: (message: string) => void): void {
    this.lostListener = listener;
  }

  simulateLoss(): void {
    if (this.destroyed || this.lost) return;
    const event =
      typeof WebGLContextEvent === 'function'
        ? new WebGLContextEvent('webglcontextlost', { cancelable: true, statusMessage: 'simulated loss' })
        : new Event('webglcontextlost', { cancelable: true });
    this.canvas.dispatchEvent(event);
  }

  private noteLost(message: string): void {
    if (this.destroyed || this.lost) return;
    this.lost = true;
    if (this.rafHandle !== null) {
      const cancel = (globalThis as { cancelAnimationFrame?: (id: number) => void })
        .cancelAnimationFrame;
      cancel?.(this.rafHandle);
      this.rafHandle = null;
    }
    this.lostListener?.(message);
  }

  resize(width: number, height: number): void {
    const deviceWidth = Math.max(1, Math.round(width * this.dpr));
    const deviceHeight = Math.max(1, Math.round(height * this.dpr));
    this.canvas.width = deviceWidth;
    this.canvas.height = deviceHeight;
  }

  requestFrame(scene: Scene): void {
    if (this.destroyed || this.lost || this.rafHandle !== null) return;
    const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
      .requestAnimationFrame;
    const run = (): void => {
      this.rafHandle = null;
      if (this.destroyed || this.lost) return;
      this.renderNow(scene);
    };
    if (raf) {
      this.rafHandle = raf(run);
    } else {
      this.rafHandle = setTimeout(run, 16) as unknown as number;
    }
  }

  dispose(): void {
    this.destroy();
  }

  private renderNow(scene: Scene): void {
    if (this.destroyed || this.lost) return;
    this.frameCounter++;
    const deviceWidth = this.canvas.width;
    const deviceHeight = this.canvas.height;
    if (deviceWidth === 0 || deviceHeight === 0) {
      scene.completeFrame();
      return;
    }
    this.plan = buildFramePlan(scene, {
      deviceWidth,
      deviceHeight,
      dpr: this.dpr,
    });
    this.evictTiles();
    this.evictLabels();
    this.evictSprites();
    this.evictMedia();
    this.frameDrawCalls = 0;
    this.drawPlan(this.plan, false);
    scene.setFrameStats({
      instances: this.plan.stats.instances,
      drawCalls: this.frameDrawCalls,
      gpuBytes: this.estimateGpuBytes(),
    });
    scene.completeFrame();
  }

  private estimateGpuBytes(): number {
    let bytes = 0;
    for (const entry of this.tileCache.values()) {
      if (entry.state === 'ready') bytes += 256 * 256 * 4;
    }
    for (const entry of this.mediaTextures.values()) {
      if (entry.texture) bytes += entry.width * entry.height * 4;
    }
    for (const entry of this.labelCache.values()) {
      bytes += entry.canvas.width * entry.canvas.height * 4;
    }
    for (const entry of this.spriteCache.values()) {
      bytes += Math.round(entry.width * this.dpr) * Math.round(entry.height * this.dpr) * 4;
    }
    for (const entry of this.batchBuffers.values()) bytes += entry.bytes;
    return bytes;
  }

  private drawPlan(plan: FramePlan, pickMode: boolean): void {
    this.pruneBatchBuffers(plan);
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (pickMode) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    for (const draw of plan.draws) {
      if (draw.type === 'tiles') {
        this.drawTiles(draw.tiles, pickMode);
        continue;
      }
      if (draw.type === 'media') {
        this.drawMedia(draw.media, pickMode);
        continue;
      }
      if (draw.type === 'labels') {
        this.drawLabels(draw.labels, pickMode);
        continue;
      }
      if (draw.type === 'sprites') {
        this.drawSprites(draw.sprites, pickMode);
        continue;
      }
      const batch = draw.batch;
      if (batch.kind === 'points') this.drawPoints(batch, pickMode);
      else if (batch.kind === 'lines') this.drawLines(batch, pickMode, batch.dash ?? null);
      else this.drawFills(batch, pickMode);
    }
  }

  /* ------------------------------ programs -------------------------------- */

  private compile(name: string, vertex: string, fragment: string, attribs: string[], uniforms: string[]): ProgramBundle {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new MapletError('render-failed', 'shader allocation failed');
      let effective = source;
      if (!this.highpFragment) {
        if (type === gl.FRAGMENT_SHADER) {
          effective = effective.replaceAll('precision highp float;', 'precision mediump float;');
        }
        // GLSL ES 1.0 requires a varying's and a uniform's precision to match
        // between the vertex and fragment stage. With a mediump fragment
        // default (no highp support) both stages must declare every shared
        // varying and float uniform as mediump explicitly; the vertex stage
        // keeps highp for its own math, so only the declarations change.
        effective = effective.replace(
          /\bvarying\s+(vec[234]|float|mat[234])\s+(\w+)\s*;/g,
          'varying mediump $1 $2;',
        );
        effective = effective.replace(
          /\buniform\s+(float|vec[234]|mat[234])\s+(\w+)(\s*\[\s*\d+\s*\])?\s*;/g,
          'uniform mediump $1 $2$3;',
        );
      }
      gl.shaderSource(shader, effective);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        fail('render-failed', `${name} shader did not compile`, { log: log ?? '' });
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vertex);
    const fs = compile(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    if (!program) throw new MapletError('render-failed', 'program allocation failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      fail('render-failed', `${name} program did not link`, { log: log ?? '' });
    }
    const bundle: ProgramBundle = { program, attribs: {}, uniforms: {} };
    for (const attrib of attribs) {
      bundle.attribs[attrib] = gl.getAttribLocation(program, attrib);
    }
    for (const uniform of uniforms) {
      bundle.uniforms[uniform] = gl.getUniformLocation(program, uniform);
    }
    this.programs.set(name, bundle);
    return bundle;
  }

  private program(name: string): ProgramBundle {
    const existing = this.programs.get(name);
    if (existing) return existing;
    switch (name) {
      case 'points':
        return this.compile(
          'points',
          POINT_VERTEX,
          POINT_FRAGMENT,
          ['aCorner', 'aPos', 'aFill', 'aStroke', 'aMeta'],
          ['uViewport', 'uDpr', 'uPickMode', 'uOffset', 'uPickBase'],
        );
      case 'lines':
        return this.compile(
          'lines',
          LINE_VERTEX,
          LINE_FRAGMENT,
          ['aCorner', 'aSeg', 'aLine', 'aFill'],
          ['uViewport', 'uDpr', 'uPickMode', 'uDashCount', 'uDashPattern[0]', 'uDashOffset'],
        );
      case 'fills':
        return this.compile('fills', FILL_VERTEX, FILL_FRAGMENT, ['aPos', 'aFill', 'aMeta'], ['uViewport', 'uDpr', 'uPickMode']);
      case 'raster':
        return this.compile('raster', RASTER_VERTEX, RASTER_FRAGMENT, ['aPos', 'aUV', 'aPick'], [
          'uViewport',
          'uDpr',
          'uTexture',
          'uPickMode',
        ]);
      case 'labels':
        return this.compile(
          'labels',
          LABEL_VERTEX,
          LABEL_FRAGMENT,
          ['aPos', 'aUV', 'aFill', 'aMeta'],
          ['uViewport', 'uDpr', 'uPickMode', 'uTexture', 'uPickThreshold'],
        );
      default:
        throw new MapletError('render-failed', `unknown program: ${name}`);
    }
  }

  private ensureBuffer(name: keyof WebGl1Backend['buffers']): WebGLBuffer {
    const existing = this.buffers[name];
    if (existing) return existing;
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new MapletError('render-failed', 'buffer allocation failed');
    this.buffers[name] = buffer;
    if (name === 'quad' || name === 'tri') {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, name === 'quad' ? CORNERS_QUAD : CORNERS_TRI, this.gl.STATIC_DRAW);
    }
    return buffer;
  }

  private pruneBatchBuffers(plan: FramePlan): void {
    const live = new Set(plan.draws.flatMap((draw) => draw.type === 'batch' ? [draw.batch.data] : []));
    let attributesDisabled = false;
    for (const [data, entry] of this.batchBuffers) {
      if (live.has(data)) continue;
      if (!attributesDisabled) {
        // Deleting a buffer unbinds its attribute pointers. WebGL validates even
        // enabled attributes unused by the next shader; each draw rebinds its own.
        const max = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS) as number;
        for (let i = 0; i < max; i++) this.gl.disableVertexAttribArray(i);
        attributesDisabled = true;
      }
      this.gl.deleteBuffer(entry.buffer);
      this.batchBuffers.delete(data);
    }
  }

  /** Buffers belong to batches, not the draw scratch area; unchanged data stays resident. */
  private bindBatchBuffer(batch: PlanBatch, corners?: Float32Array): void {
    const gl = this.gl;
    const version = batch.upload?.version ?? 0;
    let entry = this.batchBuffers.get(batch.data);
    if (!entry) {
      const buffer = gl.createBuffer();
      if (!buffer) throw new MapletError('render-failed', 'buffer allocation failed');
      entry = { buffer, version: -1, bytes: 0 };
      this.batchBuffers.set(batch.data, entry);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    if (entry.version === version) return;
    const stride = batch.kind === 'fills' ? FILL_STRIDE : POINT_STRIDE;
    if (batch.upload && entry.version >= 0 && entry.version === batch.upload.previousVersion) {
      for (const { start, end } of batch.upload.ranges) {
        const slice = batch.data.subarray(start, end);
        const data = corners ? expandInstances(slice, stride, slice.length / stride, corners, 2) : slice;
        const offset = corners ? start / stride * 6 * (stride + 2) * 4 : start * 4;
        gl.bufferSubData(gl.ARRAY_BUFFER, offset, data);
      }
    } else {
      const data = corners ? expandInstances(batch.data, stride, batch.count, corners, 2) : batch.data;
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      entry.bytes = data.byteLength;
    }
    entry.version = version;
  }

  /**
   * Actual GPU draw submissions of the current frame (used by `map.stats()`):
   * a texture group is one submission, so 500 sprites on one asset are one.
   */
  private frameDrawCalls = 0;

  private submitDrawArrays(mode: number, first: number, count: number): void {
    this.frameDrawCalls++;
    this.gl.drawArrays(mode, first, count);
  }

  private setViewportUniforms(bundle: ProgramBundle, pickMode: boolean): void {
    const gl = this.gl;
    gl.uniform2f(bundle.uniforms['uViewport']!, this.canvas.width, this.canvas.height);
    gl.uniform1f(bundle.uniforms['uDpr']!, this.dpr);
    if (bundle.uniforms['uPickMode']) gl.uniform1f(bundle.uniforms['uPickMode']!, pickMode ? 1 : 0);
  }

  /* ------------------------------- points --------------------------------- */

  private drawPoints(batch: PlanBatch, pickMode: boolean): void {
    const { count } = batch;
    if (count === 0) return;
    const gl = this.gl;
    const bundle = this.program('points');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    gl.uniform2f(bundle.uniforms['uOffset']!, batch.offsetX ?? 0, batch.offsetY ?? 0);
    gl.uniform1f(bundle.uniforms['uPickBase']!, batch.pickBase ?? 0);
    const corner = this.ensureBuffer('quad');

    const bindInstanceAttribs = (stride: number, byteOffsetBase: number, divisor: number): void => {
      const layout = [
        ['aPos', 0],
        ['aFill', 16],
        ['aStroke', 32],
        ['aMeta', 48],
      ] as const;
      for (const [name, offset] of layout) {
        const location = bundle.attribs[name]!;
        if (location < 0) continue;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, byteOffsetBase + offset);
        if (this.instanced) this.instanced.vertexAttribDivisorANGLE(location, divisor);
      }
    };

    if (this.instanced) {
      gl.bindBuffer(gl.ARRAY_BUFFER, corner);
      const cornerLocation = bundle.attribs['aCorner']!;
      if (cornerLocation >= 0) {
        gl.enableVertexAttribArray(cornerLocation);
        gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);
        this.instanced.vertexAttribDivisorANGLE(cornerLocation, 0);
      }

      this.bindBatchBuffer(batch);
      bindInstanceAttribs(POINT_STRIDE * 4, 0, 1);
      this.frameDrawCalls++;
      this.instanced.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, count);
      this.resetAllDivisors();
      return;
    }

    // CPU expansion: corner + instance attributes per vertex.
    this.bindBatchBuffer(batch, CORNERS_QUAD_TRI);
    const strideBytes = (2 + POINT_STRIDE) * 4;
    const cornerLocation = bundle.attribs['aCorner']!;
    gl.enableVertexAttribArray(cornerLocation);
    gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, strideBytes, 0);
    const layout = [
      ['aPos', 2],
      ['aFill', 6],
      ['aStroke', 10],
      ['aMeta', 14],
    ] as const;
    for (const [name, floatOffset] of layout) {
      const location = bundle.attribs[name]!;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, strideBytes, floatOffset * 4);
    }
    this.submitDrawArrays(gl.TRIANGLES, 0, count * 6);
  }

  private resetAllDivisors(): void {
    if (!this.instanced) return;
    const max = this.gl.getParameter(this.gl.MAX_VERTEX_ATTRIBS) as number;
    for (let i = 0; i < max; i++) {
      this.instanced.vertexAttribDivisorANGLE(i, 0);
    }
  }

  /* -------------------------------- lines --------------------------------- */

  private drawLines(
    batch: PlanBatch,
    pickMode: boolean,
    dash: readonly number[] | null,
  ): void {
    const { count } = batch;
    if (count === 0) return;
    const gl = this.gl;
    const bundle = this.program('lines');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    const dashArray = dash ? dash.slice(0, 8) : [];
    gl.uniform1f(bundle.uniforms['uDashCount']!, dashArray.length);
    if (dashArray.length > 0) {
      // The shader keeps dashAlpha() == 1 while uDashCount < 0.5, so an empty
      // pattern must not be uploaded (uniform1fv rejects zero-length arrays).
      gl.uniform1fv(bundle.uniforms['uDashPattern[0]']!, new Float32Array(dashArray));
    }
    gl.uniform1f(bundle.uniforms['uDashOffset']!, 0);
    const corner = this.ensureBuffer('tri');

    if (this.instanced) {
      gl.bindBuffer(gl.ARRAY_BUFFER, corner);
      const cornerLocation = bundle.attribs['aCorner']!;
      if (cornerLocation >= 0) {
        gl.enableVertexAttribArray(cornerLocation);
        gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, 0, 0);
        this.instanced.vertexAttribDivisorANGLE(cornerLocation, 0);
      }

      this.bindBatchBuffer(batch);
      const layout = [
        ['aSeg', 0],
        ['aLine', 16],
        ['aFill', 32],
      ] as const;
      for (const [name, offset] of layout) {
        const location = bundle.attribs[name]!;
        if (location < 0) continue;
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, 4, gl.FLOAT, false, LINE_STRIDE * 4, offset);
        this.instanced.vertexAttribDivisorANGLE(location, 1);
      }
      this.frameDrawCalls++;
      this.instanced.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, count);
      this.resetAllDivisors();
      return;
    }

    this.bindBatchBuffer(batch, CORNERS_TRI);
    const strideBytes = (2 + LINE_STRIDE) * 4;
    const cornerLocation = bundle.attribs['aCorner']!;
    gl.enableVertexAttribArray(cornerLocation);
    gl.vertexAttribPointer(cornerLocation, 2, gl.FLOAT, false, strideBytes, 0);
    const layout = [
      ['aSeg', 2],
      ['aLine', 6],
      ['aFill', 10],
    ] as const;
    for (const [name, floatOffset] of layout) {
      const location = bundle.attribs[name]!;
      if (location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, strideBytes, floatOffset * 4);
    }
    this.submitDrawArrays(gl.TRIANGLES, 0, count * 6);
  }

  /* -------------------------------- fills --------------------------------- */

  private drawFills(batch: PlanBatch, pickMode: boolean): void {
    const vertexCount = batch.count;
    if (vertexCount === 0) return;
    const gl = this.gl;
    const bundle = this.program('fills');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    this.bindBatchBuffer(batch);
    const strideBytes = FILL_STRIDE * 4;
    const layout = [
      ['aPos', 0],
      ['aFill', 16],
      ['aMeta', 32],
    ] as const;
    for (const [name, offset] of layout) {
      const location = bundle.attribs[name]!;
      if (location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, strideBytes, offset);
    }
    this.submitDrawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  /* -------------------------------- tiles --------------------------------- */

  /**
   * Loads a tile through an `HTMLImageElement`, which decodes PNG/JPEG/WebP and
   * standalone SVG alike (SVG tiles need `width`/`height` or `viewBox` so the
   * decoded image has an intrinsic size). `crossOrigin = 'anonymous'` keeps the
   * texture CORS-clean for `texImage2D`; a server without `Access-Control-Allow-
   * Origin` therefore surfaces as a load error instead of a silent blank tile
   * (RASTER-08).
   */
  private tileEntry(url: string): TileEntry {
    let entry = this.tileCache.get(url);
    if (entry) return entry;
    entry = { state: 'loading', texture: null, image: null, lastUsed: this.frameCounter };
    this.tileCache.set(url, entry);
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (this.destroyed) return;
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        // Decoded without an intrinsic size (e.g. an SVG missing both width and
        // viewBox); texImage2D would throw, so report it as a decode error.
        entry!.state = 'error';
        return;
      }
      entry!.state = 'ready';
      entry!.image = image;
      this.scene?.requestFrame();
    };
    image.onerror = () => {
      entry!.state = 'error';
    };
    image.src = url;
    entry.image = image;
    return entry;
  }

  /** Binds (and lazily uploads) the texture of a decoded tile entry. */
  private bindTileTexture(entry: TileEntry): boolean {
    const gl = this.gl;
    if (!entry.texture) {
      if (!entry.image) return false;
      entry.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.image);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    }
    return true;
  }

  /**
   * Draws one layer's tile placements. A tile that is not decoded yet is
   * substituted by the nearest decoded ancestor (`fallbacks`, scaled up) or by
   * decoded children after a zoom-out, so loading never flashes blank. While a
   * URL change keeps the same tile set (provider switch, WMS params), the
   * previous bitmaps stay visible until their replacements decode.
   *
   * In the pick pass the same displayed area is drawn with the source's pick
   * record, so an interactive bitmap's hit surface always matches what is on
   * screen (WMS-06); non-interactive layers are skipped.
   */
  private drawTiles(
    tiles: readonly import('./../frame-plan.ts').TilePlacement[],
    pickMode: boolean,
  ): void {
    if (tiles.length === 0) return;
    const gl = this.gl;
    const bundle = this.program('raster');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    gl.uniform1i(bundle.uniforms['uTexture']!, 0);
    gl.activeTexture(gl.TEXTURE0);

    const pushQuad = (
      data: number[],
      batch: { entry: TileEntry }[],
      entry: TileEntry,
      x: number,
      y: number,
      width: number,
      height: number,
      u0: number,
      v0: number,
      u1: number,
      v1: number,
      opacity: number,
      pick: number,
      flag: number,
    ): void => {
      data.push(
        x, y, 0, 0, u0, v0, opacity, 0, pick, flag, 0, 0,
        x + width, y, 0, 0, u1, v0, opacity, 0, pick, flag, 0, 0,
        x, y + height, 0, 0, u0, v1, opacity, 0, pick, flag, 0, 0,
        x + width, y, 0, 0, u1, v0, opacity, 0, pick, flag, 0, 0,
        x + width, y + height, 0, 0, u1, v1, opacity, 0, pick, flag, 0, 0,
        x, y + height, 0, 0, u0, v1, opacity, 0, pick, flag, 0, 0,
      );
      batch.push({ entry });
    };
    const resolve = (url: string): TileEntry => {
      const entry = this.tileEntry(url);
      entry.lastUsed = this.frameCounter;
      return entry;
    };

    const vertexData: number[] = [];
    const draws: { entry: TileEntry }[] = [];
    // All placements of a tiles draw belong to one layer.
    const layerId = tiles[0]!.layerId;
    const held = this.heldTiles.get(layerId);
    let allReady = true;
    for (const tile of tiles) {
      if (pickMode && tile.pickIndex === undefined) continue;
      const pick = tile.pickIndex ?? 0;
      const flag = tile.pickIndex === undefined ? 0 : 1;
      const entry = resolve(tile.url);
      if (entry.state === 'ready') {
        pushQuad(vertexData, draws, entry, tile.sx, tile.sy, tile.sw, tile.sh, 0, 0, 1, 1, tile.opacity, pick, flag);
        continue;
      }
      allReady = false;
      let filled = false;
      for (const fallback of tile.fallbacks) {
        const ancestor = resolve(fallback.url);
        if (ancestor.state !== 'ready') continue;
        pushQuad(
          vertexData,
          draws,
          ancestor,
          tile.sx,
          tile.sy,
          tile.sw,
          tile.sh,
          fallback.u0,
          fallback.v0,
          fallback.u1,
          fallback.v1,
          tile.opacity,
          pick,
          flag,
        );
        filled = true;
        break;
      }
      if (!filled && tile.children) {
        const halfWidth = tile.sw / 2;
        const halfHeight = tile.sh / 2;
        for (let index = 0; index < 4; index++) {
          const child = resolve(tile.children[index]!);
          if (child.state !== 'ready') continue;
          pushQuad(
            vertexData,
            draws,
            child,
            tile.sx + (index % 2) * halfWidth,
            tile.sy + (index >= 2 ? 1 : 0) * halfHeight,
            halfWidth,
            halfHeight,
            0,
            0,
            1,
            1,
            tile.opacity,
            pick,
            flag,
          );
          filled = true;
        }
      }
      if (filled) continue;
      // Last resort after a URL change: the same tile from the previous
      // template (provider switch, WMS params). It is drawn instead of - never
      // underneath - the replacement, so partially loaded views have no ghost.
      const heldUrl = held?.get(tile.tileKey);
      if (heldUrl) {
        const heldEntry = this.tileCache.get(heldUrl);
        if (heldEntry && heldEntry.state === 'ready') {
          heldEntry.lastUsed = this.frameCounter;
          pushQuad(vertexData, draws, heldEntry, tile.sx, tile.sy, tile.sw, tile.sh, 0, 0, 1, 1, tile.opacity, pick, flag);
        }
      }
    }
    if (allReady) {
      this.heldTiles.set(layerId, new Map(tiles.map((tile) => [tile.tileKey, tile.url])));
    } else if (!held) {
      // First population: a later URL change can fall back to this template.
      this.heldTiles.set(layerId, new Map(tiles.map((tile) => [tile.tileKey, tile.url])));
    }

    if (vertexData.length === 0) return;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ensureBuffer('tiles'));
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(vertexData), gl.STREAM_DRAW);
    const strideBytes = RASTER_STRIDE * 4;
    const posLocation = bundle.attribs['aPos']!;
    gl.enableVertexAttribArray(posLocation);
    gl.vertexAttribPointer(posLocation, 4, gl.FLOAT, false, strideBytes, 0);
    const uvLocation = bundle.attribs['aUV']!;
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 4, gl.FLOAT, false, strideBytes, 16);
    const pickLocation = bundle.attribs['aPick']!;
    gl.enableVertexAttribArray(pickLocation);
    gl.vertexAttribPointer(pickLocation, 4, gl.FLOAT, false, strideBytes, 32);
    // One draw call per texture; tiles sharing a texture stay separate.
    let offset = 0;
    for (const { entry } of draws) {
      if (this.bindTileTexture(entry)) this.submitDrawArrays(gl.TRIANGLES, offset, 6);
      offset += 6;
    }
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private evictTiles(): void {
    if (this.tileCache.size <= MAX_TILES) return;
    const entries = Array.from(this.tileCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = this.tileCache.size - MAX_TILES;
    for (let i = 0; i < removeCount; i++) {
      const [url, entry] = entries[i]!;
      if (url === undefined || !entry) continue;
      if (entry.texture) this.gl.deleteTexture(entry.texture);
      this.tileCache.delete(url);
    }
  }

  /* --------------------------------- media --------------------------------- */

  private mediaEntry(sourceId: string): MediaEntry {
    let entry = this.mediaTextures.get(sourceId);
    if (!entry) {
      entry = { texture: null, element: null, width: 0, height: 0, pixelVersion: -1, lastUsed: this.frameCounter };
      this.mediaTextures.set(sourceId, entry);
    }
    return entry;
  }

  /**
   * Uploads the current bitmap of a media source. A new element identity or a
   * size change forces a full upload; region updates go through
   * `texSubImage2D` with only the changed rectangles (MEDIA-03), video frames
   * and URL images are uploaded whole (MEDIA-05). The texture stays
   * premultiplied, matching the raster program's blend mode.
   */
  private uploadMedia(entry: MediaEntry, source: MediaSourceImpl): boolean {
    const gl = this.gl;
    const element = source.element;
    if (!element || source.width === 0 || source.height === 0) return false;
    const created = entry.texture === null;
    if (!entry.texture) entry.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    const full =
      created || entry.element !== element || entry.width !== source.width || entry.height !== source.height;
    if (full) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      entry.element = element;
      entry.width = source.width;
      entry.height = source.height;
      entry.pixelVersion = source.pixelVersion;
      source.takeDirtyRegions();
      return true;
    }
    if (entry.pixelVersion !== source.pixelVersion) {
      const regions = source.takeDirtyRegions();
      let updated = false;
      // `texSubImage2D` with a typed array ignores UNPACK_PREMULTIPLY_ALPHA_WEBGL,
      // so the region rows arrive already premultiplied (`regionPixels`).
      for (const region of regions) {
        const pixels = source.regionPixels(region);
        if (!pixels) break;
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          region.x,
          region.y,
          region.width,
          region.height,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels,
        );
        updated = true;
      }
      if (!updated) {
        // No writable pixel store (a video frame, or a plain URL image).
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
      entry.pixelVersion = source.pixelVersion;
    }
    return true;
  }

  /**
   * Draws media quads (image/video in bounds) in plan order, so their stacking
   * against tiles and vectors follows the layer order (MEDIA-01). In pick mode
   * each interactive quad is one pick record for the whole media source.
   */
  private drawMedia(media: readonly MediaPlacement[], pickMode: boolean): void {
    if (media.length === 0) return;
    const gl = this.gl;
    const bundle = this.program('raster');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    gl.uniform1i(bundle.uniforms['uTexture']!, 0);
    gl.activeTexture(gl.TEXTURE0);

    const pushQuad = (
      data: number[],
      x: number,
      y: number,
      width: number,
      height: number,
      opacity: number,
      pick: number,
      flag: number,
    ): void => {
      data.push(
        x, y, 0, 0, 0, 0, opacity, 0, pick, flag, 0, 0,
        x + width, y, 0, 0, 1, 0, opacity, 0, pick, flag, 0, 0,
        x, y + height, 0, 0, 0, 1, opacity, 0, pick, flag, 0, 0,
        x + width, y, 0, 0, 1, 0, opacity, 0, pick, flag, 0, 0,
        x + width, y + height, 0, 0, 1, 1, opacity, 0, pick, flag, 0, 0,
        x, y + height, 0, 0, 0, 1, opacity, 0, pick, flag, 0, 0,
      );
    };

    const vertexData: number[] = [];
    const draws: { entry: MediaEntry; run: number }[] = [];
    for (const placement of media) {
      const source = this.scene?.getMediaSource(placement.sourceId);
      if (!source) continue;
      if (pickMode && placement.pickIndex === undefined) continue;
      // The pick pass keeps the same textured draw as the colour pass; only the
      // fragment branch differs. Binding a complete texture keeps the two
      // passes independent of leftover texture state.
      const entry = this.mediaEntry(placement.sourceId);
      entry.lastUsed = this.frameCounter;
      if (!this.uploadMedia(entry, source)) continue;
      pushQuad(
        vertexData,
        placement.sx,
        placement.sy,
        placement.sw,
        placement.sh,
        placement.opacity,
        placement.pickIndex ?? 0,
        placement.pickIndex === undefined ? 0 : 1,
      );
      const last = draws[draws.length - 1];
      if (last && last.entry === entry) last.run++;
      else draws.push({ entry, run: 1 });
    }
    if (vertexData.length === 0) return;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ensureBuffer('media'));
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(vertexData), gl.STREAM_DRAW);
    const strideBytes = RASTER_STRIDE * 4;
    const posLocation = bundle.attribs['aPos']!;
    gl.enableVertexAttribArray(posLocation);
    gl.vertexAttribPointer(posLocation, 4, gl.FLOAT, false, strideBytes, 0);
    const uvLocation = bundle.attribs['aUV']!;
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 4, gl.FLOAT, false, strideBytes, 16);
    const pickLocation = bundle.attribs['aPick']!;
    gl.enableVertexAttribArray(pickLocation);
    gl.vertexAttribPointer(pickLocation, 4, gl.FLOAT, false, strideBytes, 32);
    let offset = 0;
    for (const { entry, run } of draws) {
      if (entry.texture) gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      this.submitDrawArrays(gl.TRIANGLES, offset, run * 6);
      offset += run * 6;
    }
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private evictMedia(): void {
    for (const [id, entry] of this.mediaTextures) {
      if (this.scene?.getMediaSource(id)) continue;
      if (entry.texture) this.gl.deleteTexture(entry.texture);
      this.mediaTextures.delete(id);
    }
    if (this.mediaTextures.size <= MAX_MEDIA) return;
    const entries = Array.from(this.mediaTextures.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = this.mediaTextures.size - MAX_MEDIA;
    for (let i = 0; i < removeCount; i++) {
      const [id, entry] = entries[i]!;
      if (entry.texture) this.gl.deleteTexture(entry.texture);
      this.mediaTextures.delete(id);
    }
  }

  /* -------------------------------- labels --------------------------------- */

  /**
   * Rasterizes one label into a glyph-atlas page (white, so the fragment tints
   * it). Evicted pages are reconstructed by this same call (TEXT-08); DPR keeps
   * glyphs crisp without a second layout pass (TEXT-02).
   */
  private labelEntry(
    text: string,
    sizePx: number,
    fontFamily: string,
    direction: 'ltr' | 'rtl' | 'auto',
  ): LabelEntry {
    // The font signature is part of the key: when a registered font becomes
    // ready (or fails), the entry is recreated instead of reusing a stale
    // rasterization from the fallback face (TEXT-05).
    const fontSignature = this.scene?.fontSignature(fontFamily) ?? 'system';
    const key = `${text}|${sizePx}|${fontFamily}|${direction}|${fontSignature}`;
    const existing = this.labelCache.get(key);
    if (existing) return existing;
    const scale = this.dpr;
    const deviceSize = Math.max(1, sizePx * scale);
    const font = `${deviceSize}px ${fontFamily}`;
    const canvas = document.createElement('canvas');
    if (direction === 'auto') canvas.dir = 'auto';
    const context = canvas.getContext('2d');
    let width = Math.max(1, Math.ceil(deviceSize * text.length * 0.6) + 4);
    let height = Math.max(1, Math.ceil(deviceSize * 1.35));
    if (context) {
      context.font = font;
      context.direction = direction === 'rtl' ? 'rtl' : direction === 'auto' ? 'inherit' : 'ltr';
      context.textAlign = 'left';
      if ('fontKerning' in context) context.fontKerning = 'normal';
      width = Math.max(1, Math.ceil(context.measureText(text).width) + Math.ceil(2 * scale));
    }
    canvas.width = width;
    canvas.height = height;
    if (context) {
      context.font = font;
      context.direction = direction === 'rtl' ? 'rtl' : direction === 'auto' ? 'inherit' : 'ltr';
      context.textAlign = 'left';
      if ('fontKerning' in context) context.fontKerning = 'normal';
      context.textBaseline = 'middle';
      context.fillStyle = '#ffffff';
      context.fillText(text, Math.ceil(scale), Math.round(height / 2));
    }
    const entry: LabelEntry = {
      canvas,
      texture: null,
      cssWidth: width / scale,
      cssHeight: height / scale,
      lastUsed: this.frameCounter,
    };
    this.labelCache.set(key, entry);
    return entry;
  }

  private bindLabelTexture(entry: LabelEntry): boolean {
    const gl = this.gl;
    if (!entry.texture) {
      entry.texture = gl.createTexture();
      if (!entry.texture) return false;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    }
    return true;
  }

  private drawLabels(labels: readonly import('./../frame-plan.ts').LabelPlacement[], pickMode: boolean): void {
    if (labels.length === 0) return;
    const gl = this.gl;
    const bundle = this.program('labels');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    gl.uniform1i(bundle.uniforms['uTexture']!, 0);
    gl.uniform1f(bundle.uniforms['uPickThreshold']!, 0.02);
    gl.activeTexture(gl.TEXTURE0);
    const data: number[] = [];
    const batch: { entry: LabelEntry }[] = [];
    const drawnRects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const label of labels) {
      const entry = this.labelEntry(label.text, label.sizePx, label.fontFamily, label.direction);
      entry.lastUsed = this.frameCounter;
      const width = entry.cssWidth;
      const height = entry.cssHeight;
      const vertices = quadVertices(
        label.sx + label.offsetX,
        label.sy + label.offsetY,
        width,
        height,
        label.rotate,
      );
      if (label.collision && !pickMode) {
        const rect = quadBounds(vertices);
        const overlaps = drawnRects.some(
          (other) =>
            !(rect.x1 <= other.x0 || rect.x0 >= other.x1 || rect.y1 <= other.y0 || rect.y0 >= other.y1),
        );
        if (overlaps) continue;
        drawnRects.push(rect);
      }
      const opacity = label.color[3];
      const push = (px: number, py: number, u: number, v: number): void => {
        data.push(
          px, py, 0, 0, u, v, 0, 0,
          label.color[0], label.color[1], label.color[2], opacity,
          label.pickIndex, label.interactive ? 1 : 0, 0, 0,
        );
      };
      for (let index = 0; index < 6; index++) {
        push(vertices[index * 2]!, vertices[index * 2 + 1]!, QUAD_UVS[index]![0], QUAD_UVS[index]![1]);
      }
      batch.push({ entry });
    }
    if (data.length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ensureBuffer('labels'));
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(data), gl.STREAM_DRAW);
    const strideBytes = 16 * 4;
    const layout = [
      ['aPos', 0],
      ['aUV', 16],
      ['aFill', 32],
      ['aMeta', 48],
    ] as const;
    for (const [name, offset] of layout) {
      const location = bundle.attribs[name]!;
      if (location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, strideBytes, offset);
    }
    for (const { entry } of batch) this.bindLabelTexture(entry);
    // One draw call per atlas-page run (repeated labels share a page).
    let offset = 0;
    let index = 0;
    while (index < batch.length) {
      const entry = batch[index]!.entry;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      let run = 0;
      while (index < batch.length && batch[index]!.entry === entry) {
        index++;
        run++;
      }
      this.submitDrawArrays(gl.TRIANGLES, offset, run * 6);
      offset += run * 6;
    }
  }

  /** Bounded glyph atlas: least-recently-used pages are reconstructible (TEXT-08). */
  private evictLabels(): void {
    if (this.labelCache.size <= MAX_LABELS) return;
    const entries = Array.from(this.labelCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = this.labelCache.size - MAX_LABELS;
    for (let i = 0; i < removeCount; i++) {
      const [key, entry] = entries[i]!;
      if (key === undefined || !entry) continue;
      if (entry.texture) this.gl.deleteTexture(entry.texture);
      this.labelCache.delete(key);
    }
  }

  /* -------------------------------- sprites -------------------------------- */

  /**
   * One GPU texture per registered asset shared by all of its instances
   * (MEDIA-07: hundreds of sprites, one texture, no DOM element per icon).
   */
  private spriteEntry(assetId: string): SpriteEntry | null {
    const asset = this.scene?.assets.get(assetId);
    if (!asset || asset.state !== 'ready' || !asset.image) return null;
    const existing = this.spriteCache.get(assetId);
    if (existing && existing.assetVersion === asset.version) return existing;
    if (existing) this.gl.deleteTexture(existing.texture);
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, asset.image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const entry: SpriteEntry = {
      assetVersion: asset.version,
      texture,
      width: asset.image.naturalWidth / this.dpr,
      height: asset.image.naturalHeight / this.dpr,
      lastUsed: this.frameCounter,
    };
    this.spriteCache.set(assetId, entry);
    return entry;
  }

  private drawSprites(sprites: readonly import('./../frame-plan.ts').SpritePlacement[], pickMode: boolean): void {
    if (sprites.length === 0) return;
    const gl = this.gl;
    const bundle = this.program('labels');
    gl.useProgram(bundle.program);
    this.setViewportUniforms(bundle, pickMode);
    gl.uniform1i(bundle.uniforms['uTexture']!, 0);
    // Transparent icon areas (< 50% alpha) are not interactive hits (PICK-05).
    gl.uniform1f(bundle.uniforms['uPickThreshold']!, 0.5);
    gl.activeTexture(gl.TEXTURE0);
    const data: number[] = [];
    const batch: { entry: SpriteEntry }[] = [];
    for (const sprite of sprites) {
      const entry = this.spriteEntry(sprite.assetId);
      if (!entry) continue;
      entry.lastUsed = this.frameCounter;
      const width = sprite.sizePx > 0 ? sprite.sizePx : entry.width;
      const height = sprite.sizePx > 0 ? sprite.sizePx : entry.height;
      const vertices = quadVertices(
        sprite.sx + sprite.offsetX,
        sprite.sy + sprite.offsetY,
        width,
        height,
        sprite.rotate,
        sprite.sx,
        sprite.sy,
      );
      const opacity = sprite.opacity;
      const push = (px: number, py: number, u: number, v: number): void => {
        data.push(
          px, py, 0, 0, u, v, 0, 0,
          1, 1, 1, opacity,
          sprite.pickIndex, sprite.interactive ? 1 : 0, 0, 0,
        );
      };
      for (let index = 0; index < 6; index++) {
        push(vertices[index * 2]!, vertices[index * 2 + 1]!, QUAD_UVS[index]![0], QUAD_UVS[index]![1]);
      }
      batch.push({ entry });
    }
    if (data.length === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ensureBuffer('labels'));
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(data), gl.STREAM_DRAW);
    const strideBytes = 16 * 4;
    const layout = [
      ['aPos', 0],
      ['aUV', 16],
      ['aFill', 32],
      ['aMeta', 48],
    ] as const;
    for (const [name, offset] of layout) {
      const location = bundle.attribs[name]!;
      if (location < 0) continue;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, strideBytes, offset);
    }
    // One draw call per texture run: hundreds of instances of one asset are a
    // single submission (MEDIA-07).
    let offset = 0;
    let index = 0;
    while (index < batch.length) {
      const entry = batch[index]!.entry;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      let run = 0;
      while (index < batch.length && batch[index]!.entry === entry) {
        index++;
        run++;
      }
      this.submitDrawArrays(gl.TRIANGLES, offset, run * 6);
      offset += run * 6;
    }
  }

  /** Drops GPU copies of removed assets; reloads are handled by spriteEntry. */
  private evictSprites(): void {
    for (const [assetId, entry] of this.spriteCache) {
      const asset = this.scene?.assets.get(assetId);
      if (!asset || asset.state !== 'ready') {
        this.gl.deleteTexture(entry.texture);
        this.spriteCache.delete(assetId);
      }
    }
  }

  /* -------------------------------- picking ------------------------------- */

  private ensurePickTarget(): NonNullable<WebGl1Backend['pickTarget']> {
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (this.pickTarget && this.pickTarget.width === width && this.pickTarget.height === height) {
      return this.pickTarget;
    }
    const gl = this.gl;
    if (this.pickTarget) {
      gl.deleteFramebuffer(this.pickTarget.framebuffer);
      gl.deleteTexture(this.pickTarget.texture);
    }
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new MapletError('render-failed', 'pick target allocation failed');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new MapletError('render-failed', 'pick framebuffer is incomplete');
    }
    this.pickTarget = { framebuffer, texture, width, height };
    return this.pickTarget;
  }

  async pick(scene: Scene, point: ScreenPoint, options: { limit: number }): Promise<readonly PickResult[]> {
    if (this.destroyed) return [];
    if (this.lost) {
      fail('gpu-unavailable', 'the WebGL context was lost; the map replaces it automatically', {});
    }
    // PICK-12: the whole body below runs synchronously (no awaits), so this
    // span is exactly how long the caller's thread is blocked by the pick.
    const startedAt = monotonicNow();
    const plan = buildFramePlan(scene, {
      deviceWidth: this.canvas.width,
      deviceHeight: this.canvas.height,
      dpr: this.dpr,
    });
    this.plan = plan;
    const gl = this.gl;
    const target = this.ensurePickTarget();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    this.drawPlan(plan, true);
    const px = Math.round(point.x * this.dpr);
    // GL rows grow upwards and the point's pixel is `height - 1 - y`; using the
    // same left-top convention as `samplePixel` keeps both backends' pick
    // windows on the same CSS pixels (found by the parity battery).
    const py = this.canvas.height - 1 - Math.round(point.y * this.dpr);
    const radius = PICK_RADIUS * this.dpr;
    const x0 = Math.max(0, Math.floor(px - radius));
    const y0 = Math.max(0, Math.floor(py - radius));
    const w = Math.min(target.width - x0, Math.ceil(radius * 2 + 1));
    const h = Math.min(target.height - y0, Math.ceil(radius * 2 + 1));
    const pixels = new Uint8Array(Math.max(1, w) * Math.max(1, h) * 4);
    // readPixels forces the pick pass to finish and copies the pixels back on
    // the calling thread; measured separately from the rest of the pick.
    const readStartedAt = monotonicNow();
    gl.readPixels(x0, y0, Math.max(1, w), Math.max(1, h), gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const readMs = monotonicNow() - readStartedAt;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const results: PickResult[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      const a = pixels[i + 3]!;
      if (a === 0) continue;
      const index = r * 65536 + g * 256 + b;
      if (seen.has(index)) continue;
      seen.add(index);
      const entry = plan.pickTable.get(index);
      if (!entry) continue;
      const source = scene.getSourceImpl(entry.feature.sourceId);
      if (source) {
        const record = source.store.get(entry.feature.id, entry.feature.namespace);
        if (!record || record.generation !== entry.feature.generation) continue;
      } else if (
        !scene.getMediaSource(entry.feature.sourceId) &&
        !scene.getRasterSource(entry.feature.sourceId)
      ) {
        continue;
      }
      results.push({
        feature: entry.feature,
        layerId: entry.layerId,
        sourceId: entry.feature.sourceId,
        screen: point,
        revision: plan.revision,
      });
      if (results.length >= options.limit) break;
    }
    this.pickStall.record(monotonicNow() - startedAt, readMs);
    scene.setPickStats(this.pickStall.snapshot());
    return results;
  }

  /**
   * Diagnostics: renders one frame and reads the pixel at a CSS-pixel position.
   * Both axes use the same convention: pixel `(round(x), round(y))` with a
   * top-left origin (the GL row is flipped once, not twice).
   */
  async samplePixel(scene: Scene, point: ScreenPoint): Promise<{ r: number; g: number; b: number; a: number }> {
    if (this.destroyed) return { r: 0, g: 0, b: 0, a: 0 };
    if (this.lost) {
      fail('gpu-unavailable', 'the WebGL context was lost; the map replaces it automatically', {});
    }
    const gl = this.gl;
    const plan = buildFramePlan(scene, {
      deviceWidth: this.canvas.width,
      deviceHeight: this.canvas.height,
      dpr: this.dpr,
    });
    this.plan = plan;
    this.frameDrawCalls = 0;
    this.drawPlan(plan, false);
    const pixel = new Uint8Array(4);
    const x = Math.max(0, Math.min(this.canvas.width - 1, Math.round(point.x * this.dpr)));
    const y = Math.max(0, Math.min(this.canvas.height - 1, this.canvas.height - 1 - Math.round(point.y * this.dpr)));
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    // Re-render through the normal frame path so the compositor keeps a frame.
    this.drawPlan(plan, false);
    return { r: pixel[0]!, g: pixel[1]!, b: pixel[2]!, a: pixel[3]! };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lostListener = null;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    if (this.rafHandle !== null) {
      const cancel = (globalThis as { cancelAnimationFrame?: (id: number) => void })
        .cancelAnimationFrame;
      cancel?.(this.rafHandle);
      this.rafHandle = null;
    }
    const gl = this.gl;
    for (const entry of this.batchBuffers.values()) gl.deleteBuffer(entry.buffer);
    this.batchBuffers.clear();
    for (const bundle of this.programs.values()) gl.deleteProgram(bundle.program);
    for (const buffer of Object.values(this.buffers)) {
      if (buffer) gl.deleteBuffer(buffer);
    }
    for (const entry of this.tileCache.values()) {
      if (entry.texture) gl.deleteTexture(entry.texture);
    }
    this.tileCache.clear();
    this.heldTiles.clear();
    for (const entry of this.labelCache.values()) {
      if (entry.texture) gl.deleteTexture(entry.texture);
    }
    this.labelCache.clear();
    for (const entry of this.spriteCache.values()) gl.deleteTexture(entry.texture);
    this.spriteCache.clear();
    for (const entry of this.mediaTextures.values()) {
      if (entry.texture) gl.deleteTexture(entry.texture);
    }
    this.mediaTextures.clear();
    if (this.pickTarget) {
      gl.deleteFramebuffer(this.pickTarget.framebuffer);
      gl.deleteTexture(this.pickTarget.texture);
    }
    this.canvas.remove();
  }
}

/** Expands instance data into per-vertex data for the extension-less GL path. */
export function expandInstances(
  data: Float32Array,
  stride: number,
  count: number,
  corners: Float32Array,
  cornerSize: number,
): Float32Array {
  const verticesPerInstance = corners.length / cornerSize;
  const outStride = cornerSize + stride;
  const out = new Float32Array(count * verticesPerInstance * outStride);
  let o = 0;
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    for (let v = 0; v < verticesPerInstance; v++) {
      out.set(corners.subarray(v * cornerSize, (v + 1) * cornerSize), o);
      out.set(data.subarray(base, base + stride), o + cornerSize);
      o += outStride;
    }
  }
  return out;
}

export { FLAG_INTERACTIVE };
