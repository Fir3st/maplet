/**
 * Raster sources: XYZ/TMS tile templates and WMS requests.
 *
 * The source owns descriptor state only; pixel fetching happens in the tile loader
 * used by the renderer. `update`/`setParams` bump the source revision so late
 * responses of an older revision are discarded (RASTER-07, WMS-05), and a WMS
 * descriptor refuses a CRS the request builder cannot express (WMS-06).
 */

import { fail } from '../api/errors.ts';
import { Emitter } from '../api/events.ts';
import type { SubscribeOptions, Unsubscribe } from '../api/types.ts';
import { assertSupportedWmsCrs } from '../formats/raster.ts';
import {
  tileGridOptions,
  wmsTileGridOptions,
  type RasterTilesOptions,
  type TileGridOptions,
  type WmsOptions,
} from '../formats/raster.ts';

export type RasterSourceKind = 'rasterTiles' | 'wms';

export interface RasterSourceSnapshot {
  readonly sourceId: string;
  readonly revision: number;
  readonly kind: RasterSourceKind;
  readonly url: string;
}

export class RasterSourceImpl {
  readonly id: string;
  readonly kind: RasterSourceKind;
  options: RasterTilesOptions | WmsOptions;
  revision = 0;
  readonly emitter = new Emitter<{ change: RasterSourceSnapshot }>();

  constructor(id: string, kind: RasterSourceKind, options: RasterTilesOptions | WmsOptions) {
    this.id = id;
    this.kind = kind;
    this.options = options;
    const crs = (options as WmsOptions).crs;
    if (kind === 'wms' && crs !== undefined) assertSupportedWmsCrs(crs);
  }

  tilesGrid(): TileGridOptions {
    if (this.kind === 'rasterTiles') return tileGridOptions(this.options);
    return wmsTileGridOptions(this.options as WmsOptions);
  }

  update(patch: Partial<RasterTilesOptions & WmsOptions>): void {
    // An unsupported CRS is refused at the descriptor boundary, before any
    // frame plan could send degree coordinates to a projected service (WMS-06).
    if (this.kind === 'wms' && patch.crs !== undefined) assertSupportedWmsCrs(patch.crs);
    this.options = { ...this.options, ...patch };
    this.revision++;
    this.emitter.emit('change', this.snapshot());
  }

  setParams(params: Readonly<Record<string, string>>): void {
    if (this.kind !== 'wms') {
      fail('invalid-state', `source ${this.id} is not a WMS source`);
    }
    const options = this.options as WmsOptions;
    this.options = { ...options, params: { ...(options.params ?? {}), ...params } };
    this.revision++;
    this.emitter.emit('change', this.snapshot());
  }

  snapshot(): RasterSourceSnapshot {
    return {
      sourceId: this.id,
      revision: this.revision,
      kind: this.kind,
      url: this.options.url,
    };
  }

  destroy(): void {
    this.emitter.clear();
  }
}

export interface RasterSourceHandle {
  readonly id: string;
  readonly type: 'raster';
  /** Current descriptor snapshot (readonly). */
  snapshot(): RasterSourceSnapshot;
  /** Full current options; treat as readonly. */
  getOptions(): RasterTilesOptions | WmsOptions;
  update(patch: Partial<RasterTilesOptions & WmsOptions>): void;
  /** WMS parameter change (layers/time/...). */
  setParams(params: Readonly<Record<string, string>>): void;
  subscribe(fn: (snapshot: RasterSourceSnapshot) => void, options?: SubscribeOptions): Unsubscribe;
}

export function createRasterSourceHandle(impl: RasterSourceImpl): RasterSourceHandle {
  return {
    id: impl.id,
    type: 'raster',
    snapshot() {
      return impl.snapshot();
    },
    getOptions() {
      return impl.options;
    },
    update(patch) {
      impl.update(patch);
    },
    setParams(params) {
      impl.setParams(params);
    },
    subscribe(fn, options) {
      fn(impl.snapshot());
      return impl.emitter.on('change', fn, options);
    },
  };
}
