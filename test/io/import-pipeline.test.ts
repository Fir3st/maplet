import test from 'node:test';
import assert from 'node:assert/strict';

import { isMapletError, MapletError } from '../../src/index.ts';
import type { FeatureInput, ImportWorkerLike } from '../../src/index.ts';
import { ImportPipeline } from '../../src/io/import-pipeline.ts';
import type {
  ImportJobRequest,
  PointImportJobRequest,
  WorkerImportRequest,
} from '../../src/io/prepare.ts';
import { prepareParts } from '../../src/io/parts.ts';
import { crs } from '../../src/math/crs.ts';

/* ------------------------------- fake worker ------------------------------ */

interface Posted {
  readonly requestId: number;
  readonly request: WorkerImportRequest;
  readonly transfer: readonly Transferable[];
}

class FakeWorker implements ImportWorkerLike {
  readonly posted: Posted[] = [];
  readonly listeners = new Map<string, ((event: { readonly data?: unknown }) => void)[]>();
  terminated = false;

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    const envelope = message as { requestId: number; request: WorkerImportRequest };
    this.posted.push({ requestId: envelope.requestId, request: envelope.request, transfer });
  }

  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }

  emitFailure(type: 'error' | 'messageerror' = 'error'): void {
    for (const listener of this.listeners.get(type) ?? []) listener({});
  }
}

function pointJob(sourceId = 's'): ImportJobRequest {
  return {
    kind: 'columnar',
    sourceId,
    positionKind: 'geographic',
    batch: { kind: 'point', positions: Float64Array.of(14, 50) },
  };
}

function features(): FeatureInput[] {
  return [{ geometry: { type: 'point', position: { lat: 50, lng: 14 } } }];
}

function pipelineWithWorker(queueLimit = 4): { pipeline: ImportPipeline; worker: FakeWorker } {
  const worker = new FakeWorker();
  const pipeline = new ImportPipeline({ workerFactory: () => worker, queueLimit });
  return { pipeline, worker };
}

/* --------------------------------- tests ---------------------------------- */

test('IO-07: the transfer list deduplicates buffers shared by several columns', async () => {
  const worker = new FakeWorker();
  const pipeline = new ImportPipeline({ workerFactory: () => worker });
  const shared = new Float64Array(6);
  const promise = pipeline.submit(
    {
      kind: 'columnar',
      sourceId: 's',
      positionKind: 'geographic',
      batch: { kind: 'point', positions: shared.subarray(0, 4), altitudes: shared.subarray(4, 6) },
    },
    { copy: false },
  );
  assert.deepEqual(worker.posted[0]!.transfer, [shared.buffer]);
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: [] });
  await promise;
  pipeline.destroy();
});

test('IO-09: the worker prepares a job and the pipeline reports its use', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const promise = pipeline.submit(pointJob(), { revision: 3 });
  assert.equal(pipeline.debug().pending, 1);
  assert.equal(worker.posted.length, 1);
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: features() });
  const prepared = await promise;
  assert.equal(prepared.length, 1);
  const debug = pipeline.debug();
  assert.equal(debug.backend, 'worker');
  assert.equal(debug.pending, 0);
  assert.deepEqual(debug.used, { worker: 1, inline: 0 });
  pipeline.destroy();
});

test('compact point worker replies stay columnar and malformed columns fail closed', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const batch = { kind: 'point' as const, positions: Float64Array.of(14, 50), ids: ['a'] };
  const prepared = pipeline.submit(
    { kind: 'columnar-points', sourceId: 's', positionKind: 'geographic', batch },
    { copy: false },
  );
  assert.deepEqual(worker.posted[0]!.transfer, [batch.positions.buffer]);
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: batch });
  assert.equal((await prepared).positions.length, 2);
  const malformed = pipeline.submit({
    kind: 'columnar-points',
    sourceId: 's',
    positionKind: 'geographic',
    batch,
  });
  worker.reply({
    requestId: worker.posted[1]!.requestId,
    ok: true,
    features: { kind: 'point', positions: Float64Array.of(Number.NaN, 0) },
  });
  await assert.rejects(
    malformed,
    (error: unknown) => isMapletError(error) && error.code === 'worker-failed',
  );
  assert.equal(worker.terminated, true);
  pipeline.destroy();
});

test('compact point metadata is owned once and never sent through the geometry worker', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const nested = { value: 1 };
  const batch = {
    kind: 'point' as const,
    positions: Float64Array.of(14, 50),
    ids: ['a'],
    properties: [{ nested }],
  };
  const pending = pipeline.submit({
    kind: 'columnar-points',
    sourceId: 's',
    positionKind: 'geographic',
    batch,
  });
  const posted = worker.posted[0]!;
  assert.notEqual(posted.request.kind, 'geojson');
  const columns = (posted.request as PointImportJobRequest).batch;
  assert.equal(columns.ids, undefined);
  assert.equal(columns.properties, undefined);
  nested.value = 99;
  batch.ids[0] = 'changed';
  worker.reply({ requestId: posted.requestId, ok: true, features: columns });
  const prepared = await pending;
  assert.deepEqual(prepared.ids, ['a']);
  assert.deepEqual(prepared.properties, [{ nested: { value: 1 } }]);
  assert.notEqual(prepared.properties![0], batch.properties[0]);
  assert.equal(prepared.positions, columns.positions);
  pipeline.destroy();
});

test('compact worker replies cannot silently change the owned metadata row count', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const pending = pipeline.submit({
    kind: 'columnar-points',
    sourceId: 's',
    positionKind: 'geographic',
    batch: { kind: 'point', positions: Float64Array.of(14, 50), ids: ['a'] },
  });
  worker.reply({
    requestId: worker.posted[0]!.requestId,
    ok: true,
    features: { kind: 'point', positions: new Float64Array(0) },
  });
  await assert.rejects(
    pending,
    (error: unknown) => isMapletError(error) && error.code === 'worker-failed',
  );
  assert.equal(worker.terminated, true);
  pipeline.destroy();
});

test('local metadata copies preserve property graph aliases, cycles and native values', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const ids = [42, '42', undefined];
  const shared: Record<string, unknown> = { date: new Date(123), bytes: Uint8Array.of(1, 2), ids };
  shared.self = shared;
  shared.map = new Map([['shared', shared]]);
  const properties = [shared, { shared }, undefined];
  const pending = pipeline.submit({
    kind: 'columnar-points',
    sourceId: 's',
    positionKind: 'geographic',
    batch: { kind: 'point', positions: new Float64Array(6), ids, properties },
  });
  ids[0] = 'changed';
  (shared.bytes as Uint8Array)[0] = 9;
  worker.reply({
    requestId: worker.posted[0]!.requestId,
    ok: true,
    features: { kind: 'point', positions: new Float64Array(6) },
  });
  const owned = await pending;
  assert.deepEqual(owned.ids, [42, '42', undefined]);
  const first = owned.properties![0]!;
  assert.notEqual(first, shared);
  assert.equal(first.self, first);
  assert.equal(owned.properties![1]!.shared, first);
  assert.equal((first.map as Map<string, unknown>).get('shared'), first);
  assert.deepEqual(first.date, new Date(123));
  assert.deepEqual(first.bytes, Uint8Array.of(1, 2));
  assert.deepEqual(first.ids, [42, '42', undefined]);
  pipeline.destroy();
});

test('binary parts keep owned metadata local and adopt the actual worker coordinate pools', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const batch = {
    kind: 'lineString' as const,
    positions: Float64Array.of(0, 0, 1, 1),
    partOffsets: Uint32Array.of(0, 2),
    ids: ['a'],
    properties: [{ nested: { value: 1 } }],
  };
  const pending = pipeline.submit({
    kind: 'columnar-parts',
    sourceId: 's',
    batch,
    positionKind: 'planar',
    projectionCode: 'SIMPLE',
  });
  const request = worker.posted[0]!.request;
  assert.equal(request.kind, 'columnar-parts');
  if (request.kind !== 'columnar-parts') throw new Error('unexpected test request');
  assert.equal(request.batch.ids, undefined);
  assert.equal(request.batch.properties, undefined);
  batch.ids[0] = 'changed';
  batch.properties[0]!.nested.value = 9;
  const reply = prepareParts(request.batch, crs.simple());
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: reply });
  const prepared = await pending;
  assert.equal(prepared.kind, 'prepared-parts');
  if (prepared.kind !== 'prepared-parts') throw new Error('unexpected test reply');
  assert.deepEqual(prepared.ids, ['a']);
  assert.deepEqual(prepared.properties, [{ nested: { value: 1 } }]);
  assert.equal(prepared.geometries, reply.geometries);
  pipeline.destroy();
});

test('binary workers fail closed on changed counts, kinds or malformed pools', async () => {
  for (const fault of ['count', 'kind', 'offset'] as const) {
    const { pipeline, worker } = pipelineWithWorker();
    const batch = {
      kind: 'polygon' as const,
      positions: Float64Array.of(0, 0, 1, 0, 1, 1, 0, 1),
      partOffsets: Uint32Array.of(0, 4),
    };
    const pending = pipeline.submit({
      kind: 'columnar-parts',
      sourceId: 's',
      batch,
      positionKind: 'planar',
      projectionCode: 'SIMPLE',
    });
    const reply = prepareParts(
      fault === 'kind' ? { ...batch, kind: 'lineString' } : batch,
      crs.simple(),
    );
    if (fault === 'count')
      worker.reply({
        requestId: worker.posted[0]!.requestId,
        ok: true,
        features: { ...reply, geometries: [] },
      });
    else {
      if (fault === 'offset')
        (reply.geometries[0]!.payload as { rings: Uint32Array }).rings[1] = 0xffffffff;
      worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: reply });
    }
    await assert.rejects(
      pending,
      (error: unknown) => isMapletError(error) && error.code === 'worker-failed',
    );
    assert.equal(worker.terminated, true);
    pipeline.destroy();
  }
});

test('IO-06/IO-07: copy transfers nothing; move transfers the batch buffers', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const batch = {
    kind: 'polygon' as const,
    positions: Float64Array.of(0, 0, 1, 0, 1, 1),
    partOffsets: Int32Array.of(0, 3),
    featurePartOffsets: Int32Array.of(0, 1),
    altitudes: Float64Array.of(1, 1, 1),
  };
  const copy = pipeline.submit({
    kind: 'columnar',
    sourceId: 's',
    positionKind: 'geographic',
    batch,
  });
  assert.deepEqual(worker.posted[0]!.transfer, [], 'the default copy transfers nothing');
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: features() });
  await copy;

  const move = pipeline.submit(
    { kind: 'columnar', sourceId: 's', positionKind: 'geographic', batch },
    { copy: false },
  );
  assert.equal(worker.posted.length, 2);
  assert.deepEqual(worker.posted[1]!.transfer, [
    batch.positions.buffer,
    batch.altitudes.buffer,
    batch.partOffsets.buffer,
    batch.featurePartOffsets.buffer,
  ]);
  worker.reply({ requestId: worker.posted[1]!.requestId, ok: true, features: features() });
  await move;
  pipeline.destroy();
});

test('LIFE-09: the queue is bounded and overruns reject with explicit backpressure', async () => {
  const { pipeline, worker } = pipelineWithWorker(2);
  const first = pipeline.submit(pointJob(), { revision: 4 });
  const second = pipeline.submit(pointJob());
  const third = pipeline.submit(pointJob());
  assert.equal(pipeline.debug().pending, 3, 'one active plus two waiting jobs');
  await assert.rejects(
    pipeline.submit(pointJob(), { revision: 9 }),
    (error: unknown) =>
      isMapletError(error) &&
      error.code === 'aborted' &&
      error.detail.reason === 'queue-full' &&
      error.detail.revision === 9,
  );
  assert.equal(pipeline.debug().pending, 3, 'a rejected submit never enters the queue');
  // Drain in request order.
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: features() });
  await first;
  worker.reply({ requestId: worker.posted[1]!.requestId, ok: true, features: features() });
  await second;
  worker.reply({ requestId: worker.posted[2]!.requestId, ok: true, features: features() });
  await third;
  assert.equal(pipeline.debug().pending, 0);
  pipeline.destroy();
});

test('IO-09: aborting a waiting job rejects it and never posts it', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const controller = new AbortController();
  const active = pipeline.submit(pointJob());
  const queued = pipeline.submit(pointJob(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    queued,
    (error: unknown) => isMapletError(error) && error.code === 'aborted',
  );
  assert.equal(pipeline.debug().pending, 1, 'the aborted job left the queue');
  assert.equal(worker.posted.length, 1);
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: features() });
  await active;
  assert.equal(worker.posted.length, 1, 'the aborted job was never posted');
  pipeline.destroy();
});

test('IO-09/IO-10: a mid-flight abort rejects immediately and the late reply is ignored', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const controller = new AbortController();
  const aborted = pipeline.submit(pointJob(), { signal: controller.signal, revision: 2 });
  const requestId = worker.posted[0]!.requestId;
  controller.abort();
  await assert.rejects(
    aborted,
    (error: unknown) =>
      isMapletError(error) && error.code === 'aborted' && error.detail.revision === 2,
  );
  assert.equal(pipeline.debug().pending, 0);
  // The worker finishes anyway; the late reply must not publish anything.
  worker.reply({ requestId, ok: true, features: features() });
  assert.equal(pipeline.debug().used.worker, 0, 'a late reply does not count as a preparation');
  assert.equal(pipeline.debug().pending, 0);

  const next = pipeline.submit(pointJob());
  const nextRequest = worker.posted[1]!.requestId;
  assert.notEqual(nextRequest, requestId, 'the next job gets a fresh request id');
  worker.reply({ requestId: nextRequest, ok: true, features: features() });
  await next;
  pipeline.destroy();
});

test('IO-10: stale and foreign replies are ignored without touching the active job', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const job = pipeline.submit(pointJob());
  const requestId = worker.posted[0]!.requestId;
  worker.reply({ requestId: requestId + 100, ok: true, features: features() });
  worker.reply({
    requestId: requestId - 1,
    ok: false,
    error: { code: 'aborted', message: 'late' },
  });
  assert.equal(pipeline.debug().pending, 1, 'the active job is still waiting');
  assert.equal(pipeline.debug().backend, 'worker');
  worker.reply({ requestId, ok: true, features: features() });
  await job;
  pipeline.destroy();
});

test('IO-10: late replies from cancelled imports cannot poison a different result format', async () => {
  const compact: PointImportJobRequest = {
    kind: 'columnar-points',
    sourceId: 's',
    positionKind: 'geographic',
    batch: { kind: 'point', positions: Float64Array.of(14, 50) },
  };
  for (const oldCompact of [false, true]) {
    const { pipeline, worker } = pipelineWithWorker();
    const controller = new AbortController();
    const aborted = oldCompact
      ? pipeline.submit(compact, { signal: controller.signal })
      : pipeline.submit(pointJob(), { signal: controller.signal });
    const oldId = worker.posted[0]!.requestId;
    controller.abort();
    await assert.rejects(
      aborted,
      (error: unknown) => isMapletError(error) && error.code === 'aborted',
    );
    const next = oldCompact ? pipeline.submit(pointJob()) : pipeline.submit(compact);
    void next.catch(() => {});
    worker.reply({ requestId: oldId, ok: true, features: oldCompact ? compact.batch : features() });
    assert.equal(
      pipeline.debug().backend,
      'worker',
      'the late result must be ignored before validating its format',
    );
    assert.equal(pipeline.debug().pending, 1);
    worker.reply({
      requestId: worker.posted[1]!.requestId,
      ok: true,
      features: oldCompact ? features() : compact.batch,
    });
    await next;
    assert.equal(pipeline.debug().used.worker, 1);
    pipeline.destroy();
  }
});

test('IO-11: a worker result error rejects typed without breaking the worker', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const bad = pipeline.submit(pointJob(), { revision: 5 });
  worker.reply({
    requestId: worker.posted[0]!.requestId,
    ok: false,
    error: { code: 'import-invalid', message: 'bad offsets', detail: { index: 2 } },
  });
  await assert.rejects(
    bad,
    (error: unknown) =>
      isMapletError(error) &&
      error.code === 'import-invalid' &&
      error.detail.index === 2 &&
      error.detail.revision === 5,
  );
  const good = pipeline.submit(pointJob());
  assert.equal(worker.posted.length, 2, 'the worker stays in use after a preparation error');
  worker.reply({ requestId: worker.posted[1]!.requestId, ok: true, features: features() });
  await good;
  assert.equal(pipeline.debug().used.worker, 1);
  pipeline.destroy();
});

test('IO-11: an invalid worker message fails the active job and falls back inline for good', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const failed = pipeline.submit(pointJob(), { revision: 6 });
  worker.reply({ requestId: 'wrong type' });
  await assert.rejects(
    failed,
    (error: unknown) =>
      isMapletError(error) && error.code === 'worker-failed' && error.detail.revision === 6,
  );
  assert.equal(worker.terminated, true, 'a broken worker is terminated');
  const fallback = await pipeline.submit(pointJob());
  assert.equal(fallback.length, 1, 'the inline fallback still prepares the job');
  const debug = pipeline.debug();
  assert.equal(debug.backend, 'inline');
  assert.deepEqual(debug.used, { worker: 0, inline: 1 });
  assert.equal(worker.posted.length, 1, 'nothing was posted to the broken worker');
  pipeline.destroy();
});

test('IO-11: a worker crash fails the active job and permanently switches to inline', async () => {
  const worker = new FakeWorker();
  const pipeline = new ImportPipeline({ workerFactory: () => worker });
  const failed = pipeline.submit(pointJob());
  worker.emitFailure('error');
  await assert.rejects(
    failed,
    (error: unknown) => isMapletError(error) && error.code === 'worker-failed',
  );
  const fallback = await pipeline.submit(pointJob());
  assert.equal(fallback.length, 1);
  assert.equal(pipeline.debug().used.inline, 1);
  assert.equal(worker.posted.length, 1);
  pipeline.destroy();
});

test('TX-09: preparation failures carry the logical revision', async () => {
  const inline = new ImportPipeline({ workerFactory: () => null });
  await assert.rejects(
    inline.submit(
      {
        kind: 'columnar',
        sourceId: 's',
        positionKind: 'geographic',
        batch: { kind: 'point', positions: Float64Array.of(1, Number.NaN) },
      },
      { revision: 11 },
    ),
    (error: unknown) =>
      isMapletError(error) && error.code === 'import-invalid' && error.detail.revision === 11,
  );
  assert.equal(inline.debug().used.inline, 0, 'failed preparations are not counted as use');
  inline.destroy();
});

test('IO-08: without a worker the pipeline prepares inline and copy stays usable', async () => {
  const pipeline = new ImportPipeline({ workerFactory: () => null });
  const positions = Float64Array.of(14, 50, 14.1, 50.1);
  const prepared = await pipeline.submit(
    {
      kind: 'columnar',
      sourceId: 's',
      positionKind: 'geographic',
      batch: { kind: 'point', positions },
    },
    { copy: false },
  );
  assert.equal(prepared.length, 2);
  assert.equal(positions.byteLength, 32, 'inline degradation keeps the input buffer usable');
  assert.deepEqual(pipeline.debug().used, { worker: 0, inline: 1 });
  pipeline.destroy();
});

test('destroy cancels active and queued jobs and rejects further work', async () => {
  const { pipeline, worker } = pipelineWithWorker();
  const active = pipeline.submit(pointJob());
  const queued = pipeline.submit(pointJob());
  pipeline.destroy();
  await assert.rejects(
    active,
    (error: unknown) => isMapletError(error) && error.code === 'destroyed',
  );
  await assert.rejects(
    queued,
    (error: unknown) => isMapletError(error) && error.code === 'destroyed',
  );
  assert.equal(worker.terminated, true);
  await assert.rejects(
    pipeline.submit(pointJob()),
    (error: unknown) => isMapletError(error) && error.code === 'destroyed',
  );
});

test('a clone failure is a typed error and does not poison the pipeline', async () => {
  const worker = new FakeWorker();
  const pipeline = new ImportPipeline({ workerFactory: () => worker });
  const originalPost = worker.postMessage.bind(worker);
  let failNext = true;
  worker.postMessage = function (message: unknown, transfer: readonly Transferable[] = []): void {
    if (failNext) {
      failNext = false;
      throw new MapletError('invalid-argument', 'simulated clone failure', {});
    }
    originalPost.call(this, message, transfer);
  };
  await assert.rejects(
    pipeline.submit(pointJob(), { revision: 1 }),
    (error: unknown) =>
      isMapletError(error) &&
      error.code === 'import-invalid' &&
      error.detail.reason === 'copy-failed',
  );
  const next = pipeline.submit(pointJob());
  assert.equal(worker.posted.length, 1);
  worker.reply({ requestId: worker.posted[0]!.requestId, ok: true, features: features() });
  await next;
  pipeline.destroy();
});
