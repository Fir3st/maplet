/**
 * Import worker (IO-09..IO-11).
 *
 * Module worker driven by `ImportPipeline`: it receives
 * `{ requestId, request }` messages, runs the shared `prepareImport` and replies
 * `{ requestId, ok: true, features }` or `{ requestId, ok: false, error }` with
 * the typed error serialized as `{ code, message, detail }`.
 *
 * The worker is stateless: cancellation is the caller's job (late replies are
 * dropped there), a crash never touches the scene and an unexpected failure is
 * reported as `worker-failed` instead of killing the message port.
 */

import { isMapletError } from '../api/errors.ts';
import { prepareImport, type WorkerImportRequest } from '../io/prepare.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Errors cross the worker boundary as plain data (DOMException is not cloneable). */
function serializeError(error: unknown): {
  code: string;
  message: string;
  detail: Record<string, unknown>;
} {
  if (isMapletError(error)) {
    return { code: error.code, message: error.message, detail: { ...error.detail } };
  }
  return {
    code: 'worker-failed',
    message: error instanceof Error ? error.message : String(error),
    detail: { reason: 'unexpected' },
  };
}

scope.onmessage = (event: MessageEvent) => {
  const data = event.data as { requestId?: unknown; request?: WorkerImportRequest } | null;
  if (typeof data !== 'object' || data === null || typeof data.requestId !== 'number') {
    // Not a request of this protocol; the pipeline ignores foreign messages too.
    return;
  }
  const requestId = data.requestId;
  try {
    const features = prepareImport(data.request as WorkerImportRequest);
    const transfer: Transferable[] = [];
    if (!Array.isArray(features)) {
      const buffers = new Set<ArrayBuffer>();
      const add = (view: ArrayBufferView | undefined): void => { if (view?.buffer instanceof ArrayBuffer) buffers.add(view.buffer); };
      if (features.kind === 'prepared-parts') {
        for (const geometry of features.geometries) {
          add(geometry.bbox);
          const payload = geometry.payload;
          if ('vertices' in payload) { add(payload.vertices); add(payload.parts); }
          if ('ringVertices' in payload) { add(payload.ringVertices); add(payload.rings); add(payload.ringOuter); }
        }
      } else {
        const batch = features.kind === 'raw-parts' ? features.batch : features;
        add(batch.positions); add(batch.altitudes);
        if (batch.kind !== 'point') { add(batch.partOffsets); add(batch.featurePartOffsets); }
      }
      for (const buffer of buffers) transfer.push(buffer);
    }
    scope.postMessage({ requestId, ok: true, features }, transfer);
  } catch (error) {
    scope.postMessage({ requestId, ok: false, error: serializeError(error) });
  }
};
