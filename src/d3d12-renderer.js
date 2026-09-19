import { ShaderCompiler } from './shader-compiler.js';
import { reflectDXBCInputSignature } from './dxbc-signature.js';
import { validateIndexSnapshot } from './d3d12-indices.js';

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const finite = (value) => Number.isFinite(value) && Number.isFinite(Math.fround(value));

// D3D12 owns resources and command recording in the guest API frontend. This
// backend consumes validated submission snapshots and shares the worker GPU
// device with the other graphics frontends; shader compilation remains generic.
export class D3D12Renderer {
  constructor(graphics) {
    this.graphics = graphics;
    this.compiler = new ShaderCompiler();
    this.swapchains = new Map();
    this.resources = new Map();
    this.pipelines = new Map();
    this.drawSlots = [];
    this.vertexSlots = [];
    this.indexSlots = [];
    this.frames = 0;
    this.draws = 0;
  }

  async initialize() {
    await this.graphics.initialize();
    this.device = this.graphics.device;
    if (this.layout) return;
    this.emptyLayout = this.device.createBindGroupLayout({ entries: [] });
    this.drawLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', minBindingSize: 16 },
        },
      ],
    });
    this.layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.emptyLayout, this.emptyLayout, this.emptyLayout, this.drawLayout],
    });
    this.emptyGroup = this.device.createBindGroup({ layout: this.emptyLayout, entries: [] });
  }

  async serializeRootSignature(flags) {
    return this.compiler.serializeRootSignature(flags);
  }

  async validateRootSignature(bytes) {
    return this.compiler.validateRootSignature(bytes);
  }

  async createSwapChain({ id, windowId, width, height, bufferIds }) {
    if (
      !integer(id, 1, 0xffffffff) ||
      this.swapchains.has(id) ||
      this.swapchains.size >= 4 ||
      !integer(windowId, 1, 0xffffffff) ||
      !integer(width, 1, 2048) ||
      !integer(height, 1, 2048) ||
      !Array.isArray(bufferIds) ||
      bufferIds.length !== 2 ||
      new Set(bufferIds).size !== 2 ||
      bufferIds.some((key) => !integer(key, 1, 0xffffffff) || this.resources.has(key))
    )
      throw Error('Unsupported D3D12 swap chain');
    await this.initialize();
    const canvas = new OffscreenCanvas(width, height);
    const software = this.graphics.presentationMode === 'readback';
    const context = canvas.getContext(software ? '2d' : 'webgpu');
    if (!context) throw Error('D3D12 presentation context unavailable');
    if (!software)
      context.configure({
        device: this.device,
        format: 'rgba8unorm',
        alphaMode: 'opaque',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    const chain = {
      id,
      windowId,
      width,
      height,
      bufferIds,
      canvas,
      context,
      software,
      textures: [],
    };
    try {
      for (const resourceId of bufferIds) {
        const texture = this.device.createTexture({
          label: 'D3D12 swap chain backbuffer',
          size: [width, height],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        chain.textures.push(texture);
        this.resources.set(resourceId, { kind: 'color', width, height, chain, texture });
      }
      if (software) {
        chain.bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        chain.readback = this.device.createBuffer({
          size: chain.bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      }
      this.swapchains.set(id, chain);
    } catch (error) {
      for (const key of bufferIds) this.resources.delete(key);
      for (const texture of chain.textures) texture.destroy();
      chain.readback?.destroy();
      if (!software) context.unconfigure();
      throw error;
    }
  }

  async createResource({ id, kind, width, height, format }) {
    if (
      !integer(id, 1, 0xffffffff) ||
      this.resources.has(id) ||
      this.resources.size >= 24 ||
      kind !== 'depth' ||
      format !== 'depth16unorm' ||
      !integer(width, 1, 2048) ||
      !integer(height, 1, 2048)
    )
      throw Error('Unsupported D3D12 depth resource');
    await this.initialize();
    this.device.pushErrorScope('validation');
    const texture = this.device.createTexture({
      label: 'D3D12 depth resource',
      size: [width, height],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const error = await this.device.popErrorScope();
    if (error) {
      texture.destroy();
      throw Error(error.message);
    }
    this.resources.set(id, { kind, width, height, texture });
  }

  async createPipeline({ id, vertex, pixel, inputLayout = [], vertexStride = 0, depth = null }) {
    if (!integer(id, 1, 0xffffffff) || this.pipelines.has(id) || this.pipelines.size >= 32)
      throw Error('D3D12 pipeline limit exceeded');
    if (
      !Array.isArray(inputLayout) ||
      !(
        (inputLayout.length === 0 && vertexStride === 0) ||
        (inputLayout.length === 2 &&
          vertexStride === 32 &&
          inputLayout.every(
            (attribute, index) =>
              attribute.shaderLocation === index &&
              attribute.offset === index * 16 &&
              attribute.format === 'float32x4',
          ))
      )
    )
      throw Error('Unsupported D3D12 input layout');
    if (
      depth &&
      (depth.format !== 'depth16unorm' ||
        typeof depth.writeEnabled !== 'boolean' ||
        depth.compare !== 'less-equal')
    )
      throw Error('Unsupported D3D12 depth pipeline');
    const signature = reflectDXBCInputSignature(vertex).filter((entry) => entry.systemValue === 0);
    if (signature.length !== inputLayout.length)
      throw Error('D3D12 input layout does not cover the vertex shader signature');
    const attributes = inputLayout.map((attribute, index) => {
      const semantic = ['POSITION', 'COLOR'][index];
      const entry = signature.find(
        (input) => input.semanticName.toUpperCase() === semantic && input.semanticIndex === 0,
      );
      if (!entry || entry.mask !== 15 || entry.register > 15)
        throw Error('Unsupported D3D12 vertex shader input: ' + semantic);
      return { ...attribute, shaderLocation: entry.register };
    });
    await this.initialize();
    const vs = await this.compiler.compile(vertex);
    const ps = await this.compiler.compile(pixel);
    this.device.pushErrorScope('validation');
    let pipeline, failure;
    try {
      pipeline = await this.device.createRenderPipelineAsync({
        label: 'D3D12 translated DXBC pipeline',
        layout: this.layout,
        vertex: {
          module: this.device.createShaderModule({ code: vs.wgsl }),
          entryPoint: 'main',
          buffers: attributes.length ? [{ arrayStride: vertexStride, attributes }] : [],
        },
        fragment: {
          module: this.device.createShaderModule({ code: ps.wgsl }),
          entryPoint: 'main',
          targets: [{ format: 'rgba8unorm' }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        ...(depth
          ? {
              depthStencil: {
                format: depth.format,
                depthWriteEnabled: depth.writeEnabled,
                depthCompare: depth.compare,
              },
            }
          : {}),
      });
    } catch (error) {
      failure = error;
    }
    const validation = await this.device.popErrorScope();
    if (failure || validation) throw failure ?? Error(validation.message);
    this.pipelines.set(id, { pipeline, vertexStride, depth });
    this.graphics.emit({
      type: 'log',
      text: 'D3D12 DXBC shaders compiled to WGSL in the browser worker',
    });
  }

  validateCommands(commands) {
    if (!Array.isArray(commands) || commands.length > 256)
      throw Error('D3D12 submission limit exceeded');
    let vertexBytes = 0;
    for (const command of commands) {
      const resource = this.resources.get(command.target);
      if (!resource) throw Error('D3D12 command uses a released resource');
      if (command.type === 'clear-depth') {
        if (
          resource.kind !== 'depth' ||
          !finite(command.depth) ||
          command.depth < 0 ||
          command.depth > 1
        )
          throw Error('Invalid D3D12 depth clear');
        continue;
      }
      if (resource.kind !== 'color') throw Error('D3D12 command requires a color target');
      if (command.type === 'clear') {
        if (
          !Array.isArray(command.color) ||
          command.color.length !== 4 ||
          !command.color.every(finite)
        )
          throw Error('Invalid D3D12 clear color');
      } else if (command.type === 'draw') {
        const p = this.pipelines.get(command.pipeline);
        const indexed = command.indexCount !== undefined;
        const depth = this.resources.get(command.depthTarget);
        if (
          !p ||
          (p.depth
            ? !depth ||
              depth.kind !== 'depth' ||
              depth.width !== resource.width ||
              depth.height !== resource.height
            : !!command.depthTarget)
        )
          throw Error('D3D12 draw depth target does not match pipeline');
        if (p.vertexStride) {
          if (
            !(command.vertices instanceof Uint8Array) ||
            command.vertexStride !== p.vertexStride ||
            command.vertices.length % p.vertexStride ||
            (!indexed &&
              command.vertices.length <
                (command.firstVertex + command.vertexCount) * p.vertexStride)
          )
            throw Error('Invalid D3D12 vertex buffer snapshot');
          vertexBytes += command.vertices.length;
        } else if (command.vertices?.length || command.vertexStride)
          throw Error('Unexpected D3D12 vertex input');
        if (indexed) {
          validateIndexSnapshot(
            command,
            p.vertexStride ? command.vertices.length / p.vertexStride : null,
          );
          vertexBytes += command.indices.length;
        } else if (command.indices || command.indexFormat)
          throw Error('Unexpected D3D12 index input');
        if (vertexBytes > 8 * 1024 * 1024) throw Error('D3D12 upload submission limit exceeded');
        const v = command.viewport,
          s = command.scissor;
        if (
          !this.pipelines.has(command.pipeline) ||
          !v ||
          !s ||
          ![v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth].every(finite) ||
          v.x < 0 ||
          v.y < 0 ||
          v.width <= 0 ||
          v.height <= 0 ||
          v.x + v.width > resource.chain.width ||
          v.y + v.height > resource.chain.height ||
          v.minDepth < 0 ||
          v.maxDepth > 1 ||
          v.minDepth > v.maxDepth ||
          !integer(s.left, 0, resource.chain.width) ||
          !integer(s.right, s.left, resource.chain.width) ||
          !integer(s.top, 0, resource.chain.height) ||
          !integer(s.bottom, s.top, resource.chain.height) ||
          (!indexed && !integer(command.vertexCount, 0, 65535)) ||
          !integer(command.instanceCount, 0, 1024) ||
          (!indexed && !integer(command.firstVertex, 0, 0x7fffffff - command.vertexCount)) ||
          !integer(command.firstInstance, 0, 0x7fffffff - command.instanceCount)
        )
          throw Error('Unsupported D3D12 draw state');
      } else throw Error('Unsupported D3D12 command ' + command.type);
    }
  }

  uploadBuffer(slots, index, bytes, usage) {
    const size = Math.ceil(bytes.length / 4) * 4;
    let slot = slots[index];
    if (slot && slot.size !== size) {
      slot.buffer.destroy();
      slot = null;
    }
    if (!slot) {
      slot = {
        size,
        buffer: this.device.createBuffer({
          size,
          usage: usage | GPUBufferUsage.COPY_DST,
        }),
      };
      slots[index] = slot;
    }
    // WebGPU writes require a multiple of four bytes; R16 index views may
    // contain an odd number of indices. Padding is never exposed to the draw.
    const upload = size === bytes.length ? bytes : new Uint8Array(size);
    if (upload !== bytes) upload.set(bytes);
    this.device.queue.writeBuffer(slot.buffer, 0, upload);
    return slot.buffer;
  }

  drawParameters(index, command) {
    if (!this.drawSlots[index]) {
      const buffer = this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const group = this.device.createBindGroup({
        layout: this.drawLayout,
        entries: [{ binding: 0, resource: { buffer } }],
      });
      this.drawSlots[index] = { buffer, group };
    }
    const slot = this.drawSlots[index];
    this.device.queue.writeBuffer(
      slot.buffer,
      0,
      new Int32Array([command.baseVertex ?? command.firstVertex, command.firstInstance, 0, 0]),
    );
    return slot.group;
  }

  async execute({ commands }) {
    this.validateCommands(commands);
    await this.initialize();
    if (this.graphics.failure) throw Error(this.graphics.failure);
    this.device.pushErrorScope('validation');
    let failure,
      draws = 0,
      vertexDraws = 0,
      indexDraws = 0;
    try {
      const encoder = this.device.createCommandEncoder();
      for (const command of commands) {
        const { texture } = this.resources.get(command.target);
        const clear = command.type === 'clear';
        const clearDepth = command.type === 'clear-depth';
        const depth = clearDepth ? texture : this.resources.get(command.depthTarget)?.texture;
        const pass = encoder.beginRenderPass({
          colorAttachments: clearDepth
            ? []
            : [
                {
                  view: texture.createView(),
                  loadOp: clear ? 'clear' : 'load',
                  storeOp: 'store',
                  clearValue: clear ? command.color : [0, 0, 0, 1],
                },
              ],
          ...(depth
            ? {
                depthStencilAttachment: {
                  view: depth.createView(),
                  depthLoadOp: clearDepth ? 'clear' : 'load',
                  depthStoreOp: 'store',
                  depthClearValue: clearDepth ? command.depth : 1,
                },
              }
            : {}),
        });
        if (!clear && !clearDepth) {
          const v = command.viewport,
            s = command.scissor;
          const p = this.pipelines.get(command.pipeline);
          pass.setPipeline(p.pipeline);
          if (p.vertexStride)
            pass.setVertexBuffer(
              0,
              this.uploadBuffer(
                this.vertexSlots,
                vertexDraws++,
                command.vertices,
                GPUBufferUsage.VERTEX,
              ),
            );
          for (let group = 0; group < 3; group++) pass.setBindGroup(group, this.emptyGroup);
          pass.setBindGroup(3, this.drawParameters(draws++, command));
          pass.setViewport(v.x, v.y, v.width, v.height, v.minDepth, v.maxDepth);
          pass.setScissorRect(s.left, s.top, s.right - s.left, s.bottom - s.top);
          if (command.indexCount !== undefined) {
            pass.setIndexBuffer(
              this.uploadBuffer(
                this.indexSlots,
                indexDraws++,
                command.indices,
                GPUBufferUsage.INDEX,
              ),
              command.indexFormat,
              0,
              command.indices.length,
            );
            pass.drawIndexed(
              command.indexCount,
              command.instanceCount,
              command.firstIndex,
              command.baseVertex,
              command.firstInstance,
            );
          } else
            pass.draw(
              command.vertexCount,
              command.instanceCount,
              command.firstVertex,
              command.firstInstance,
            );
        }
        pass.end();
      }
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    } catch (error) {
      failure = error;
    }
    const validation = await this.device.popErrorScope();
    if (failure || validation) throw failure ?? Error(validation.message);
    for (const slot of this.vertexSlots.splice(vertexDraws)) slot.buffer.destroy();
    for (const slot of this.indexSlots.splice(indexDraws)) slot.buffer.destroy();
    this.draws += draws;
  }

  async present({ id, index }) {
    const chain = this.swapchains.get(id);
    if (!chain || !integer(index, 0, 1)) throw Error('Invalid D3D12 presentation buffer');
    if (this.graphics.failure) throw Error(this.graphics.failure);
    const texture = chain.textures[index];
    this.device.pushErrorScope('validation');
    let failure;
    try {
      const encoder = this.device.createCommandEncoder();
      if (chain.software)
        encoder.copyTextureToBuffer(
          { texture },
          { buffer: chain.readback, bytesPerRow: chain.bytesPerRow },
          [chain.width, chain.height],
        );
      else
        encoder.copyTextureToTexture({ texture }, { texture: chain.context.getCurrentTexture() }, [
          chain.width,
          chain.height,
        ]);
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    } catch (error) {
      failure = error;
    }
    const validation = await this.device.popErrorScope();
    if (failure || validation) throw failure ?? Error(validation.message);
    if (chain.software) {
      await chain.readback.mapAsync(GPUMapMode.READ);
      try {
        const source = new Uint8Array(chain.readback.getMappedRange());
        const pixels = new Uint8ClampedArray(chain.width * chain.height * 4);
        for (let row = 0; row < chain.height; row++)
          pixels.set(
            source.subarray(row * chain.bytesPerRow, row * chain.bytesPerRow + chain.width * 4),
            row * chain.width * 4,
          );
        for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255;
        chain.context.putImageData(new ImageData(pixels, chain.width, chain.height), 0, 0);
      } finally {
        chain.readback.unmap();
      }
    }
    const bitmap = chain.canvas.transferToImageBitmap();
    this.graphics.emit({
      type: 'frame',
      windowId: chain.windowId,
      width: chain.width,
      height: chain.height,
      bitmap,
      renderer: 'webgpu',
      graphicsApi: 'd3d12',
      graphicsFrames: ++this.frames,
      graphicsDraws: this.draws,
    });
  }

  destroyPipeline({ id }) {
    this.pipelines.delete(id);
  }

  destroyResource({ id }) {
    const resource = this.resources.get(id);
    if (!resource || resource.kind === 'color') return;
    resource.texture.destroy();
    this.resources.delete(id);
  }

  destroySwapChain({ id }) {
    const chain = this.swapchains.get(id);
    if (!chain) return;
    for (const key of chain.bufferIds) this.resources.delete(key);
    for (const texture of chain.textures) texture.destroy();
    chain.readback?.destroy();
    if (!chain.software) chain.context.unconfigure();
    this.swapchains.delete(id);
  }

  dispose() {
    for (const id of this.swapchains.keys()) this.destroySwapChain({ id });
    for (const id of this.resources.keys()) this.destroyResource({ id });
    for (const slot of this.drawSlots) slot.buffer.destroy();
    for (const slot of this.vertexSlots) slot.buffer.destroy();
    for (const slot of this.indexSlots) slot.buffer.destroy();
    this.drawSlots.length = 0;
    this.vertexSlots.length = 0;
    this.indexSlots.length = 0;
    this.pipelines.clear();
  }
}
