/**
 * Development probe: extracts the WGSL sources from the built WebGPU backend,
 * compiles every shader, creates every pipeline with the backend's descriptors
 * and prints the first validation error of each. Results: `window.__gpuProbe`.
 */
const logs = [];
window.__gpuProbe = { logs, done: false };

const text = await (await fetch('../dist/render/webgpu/backend.js')).text();

function extract(name) {
  const marker = `const ${name} = `;
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('`', at);
  if (start < 0) return null;
  let end = start + 1;
  while (end < text.length && text[end] !== '`') end++;
  return text.slice(start + 1, end);
}

const uniformsSrc = extract('UNIFORMS');
logs.push(`extract UNIFORMS: ${uniformsSrc ? uniformsSrc.length + ' chars' : 'NOT FOUND'}`);

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();
const format = navigator.gpu.getPreferredCanvasFormat();

const specs = {
  POINTS_WGSL: {
    topology: 'triangle-strip',
    blend: true,
    textured: false,
    buffers: [
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
      {
        arrayStride: 64,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 1, offset: 0, format: 'float32x4' },
          { shaderLocation: 2, offset: 16, format: 'float32x4' },
          { shaderLocation: 3, offset: 32, format: 'float32x4' },
          { shaderLocation: 4, offset: 48, format: 'float32x4' },
        ],
      },
    ],
  },
  LINES_WGSL: {
    topology: 'triangle-list',
    blend: true,
    textured: false,
    buffers: [
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
      {
        arrayStride: 48,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 1, offset: 0, format: 'float32x4' },
          { shaderLocation: 2, offset: 16, format: 'float32x4' },
          { shaderLocation: 3, offset: 32, format: 'float32x4' },
        ],
      },
    ],
  },
  FILLS_WGSL: {
    topology: 'triangle-list',
    blend: true,
    textured: false,
    buffers: [
      {
        arrayStride: 48,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
          { shaderLocation: 2, offset: 32, format: 'float32x4' },
        ],
      },
    ],
  },
  RASTER_WGSL: {
    topology: 'triangle-list',
    blend: true,
    textured: true,
    buffers: [
      {
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
        ],
      },
    ],
  },
  LABELS_WGSL: {
    topology: 'triangle-list',
    blend: true,
    textured: true,
    buffers: [
      {
        arrayStride: 64,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
          { shaderLocation: 2, offset: 32, format: 'float32x4' },
          { shaderLocation: 3, offset: 48, format: 'float32x4' },
        ],
      },
    ],
  },
};

const uniformLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 },
    },
  ],
});
const textureLayout = device.createBindGroupLayout({
  entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
});

const straight = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

for (const [name, spec] of Object.entries(specs)) {
  const raw = extract(name);
  if (raw === null) {
    logs.push(`${name}: NOT FOUND`);
    continue;
  }
  const code = raw.split('${UNIFORMS}').join(uniformsSrc ?? '');
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((message) => message.type === 'error');
  if (errors.length > 0) {
    for (const message of errors) {
      logs.push(`${name} WGSL ERROR ${message.lineNum}:${message.linePos} ${message.message}`);
    }
    continue;
  }
  const layouts = spec.textured ? [uniformLayout, textureLayout] : [uniformLayout];
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: layouts });
  device.pushErrorScope('validation');
  let syncError = null;
  try {
    device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_main', buffers: spec.buffers },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format, blend: straight }] },
      primitive: { topology: spec.topology },
    });
  } catch (error) {
    syncError = String(error);
  }
  const scopeError = await device.popErrorScope();
  logs.push(
    `${name}: ${syncError ? 'create threw ' + syncError : scopeError ? 'validation ' + scopeError.message : 'pipeline ok'}`,
  );
}

window.__gpuProbe.done = true;
document.getElementById('out').textContent = logs.join('\n');
