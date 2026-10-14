/** Whole-text shaping, shared image pages and one draw/pick visibility decision. */
import { fail } from '../api/errors.ts';
import type { BufferUpload, LabelPlacement, SpritePlacement, SymbolAppearance } from './frame-plan.ts';
import { CollisionGrid } from './collision-grid.ts';
import { QUAD_UVS, quadBounds, quadVertices } from './quad.ts';

export interface AtlasPage {
  readonly canvas: HTMLCanvasElement;
  readonly keys: Set<string>;
  revision: number;
  lastUsed: number;
  active: boolean;
  x: number;
  y: number;
  rowHeight: number;
}
interface Region { page: AtlasPage; x: number; y: number; width: number; height: number }
export interface SymbolMesh {
  readonly data: Float32Array;
  readonly runs: readonly { readonly page: AtlasPage; readonly count: number }[];
  upload: BufferUpload;
}

/** Sprite attribute color: tint RGB with tint alpha combined into the opacity. */
function spriteColor(sprite: SpritePlacement): readonly number[] {
  return [sprite.tint[0], sprite.tint[1], sprite.tint[2], sprite.tint[3] * sprite.opacity];
}

interface RetainedSymbols {
  dependency: string;
  mesh: SymbolMesh;
  offsets: Int32Array;
  appearanceVersion: number;
}

export class Symbols {
  private readonly maxDimension: number;
  private readonly dpr: number;
  private readonly regions = new Map<string, Region>();
  private readonly pages = new Set<AtlasPage>();
  private readonly labelMeshes = new WeakMap<readonly LabelPlacement[], RetainedSymbols & { families: readonly string[] }>();
  private readonly spriteMeshes = new WeakMap<readonly SpritePlacement[], RetainedSymbols & { ids: readonly string[] }>();

  constructor(maxDimension: number, dpr: number) { this.maxDimension = maxDimension; this.dpr = dpr; }

  private get(key: string, frame: number): Region | undefined {
    const region = this.regions.get(key);
    if (region) region.page.lastUsed = frame;
    return region;
  }

  private insert(key: string, image: HTMLCanvasElement | HTMLImageElement, width: number, height: number, frame: number): Region {
    if (width > this.maxDimension || height > this.maxDimension) fail('render-failed', 'symbol exceeds the GPU texture dimension', { width, height, maxDimension: this.maxDimension });
    const pageSize = Math.min(512, this.maxDimension);
    const pad = width + 2 <= this.maxDimension && height + 2 <= this.maxDimension ? 1 : 0;
    const sw = width + pad * 2, sh = height + pad * 2;
    let page: AtlasPage | undefined;
    if (sw <= pageSize && sh <= pageSize) {
      for (const candidate of this.pages) {
        if (candidate.canvas.width !== pageSize || candidate.canvas.height !== pageSize) continue;
        if (candidate.x + sw > pageSize) {
          if (candidate.y + candidate.rowHeight + sh > pageSize) continue;
          candidate.y += candidate.rowHeight; candidate.x = 0; candidate.rowHeight = 0;
        }
        if (candidate.y + sh <= pageSize) { page = candidate; break; }
      }
    }
    if (!page) {
      const canvas = document.createElement('canvas');
      canvas.width = sw <= pageSize && sh <= pageSize ? pageSize : sw;
      canvas.height = sw <= pageSize && sh <= pageSize ? pageSize : sh;
      page = { canvas, keys: new Set(), revision: 0, lastUsed: frame, active: true, x: 0, y: 0, rowHeight: 0 };
      this.pages.add(page);
    }
    const x = page.x + pad, y = page.y + pad;
    const context = page.canvas.getContext('2d');
    if (!context) fail('render-failed', 'a symbol atlas could not create a 2D context');
    context.drawImage(image, x, y, width, height);
    // Extruded gutters preserve clamped edge sampling without cross-image bleed.
    if (pad) {
      context.drawImage(image, 0, 0, width, 1, x, y - 1, width, 1);
      context.drawImage(image, 0, height - 1, width, 1, x, y + height, width, 1);
      context.drawImage(image, 0, 0, 1, height, x - 1, y, 1, height);
      context.drawImage(image, width - 1, 0, 1, height, x + width, y, 1, height);
      for (const dx of [0, 1]) for (const dy of [0, 1]) context.drawImage(image, dx ? width - 1 : 0, dy ? height - 1 : 0, 1, 1, x + (dx ? width : -1), y + (dy ? height : -1), 1, 1);
    }
    page.x += sw; page.rowHeight = Math.max(page.rowHeight, sh); page.revision++; page.lastUsed = frame; page.keys.add(key);
    const region = { page, x, y, width, height };
    this.regions.set(key, region);
    return region;
  }

  private text(label: LabelPlacement, signature: string, frame: number): Region {
    const key = JSON.stringify(['text', label.text, label.sizePx, label.fontFamily, label.direction, signature, this.dpr]);
    const cached = this.get(key, frame);
    if (cached) return cached;
    const deviceSize = Math.max(1, label.sizePx * this.dpr), font = `${deviceSize}px ${label.fontFamily}`;
    const canvas = document.createElement('canvas');
    if (label.direction === 'auto') canvas.dir = 'auto';
    const context = canvas.getContext('2d');
    if (!context) fail('render-failed', 'text shaping could not create a 2D context');
    context.font = font; context.direction = label.direction === 'rtl' ? 'rtl' : label.direction === 'auto' ? 'inherit' : 'ltr';
    context.textAlign = 'left'; context.fontKerning = 'normal';
    canvas.width = Math.max(1, Math.ceil(context.measureText(label.text).width) + Math.ceil(2 * this.dpr));
    canvas.height = Math.max(1, Math.ceil(deviceSize * 1.35));
    context.font = font; context.direction = label.direction === 'rtl' ? 'rtl' : label.direction === 'auto' ? 'inherit' : 'ltr';
    context.textAlign = 'left'; context.fontKerning = 'normal'; context.textBaseline = 'middle'; context.fillStyle = '#ffffff';
    context.fillText(label.text, Math.ceil(this.dpr), Math.round(canvas.height / 2));
    return this.insert(key, canvas, canvas.width, canvas.height, frame);
  }

  private retained(cached: RetainedSymbols | undefined, dependency: string, frame: number): SymbolMesh | undefined {
    if (!cached || cached.dependency !== dependency || cached.mesh.runs.some((run) => !run.page.active)) return undefined;
    for (const run of cached.mesh.runs) run.page.lastUsed = frame;
    return cached.mesh;
  }

  private patchAppearance(cached: RetainedSymbols, appearance: SymbolAppearance | undefined,
    colorAt: (index: number) => readonly number[], interactiveAt: (index: number) => boolean): void {
    const version = appearance?.version ?? 0;
    if (version === cached.appearanceVersion) return;
    const local = appearance?.previousVersion === cached.appearanceVersion;
    const indices = local ? appearance!.indices : Array.from({ length: cached.offsets.length }, (_, i) => i);
    const ranges: { start: number; end: number }[] = [];
    for (const index of indices) {
      const start = cached.offsets[index]!;
      if (start < 0) continue; // Collision-suppressed labels have no GPU vertices.
      const color = colorAt(index), interactive = interactiveAt(index);
      for (let at = start; at < start + 6 * 16; at += 16) {
        cached.mesh.data.set(color, at + 8);
        cached.mesh.data[at + 13] = interactive ? 1 : 0;
      }
      ranges.push({ start, end: start + 6 * 16 });
    }
    cached.mesh.upload = { version, previousVersion: local ? cached.appearanceVersion : -1, ranges };
    cached.appearanceVersion = version;
  }

  labels(labels: readonly LabelPlacement[], fontSignature: (family: string) => string, frame: number, appearance?: SymbolAppearance): SymbolMesh {
    const previous = this.labelMeshes.get(labels);
    const families = previous?.families ?? Array.from(new Set(labels.map((label) => label.fontFamily)));
    const signatures = new Map(families.map((family) => [family, fontSignature(family)]));
    const dependency = JSON.stringify(Array.from(signatures));
    const cached = this.retained(previous, dependency, frame);
    if (cached) {
      this.patchAppearance(previous!, appearance, (index) => labels[index]!.color, (index) => labels[index]!.interactive);
      return cached;
    }
    const data: number[] = [], runs: { page: AtlasPage; count: number }[] = [], collisions = new CollisionGrid();
    const offsets = new Int32Array(labels.length).fill(-1);
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index]!;
      const region = this.text(label, signatures.get(label.fontFamily)!, frame);
      const vertices = quadVertices(label.offsetX, label.offsetY, region.width / this.dpr, region.height / this.dpr, label.rotate);
      if (label.collision) {
        const rect = quadBounds(vertices);
        rect.x0 += label.sx; rect.x1 += label.sx; rect.y0 += label.sy; rect.y1 += label.sy;
        if (collisions.overlaps(rect)) continue;
        collisions.add(rect);
      }
      offsets[index] = data.length;
      this.quad(data, runs, region, vertices, label.sx, label.sy, label.color, label.pickIndex, label.interactive);
    }
    const version = appearance?.version ?? 0, mesh = { data: Float32Array.from(data), runs, upload: { version, previousVersion: -1, ranges: [] } };
    this.labelMeshes.set(labels, { dependency, mesh, families, offsets, appearanceVersion: version });
    return mesh;
  }

  sprites(sprites: readonly SpritePlacement[], asset: (id: string) => { version: number; image: HTMLImageElement | null } | undefined, frame: number, appearance?: SymbolAppearance): SymbolMesh {
    const previous = this.spriteMeshes.get(sprites);
    const ids = previous?.ids ?? Array.from(new Set(sprites.map((sprite) => sprite.assetId)));
    const assets = new Map(ids.map((id) => [id, asset(id)]));
    const dependency = JSON.stringify(Array.from(assets, ([id, value]) => [id, value?.version, value?.image?.naturalWidth, value?.image?.naturalHeight]));
    const cached = this.retained(previous, dependency, frame);
    if (cached) {
      this.patchAppearance(previous!, appearance, (index) => spriteColor(sprites[index]!), (index) => sprites[index]!.interactive);
      return cached;
    }
    const data: number[] = [], runs: { page: AtlasPage; count: number }[] = [];
    const offsets = new Int32Array(sprites.length).fill(-1);
    for (let index = 0; index < sprites.length; index++) {
      const sprite = sprites[index]!;
      const item = assets.get(sprite.assetId);
      if (!item?.image) continue;
      const key = JSON.stringify(['image', sprite.assetId, item.version]);
      const region = this.get(key, frame) ?? this.insert(key, item.image, item.image.naturalWidth, item.image.naturalHeight, frame);
      const width = sprite.sizePx > 0 ? sprite.sizePx : region.width / this.dpr, height = sprite.sizePx > 0 ? sprite.sizePx : region.height / this.dpr;
      const vertices = quadVertices(sprite.offsetX, sprite.offsetY, width, height, sprite.rotate, 0, 0);
      offsets[index] = data.length;
      this.quad(data, runs, region, vertices, sprite.sx, sprite.sy, spriteColor(sprite), sprite.pickIndex, sprite.interactive);
    }
    const version = appearance?.version ?? 0, mesh = { data: Float32Array.from(data), runs, upload: { version, previousVersion: -1, ranges: [] } };
    this.spriteMeshes.set(sprites, { dependency, mesh, ids, offsets, appearanceVersion: version });
    return mesh;
  }

  private quad(data: number[], runs: { page: AtlasPage; count: number }[], region: Region, vertices: Float32Array,
    x: number, y: number, color: readonly number[], pick: number, interactive: boolean): void {
    const { page } = region;
    for (let i = 0; i < 6; i++) {
      const uv = QUAD_UVS[i]!;
      data.push(x, y, vertices[i * 2]!, vertices[i * 2 + 1]!, (region.x + uv[0] * region.width) / page.canvas.width,
        (region.y + uv[1] * region.height) / page.canvas.height, 0, 0, color[0]!, color[1]!, color[2]!, color[3]!, pick, interactive ? 1 : 0, 0, 0);
    }
    const last = runs[runs.length - 1];
    if (last?.page === page) last.count += 6; else runs.push({ page, count: 6 });
  }

  /** Evict reconstructible pages, never truncate this frame's placements. */
  evict(): readonly AtlasPage[] {
    if (this.pages.size <= 256) return [];
    const removed = Array.from(this.pages).sort((a, b) => a.lastUsed - b.lastUsed).slice(0, this.pages.size - 256);
    for (const page of removed) {
      for (const key of page.keys) this.regions.delete(key);
      page.active = false; this.pages.delete(page);
    }
    return removed;
  }

  clear(): void { for (const page of this.pages) page.active = false; this.pages.clear(); this.regions.clear(); }
}
