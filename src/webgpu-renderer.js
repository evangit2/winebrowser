import { D3D9ProgrammableRenderer } from './d3d9-programmable-renderer.js';

// Browser graphics backend. Guest API objects and pointers stay in d3d9.js;
// this module consumes bounded, immutable geometry/state snapshots in a worker.
const COLOR_SHADER = `
struct Transforms { world: mat4x4<f32>, view: mat4x4<f32>, projection: mat4x4<f32> }
@group(0) @binding(0) var<uniform> transforms: Transforms;
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) color: vec4<f32> }
@vertex fn vertexMain(@location(0) position: vec3<f32>, @location(1) bgra: vec4<f32>) -> VertexOut {
  var output: VertexOut;
  // D3D matrices are stored row-major for row vectors; WGSL reads those bytes
  // as transposed column-major matrices, preserving D3D's transform order.
  output.position = transforms.projection * transforms.view * transforms.world * vec4(position, 1.0);
  output.color = bgra.bgra;
  return output;
}
@fragment fn fragmentMain(input: VertexOut) -> @location(0) vec4<f32> { return input.color; }
`;
const MAX_DEVICES = 4;
const MAX_DIMENSION = 2048;
const MAX_COMMANDS = 256;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const color = (argb) => ({
  r: ((argb >>> 16) & 255) / 255,
  g: ((argb >>> 8) & 255) / 255,
  b: (argb & 255) / 255,
  a: ((argb >>> 24) & 255) / 255,
});
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

  async createDevice({ id, windowId, width, height, depth }) {
    if (
      !integer(id, 1, 0xffffffff) ||
      this.surfaces.has(id) ||
      this.surfaces.size >= MAX_DEVICES ||
      !integer(windowId, 1, 0xffffffff) ||
      !integer(width, 1, MAX_DIMENSION) ||
      !integer(height, 1, MAX_DIMENSION) ||
      typeof depth !== 'boolean'
    )
      throw Error('Invalid or oversized graphics surface');
    await this.initialize();
    const canvas = new OffscreenCanvas(width, height);
    let context = null,
      context2d = null,
      renderTexture = null,
      readback = null,
      depthTexture = null,
      bytesPerRow = 0;
    try {
      if (this.presentationMode === 'readback') {
        context2d = canvas.getContext('2d');
        if (!context2d) throw Error('2D OffscreenCanvas is unavailable for WebGPU readback');
        renderTexture = this.device.createTexture({
          label: 'guest color buffer for readback',
          size: [width, height],
          format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        readback = this.device.createBuffer({
          label: 'guest frame readback',
          size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      } else {
        context = canvas.getContext('webgpu');
        if (!context) throw Error('WebGPU OffscreenCanvas is unavailable');
        context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
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
      renderTexture?.destroy();
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
      renderTexture,
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
    let bytes = 0;
    for (const command of commands) {
      if (command.type === 'clear') {
        if (
          !integer(command.color, 0, 0xffffffff) ||
          !Number.isFinite(command.depth) ||
          command.depth < 0 ||
          command.depth > 1 ||
          typeof command.clearColor !== 'boolean' ||
          typeof command.clearDepth !== 'boolean' ||
          (command.clearDepth && !surface.depthTexture)
        )
          throw Error('Invalid graphics clear command');
      } else if (command.type === 'draw') {
        if (
          !(command.vertices instanceof Uint8Array) ||
          !integer(command.vertexCount, 3, 65535) ||
          command.vertexCount % 3 ||
          !integer(command.stride, 16, 256) ||
          command.stride % 4 ||
          command.vertices.length < (command.vertexCount - 1) * command.stride + 16 ||
          !matrix(command.world) ||
          !matrix(command.view) ||
          !matrix(command.projection) ||
          command.cullMode !== 'none' ||
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
    }
  }

  pipeline(surface, command) {
    const key = [
      command.stride,
      !!surface.depthTexture,
      command.depthTest,
      command.depthWrite,
    ].join(':');
    if (!this.pipelines.has(key))
      this.pipelines.set(
        key,
        this.device.createRenderPipeline({
          label: 'XYZ diffuse triangle pipeline',
          layout: this.pipelineLayout,
          vertex: {
            module: this.shader,
            entryPoint: 'vertexMain',
            buffers: [
              {
                arrayStride: command.stride,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x3' },
                  { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
                ],
              },
            ],
          },
          fragment: {
            module: this.shader,
            entryPoint: 'fragmentMain',
            targets: [{ format: this.format }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          ...(surface.depthTexture
            ? {
                depthStencil: {
                  format: 'depth16unorm',
                  depthWriteEnabled: command.depthTest && command.depthWrite,
                  depthCompare: command.depthTest ? 'less-equal' : 'always',
                },
              }
            : {}),
        }),
      );
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
    }
    this.device.pushErrorScope('validation');
    let error;
    try {
      const target = (surface.renderTexture ?? surface.context.getCurrentTexture()).createView();
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
              clearValue: color(clear?.color ?? 0xff000000),
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
      let programmableIndex = 0;
      for (const command of commands) {
        if (command.type === 'clear') {
          begin(command);
          continue;
        }
        if (!pass) begin();
        if (command.type === 'draw-programmable') {
          this.programmable.draw(pass, programmable[programmableIndex++]);
        } else {
          const slot = this.upload(surface, drawIndex++, command);
          pass.setPipeline(this.pipeline(surface, command));
          pass.setBindGroup(0, slot.bindGroup);
          pass.setVertexBuffer(0, slot.vertex);
          pass.draw(command.vertexCount);
        }
      }
      if (!pass) begin();
      pass.end();
      if (surface.readback)
        encoder.copyTextureToBuffer(
          { texture: surface.renderTexture },
          {
            buffer: surface.readback,
            bytesPerRow: surface.bytesPerRow,
            rowsPerImage: surface.height,
          },
          [surface.width, surface.height],
        );
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
    } catch (caught) {
      error = caught;
    }
    const validation = await this.device.popErrorScope();
    if (error || validation)
      throw error ?? Error('WebGPU validation failed: ' + validation.message);
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
    }
    this.programmable.destroySurface(surface);
    surface.depthTexture?.destroy();
    surface.readback?.destroy();
    surface.renderTexture?.destroy();
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
  }
}
