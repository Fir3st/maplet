/**
 * WebGPU backend.
 *
 * Same frame plan, identity, style and picking contract as the WebGL 1 backend
 * (plan: "Backendová hranice zahrnuje skutečné rozdíly"): only device creation,
 * resources, pipelines, render passes and readback differ.
 *
 * - WGSL ports of the GLSL ES shaders keep the fragment-shader anti-aliasing and
 *   the pick encoding identical, so the same scene renders the same pixels
 *   (GPU-01);
 * - instances use hardware `stepMode: 'instance'` vertex buffers (no CPU
 *   expansion needed);
 * - picking and `debug.samplePixel` render into offscreen textures and read a
 *   small region back, mirroring the WebGL 1 path;
 * - tile/glyph/sprite textures are uploaded with the same premultiplication and
 *   blending rules as WebGL 1.
 */

import { fail, MapletError } from './../../api/errors.ts';
import type { ScreenPoint } from './../../api/types.ts';
import type { Scene } from './../../scene/scene.ts';
import type { MediaElement, MediaSourceImpl } from './../../scene/media-source.ts';
import {
  buildFramePlan,
  releaseFramePlan,
  FILL_STRIDE,
  LINE_STRIDE,
  POINT_STRIDE,
  type FramePlan,
  type MediaPlacement,
  type TilePlacement,
  type PlanBatch,
} from './../frame-plan.ts';
import { monotonicNow, PickStallRecorder, type PickResult } from './../picking.ts';
import { Symbols, type AtlasPage, type SymbolMesh } from './../symbols.ts';
import type { BackendInitOptions, MapBackend } from './../backends.ts';

/* ------------------------------- WGSL common ----------------------------- */

const UNIFORMS = /* wgsl */ `
struct Uniforms {
  viewport: vec2f,
  dpr: f32,
  pickMode: f32,
  dashCount: f32,
  dashOffset: f32,
  pickThreshold: f32,
  pad0: f32,
  dash: array<vec4f, 2>,
  offset: vec2f,
  pickBase: f32,
  pad1: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

fn pickEncode(index: f32) -> vec4f {
  let r = floor(index / 65536.0);
  let g = floor((index - r * 65536.0) / 256.0);
  let b = index - r * 65536.0 - g * 256.0;
  return vec4f(r / 255.0, g / 255.0, b / 255.0, 1.0);
}

fn clipFromCss(css: vec2f) -> vec4f {
  let device = css * u.dpr;
  let clip = vec2f(device.x / u.viewport.x * 2.0 - 1.0, 1.0 - device.y / u.viewport.y * 2.0);
  return vec4f(clip, 0.0, 1.0);
}
`;

const POINTS_WGSL = /* wgsl */ `
${UNIFORMS}
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) localPos: vec2f,
  @location(1) fill: vec4f,
  @location(2) stroke: vec4f,
  @location(3) pickMeta: vec4f,
  @location(4) radius: vec2f,
};

@vertex
fn vs_main(
  @location(0) aCorner: vec2f,
  @location(1) aPos: vec4f,
  @location(2) aFill: vec4f,
  @location(3) aStroke: vec4f,
  @location(4) aMeta: vec4f,
) -> VSOut {
  var out: VSOut;
  let radius = max(aPos.zw, vec2f(0.01));
  let strokePad = select(0.0, aMeta.y * 0.5, aStroke.a > 0.0);
  let offset = aCorner * (radius + strokePad);
  out.pos = clipFromCss(aPos.xy + u.offset + offset);
  if (aMeta.w >= 2.0) { out.pos = vec4f(2.0, 2.0, 0.0, 1.0); }
  out.localPos = offset / max(radius, vec2f(0.01));
  out.fill = aFill;
  out.stroke = aStroke;
  out.pickMeta = vec4f(aMeta.xy, aMeta.z + u.pickBase, aMeta.w);
  out.radius = radius;
  return out;
}

fn shapeDistance(p: vec2f, shape: f32) -> f32 {
  if (shape < 0.5) { return length(p); }
  if (shape < 1.5) { return max(abs(p.x), abs(p.y)); }
  if (shape < 2.5) { return abs(p.x) + abs(p.y); }
  return max(abs(p.x) * 1.15 + p.y * 0.58, -p.y + 0.58);
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let shape = in.pickMeta.x;
  let strokeWidth = in.pickMeta.y;
  let d = shapeDistance(in.localPos, shape);
  let radiusPx = max(min(in.radius.x, in.radius.y), 0.5);
  let aa = (1.5 / (radiusPx * u.dpr)) + 0.002;
  let fillAlpha = clamp((1.0 - d) / aa, 0.0, 1.0);
  var color = vec4f(in.fill.rgb, in.fill.a * fillAlpha);
  if (strokeWidth > 0.0 && in.stroke.a > 0.0) {
    let strokeLocal = clamp(strokeWidth * 0.5 / radiusPx, 0.02, 0.98);
    let inner = 1.0 - strokeLocal;
    let strokeAlpha = clamp((d - inner) / aa, 0.0, 1.0) * clamp((1.0 - d) / aa, 0.0, 1.0);
    let strokeColor = vec4f(in.stroke.rgb, in.stroke.a * strokeAlpha);
    color = mix(color, strokeColor, select(0.0, 1.0, d <= 1.0) * strokeAlpha);
    color.a = max(color.a, strokeColor.a);
  }
  if (color.a <= 0.001) { discard; }
  if (u.pickMode > 0.5) {
    if ((in.pickMeta.w % 2.0) < 0.5) { discard; }
    return pickEncode(in.pickMeta.z);
  }
  return color;
}
`;

const LINES_WGSL = /* wgsl */ `
${UNIFORMS}
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) cssPos: vec2f,
  @location(1) seg: vec4f,
  @location(2) line: vec4f,
  @location(3) fill: vec4f,
  @location(4) arc: f32,
};

fn dashValue(i: i32) -> f32 {
  let v = u.dash[i / 2];
  if (i % 2 == 0) { return v.x; }
  return v.y;
}

@vertex
fn vs_main(
  @location(0) aCorner: vec2f,
  @location(1) aSeg: vec4f,
  @location(2) aLine: vec4f,
  @location(3) aFill: vec4f,
  @location(4) aArc: vec4f,
) -> VSOut {
  var out: VSOut;
  let p0 = aSeg.xy + u.offset;
  let p1 = aSeg.zw + u.offset;
  let delta = p1 - p0;
  var segLen = length(delta);
  var dir: vec2f;
  if (segLen < 0.0001) {
    dir = vec2f(1.0, 0.0);
    segLen = 0.0;
  } else {
    dir = delta / segLen;
  }
  let normal = vec2f(-dir.y, dir.x);
  let halfWidth = aLine.x * 0.5 + 1.0;
  let extend = select(0.0, halfWidth, aLine.y > 0.5);
  let base = p0 - dir * extend;
  let total = segLen + extend * 2.0;
  let along = aCorner.x * total;
  let cssPos = base + dir * along + normal * ((aCorner.y * 2.0 - 1.0) * halfWidth);
  out.pos = clipFromCss(cssPos);
  if (aLine.w >= 2.0) { out.pos = vec4f(2.0, 2.0, 0.0, 1.0); }
  out.cssPos = cssPos;
  out.seg = vec4f(p0, p1);
  out.line = vec4f(aLine.xy, aLine.z + u.pickBase, aLine.w);
  out.fill = aFill;
  out.arc = aArc.x + clamp(along - extend, 0.0, segLen);
  return out;
}

fn dashAlpha(arc: f32) -> f32 {
  if (u.dashCount < 1.0) { return 1.0; }
  var period = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    if (f32(i) < u.dashCount) { period = period + dashValue(i); }
  }
  if (period <= 0.0) { return 1.0; }
  var phase = (arc + u.dashOffset) % period;
  if (phase < 0.0) { phase = phase + period; }
  var cursor = 0.0;
  for (var i = 0; i < 8; i = i + 1) {
    if (f32(i) < u.dashCount) {
      let step = dashValue(i);
      if (phase >= cursor && phase < cursor + step) {
        if (i % 2 == 0) { return 1.0; }
        return 0.0;
      }
      cursor = cursor + step;
    }
  }
  return 1.0;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let p0 = in.seg.xy;
  let p1 = in.seg.zw;
  var edgeLen = length(p1 - p0);
  var dir: vec2f;
  var t: f32;
  if (edgeLen < 0.0001) {
    dir = vec2f(1.0, 0.0);
    t = 0.5;
    edgeLen = 0.0001;
  } else {
    dir = (p1 - p0) / edgeLen;
    t = dot(in.cssPos - p0, dir) / edgeLen;
  }
  let width = in.line.x;
  let halfWidth = max(width * 0.5, 0.35);
  let center = length(in.cssPos - p0);
  let closest = p0 + dir * clamp(t, 0.0, 1.0) * edgeLen;
  let segmentDistance = length(in.cssPos - closest) - halfWidth;
  var distance: f32;
  if (edgeLen < 0.0002) {
    distance = select(1.0, center - halfWidth, in.line.y > 0.5);
  } else if (in.line.y > 0.5) {
    distance = segmentDistance;
  } else {
    if (t < 0.0) { distance = max(segmentDistance, -t * edgeLen); }
    else if (t > 1.0) { distance = max(segmentDistance, (t - 1.0) * edgeLen); }
    else { distance = segmentDistance; }
  }
  let aa = 1.0 / u.dpr;
  var alpha = clamp(0.5 - distance / aa, 0.0, 1.0);
  let dash = select(1.0, dashAlpha(in.arc), u.dashCount > 0.5);
  alpha = alpha * dash;
  if (alpha <= 0.001) { discard; }
  if (u.pickMode > 0.5) {
    if ((in.line.w % 2.0) < 0.5 || in.fill.a <= 0.001) { discard; }
    return pickEncode(in.line.z);
  }
  return vec4f(in.fill.rgb, in.fill.a * alpha);
}
`;

const FILLS_WGSL = /* wgsl */ `
${UNIFORMS}
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) fill: vec4f,
  @location(1) pickMeta: vec4f,
};

@vertex
fn vs_main(
  @location(0) aPos: vec4f,
  @location(1) aFill: vec4f,
  @location(2) aMeta: vec4f,
) -> VSOut {
  var out: VSOut;
  out.pos = clipFromCss(aPos.xy + u.offset);
  if (aMeta.y >= 2.0) { out.pos = vec4f(2.0, 2.0, 0.0, 1.0); }
  out.fill = aFill;
  out.pickMeta = vec4f(aMeta.x + u.pickBase, aMeta.yzw);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  if (u.pickMode > 0.5) {
    if ((in.pickMeta.y % 2.0) < 0.5 || in.fill.a <= 0.001) { discard; }
    return pickEncode(in.pickMeta.x);
  }
  return in.fill;
}
`;

const RASTER_WGSL = /* wgsl */ `
${UNIFORMS}
@group(1) @binding(0) var texture0: texture_2d<f32>;
@group(1) @binding(1) var sampler0: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) opacity: f32,
  @location(2) pick: vec4f,
};

@vertex
fn vs_main(@location(0) aPos: vec4f, @location(1) aUV: vec4f, @location(2) aPick: vec4f) -> VSOut {
  var out: VSOut;
  out.pos = clipFromCss(aPos.xy);
  out.uv = aUV.xy;
  out.opacity = aUV.z;
  out.pick = aPick;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  if (u.pickMode > 0.5) {
    // Media quads are one pick record per source, not per pixel (MEDIA-05).
    if (in.pick.y < 0.5) { discard; }
    return pickEncode(in.pick.x);
  }
  var color = textureSample(texture0, sampler0, in.uv);
  // The texture is premultiplied: scaling both rgb and alpha is a correct fade
  // and keeps layer opacity blending with what is below instead of darkening.
  color = color * in.opacity;
  return color;
}
`;

const LABELS_WGSL = /* wgsl */ `
${UNIFORMS}
@group(1) @binding(0) var texture0: texture_2d<f32>;
@group(1) @binding(1) var sampler0: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) fill: vec4f,
  @location(2) pickMeta: vec4f,
};

@vertex
fn vs_main(
  @location(0) aPos: vec4f,
  @location(1) aUV: vec4f,
  @location(2) aFill: vec4f,
  @location(3) aMeta: vec4f,
) -> VSOut {
  var out: VSOut;
  out.pos = clipFromCss(aPos.xy + aPos.zw + u.offset);
  out.uv = aUV.xy;
  out.fill = aFill;
  out.pickMeta = vec4f(aMeta.x + u.pickBase, aMeta.yzw);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  let texel = textureSample(texture0, sampler0, in.uv);
  if (u.pickMode > 0.5) {
    if (texel.a < u.pickThreshold || in.pickMeta.y < 0.5 || in.fill.a <= 0.001) { discard; }
    return pickEncode(in.pickMeta.x);
  }
  let alpha = texel.a * in.fill.a;
  if (alpha <= 0.004) { discard; }
  return vec4f(texel.rgb * in.fill.rgb, alpha);
}
`;

/* -------------------------------- internals ------------------------------ */

interface PipelineBundle {
  pipeline: GPURenderPipeline;
  pickPipeline: GPURenderPipeline;
  uniformGroup: GPUBindGroup;
  textureGroups: Map<GPUTexture, GPUBindGroup>;
}

interface TileEntry {
  state: 'loading' | 'ready' | 'error';
  texture: GPUTexture | null;
  image: HTMLImageElement | null;
  lastUsed: number;
}

/**
 * GPU copy of a media source (image/video). `element` is the uploaded bitmap
 * identity; `pixelVersion` guards partial `writeTexture` uploads so consecutive
 * region updates are all transferred (MEDIA-03).
 */
interface MediaEntry {
  texture: GPUTexture | null;
  element: MediaElement | null;
  width: number;
  height: number;
  pixelVersion: number;
  lastUsed: number;
}

const MAX_TILES = 256;
const MAX_MEDIA = 16;
/** Raster quad vertex stride: aPos(4) + aUV(4) + aPick(4). */
const RASTER_STRIDE = 12;
const PICK_RADIUS = 2;
const UNIFORM_SLOT = 256;
const CORNERS_QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const CORNERS_TRI = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);

const STRAIGHT_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const PREMULTIPLIED_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

export interface WebGpuInit {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
}

/** Asynchronous device acquisition; the factory awaits this (see backends.ts). */
export async function createWebGpuBackend(options: BackendInitOptions): Promise<WebGpuBackend> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    throw new MapletError('gpu-unavailable', 'navigator.gpu is not available');
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('webgpu');
  if (!context) {
    throw new MapletError('gpu-unavailable', 'a WebGPU canvas context could not be created');
  }
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (error) {
    throw new MapletError('gpu-unavailable', `requestAdapter failed: ${String(error)}`);
  }
  if (!adapter) {
    throw new MapletError('gpu-unavailable', 'no WebGPU adapter is available');
  }
  const device = await adapter.requestDevice();
  const format = navigator.gpu.getPreferredCanvasFormat();
  return new WebGpuBackend(options, { adapter, device, format });
}

export class WebGpuBackend implements MapBackend {
  readonly kind = 'webgpu' as const;
  readonly notes: string[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampler: GPUSampler;
  private readonly uniformLayout: GPUBindGroupLayout;
  private readonly textureLayout: GPUBindGroupLayout;
  private readonly pipelines = new Map<string, PipelineBundle>();
  private readonly staticBuffers = new Map<string, GPUBuffer>();
  private readonly batchBuffers = new Map<Float32Array, { buffer: GPUBuffer; version: number }>();
  private readonly indexBuffers = new Map<Uint32Array, GPUBuffer>();
  private readonly vertexPages = new Map<
    string,
    { buffer: GPUBuffer; capacity: number; used: number }[]
  >();
  private readonly tileCache = new Map<string, TileEntry>();
  private readonly symbols: Symbols;
  private readonly atlasTextures = new Map<AtlasPage, { texture: GPUTexture; revision: number }>();
  private readonly symbolBuffers = new Map<Float32Array, { buffer: GPUBuffer; version: number }>();
  private readonly usedSymbols = new Set<Float32Array>();
  private readonly mediaTextures = new Map<string, MediaEntry>();
  private readonly heldTiles = new Map<string, Map<string, string>>();
  private uniforms: GPUBuffer | null = null;
  private uniformSlots = 0;
  private uniformOffset = 0;
  /** Buffers are destroyed after the submit that last referenced them. */
  private readonly retiredBuffers: GPUBuffer[] = [];
  private readonly uniformScratch = new Float32Array(20);
  private offscreen: {
    kind: 'pick' | 'sample';
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
  } | null = null;
  private scene: Scene | null = null;
  private plan: FramePlan | null = null;
  private rafHandle: number | null = null;
  private readonly pickStall = new PickStallRecorder('async');
  private destroyed = false;
  private lost = false;
  private lostListener: ((message: string) => void) | null = null;
  private frameCounter = 0;
  private frameDrawCalls = 0;
  private dpr: number;

  constructor(options: BackendInitOptions, init: WebGpuInit) {
    this.canvas = document.createElement('canvas');
    this.dpr = options.dpr;
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    options.container.appendChild(this.canvas);
    const context = this.canvas.getContext('webgpu');
    if (!context) {
      this.canvas.remove();
      throw new MapletError('gpu-unavailable', 'a WebGPU canvas context could not be created');
    }
    this.context = context;
    this.device = init.device;
    this.symbols = new Symbols(init.device.limits.maxTextureDimension2D, this.dpr);
    this.format = init.format;
    context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.uniformLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 80 },
        },
      ],
    });
    this.textureLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    this.notes.push(`webgpu ${this.format}`);
    this.device.onuncapturederror = (event) => {
      const message = (event as { error?: { message?: string } }).error?.message ?? 'unknown WebGPU error';
      this.notes.push(message);
      console.error(`maplet webgpu: ${message}`);
    };
    try {
      const info = (init.adapter as { info?: { vendor?: string; architecture?: string } }).info;
      if (info && (info.vendor || info.architecture)) {
        this.notes.push(`${info.vendor ?? 'gpu'} ${info.architecture ?? ''}`.trim());
      }
    } catch {
      // Adapter info is optional.
    }
    this.device.lost.then((info) => {
      this.noteLost(`device lost: ${info.message || info.reason}`);
    });
    this.resize(options.width, options.height);
  }

  onLost(listener: (message: string) => void): void {
    this.lostListener = listener;
  }

  simulateLoss(): void {
    if (!this.destroyed && !this.lost) this.device.destroy();
  }

  /**
   * A lost device stops producing frames and reports the reason once; the map
   * replaces this backend and re-attaches the scene (GPU-07, GPU-09).
   */
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

  attach(scene: Scene): void {
    this.scene = scene;
    scene.setPickStats(this.pickStall.snapshot());
  }

  resize(width: number, height: number): void {
    const deviceWidth = Math.max(1, Math.round(width * this.dpr));
    const deviceHeight = Math.max(1, Math.round(height * this.dpr));
    this.canvas.width = deviceWidth;
    this.canvas.height = deviceHeight;
    if (this.offscreen) {
      this.offscreen.texture.destroy();
      this.offscreen = null;
    }
  }

  requestFrame(scene: Scene): void {
    if (this.destroyed || this.lost || this.rafHandle !== null) return;
    const raf = (globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number })
      .requestAnimationFrame;
    const run = (): void => {
      this.rafHandle = null;
      if (this.destroyed || this.lost) return;
      try { this.renderNow(scene); } catch (error) { scene.failFrame(error); }
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

  setVisible(visible: boolean): void {
    this.canvas.style.visibility = visible ? '' : 'hidden';
  }

  /* ------------------------------ frame path ------------------------------ */

  private renderNow(scene: Scene): void {
    if (this.destroyed || this.lost || scene.overrideFrameDriver) return;
    this.frameCounter++;
    const deviceWidth = this.canvas.width;
    const deviceHeight = this.canvas.height;
    if (deviceWidth === 0 || deviceHeight === 0) {
      scene.completeFrame();
      return;
    }
    this.plan = buildFramePlan(scene, { deviceWidth, deviceHeight, dpr: this.dpr });
    this.evictTiles();
    this.evictSymbols();
    this.evictMedia();
    this.frameDrawCalls = 0;
    this.beginUniformFrame(this.plan);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    this.drawPlan(pass, this.plan, false);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.flushRetiredBuffers();
    scene.setFrameStats({
      instances: this.plan.stats.instances,
      drawCalls: this.frameDrawCalls,
      gpuBytes: this.estimateGpuBytes(),
    });
    scene.completeFrame(this.plan.revision, this.plan);
  }

  private estimateGpuBytes(): number {
    let bytes = 0;
    for (const entry of this.tileCache.values()) {
      if (entry.state === 'ready') bytes += 256 * 256 * 4;
    }
    for (const entry of this.mediaTextures.values()) {
      if (entry.texture) bytes += entry.width * entry.height * 4;
    }
    for (const page of this.atlasTextures.keys()) bytes += page.canvas.width * page.canvas.height * 4;
    for (const data of this.symbolBuffers.keys()) bytes += data.byteLength;
    if (this.plan) {
      for (const draw of this.plan.draws) {
        if (draw.type === 'batch') bytes += draw.batch.data.byteLength;
      }
    }
    for (const indices of this.indexBuffers.keys()) bytes += indices.byteLength;
    return bytes;
  }

  /**
   * Uniform slots are dynamic offsets into one buffer; capacity is reserved
   * before any writes of a frame/pass so an offset never points past the buffer.
   */
  private beginUniformFrame(plan: FramePlan, passes = 1): void {
    this.resetVertexPages();
    const live = new Set(plan.draws.flatMap((draw) => draw.type === 'batch' ? [draw.batch.data] : []));
    const liveIndices = new Set(plan.draws.flatMap((draw) => draw.type === 'batch' && draw.batch.indices ? [draw.batch.indices] : []));
    for (const [indices, buffer] of this.indexBuffers) if (!liveIndices.has(indices)) {
      this.retiredBuffers.push(buffer); this.indexBuffers.delete(indices);
    }
    for (const [data, entry] of this.batchBuffers) {
      if (live.has(data)) continue;
      this.retiredBuffers.push(entry.buffer);
      this.batchBuffers.delete(data);
    }
    this.uniformOffset = 0;
    this.ensureUniformCapacity(plan.stats.drawCalls * passes + 256);
  }

  private ensureUniformCapacity(slots: number): void {
    if (this.uniforms && this.uniformSlots >= slots) return;
    const capacity = Math.max(512, this.uniformSlots * 2, slots);
    if (this.uniforms) this.retiredBuffers.push(this.uniforms);
    this.uniforms = this.device.createBuffer({
      size: capacity * UNIFORM_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformSlots = capacity;
    // Existing bind groups referenced the old buffer; rebuild them lazily.
    this.pipelines.clear();
  }

  /** Destroys buffers whose last referencing submit has been issued. */
  private flushRetiredBuffers(): void {
    for (const buffer of this.retiredBuffers) buffer.destroy();
    this.retiredBuffers.length = 0;
  }

  private allocUniform(
    pickMode: boolean,
    dash: readonly number[] | null,
    pickThreshold: number,
    batch?: Pick<PlanBatch, 'offsetX' | 'offsetY' | 'pickBase'>,
  ): number {
    const offset = this.uniformOffset * UNIFORM_SLOT;
    this.uniformOffset++;
    const scratch = this.uniformScratch;
    scratch.fill(0);
    scratch[0] = this.canvas.width;
    scratch[1] = this.canvas.height;
    scratch[2] = this.dpr;
    scratch[3] = pickMode ? 1 : 0;
    scratch[4] = dash ? dash.length : 0;
    scratch[5] = 0;
    scratch[6] = pickThreshold;
    scratch[7] = 0;
    if (dash) {
      const count = Math.min(8, dash.length);
      for (let i = 0; i < count; i++) scratch[8 + i] = dash[i]!;
    }
    scratch[16] = batch?.offsetX ?? 0;
    scratch[17] = batch?.offsetY ?? 0;
    scratch[18] = batch?.pickBase ?? 0;
    this.device.queue.writeBuffer(this.uniforms!, offset, scratch);
    return offset;
  }

  /* ------------------------------- pipelines ------------------------------- */

  private program(name: 'points' | 'lines' | 'fills' | 'raster' | 'labels'): PipelineBundle {
    const existing = this.pipelines.get(name);
    if (existing) return existing;
    const spec = {
      points: {
        code: POINTS_WGSL,
        topology: 'triangle-strip' as GPUPrimitiveTopology,
        blend: STRAIGHT_BLEND,
        textured: false,
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }],
          },
          {
            arrayStride: POINT_STRIDE * 4,
            stepMode: 'instance' as GPUVertexStepMode,
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 2, offset: 16, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 3, offset: 32, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 4, offset: 48, format: 'float32x4' as GPUVertexFormat },
            ],
          },
        ],
      },
      lines: {
        code: LINES_WGSL,
        topology: 'triangle-list' as GPUPrimitiveTopology,
        blend: STRAIGHT_BLEND,
        textured: false,
        buffers: [
          {
            arrayStride: 8,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' as GPUVertexFormat }],
          },
          {
            arrayStride: LINE_STRIDE * 4,
            stepMode: 'instance' as GPUVertexStepMode,
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 2, offset: 16, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 3, offset: 32, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 4, offset: 48, format: 'float32x4' as GPUVertexFormat },
            ],
          },
        ],
      },
      fills: {
        code: FILLS_WGSL,
        topology: 'triangle-list' as GPUPrimitiveTopology,
        blend: STRAIGHT_BLEND,
        textured: false,
        buffers: [
          {
            arrayStride: FILL_STRIDE * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 1, offset: 16, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 2, offset: 32, format: 'float32x4' as GPUVertexFormat },
            ],
          },
        ],
      },
      raster: {
        code: RASTER_WGSL,
        topology: 'triangle-list' as GPUPrimitiveTopology,
        blend: PREMULTIPLIED_BLEND,
        textured: true,
        buffers: [
          {
            arrayStride: RASTER_STRIDE * 4,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 1, offset: 16, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 2, offset: 32, format: 'float32x4' as GPUVertexFormat },
            ],
          },
        ],
      },
      labels: {
        code: LABELS_WGSL,
        topology: 'triangle-list' as GPUPrimitiveTopology,
        blend: STRAIGHT_BLEND,
        textured: true,
        buffers: [
          {
            arrayStride: 64,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 1, offset: 16, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 2, offset: 32, format: 'float32x4' as GPUVertexFormat },
              { shaderLocation: 3, offset: 48, format: 'float32x4' as GPUVertexFormat },
            ],
          },
        ],
      },
    }[name];
    const module = this.device.createShaderModule({ code: spec.code });
    void module.getCompilationInfo().then((info) => {
      for (const message of info.messages) {
        if (message.type === 'error') {
          this.notes.push(`wgsl ${name}: ${message.lineNum}:${message.message}`);
          console.error(`maplet webgpu ${name} WGSL error at line ${message.lineNum}: ${message.message}`);
        }
      }
    });
    const layouts = spec.textured ? [this.uniformLayout, this.textureLayout] : [this.uniformLayout];
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: layouts });
    const make = (blend: GPUBlendState | undefined): GPURenderPipeline => {
      this.device.pushErrorScope('validation');
      try {
        const pipeline = this.device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: { module, entryPoint: 'vs_main', buffers: spec.buffers },
          fragment: {
            module,
            entryPoint: 'fs_main',
            targets: [{ format: this.format, blend }],
          },
          primitive: { topology: spec.topology },
        });
        void this.device.popErrorScope().then((error) => {
          if (error) {
            this.notes.push(`pipeline ${name}: ${error.message}`);
            console.error(`maplet webgpu pipeline ${name}: ${error.message}`);
          }
        });
        return pipeline;
      } catch (error) {
        void this.device.popErrorScope();
        throw error;
      }
    };
    const bundle: PipelineBundle = {
      pipeline: make(spec.blend),
      pickPipeline: make(undefined),
      uniformGroup: this.device.createBindGroup({
        layout: this.uniformLayout,
        entries: [{ binding: 0, resource: { buffer: this.uniforms!, size: 80 } }],
      }),
      textureGroups: new Map(),
    };
    this.pipelines.set(name, bundle);
    return bundle;
  }

  private textureGroup(bundle: PipelineBundle, texture: GPUTexture): GPUBindGroup {
    const existing = bundle.textureGroups.get(texture);
    if (existing) return existing;
    const group = this.device.createBindGroup({
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    bundle.textureGroups.set(texture, group);
    return group;
  }

  /* ------------------------------- buffers --------------------------------- */

  /**
   * Vertex data lives in page rings: every draw of a frame writes at its own
   * offset, so a later upload can never overwrite the data of a draw that was
   * already encoded into the command buffer (WebGPU queue writes all execute
   * before the command buffer's draws, unlike ordered GL calls).
   */
  private uploadBuffer(
    name: string,
    data: Float32Array,
  ): { buffer: GPUBuffer; offset: number; size: number } {
    const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
    let pages = this.vertexPages.get(name);
    if (!pages) {
      pages = [];
      this.vertexPages.set(name, pages);
    }
    if (pages.length === 0) {
      const capacity = Math.max(size, 4096);
      pages.push({
        buffer: this.device.createBuffer({
          size: capacity,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        capacity,
        used: 0,
      });
    }
    let page = pages[pages.length - 1]!;
    if (page.used + size > page.capacity) {
      if (page.used === 0) {
        // Nothing references this page yet; growing it in place is safe.
        this.retiredBuffers.push(page.buffer);
        const capacity = Math.max(size, page.capacity * 2);
        page = {
          buffer: this.device.createBuffer({
            size: capacity,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          }),
          capacity,
          used: 0,
        };
        pages[pages.length - 1] = page;
      } else {
        const capacity = Math.max(size, page.capacity);
        page = {
          buffer: this.device.createBuffer({
            size: capacity,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
          }),
          capacity,
          used: 0,
        };
        pages.push(page);
      }
    }
    const offset = page.used;
    this.device.queue.writeBuffer(page.buffer, offset, data);
    page.used += size;
    return { buffer: page.buffer, offset, size };
  }

  /** Starts a new frame: page contents are not reused until the frame ends. */
  private resetVertexPages(): void {
    for (const pages of this.vertexPages.values()) {
      for (let index = 1; index < pages.length; index++) {
        this.retiredBuffers.push(pages[index]!.buffer);
      }
      pages.length = Math.min(1, pages.length);
      if (pages[0]) pages[0].used = 0;
    }
  }

  private staticBuffer(name: string, data: Float32Array): GPUBuffer {
    const existing = this.staticBuffers.get(name);
    if (existing) return existing;
    const buffer = this.device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    this.staticBuffers.set(name, buffer);
    return buffer;
  }

  private uploadBatch(batch: PlanBatch): GPUBuffer {
    const version = batch.upload?.version ?? 0;
    let entry = this.batchBuffers.get(batch.data);
    if (!entry) {
      entry = {
        buffer: this.device.createBuffer({ size: Math.max(4, batch.data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
        version: -1,
      };
      this.batchBuffers.set(batch.data, entry);
    }
    if (entry.version !== version) {
      if (batch.upload && entry.version >= 0 && entry.version === batch.upload.previousVersion) {
        for (const { start, end } of batch.upload.ranges) {
          this.device.queue.writeBuffer(entry.buffer, start * 4, batch.data.subarray(start, end));
        }
      } else this.device.queue.writeBuffer(entry.buffer, 0, batch.data);
      entry.version = version;
    }
    return entry.buffer;
  }

  /* -------------------------------- draws ---------------------------------- */

  private drawPlan(pass: GPURenderPassEncoder, plan: FramePlan, pickMode: boolean): void {
    this.usedSymbols.clear();
    for (const draw of plan.draws) {
      if (draw.type === 'tiles') {
        this.drawTiles(pass, draw.tiles, pickMode);
        continue;
      }
      if (draw.type === 'media') {
        this.drawMedia(pass, draw.media, pickMode);
        continue;
      }
      if (draw.type === 'labels') {
        this.drawSymbols(pass, this.symbols.labels(draw.labels, (family) => this.scene?.fontSignature(family) ?? 'system', this.frameCounter, draw.appearance), pickMode, 0.02, draw);
        continue;
      }
      if (draw.type === 'sprites') {
        this.drawSymbols(pass, this.symbols.sprites(draw.sprites, (id) => this.scene?.assets.get(id), this.frameCounter, draw.appearance), pickMode, 0.5, draw);
        continue;
      }
      const batch = draw.batch;
      if (batch.kind === 'points') this.drawPoints(pass, batch, pickMode);
      else if (batch.kind === 'lines') {
        this.drawLines(pass, batch, pickMode, batch.dash ?? null);
      } else {
        this.drawFills(pass, batch, pickMode);
      }
    }
    for (const [data, entry] of this.symbolBuffers) if (!this.usedSymbols.has(data)) {
      this.retiredBuffers.push(entry.buffer); this.symbolBuffers.delete(data);
    }
  }

  private drawPoints(pass: GPURenderPassEncoder, batch: PlanBatch, pickMode: boolean): void {
    const { count } = batch;
    if (count === 0) return;
    const bundle = this.program('points');
    pass.setPipeline(pickMode ? bundle.pickPipeline : bundle.pipeline);
    pass.setBindGroup(0, bundle.uniformGroup, [this.allocUniform(pickMode, null, 0, batch)]);
    pass.setVertexBuffer(0, this.staticBuffer('quad', CORNERS_QUAD));
    pass.setVertexBuffer(1, this.uploadBatch(batch));
    this.frameDrawCalls++;
    pass.draw(4, count);
  }

  private drawLines(
    pass: GPURenderPassEncoder,
    batch: PlanBatch,
    pickMode: boolean,
    dash: readonly number[] | null,
  ): void {
    const { count } = batch;
    if (count === 0) return;
    const bundle = this.program('lines');
    pass.setPipeline(pickMode ? bundle.pickPipeline : bundle.pipeline);
    pass.setBindGroup(0, bundle.uniformGroup, [this.allocUniform(pickMode, dash, 0, batch)]);
    pass.setVertexBuffer(0, this.staticBuffer('tri', CORNERS_TRI));
    pass.setVertexBuffer(1, this.uploadBatch(batch));
    this.frameDrawCalls++;
    pass.draw(6, count);
  }

  private drawFills(pass: GPURenderPassEncoder, batch: PlanBatch, pickMode: boolean): void {
    const vertexCount = batch.count;
    if (vertexCount === 0) return;
    const bundle = this.program('fills');
    pass.setPipeline(pickMode ? bundle.pickPipeline : bundle.pipeline);
    pass.setBindGroup(0, bundle.uniformGroup, [this.allocUniform(pickMode, null, 0, batch)]);
    pass.setVertexBuffer(0, this.uploadBatch(batch));
    this.frameDrawCalls++;
    if (batch.indices) {
      let buffer = this.indexBuffers.get(batch.indices);
      if (!buffer) {
        buffer = this.device.createBuffer({ size: Math.max(4, batch.indices.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(buffer, 0, batch.indices); this.indexBuffers.set(batch.indices, buffer);
      }
      pass.setIndexBuffer(buffer, 'uint32'); pass.drawIndexed(vertexCount);
    } else pass.draw(vertexCount);
  }

  /* -------------------------------- tiles ---------------------------------- */

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
    if (entry.texture) return true;
    if (!entry.image) return false;
    const width = entry.image.naturalWidth || entry.image.width;
    const height = entry.image.naturalHeight || entry.image.height;
    const texture = this.device.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: entry.image },
      { texture, premultipliedAlpha: true },
      [width, height],
    );
    entry.texture = texture;
    return true;
  }

  /**
   * Same fallback chain as WebGL 1: an undecoded tile is substituted by the
   * nearest decoded ancestor (or children after zoom-out, or the previous
   * template while a URL change loads) so loading never flashes blank.
   */
  /**
   * Tile placements, including their interactive area: the pick pass draws the
   * same displayed quad with the raster source's single pick record (WMS-06);
   * non-interactive layers are skipped.
   */
  private drawTiles(pass: GPURenderPassEncoder, tiles: readonly TilePlacement[], pickMode: boolean): void {
    if (tiles.length === 0) return;
    const bundle = this.program('raster');
    const pushQuad = (
      data: number[],
      batch: { entry: TileEntry; run: number }[],
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
      const last = batch[batch.length - 1];
      if (last && last.entry === entry) last.run++;
      else batch.push({ entry, run: 1 });
    };
    const resolve = (url: string): TileEntry => {
      const entry = this.tileEntry(url);
      entry.lastUsed = this.frameCounter;
      return entry;
    };

    const vertexData: number[] = [];
    const draws: { entry: TileEntry; run: number }[] = [];
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
      this.heldTiles.set(layerId, new Map(tiles.map((tile) => [tile.tileKey, tile.url])));
    }

    if (vertexData.length === 0) return;
    const buffer = this.uploadBuffer('tiles', Float32Array.from(vertexData));
    const uniform = this.allocUniform(pickMode, null, 0);
    pass.setPipeline(pickMode ? bundle.pickPipeline : bundle.pipeline);
    pass.setVertexBuffer(0, buffer.buffer, buffer.offset, buffer.size);
    let offset = 0;
    for (const { entry, run } of draws) {
      if (!this.bindTileTexture(entry) || !entry.texture) {
        offset += run * 6;
        continue;
      }
      pass.setBindGroup(1, this.textureGroup(bundle, entry.texture));
      pass.setBindGroup(0, bundle.uniformGroup, [uniform]);
      this.frameDrawCalls++;
      pass.draw(run * 6, 1, offset, 0);
      offset += run * 6;
    }
  }

  private evictTiles(): void {
    if (this.tileCache.size <= MAX_TILES) return;
    const entries = Array.from(this.tileCache.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = this.tileCache.size - MAX_TILES;
    for (let i = 0; i < removeCount; i++) {
      const [url, entry] = entries[i]!;
      if (url === undefined || !entry) continue;
      entry.texture?.destroy();
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
   * Mirrors the WebGL 1 upload policy: element/size changes upload the whole
   * bitmap (`copyExternalImageToTexture`, premultiplied like the canvas),
   * region updates use `writeTexture` on the changed rectangles only and video
   * frames upload the current frame (MEDIA-03/05).
   */
  private uploadMedia(entry: MediaEntry, source: MediaSourceImpl): boolean {
    const element = source.element;
    if (!element || source.width === 0 || source.height === 0) return false;
    const created = entry.texture === null;
    if (!entry.texture) {
      entry.texture = this.device.createTexture({
        size: [source.width, source.height],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }
    const full =
      created || entry.element !== element || entry.width !== source.width || entry.height !== source.height;
    const uploadWhole = (): void => {
      this.device.queue.copyExternalImageToTexture(
        { source: element },
        { texture: entry.texture!, premultipliedAlpha: true },
        [source.width, source.height],
      );
    };
    if (full) {
      uploadWhole();
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
      for (const region of regions) {
        const pixels = source.regionPixels(region);
        if (!pixels) break;
        this.device.queue.writeTexture(
          { texture: entry.texture!, origin: { x: region.x, y: region.y } },
          pixels,
          { bytesPerRow: region.width * 4, rowsPerImage: region.height },
          { width: region.width, height: region.height },
        );
        updated = true;
      }
      if (!updated) uploadWhole();
      entry.pixelVersion = source.pixelVersion;
    }
    return true;
  }

  /** Media quads follow the layer order and are one pick record per source. */
  private drawMedia(pass: GPURenderPassEncoder, media: readonly MediaPlacement[], pickMode: boolean): void {
    if (media.length === 0) return;
    const bundle = this.program('raster');
    const vertexData: number[] = [];
    const draws: { entry: MediaEntry; run: number }[] = [];
    for (const placement of media) {
      const source = this.scene?.getMediaSource(placement.sourceId);
      if (!source) continue;
      if (pickMode && placement.pickIndex === undefined) continue;
      // Same textured draw in both passes; see the WebGL 1 backend for why the
      // pick pass binds a complete texture too.
      const entry = this.mediaEntry(placement.sourceId);
      entry.lastUsed = this.frameCounter;
      if (!this.uploadMedia(entry, source)) continue;
      const pick = placement.pickIndex ?? 0;
      const flag = placement.pickIndex === undefined ? 0 : 1;
      const { sx, sy, sw, sh, opacity } = placement;
      vertexData.push(
        sx, sy, 0, 0, 0, 0, opacity, 0, pick, flag, 0, 0,
        sx + sw, sy, 0, 0, 1, 0, opacity, 0, pick, flag, 0, 0,
        sx, sy + sh, 0, 0, 0, 1, opacity, 0, pick, flag, 0, 0,
        sx + sw, sy, 0, 0, 1, 0, opacity, 0, pick, flag, 0, 0,
        sx + sw, sy + sh, 0, 0, 1, 1, opacity, 0, pick, flag, 0, 0,
        sx, sy + sh, 0, 0, 0, 1, opacity, 0, pick, flag, 0, 0,
      );
      const last = draws[draws.length - 1];
      if (last && last.entry === entry) last.run++;
      else draws.push({ entry, run: 1 });
    }
    if (vertexData.length === 0) return;
    const buffer = this.uploadBuffer('media', Float32Array.from(vertexData));
    const uniform = this.allocUniform(pickMode, null, 0);
    pass.setPipeline(pickMode ? bundle.pickPipeline : bundle.pipeline);
    pass.setVertexBuffer(0, buffer.buffer, buffer.offset, buffer.size);
    let offset = 0;
    for (const { entry, run } of draws) {
      if (entry.texture) pass.setBindGroup(1, this.textureGroup(bundle, entry.texture));
      pass.setBindGroup(0, bundle.uniformGroup, [uniform]);
      this.frameDrawCalls++;
      pass.draw(run * 6, 1, offset, 0);
      offset += run * 6;
    }
  }

  private evictMedia(): void {
    for (const [id, entry] of this.mediaTextures) {
      if (this.scene?.getMediaSource(id)) continue;
      entry.texture?.destroy();
      this.mediaTextures.delete(id);
    }
    if (this.mediaTextures.size <= MAX_MEDIA) return;
    const entries = Array.from(this.mediaTextures.entries()).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const removeCount = this.mediaTextures.size - MAX_MEDIA;
    for (let i = 0; i < removeCount; i++) {
      const [id, entry] = entries[i]!;
      entry.texture?.destroy();
      this.mediaTextures.delete(id);
    }
  }

  /* -------------------------------- labels --------------------------------- */

  private atlasTexture(page: AtlasPage): GPUTexture {
    let entry = this.atlasTextures.get(page);
    if (!entry) {
      const texture = this.device.createTexture({ size: [page.canvas.width, page.canvas.height], format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      entry = { texture, revision: -1 }; this.atlasTextures.set(page, entry);
    }
    if (entry.revision !== page.revision) {
      this.device.queue.copyExternalImageToTexture({ source: page.canvas }, { texture: entry.texture, premultipliedAlpha: false }, [page.canvas.width, page.canvas.height]);
      entry.revision = page.revision;
    }
    return entry.texture;
  }

  private drawSymbols(pass: GPURenderPassEncoder, mesh: SymbolMesh, pickMode: boolean, threshold: number,
    transform: Pick<PlanBatch, 'offsetX' | 'offsetY' | 'pickBase'>): void {
    if (!mesh.data.length) return;
    const bundle = this.program('labels');
    let entry = this.symbolBuffers.get(mesh.data);
    if (!entry) {
      const buffer = this.device.createBuffer({ size: mesh.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, mesh.data);
      entry = { buffer, version: mesh.upload.version }; this.symbolBuffers.set(mesh.data, entry);
    } else if (entry.version !== mesh.upload.version) {
      if (entry.version === mesh.upload.previousVersion) {
        for (const { start, end } of mesh.upload.ranges) this.device.queue.writeBuffer(entry.buffer, start * 4, mesh.data.subarray(start, end));
      } else this.device.queue.writeBuffer(entry.buffer, 0, mesh.data);
      entry.version = mesh.upload.version;
    }
    this.usedSymbols.add(mesh.data);
    pass.setPipeline(pickMode ? bundle.pickPipeline : bundle.pipeline);
    pass.setVertexBuffer(0, entry.buffer);
    pass.setBindGroup(0, bundle.uniformGroup, [this.allocUniform(pickMode, null, threshold, transform)]);
    let offset = 0;
    for (const run of mesh.runs) {
      pass.setBindGroup(1, this.textureGroup(bundle, this.atlasTexture(run.page)));
      this.frameDrawCalls++; pass.draw(run.count, 1, offset, 0); offset += run.count;
    }
  }

  private evictSymbols(): void {
    for (const page of this.symbols.evict()) {
      this.atlasTextures.get(page)?.texture.destroy(); this.atlasTextures.delete(page);
    }
  }

  /* --------------------------------- readback ------------------------------ */

  private ensureOffscreen(kind: 'pick' | 'sample'): NonNullable<WebGpuBackend['offscreen']> {
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (this.offscreen && this.offscreen.kind === kind && this.offscreen.width === width && this.offscreen.height === height) {
      return this.offscreen;
    }
    this.offscreen?.texture.destroy();
    const texture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.offscreen = { kind, texture, view: texture.createView(), width, height };
    return this.offscreen;
  }

  private async readRegion(
    texture: GPUTexture,
    x0: number,
    y0: number,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture, origin: { x: x0, y: y0 } },
      { buffer, bytesPerRow, rowsPerImage: height },
      { width, height },
    );
    this.device.queue.submit([encoder.finish()]);
    this.flushRetiredBuffers();
    try {
      await buffer.mapAsync(GPUMapMode.READ);
    } catch (error) {
      buffer.destroy();
      throw new MapletError(
        'gpu-unavailable',
        `a WebGPU readback was cancelled (${String(error)})`,
      );
    }
    const view = new Uint8Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    // WebGL's readPixels always returns RGBA; a BGRA canvas format stores the
    // same values with R and B swapped, so normalize before returning.
    if (this.format.startsWith('bgra')) {
      for (let i = 0; i + 2 < view.length; i += 4) {
        const swap = view[i]!;
        view[i] = view[i + 2]!;
        view[i + 2] = swap;
      }
    }
    return view;
  }

  async pick(scene: Scene, point: ScreenPoint, options: { limit: number }): Promise<readonly PickResult[]> {
    if (this.destroyed) return [];
    if (this.lost) {
      fail('gpu-unavailable', 'the WebGPU device was lost; the map replaces it automatically', {});
    }
    // PICK-12: everything down to the first await runs synchronously; the
    // readback wait below happens across awaits and does not block the caller.
    const startedAt = monotonicNow();
    const plan = buildFramePlan(scene, {
      deviceWidth: this.canvas.width,
      deviceHeight: this.canvas.height,
      dpr: this.dpr,
    });
    this.plan = plan;
    const target = this.ensureOffscreen('pick');
    this.beginUniformFrame(plan);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    this.drawPlan(pass, plan, true);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.flushRetiredBuffers();

    const px = Math.round(point.x * this.dpr);
    const py = Math.round(point.y * this.dpr);
    const radius = PICK_RADIUS * this.dpr;
    const x0 = Math.max(0, Math.floor(px - radius));
    const y0 = Math.max(0, Math.floor(py - radius));
    const width = Math.max(1, Math.min(target.width - x0, Math.ceil(radius * 2 + 1)));
    const height = Math.max(1, Math.min(target.height - y0, Math.ceil(radius * 2 + 1)));
    // `readRegion` encodes and submits the copy synchronously; the wait for
    // the mapped buffer happens across the await. Only the submission is a
    // blocking readback portion here.
    const readStartedAt = monotonicNow();
    const readback = this.readRegion(target.texture, x0, y0, width, height);
    const readSubmitMs = monotonicNow() - readStartedAt;
    this.pickStall.record(monotonicNow() - startedAt, readSubmitMs);
    scene.setPickStats(this.pickStall.snapshot());
    let pixels: Uint8Array;
    try {
      pixels = await readback;
    } catch (error) {
      if (this.lost || this.destroyed) {
        fail('gpu-unavailable', 'a pending WebGPU pick was cancelled by device loss', {});
      }
      throw error;
    }
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

    const results: PickResult[] = [];
    const seen = new Set<number>();
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const at = row * bytesPerRow + col * 4;
        const r = pixels[at]!;
        const g = pixels[at + 1]!;
        const b = pixels[at + 2]!;
        const a = pixels[at + 3]!;
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
        if (results.length >= options.limit) return results;
      }
    }
    return results;
  }

  /**
   * Diagnostics: renders the plan into an offscreen target and reads the pixel
   * at a CSS-pixel position (top-left origin, matching WebGPU texture rows).
   */
  async samplePixel(scene: Scene, point: ScreenPoint): Promise<{ r: number; g: number; b: number; a: number }> {
    if (this.destroyed) return { r: 0, g: 0, b: 0, a: 0 };
    if (this.lost) {
      fail('gpu-unavailable', 'the WebGPU device was lost; the map replaces it automatically', {});
    }
    const plan = buildFramePlan(scene, {
      deviceWidth: this.canvas.width,
      deviceHeight: this.canvas.height,
      dpr: this.dpr,
    });
    this.plan = plan;
    this.frameDrawCalls = 0;
    this.beginUniformFrame(plan, 2);
    const target = this.ensureOffscreen('sample');
    const encoder = this.device.createCommandEncoder();
    const samplePass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: target.view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    this.drawPlan(samplePass, plan, false);
    samplePass.end();
    // Keep a normal frame on the canvas so the compositor has content.
    const canvasPass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    this.drawPlan(canvasPass, plan, false);
    canvasPass.end();
    this.device.queue.submit([encoder.finish()]);
    this.flushRetiredBuffers();

    const x = Math.max(0, Math.min(target.width - 1, Math.round(point.x * this.dpr)));
    const y = Math.max(0, Math.min(target.height - 1, Math.round(point.y * this.dpr)));
    let pixels: Uint8Array;
    try {
      pixels = await this.readRegion(target.texture, x, y, 1, 1);
    } catch (error) {
      if (this.lost || this.destroyed) {
        fail('gpu-unavailable', 'a pending WebGPU readback was cancelled by device loss', {});
      }
      throw error;
    }
    return { r: pixels[0]!, g: pixels[1]!, b: pixels[2]!, a: pixels[3]! };
  }

  destroy(): void {
    if (this.scene) releaseFramePlan(this.scene);
    this.plan = null;
    if (this.destroyed) return;
    this.destroyed = true;
    this.lostListener = null;
    if (this.rafHandle !== null) {
      const cancel = (globalThis as { cancelAnimationFrame?: (id: number) => void })
        .cancelAnimationFrame;
      cancel?.(this.rafHandle);
      this.rafHandle = null;
    }
    for (const buffer of this.staticBuffers.values()) buffer.destroy();
    for (const entry of this.batchBuffers.values()) entry.buffer.destroy();
    this.batchBuffers.clear();
    for (const buffer of this.indexBuffers.values()) buffer.destroy();
    this.indexBuffers.clear();
    this.staticBuffers.clear();
    for (const pages of this.vertexPages.values()) {
      for (const page of pages) page.buffer.destroy();
    }
    this.vertexPages.clear();
    for (const buffer of this.retiredBuffers) buffer.destroy();
    this.retiredBuffers.length = 0;
    for (const entry of this.tileCache.values()) entry.texture?.destroy();
    this.tileCache.clear();
    this.heldTiles.clear();
    for (const entry of this.atlasTextures.values()) entry.texture.destroy();
    this.atlasTextures.clear(); this.symbols.clear();
    for (const entry of this.symbolBuffers.values()) entry.buffer.destroy();
    this.symbolBuffers.clear();
    for (const entry of this.mediaTextures.values()) entry.texture?.destroy();
    this.mediaTextures.clear();
    this.offscreen?.texture.destroy();
    this.offscreen = null;
    this.uniforms?.destroy();
    this.uniforms = null;
    this.pipelines.clear();
    this.canvas.remove();
    this.device.destroy();
  }
}
