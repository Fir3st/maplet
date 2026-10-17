import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGl1Backend } from '../../src/render/webgl1/backend.ts';
import { WebGpuBackend } from '../../src/render/webgpu/backend.ts';
import type { PlanBatch } from '../../src/render/frame-plan.ts';

test('WebGL retained uploads allocate first, patch contiguous ranges, and recover skipped versions', () => {
  const calls: { full: boolean; offset: number; data: Float32Array }[] = [];
  let allocated = false;
  const backend = Object.create(WebGl1Backend.prototype) as {
    gl: unknown;
    batchBuffers: Map<unknown, unknown>;
    bindBatchBuffer(batch: PlanBatch, corners?: Float32Array): void;
  };
  backend.batchBuffers = new Map();
  backend.gl = {
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: (_target: number, data: Float32Array) => {
      allocated = true;
      calls.push({ full: true, offset: 0, data: data.slice() });
    },
    bufferSubData: (_target: number, offset: number, data: Float32Array) => {
      assert.ok(allocated, 'subdata cannot initialize a buffer');
      calls.push({ full: false, offset, data: data.slice() });
    },
  };
  const data = new Float32Array(32);
  const batch: PlanBatch = {
    layerId: 'l',
    kind: 'points',
    data,
    count: 2,
    upload: { version: 0, previousVersion: -1, ranges: [] },
  };
  backend.bindBatchBuffer(batch);
  backend.bindBatchBuffer(batch);
  assert.equal(calls.length, 1, 'unchanged color and pick passes share the GPU data');
  assert.equal(calls[0]!.data.byteLength, 128);
  data[16] = 42;
  backend.bindBatchBuffer({
    ...batch,
    upload: { version: 1, previousVersion: 0, ranges: [{ start: 16, end: 32 }] },
  });
  assert.equal(calls[1]!.full, false);
  assert.equal(calls[1]!.offset, 64);
  assert.equal(calls[1]!.data.byteLength, 64);
  backend.bindBatchBuffer({
    ...batch,
    upload: { version: 3, previousVersion: 2, ranges: [{ start: 0, end: 16 }] },
  });
  assert.equal(calls[2]!.full, true, 'a skipped version requires all changes');

  const basic = Object.create(WebGl1Backend.prototype) as typeof backend;
  basic.gl = backend.gl;
  basic.batchBuffers = new Map();
  const corners = Float32Array.of(-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1);
  basic.bindBatchBuffer(batch, corners);
  basic.bindBatchBuffer(
    { ...batch, upload: { version: 1, previousVersion: 0, ranges: [{ start: 16, end: 32 }] } },
    corners,
  );
  assert.equal(calls.at(-1)!.offset, 432);
  assert.equal(
    calls.at(-1)!.data.byteLength,
    432,
    'basic profile expands only the changed instance',
  );
});

test('WebGPU retained uploads initialize once and share buffers across encoded passes', () => {
  const calls: { offset: number; bytes: number }[] = [];
  const backend = Object.create(WebGpuBackend.prototype) as {
    device: unknown;
    batchBuffers: Map<unknown, unknown>;
    uploadBatch(batch: PlanBatch): unknown;
  };
  backend.batchBuffers = new Map();
  backend.device = {
    createBuffer: () => ({}),
    queue: {
      writeBuffer: (_buffer: unknown, offset: number, data: Float32Array) =>
        calls.push({ offset, bytes: data.byteLength }),
    },
  };
  const scope = globalThis as unknown as { GPUBufferUsage?: unknown };
  const previous = scope.GPUBufferUsage;
  scope.GPUBufferUsage = { VERTEX: 32, COPY_DST: 8 };
  try {
    const batch: PlanBatch = {
      layerId: 'l',
      kind: 'points',
      data: new Float32Array(32),
      count: 2,
      upload: { version: 0, previousVersion: -1, ranges: [] },
    };
    const buffer = backend.uploadBatch(batch);
    assert.equal(backend.uploadBatch(batch), buffer);
    assert.deepEqual(calls, [{ offset: 0, bytes: 128 }]);
    const edited = {
      ...batch,
      upload: { version: 1, previousVersion: 0, ranges: [{ start: 16, end: 32 }] },
    };
    assert.equal(backend.uploadBatch(edited), buffer);
    backend.uploadBatch(edited);
    assert.deepEqual(calls.at(-1), { offset: 64, bytes: 64 });
    assert.equal(calls.length, 2, 'second encoded pass does not rewrite the buffer');
    backend.uploadBatch({ ...batch, upload: { version: 4, previousVersion: 3, ranges: [] } });
    assert.deepEqual(calls.at(-1), { offset: 0, bytes: 128 });
  } finally {
    if (previous === undefined) delete scope.GPUBufferUsage;
    else scope.GPUBufferUsage = previous;
  }
});

test('WebGL pruning disables stale attribute pointers before deleting batch buffers', () => {
  const calls: string[] = [];
  const retained = new Float32Array(16);
  const backend = Object.create(WebGl1Backend.prototype) as {
    gl: unknown;
    batchBuffers: Map<Float32Array, unknown>;
    indexBuffers: Map<Uint32Array, unknown>;
    expandedFills: WeakMap<Float32Array, unknown>;
    pruneBatchBuffers(plan: { draws: unknown[] }): void;
  };
  backend.batchBuffers = new Map([
    [retained, { buffer: 'live' }],
    [new Float32Array(16), { buffer: 'old-points' }],
    [new Float32Array(12), { buffer: 'old-fills' }],
  ]);
  backend.indexBuffers = new Map();
  backend.expandedFills = new WeakMap();
  backend.gl = {
    getParameter: () => 5,
    disableVertexAttribArray: (index: number) => calls.push(`disable:${index}`),
    deleteBuffer: (buffer: string) => calls.push(`delete:${buffer}`),
  };
  const plan = { draws: [{ type: 'batch', batch: { data: retained } }] };
  backend.pruneBatchBuffers(plan);
  assert.deepEqual(calls, [
    'disable:0',
    'disable:1',
    'disable:2',
    'disable:3',
    'disable:4',
    'delete:old-points',
    'delete:old-fills',
  ]);
  assert.equal(backend.batchBuffers.size, 1);
  backend.pruneBatchBuffers(plan);
  assert.equal(calls.length, 7, 'unchanged buffers retain their attribute setup');
});
