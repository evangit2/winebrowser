import { D3DTextureRenderer, fixedShader, validateTexturing } from './d3d-texture-renderer.js';
import { primitiveState, validRasterState } from './d3d-render-state.js';
import { D3D9ProgrammableRenderer } from './d3d9-programmable-renderer.js';
import { clearColor, rgb565Shader } from './d3d-presentation.js';
import { defaultViewport, validViewport, validRegion } from './d3d-viewport.js';
import { D3DClearRenderer } from './d3d-clear-renderer.js';

// Browser graphics backend. Guest API objects and pointers stay in d3d9.js;
// this module consumes bounded, immutable geometry/state snapshots in a worker.
const COLOR_SHADER = fixedShader();
const MAX_DEVICES = 4;
const MAX_DIMENSION = 2048;
const MAX_COMMANDS = 256;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const matrix = (value) =>
  (Array.isArray(value) || value instanceof Float32Array) &&
  value.length === 16 &&
  [...value].every((entry) => Number.isFinite(Math.fround(entry)));

export class WebGPURenderer {
  constructor({ emit = () => {}, gpu = globalThis.navigator?.gpu, forceReadback = false } = {}) {
    this.emit = emit;
    this.gpu = gpu;
    this.forceReadback = forceReadback;
    this.surfaces = new Map();
    this.pipelines = new Map();
    this.programmable = new D3D9ProgrammableRenderer(this);
    this.clears = new D3DClearRenderer(this);
    this.textures = new D3DTextureRenderer(this);
    this.frames = 0;
    this.draws = 0;
  }

  async initialize() {
    if (this.device) return;
    if (!this.gpu) throw Error('WebGPU is unavailable in this browser worker');
    const adapter = await this.gpu.requestAdapter();
    if (!adapter) throw Error('No WebGPU adapter is available');
    this.fallbackAdapter = !!adapter.info?.isFallbackAdapter;
    this.presentationMode = this.forceReadback || this.fallbackAdapter ? 'readback' : 'canvas';
    this.device = await adapter.requestDevice();
    this.format =
      this.presentationMode === 'readback' ? 'rgba8unorm' : this.gpu.getPreferredCanvasFormat();
    this.device.addEventListener('uncapturederror', (event) => {
      this.failure = event.error.message;
    });
    this.device.lost.then((info) => {
      if (!this.disposed) this.failure = 'WebGPU device lost: ' + info.message;
    });
    this.shader = this.device.createShaderModule({
      label: 'WineBrowser XYZ + diffuse fixed-function shader',
      code: COLOR_SHADER,
    });
    this.bindLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindLayout] });
    this.emit({
      type: 'log',
      text: `WebGPU graphics initialized in the runtime worker (${this.presentationMode} presentation${this.fallbackAdapter ? ', fallback adapter' : ''}${this.forceReadback ? ', forced' : ''})`,
    });
  }

  async createDevice({
    id,
    windowId,
    width,
    height,
    depth,
    colorFormat = 22,
    swapEffect = 1,
    interval = 0x80000000,
  }) {
    if (
      !integer(id, 1, 0xffffffff) ||
      this.surfaces.has(id) ||
      this.surfaces.size >= MAX_DEVICES ||
      !integer(windowId, 1, 0xffffffff) ||
      !integer(width, 1, MAX_DIMENSION) ||
      !integer(height, 1, MAX_DIMENSION) ||
      typeof depth !== 'boolean' ||
      ![21, 22, 23].includes(colorFormat) ||
      ![1, 2, 3].includes(swapEffect) ||
      ![0, 1, 0x80000000].includes(interval)
    )
      throw Error('Invalid or oversized graphics surface');
    await this.initialize();
    const canvas = new OffscreenCanvas(width, height);
    let context = null,
      context2d = null,
      colors = [],
      readback = null,
      depthTexture = null,
      bytesPerRow = 0;
    try {
      for (let i = 0; i < (swapEffect === 2 ? 2 : 1); i++)
        colors.push(
          this.device.createTexture({
            label: `guest persistent color buffer ${i}`,
            size: [width, height],
            format: this.format,
            usage:
              GPUTextureUsage.RENDER_ATTACHMENT |
              GPUTextureUsage.COPY_SRC |
              GPUTextureUsage.COPY_DST |
              GPUTextureUsage.TEXTURE_BINDING,
          }),
        );
      if (this.presentationMode === 'readback') {
        context2d = canvas.getContext('2d');
        if (!context2d) throw Error('2D OffscreenCanvas is unavailable for WebGPU readback');
        bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        readback = this.device.createBuffer({
          label: 'guest frame readback',
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      } else {
        context = canvas.getContext('webgpu');
        if (!context) throw Error('WebGPU OffscreenCanvas is unavailable');
        context.configure({
          device: this.device,
          format: this.format,
          alphaMode: 'opaque',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        });
      }
      depthTexture = depth
        ? this.device.createTexture({
            label: 'guest depth buffer',
            size: [width, height],
            format: 'depth16unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          })
        : null;
    } catch (error) {
      depthTexture?.destroy();
      readback?.destroy();
      for (const texture of colors) texture.destroy();
      context?.unconfigure();
      throw error;
    }
    this.surfaces.set(id, {
      id,
      windowId,
      width,
      height,
      canvas,
      context,
      context2d,
      colors,
      colorIndex: 0,
      colorFormat,
      swapEffect,
      interval,
      lastPresented: 0,
      readback,
      bytesPerRow,
      depthTexture,
      depthInitialized: false,
      slots: [],
    });
    return { width, height };
  }

  validate(surface, commands) {
    if (!Array.isArray(commands) || commands.length > MAX_COMMANDS)
      throw Error('Graphics frame command limit exceeded');
    let bytes = 0,
      textureUploads = 0;
    const textures = new Map();
    for (const command of commands) {
      if (
        command.viewport !== undefined &&
        !validViewport(command.viewport, surface.width, surface.height)
      )
        throw Error('Invalid graphics viewport');
      if (command.type === 'clear') {
        if (
          !integer(command.color, 0, 0xffffffff) ||
          !Number.isFinite(command.depth) ||
          command.depth < 0 ||
          command.depth > 1 ||
          typeof command.clearColor !== 'boolean' ||
          typeof command.clearDepth !== 'boolean' ||
          (command.clearDepth && !surface.depthTexture) ||
          (command.regions !== undefined &&
            (!Array.isArray(command.regions) ||
              command.regions.length > 256 ||
              command.regions.some((r) => !validRegion(r, surface.width, surface.height))))
        )
          throw Error('Invalid graphics clear command');
        bytes += (command.regions?.length ?? 0) * 16;
      } else if (command.type === 'draw') {
        const textureBytes = validateTexturing(command.texturing);
        const texture = command.texturing?.texture;
        if (texture) {
          const key = `${texture.id}:${texture.revision}`;
          if (textures.has(key) && textures.get(key) !== texture)
            throw Error('Conflicting graphics texture snapshots');
          if (!textures.has(key)) {
            textureUploads += textureBytes;
            if (textureUploads > 32 * 1024 * 1024)
              throw Error('Graphics frame texture limit exceeded');
            textures.set(key, texture);
          }
        }
        if (
          !(command.vertices instanceof Uint8Array) ||
          !integer(command.vertexCount, 3, 65535) ||
          command.vertexCount % 3 ||
          !integer(command.stride, 16, 256) ||
          command.stride % 4 ||
          (command.fvf !== undefined && ![0x42, 0x142].includes(command.fvf)) ||
          (command.fvf === 0x142 && command.stride < 24) ||
          command.vertices.length <
            (command.vertexCount - 1) * command.stride + (command.fvf === 0x142 ? 24 : 16) ||
          !matrix(command.world) ||
          !matrix(command.view) ||
          !matrix(command.projection) ||
          !validRasterState(command) ||
          typeof command.depthTest !== 'boolean' ||
          typeof command.depthWrite !== 'boolean' ||
          (command.depthTest && !surface.depthTexture)
        )
          throw Error('Unsupported or invalid graphics draw command');
        bytes += command.vertices.length;
        if (bytes > MAX_FRAME_BYTES) throw Error('Graphics frame upload limit exceeded');
      } else if (command.type === 'draw-programmable') {
        this.programmable.validate(surface, command);
        bytes += command.vertices.length;
        if (bytes > MAX_FRAME_BYTES) throw Error('Graphics frame upload limit exceeded');
      } else throw Error(`Unsupported graphics command: ${command.type}`);
      if (bytes > MAX_FRAME_BYTES) throw Error('Graphics frame upload limit exceeded');
    }
  }

  pipeline(surface, command) {
    const key = [
      command.stride,
      !!surface.depthTexture,
      command.depthTest,
      command.depthWrite,
      command.depthCompare ?? 'less-equal',
      command.cullMode,
      surface.colorFormat,
      !!command.dither,
      command.fvf ?? 0x42,
      JSON.stringify(command.texturing?.stage),
      !!command.texturing?.texture,
      !!command.texturing?.sampler[7],
    ].join(':');
    if (!this.pipelines.has(key)) {
      if (command.texturing) this.textures.initialize();
      const code = fixedShader(command);
      const shader =
        command.texturing || surface.colorFormat === 23
          ? this.device.createShaderModule({
              code:
                surface.colorFormat === 23
                  ? rgb565Shader(code, 'fragmentMain', command.dither)
                  : code,
            })
          : this.shader;
      this.pipelines.set(
        key,
        this.device.createRenderPipeline({
          label: 'XYZ diffuse triangle pipeline',
          layout: command.texturing ? this.textures.pipelineLayout : this.pipelineLayout,
          vertex: {
            module: shader,
            entryPoint: 'vertexMain',
            buffers: [
              {
                arrayStride: command.stride,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x3' },
                  { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
                  ...(command.texturing && command.fvf === 0x142
                    ? [{ shaderLocation: 2, offset: 16, format: 'float32x2' }]
                    : []),
                ],
              },
            ],
          },
          fragment: {
            module: shader,
            entryPoint: 'fragmentMain',
            targets: [{ format: this.format }],
          },
          primitive: primitiveState(command.cullMode),
          ...(surface.depthTexture
            ? {
                depthStencil: {
                  format: 'depth16unorm',
                  depthWriteEnabled: command.depthTest && command.depthWrite,
                  depthCompare: command.depthTest
                    ? (command.depthCompare ?? 'less-equal')
                    : 'always',
                },
              }
            : {}),
        }),
      );
    }
    return this.pipelines.get(key);
  }

  upload(surface, index, command) {
    let slot = surface.slots[index];
    if (!slot) {
      const uniform = this.device.createBuffer({
        size: 192,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      slot = {
        uniform,
        bindGroup: this.device.createBindGroup({
          layout: this.bindLayout,
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        }),
      };
      surface.slots[index] = slot;
    }
    const size = Math.ceil(command.vertices.length / 4) * 4;
    // Match this draw's size exactly: retaining each slot's historic maximum
    // would let different large draws accumulate beyond the per-frame budget.
    if (!slot.vertex || slot.capacity !== size) {
      slot.vertex?.destroy();
      slot.vertex = this.device.createBuffer({
        size,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      slot.capacity = size;
    }
    const bytes = new Uint8Array(size);
    bytes.set(command.vertices);
    this.device.queue.writeBuffer(slot.vertex, 0, bytes);
    this.device.queue.writeBuffer(
      slot.uniform,
      0,
      new Float32Array([...command.world, ...command.view, ...command.projection]),
    );
    this.textures.upload(surface, slot, command);
    return slot;
  }

  async present({ id, commands }) {
    const surface = this.surfaces.get(id);
    if (!surface) throw Error('Graphics device has been released');
    if (this.failure) throw Error(this.failure);
    this.validate(surface, commands);
    const drawCount = commands.filter((command) => command.type === 'draw').length;
    const programmableCommands = commands.filter((command) => command.type === 'draw-programmable');
    const programmable = await Promise.all(
      programmableCommands.map((command, index) =>
        this.programmable.prepare(surface, index, command),
      ),
    );
    this.programmable.trim(surface, programmable.length);
    for (const slot of surface.slots.splice(drawCount)) {
      slot.vertex?.destroy();
      slot.uniform.destroy();
      slot.textureUniform?.destroy();
    }
    this.device.pushErrorScope('validation');
    let error;
    try {
      const texture = surface.colors[surface.colorIndex];
      const target = texture.createView();
      const depthView = surface.depthTexture?.createView();
      const encoder = this.device.createCommandEncoder();
      let pass = null,
        drawIndex = 0;
      const begin = (clear) => {
        pass?.end();
        pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: target,
              loadOp: clear?.clearColor ? 'clear' : 'load',
              storeOp: 'store',
              clearValue: clearColor(clear?.color ?? 0xff000000, surface.colorFormat),
            },
          ],
          ...(depthView
            ? {
                depthStencilAttachment: {
                  view: depthView,
                  depthLoadOp: clear?.clearDepth || !surface.depthInitialized ? 'clear' : 'load',
                  depthStoreOp: 'store',
                  depthClearValue: clear?.clearDepth ? clear.depth : 1,
                },
              }
            : {}),
        });
        surface.depthInitialized = true;
      };
      let programmableIndex = 0,
        clearIndex = 0;
      for (const command of commands) {
        if (command.type === 'clear') {
          const regions = command.regions ?? [
            { x: 0, y: 0, width: surface.width, height: surface.height },
          ];
          if (
            regions.some(
              (r) =>
                r.x === 0 && r.y === 0 && r.width === surface.width && r.height === surface.height,
            )
          ) {
            begin(command);
          } else if (regions.some((r) => r.width && r.height)) {
            if (!pass) begin();
            this.clears.draw(pass, surface, clearIndex++, command, regions);
          }
          continue;
        }
        if (!pass) begin();
        const v = command.viewport ?? defaultViewport(surface.width, surface.height);
        // A zero-area viewport has no fragments; consume prepared draw slots
        // normally so later draws retain their own uploaded data.
        pass.setViewport(v.x, v.y, v.width, v.height, v.minZ, v.maxZ);
        pass.setScissorRect(0, 0, surface.width, surface.height);
        if (command.type === 'draw-programmable') {
          this.programmable.draw(pass, programmable[programmableIndex++]);
        } else {
          const slot = this.upload(surface, drawIndex++, command);
          pass.setPipeline(this.pipeline(surface, command));
          pass.setBindGroup(0, slot.bindGroup);
          if (command.texturing) pass.setBindGroup(1, slot.textureBindGroup);
          pass.setVertexBuffer(0, slot.vertex);
          pass.draw(command.vertexCount);
        }
      }
      if (!pass) begin();
      pass.end();
      this.clears.trim(surface, clearIndex);
      if (surface.readback)
        encoder.copyTextureToBuffer(
          { texture },
          {
            buffer: surface.readback,
            bytesPerRow: surface.bytesPerRow,
            rowsPerImage: surface.height,
          },
          [surface.width, surface.height],
        );
      else
        encoder.copyTextureToTexture(
          { texture },
          { texture: surface.context.getCurrentTexture() },
          [surface.width, surface.height],
        );
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      this.textures.trim(surface, commands);
    } catch (caught) {
      error = caught;
    }
    const validation = await this.device.popErrorScope();
    if (error || validation)
      throw error ?? Error('WebGPU validation failed: ' + validation.message);
    // The virtual display refreshes at 60 Hz. This bounds virtual presentation;
    // the browser still owns physical compositor/vblank timing.
    if (surface.interval !== 0x80000000 && surface.lastPresented) {
      const delay = 1000 / 60 - (performance.now() - surface.lastPresented);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay)));
    }
    if (surface.readback) {
      await surface.readback.mapAsync(GPUMapMode.READ);
      try {
        const mapped = new Uint8Array(surface.readback.getMappedRange());
        const pixels = new Uint8ClampedArray(surface.width * surface.height * 4);
        const rowLength = surface.width * 4;
        for (let row = 0; row < surface.height; row++)
          pixels.set(
            mapped.subarray(row * surface.bytesPerRow, row * surface.bytesPerRow + rowLength),
            row * rowLength,
          );
        // A normal guest window presents opaque pixels, matching the hardware
        // canvas alphaMode even when D3D Clear supplies an unused zero alpha.
        for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255;
        surface.context2d.putImageData(new ImageData(pixels, surface.width, surface.height), 0, 0);
      } finally {
        surface.readback.unmap();
      }
    }
    const bitmap = surface.canvas.transferToImageBitmap();
    surface.lastPresented = performance.now();
    if (surface.swapEffect === 2) surface.colorIndex = 1 - surface.colorIndex;
    this.draws += drawCount + programmable.length;
    this.frames++;
    this.emit({
      type: 'frame',
      windowId: surface.windowId,
      width: surface.width,
      height: surface.height,
      bitmap,
      renderer: 'webgpu',
      graphicsFrames: this.frames,
      graphicsDraws: this.draws,
    });
  }

  destroyDevice({ id }) {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    for (const slot of surface.slots) {
      slot.vertex?.destroy();
      slot.uniform.destroy();
      slot.textureUniform?.destroy();
    }
    this.programmable.destroySurface(surface);
    this.textures.trim(surface);
    this.clears.trim(surface, 0);
    surface.depthTexture?.destroy();
    surface.readback?.destroy();
    for (const texture of surface.colors) texture.destroy();
    surface.context?.unconfigure();
    this.surfaces.delete(id);
  }

  dispose() {
    this.disposed = true;
    for (const id of this.surfaces.keys()) this.destroyDevice({ id });
    this.device?.destroy();
    this.device = null;
    this.pipelines.clear();
    this.programmable.dispose();
    this.clears.dispose();
    this.textures.dispose();
  }
}
