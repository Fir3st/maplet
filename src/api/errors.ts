/**
 * Typed errors of the Maplet API. Every failure mode that callers are expected to
 * distinguish is a `MapletError` with a stable `code`; messages are for humans.
 */

export const MAPLET_ERROR_CODES = [
  'invalid-argument',
  'invalid-region',
  'invalid-state',
  'destroyed',
  'not-found',
  'duplicate-id',
  'stale-reference',
  'unsupported',
  'unsupported-capability',
  'gpu-unavailable',
  'environment',
  'dependency-conflict',
  'cycle',
  'ownership-conflict',
  'missing-endpoint',
  'aborted',
  'import-invalid',
  'worker-failed',
  'render-failed',
] as const;

export type MapletErrorCode = (typeof MAPLET_ERROR_CODES)[number];

export function isMapletErrorCode(value: unknown): value is MapletErrorCode {
  return typeof value === 'string' && (MAPLET_ERROR_CODES as readonly string[]).includes(value);
}

export interface MapletErrorDetail {
  readonly [key: string]: unknown;
}

export class MapletError extends Error {
  readonly code: MapletErrorCode;
  readonly detail: MapletErrorDetail;

  constructor(code: MapletErrorCode, message: string, detail: MapletErrorDetail = {}) {
    super(message);
    this.name = 'MapletError';
    this.code = code;
    this.detail = detail;
  }
}

export function isMapletError(error: unknown): error is MapletError {
  return error instanceof MapletError;
}

export function fail(
  code: MapletErrorCode,
  message: string,
  detail?: MapletErrorDetail,
): never {
  throw new MapletError(code, message, detail ?? {});
}

export function assertArgument(
  condition: unknown,
  message: string,
  detail?: MapletErrorDetail,
): asserts condition {
  if (!condition) fail('invalid-argument', message, detail);
}
