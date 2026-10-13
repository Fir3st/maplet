/**
 * Import preparation pipeline (IO-09..IO-11, LIFE-09, TX-09).
 *
 * One job is prepared at a time by the import worker; a bounded FIFO queues the
 * rest. Everything the pipeline guarantees is an ordering and ownership
 * contract of the *preparation* step — the source transaction that publishes
 * the prepared features always runs on the main thread afterwards, so a worker
 * failure can never leave the scene in a partial state:
 *
 * - Aborting a job rejects its promise. A job aborted before it starts never
 *   reaches the worker; a job aborted while the worker prepares it is dropped,
 *   and the late reply is ignored — it publishes neither data nor success
 *   (IO-09).
 * - Replies are matched by request id against the single active job, so stale,
 *   foreign or late messages are ignored and can never rewind the scene to
 *   older data (IO-10, IO-11).
 * - A worker crash, an unexpected worker message or a malformed reply fails the
 *   active job with `worker-failed` and permanently switches the pipeline to
 *   the inline fallback; the last consistent scene stays untouched (IO-11,
 *   TX-09). Failures carry the logical revision the preparation belonged to.
 * - The queue is bounded (`queueLimit` waiting jobs plus the active one, so
 *   `pending <= queueLimit + 1`); an overrun rejects with `aborted`
 *   `{ reason: 'queue-full' }` — explicit backpressure instead of unbounded
 *   growth (LIFE-09).
 *
 * Buffer ownership (IO-06..IO-08): the default `copy: true` clones the batch
 * into the worker, leaving the caller's arrays usable; `copy: false` transfers
 * the batch's typed arrays (a move — the buffers detach, ownership passes to
 * the operation). Without a worker the batch is read directly and `copy: false`
 * degrades to the copy semantics. `SharedArrayBuffer` is never required.
 */

import { isMapletError, isMapletErrorCode, MapletError, type MapletErrorCode, type MapletErrorDetail } from '../api/errors.ts';
import type { FeatureInput } from '../scene/source.ts';
import { prepareImport, type ImportJobRequest, type PointImportJobRequest, type PartsImportJobRequest, type PartsImport, type WorkerImportRequest, type PreparedImport } from './prepare.ts';
import { validateColumnarMetadata, validatePointBatch, validatePartsBatch, type ColumnarBatch, type ColumnarPointBatch } from './columnar.ts';
import { validPreparedParts } from './parts.ts';
import { GEOMETRY_KIND } from '../geometry/geometry.ts';
import type { FeatureId } from '../api/types.ts';

/** Minimal worker surface; `Worker` satisfies it structurally. */
export interface ImportWorkerLike {
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  terminate(): void;
}

export interface ImportPipelineOptions {
  /** Test seam; the default creates the module worker when the platform has one. */
  readonly workerFactory?: () => ImportWorkerLike | null;
  /** Maximum number of waiting jobs; the active job is extra. Default 4. */
  readonly queueLimit?: number;
}

export interface ImportSubmitOptions {
  readonly signal?: AbortSignal;
  /** Default `true`: the worker receives a structured-clone copy of the batch. */
  readonly copy?: boolean;
  /** Logical revision the preparation belongs to; failures report it (TX-09). */
  readonly revision?: number;
}

export interface ImportPipelineDebug {
  /** Effective preparation backend right now. */
  readonly backend: 'worker' | 'inline';
  /** Active plus queued jobs. */
  readonly pending: number;
  /** Completed preparations per backend (evidence that the worker really ran). */
  readonly used: { readonly worker: number; readonly inline: number };
}

const DEFAULT_QUEUE_LIMIT = 4;

interface PendingJob {
  readonly request: WorkerImportRequest;
  readonly options: ImportSubmitOptions;
  readonly resolve: (features: PreparedImport) => void;
  readonly reject: (error: unknown) => void;
  onAbort: (() => void) | null;
  aborted: boolean;
  /** Worker request id; `0` until the job is posted. */
  requestId: number;
  metadata: Pick<ColumnarPointBatch, 'ids' | 'properties'> | null;
  featureCount: number | null;
}

interface WorkerReply {
  readonly requestId: number;
  readonly ok: boolean;
  readonly features?: unknown;
  readonly error?: unknown;
}

function parseReply(data: unknown, request: WorkerImportRequest, requestId: number): WorkerReply | null {
  if (typeof data !== 'object' || data === null) return null;
  const reply = data as WorkerReply;
  if (typeof reply.requestId !== 'number' || typeof reply.ok !== 'boolean') return null;
  // A cancelled job may finish with a different payload shape than the active
  // job. Its envelope is enough to identify and ignore it; do not validate it
  // against the active request's schema or mark the worker as broken.
  if (reply.requestId !== requestId) return reply;
  if (reply.ok) {
    if (request.kind === 'columnar-points') {
      try { validatePointBatch(reply.features as ColumnarPointBatch, { positionKind: request.positionKind }); }
      catch { return null; }
    } else if (request.kind === 'columnar-parts') {
      const parts = reply.features as PartsImport;
      if (request.projectionCode !== undefined) {
        if (!validPreparedParts(parts)) return null;
        if (parts.geometries.some((geometry) => request.batch.kind === 'polygon'
          ? geometry.kind !== GEOMETRY_KIND.polygon
          : geometry.kind !== GEOMETRY_KIND.lineString && geometry.kind !== GEOMETRY_KIND.multiLineString)) return null;
      } else {
        if (!parts || parts.kind !== 'raw-parts') return null;
        if (parts.batch?.kind !== request.batch.kind) return null;
        try { validatePartsBatch(parts.batch, { positionKind: request.positionKind }); } catch { return null; }
      }
    } else if (!Array.isArray(reply.features)) return null;
  }
  if (!reply.ok && (typeof reply.error !== 'object' || reply.error === null)) return null;
  return reply;
}

function replyError(error: unknown): MapletError {
  const raw = error as { code?: unknown; message?: unknown; detail?: unknown };
  const code: MapletErrorCode = isMapletErrorCode(raw.code) ? raw.code : 'worker-failed';
  const message = typeof raw.message === 'string' ? raw.message : 'import preparation failed';
  const detail = typeof raw.detail === 'object' && raw.detail !== null ? (raw.detail as MapletErrorDetail) : {};
  return new MapletError(code, message, detail);
}

/** Adds the logical revision to typed failures that do not carry one (TX-09). */
function tagRevision(error: unknown, revision: number | undefined): unknown {
  if (revision === undefined || !isMapletError(error) || error.detail.revision !== undefined) {
    return error;
  }
  return new MapletError(error.code, error.message, { ...error.detail, revision });
}

function abortError(options: ImportSubmitOptions): MapletError {
  return tagRevision(
    new MapletError('aborted', 'import aborted', { reason: 'aborted' }),
    options.revision,
  ) as MapletError;
}

function transferablesOf(request: WorkerImportRequest): Transferable[] {
  if (request.kind === 'geojson') return [];
  const batch: ColumnarBatch = request.batch;
  // The transfer list holds ArrayBuffers (a typed-array view is not a
  // Transferable); deduplicated because several columns may share one buffer.
  // Views over a SharedArrayBuffer cannot be detached and stay copied (IO-08).
  const buffers = new Set<ArrayBuffer>();
  const add = (view: ArrayBufferView | undefined): void => {
    if (view && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  add(batch.positions);
  add(batch.altitudes);
  if (batch.kind !== 'point') {
    add(batch.partOffsets);
    add(batch.featurePartOffsets);
  }
  return Array.from(buffers);
}

function createDefaultWorker(): ImportWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('../workers/import.worker.js', import.meta.url), { type: 'module' });
  } catch {
    // No module-worker support, a blocked worker source or a CSP without
    // `worker-src`: fall back to inline preparation (documented).
    return null;
  }
}

export class ImportPipeline {
  private readonly workerFactory: () => ImportWorkerLike | null;
  private readonly queueLimit: number;
  private worker: ImportWorkerLike | null = null;
  private workerBroken = false;
  private active: PendingJob | null = null;
  private readonly queue: PendingJob[] = [];
  private nextRequestId = 1;
  private destroyed = false;
  private readonly used = { worker: 0, inline: 0 };

  constructor(options: ImportPipelineOptions = {}) {
    this.workerFactory = options.workerFactory ?? createDefaultWorker;
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  }

  /** Prepares an import; the caller applies the returned features transactionally. */
  submit(request: PointImportJobRequest, options?: ImportSubmitOptions): Promise<ColumnarPointBatch>;
  submit(request: PartsImportJobRequest, options?: ImportSubmitOptions): Promise<PartsImport>;
  submit(request: ImportJobRequest, options?: ImportSubmitOptions): Promise<FeatureInput[]>;
  submit(request: WorkerImportRequest, options: ImportSubmitOptions = {}): Promise<PreparedImport> {
    return new Promise<PreparedImport>((resolve, reject) => {
      if (this.destroyed) {
        reject(new MapletError('destroyed', 'import: the map has been destroyed', {}));
        return;
      }
      if (this.queue.length >= this.queueLimit) {
        reject(
          tagRevision(
            new MapletError('aborted', 'import rejected: the import queue is full', {
              reason: 'queue-full',
            }),
            options.revision,
          ),
        );
        return;
      }
      const job: PendingJob = {
        request,
        options,
        resolve,
        reject,
        onAbort: null,
        aborted: false,
        requestId: 0,
        metadata: null,
        featureCount: null,
      };
      const signal = options.signal;
      if (signal) {
        if (signal.aborted) {
          reject(abortError(options));
          return;
        }
        const onAbort = () => this.abortJob(job);
        job.onAbort = onAbort;
        signal.addEventListener('abort', onAbort);
      }
      this.queue.push(job);
      this.pump();
    });
  }

  debug(): ImportPipelineDebug {
    return {
      backend: this.worker && !this.workerBroken ? 'worker' : 'inline',
      pending: (this.active ? 1 : 0) + this.queue.length,
      used: { ...this.used },
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker?.terminate();
    this.worker = null;
    const active = this.releaseActive();
    if (active) {
      this.detachAbort(active);
      active.reject(new MapletError('destroyed', 'import cancelled: the map has been destroyed', {}));
    }
    for (const job of this.queue.splice(0)) {
      this.detachAbort(job);
      job.reject(new MapletError('destroyed', 'import cancelled: the map has been destroyed', {}));
    }
  }

  /* ------------------------------ scheduling ------------------------------ */

  private pump(): void {
    while (!this.destroyed && !this.active && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.aborted) {
        this.detachAbort(job);
        job.reject(abortError(job.options));
        continue;
      }
      this.active = job;
      const worker = this.ensureWorker();
      if (worker) {
        this.postJob(worker, job);
        return;
      }
      this.runInline(job);
    }
  }

  private runInline(job: PendingJob): void {
    this.releaseActive();
    this.detachAbort(job);
    try {
      // Compact columns stay compact; inline still owns its input like a worker does.
      const request = (job.request.kind === 'columnar-points' || job.request.kind === 'columnar-parts'
        ? { ...job.request, batch: structuredClone(job.request.batch) }
        : job.request) as WorkerImportRequest;
      const features = prepareImport(request);
      this.used.inline++;
      job.resolve(features);
    } catch (error) {
      job.reject(tagRevision(error, job.options.revision));
    }
  }

  private ensureWorker(): ImportWorkerLike | null {
    if (this.workerBroken) return null;
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    if (!worker) return null;
    worker.addEventListener('message', this.onWorkerMessage);
    worker.addEventListener('error', this.onWorkerFailure);
    worker.addEventListener('messageerror', this.onWorkerFailure);
    this.worker = worker;
    return worker;
  }

  private postJob(worker: ImportWorkerLike, job: PendingJob): void {
    job.requestId = this.nextRequestId++;
    try {
      let request = job.request;
      if (request.kind === 'columnar-points' || request.kind === 'columnar-parts') {
        const { ids, properties, ...columns } = request.batch;
        const count = request.kind === 'columnar-points' ? columns.positions.length / 2 :
          validatePartsBatch(request.batch, { positionKind: request.positionKind, context: `columnar(${request.sourceId})` });
        validateColumnarMetadata(request.batch, count, `columnar(${request.sourceId})`);
        // Validated IDs are primitives: copy their array without serializing half
        // a million strings. Property graphs still use the native clone, including
        // cycles, aliases and platform objects; they never round-trip to the worker.
        const ownedIds = ids === undefined ? undefined : new Array<FeatureId | undefined>(count);
        if (ownedIds) for (let i = 0; i < count; i++) ownedIds[i] = ids![i];
        job.metadata = { ...(ownedIds === undefined ? {} : { ids: ownedIds }),
          ...(properties === undefined ? {} : { properties: structuredClone(properties) }) };
        job.featureCount = count;
        request = { ...request, batch: columns } as WorkerImportRequest;
      }
      const transfer = job.options.copy === false ? transferablesOf(request) : [];
      worker.postMessage({ requestId: job.requestId, request }, transfer);
    } catch (error) {
      this.releaseActive();
      this.detachAbort(job);
      job.reject(
        tagRevision(
          new MapletError('import-invalid', 'import data cannot be sent to the worker', {
            reason: 'copy-failed',
            cause: error instanceof Error ? error.message : String(error),
          }),
          job.options.revision,
        ),
      );
      this.pump();
    }
  }

  private abortJob(job: PendingJob): void {
    if (job.aborted || this.destroyed) return;
    job.aborted = true;
    if (this.active === job) {
      // Mid-flight abort: reject now; the late worker reply is dropped by the
      // request-id match and only frees the worker for the next job.
      this.releaseActive();
      this.detachAbort(job);
      job.reject(abortError(job.options));
      this.pump();
      return;
    }
    const index = this.queue.indexOf(job);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.detachAbort(job);
      job.reject(abortError(job.options));
    }
  }

  private releaseActive(): PendingJob | null {
    const job = this.active;
    this.active = null;
    if (job) this.detachAbort(job);
    return job;
  }

  private detachAbort(job: PendingJob): void {
    if (job.onAbort) {
      job.options.signal?.removeEventListener('abort', job.onAbort);
      job.onAbort = null;
    }
  }

  /* ------------------------------- worker --------------------------------- */

  private onWorkerMessage = (event: { readonly data?: unknown }): void => {
    const job = this.active;
    if (!job) return; // no job in flight: stale or foreign message, ignored
    const reply = parseReply(event.data, job.request, job.requestId);
    if (reply === null) {
      this.failWorker(job, 'the import worker replied with an invalid message');
      return;
    }
    if (reply.requestId !== job.requestId) {
      // Stale/foreign reply (e.g. for an already aborted request): ignored.
      return;
    }
    if (reply.ok && job.featureCount !== null) {
      const result = reply.features as ColumnarPointBatch | PartsImport;
      const count = result.kind === 'prepared-parts' ? result.geometries.length : result.kind === 'raw-parts' ?
        validatePartsBatch(result.batch, { positionKind: job.request.kind === 'geojson' ? 'geographic' : job.request.positionKind }) : result.positions.length / 2;
      if (count !== job.featureCount) {
        this.failWorker(job, 'the import worker changed the feature count');
        return;
      }
    }
    this.releaseActive();
    if (reply.ok) {
      this.used.worker++;
      const result = reply.features as PreparedImport;
      if (job.metadata === null || Array.isArray(result)) job.resolve(result);
      else if (result.kind === 'raw-parts') {
        const { ids: _ids, properties: _properties, ...batch } = result.batch;
        job.resolve({ kind: 'raw-parts', batch: { ...batch, ...job.metadata } });
      } else {
        const { ids: _ids, properties: _properties, ...columns } = result;
        job.resolve({ ...columns, ...job.metadata });
      }
    } else {
      job.reject(tagRevision(replyError(reply.error), job.options.revision));
    }
    this.pump();
  };

  private onWorkerFailure = (): void => {
    const worker = this.worker;
    const job = this.active;
    if (!job) {
      // Idle failure (e.g. the module failed to load): just stop using it.
      this.workerBroken = true;
      this.worker = null;
      worker?.terminate();
      return;
    }
    this.failWorker(job, 'the import worker crashed or failed to load');
  };

  private failWorker(job: PendingJob, reason: string): void {
    const worker = this.worker;
    this.workerBroken = true;
    this.worker = null;
    worker?.terminate();
    if (this.active === job) this.releaseActive();
    job.reject(
      tagRevision(
        new MapletError('worker-failed', `import preparation failed: ${reason}`, { reason }),
        job.options.revision,
      ),
    );
    this.pump();
  }
}
