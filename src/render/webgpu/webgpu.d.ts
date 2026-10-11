/**
 * Minimal ambient WebGPU declarations for the internal backend.
 *
 * The package stays dependency-free (no @webgpu/types); this file declares only
 * the subset of the WebGPU IDL that `backend.ts` actually calls. It is not part
 * of the public API — `src/render/webgpu/backend.ts` is internal and the public
 * `MapBackend` interface never mentions these types.
 */

declare global {
  interface GPU {
    requestAdapter(options?: object): Promise<GPUAdapter | null>;
    getPreferredCanvasFormat(): GPUTextureFormat;
  }

  interface Navigator {
    readonly gpu?: GPU;
  }

  interface GPUAdapter {
    readonly info?: { readonly vendor?: string; readonly architecture?: string };
    requestDevice(descriptor?: object): Promise<GPUDevice>;
  }

  interface GPUDeviceLostInfo {
    readonly reason: string;
    readonly message: string;
  }

  interface GPUError {
    readonly message: string;
  }

  interface GPUDevice {
    readonly queue: GPUQueue;
    readonly lost: Promise<GPUDeviceLostInfo>;
    onuncapturederror: ((event: unknown) => void) | null;
    pushErrorScope(filter: 'validation' | 'out-of-memory' | 'internal'): void;
    popErrorScope(): Promise<GPUError | null>;
    createSampler(descriptor: GPUSamplerDescriptor): GPUSampler;
    createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout;
    createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup;
    createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout;
    createShaderModule(descriptor: GPUShaderModuleDescriptor): GPUShaderModule;
    createRenderPipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline;
    createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer;
    createTexture(descriptor: GPUTextureDescriptor): GPUTexture;
    createCommandEncoder(descriptor?: object): GPUCommandEncoder;
    destroy(): void;
  }

  interface GPUQueue {
    writeBuffer(buffer: GPUBuffer, bufferOffset: number, data: ArrayBufferView | ArrayBuffer): void;
    copyExternalImageToTexture(
      source: {
        readonly source: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;
        readonly flipY?: boolean;
      },
      destination: { readonly texture: GPUTexture; readonly premultipliedAlpha?: boolean },
      copySize: readonly [number, number],
    ): void;
    writeTexture(
      destination: {
        readonly texture: GPUTexture;
        readonly origin?: { readonly x: number; readonly y: number };
      },
      data: ArrayBufferView,
      dataLayout: { readonly bytesPerRow?: number; readonly rowsPerImage?: number },
      size: {
        readonly width: number;
        readonly height: number;
        readonly depthOrArrayLayers?: number;
      },
    ): void;
    submit(commandBuffers: readonly GPUCommandBuffer[]): void;
  }

  interface GPUBuffer {
    readonly size: number;
    mapAsync(mode: number): Promise<void>;
    getMappedRange(): ArrayBuffer;
    unmap(): void;
    destroy(): void;
  }

  interface GPUTexture {
    createView(descriptor?: object): GPUTextureView;
    destroy(): void;
  }

  interface GPUTextureView {}
  interface GPUSampler {}
  interface GPUBindGroup {}
  interface GPUBindGroupLayout {}
  interface GPUPipelineLayout {}
  interface GPUCompilationMessage {
    readonly type: 'error' | 'warning' | 'info';
    readonly lineNum: number;
    readonly linePos: number;
    readonly message: string;
  }

  interface GPUCompilationInfo {
    readonly messages: readonly GPUCompilationMessage[];
  }

  interface GPUShaderModule {
    getCompilationInfo(): Promise<GPUCompilationInfo>;
  }
  interface GPURenderPipeline {}
  interface GPUCommandBuffer {}

  interface GPUCanvasContext {
    configure(configuration: GPUCanvasConfiguration): void;
    getCurrentTexture(): GPUTexture;
    unconfigure(): void;
  }

  interface GPUCanvasConfiguration {
    readonly device: GPUDevice;
    readonly format: GPUTextureFormat;
    readonly alphaMode?: 'opaque' | 'premultiplied';
    readonly usage?: number;
  }

  type GPUTextureFormat = 'bgra8unorm' | 'rgba8unorm' | (string & {});

  interface GPUSamplerDescriptor {
    readonly magFilter?: 'nearest' | 'linear';
    readonly minFilter?: 'nearest' | 'linear';
    readonly mipmapFilter?: 'nearest' | 'linear';
    readonly addressModeU?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
    readonly addressModeV?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
  }

  interface GPUBindGroupLayoutDescriptor {
    readonly entries: readonly GPUBindGroupLayoutEntry[];
  }

  interface GPUBindGroupLayoutEntry {
    readonly binding: number;
    readonly visibility: number;
    readonly buffer?: {
      readonly type?: 'uniform' | 'storage' | 'read-only-storage';
      readonly hasDynamicOffset?: boolean;
      readonly minBindingSize?: number;
    };
    readonly texture?: { readonly sampleType?: 'float' | 'unfilterable-float' | 'depth' };
    readonly sampler?: { readonly type?: 'filtering' | 'non-filtering' | 'comparison' };
  }

  interface GPUBindGroupDescriptor {
    readonly layout: GPUBindGroupLayout;
    readonly entries: readonly GPUBindGroupEntry[];
  }

  interface GPUBindGroupEntry {
    readonly binding: number;
    readonly resource:
      | { readonly buffer: GPUBuffer; readonly offset?: number; readonly size?: number }
      | GPUTextureView
      | GPUSampler;
  }

  interface GPUPipelineLayoutDescriptor {
    readonly bindGroupLayouts: readonly GPUBindGroupLayout[];
  }

  interface GPUShaderModuleDescriptor {
    readonly code: string;
  }

  interface GPUBlendComponent {
    readonly srcFactor?: string;
    readonly dstFactor?: string;
    readonly operation?: 'add' | 'subtract' | 'min' | 'max';
  }

  interface GPUBlendState {
    readonly color: GPUBlendComponent;
    readonly alpha: GPUBlendComponent;
  }

  type GPUVertexFormat =
    | 'float32x2'
    | 'float32x3'
    | 'float32x4'
    | 'uint32'
    | 'uint32x2'
    | 'uint32x3'
    | 'uint32x4'
    | (string & {});
  type GPUVertexStepMode = 'vertex' | 'instance';
  type GPUPrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
  type GPUIndexFormat = 'uint16' | 'uint32';
  type GPUStoreOp = 'store' | 'discard';

  interface GPUVertexAttribute {
    readonly shaderLocation: number;
    readonly offset: number;
    readonly format: GPUVertexFormat;
  }

  interface GPUVertexBufferLayout {
    readonly arrayStride: number;
    readonly stepMode?: GPUVertexStepMode;
    readonly attributes: readonly GPUVertexAttribute[];
  }

  interface GPURenderPipelineDescriptor {
    readonly layout: GPUPipelineLayout;
    readonly vertex: {
      readonly module: GPUShaderModule;
      readonly entryPoint: string;
      readonly buffers?: readonly GPUVertexBufferLayout[];
    };
    readonly fragment?: {
      readonly module: GPUShaderModule;
      readonly entryPoint: string;
      readonly targets: readonly {
        readonly format: GPUTextureFormat;
        readonly blend?: GPUBlendState | undefined;
      }[];
    };
    readonly primitive?: {
      readonly topology?: GPUPrimitiveTopology;
      readonly cullMode?: 'none' | 'front' | 'back';
    };
  }

  interface GPUBufferDescriptor {
    readonly size: number;
    readonly usage: number;
    readonly mappedAtCreation?: boolean;
  }

  interface GPUTextureDescriptor {
    readonly size: readonly [number, number] | { readonly width: number; readonly height: number };
    readonly format: GPUTextureFormat;
    readonly usage: number;
  }

  interface GPUCommandEncoder {
    beginRenderPass(descriptor: GPURenderPassDescriptor): GPURenderPassEncoder;
    copyTextureToBuffer(
      source: { readonly texture: GPUTexture; readonly origin?: { readonly x?: number; readonly y?: number } },
      destination: { readonly buffer: GPUBuffer; readonly bytesPerRow: number; readonly rowsPerImage: number },
      copySize: { readonly width: number; readonly height: number },
    ): void;
    finish(): GPUCommandBuffer;
  }

  interface GPURenderPassColorAttachment {
    readonly view: GPUTextureView;
    readonly clearValue: { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
    readonly loadOp: 'clear' | 'load';
    readonly storeOp: GPUStoreOp;
  }

  interface GPURenderPassDescriptor {
    readonly colorAttachments: readonly GPURenderPassColorAttachment[];
  }

  interface GPURenderPassEncoder {
    setPipeline(pipeline: GPURenderPipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup, dynamicOffsets?: readonly number[]): void;
    setVertexBuffer(
      slot: number,
      buffer: GPUBuffer,
      offset?: number,
      size?: number,
    ): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
    end(): void;
  }

  const GPUShaderStage: {
    readonly VERTEX: number;
    readonly FRAGMENT: number;
    readonly COMPUTE: number;
  };
  const GPUBufferUsage: {
    readonly MAP_READ: number;
    readonly COPY_DST: number;
    readonly UNIFORM: number;
    readonly VERTEX: number;
  };
  const GPUTextureUsage: {
    readonly COPY_SRC: number;
    readonly COPY_DST: number;
    readonly TEXTURE_BINDING: number;
    readonly RENDER_ATTACHMENT: number;
  };
  const GPUMapMode: { readonly READ: number };
}

/** Minimal canvas typing bridge for the internal WebGPU context. */
declare global {
  interface HTMLCanvasElement {
    getContext(contextId: 'webgpu'): GPUCanvasContext | null;
  }
}

export {};
