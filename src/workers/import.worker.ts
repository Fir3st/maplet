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
import { prepareImport, type ImportJobRequest } from '../io/prepare.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
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
  const data = event.data as { requestId?: unknown; request?: ImportJobRequest } | null;
  if (typeof data !== 'object' || data === null || typeof data.requestId !== 'number') {
    // Not a request of this protocol; the pipeline ignores foreign messages too.
    return;
  }
  const requestId = data.requestId;
  try {
    const features = prepareImport(data.request as ImportJobRequest);
    scope.postMessage({ requestId, ok: true, features });
  } catch (error) {
    scope.postMessage({ requestId, ok: false, error: serializeError(error) });
  }
};
