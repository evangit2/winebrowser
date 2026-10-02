import { blendKey, blendConstant, colorTarget, needsBlendFeedback } from './d3d-blending.js';
import { D3DBlendRenderer } from './d3d-blend-renderer.js';
import { fvfLayout } from './d3d-fvf.js';
import { validLighting, lightingUniforms } from './d3d-lighting.js';
import {
  D3DTextureRenderer,
  fixedShader,
  validateTexturing,
  textureStages,
} from './d3d-texture-renderer.js';
import { primitiveState, validRasterState } from './d3d-render-state.js';
import { D3D9ProgrammableRenderer } from './d3d9-programmable-renderer.js';
import { clearColor, rgb565Shader } from './d3d-presentation.js';
import { defaultViewport, validViewport, validRegion } from './d3d-viewport.js';
import { D3DClearRenderer } from './d3d-clear-renderer.js';
import { validStencil, validAlphaTest, stencilFace, stencilState } from './d3d-stencil.js';
import { validFog } from './d3d-fog.js';
import {
  targetGPUFormat,
  targetPixelBytes,
  colorTargetFormats,
  snapshotFormat,
} from './d3d-pixel-format.js';
import {
  MAX_DRAW_VERTICES,
  MAX_FRAME_BYTES,
  MAX_FRAME_COMMANDS as MAX_COMMANDS,
} from './d3d-limits.js';

// Browser graphics backend. Guest API objects and pointers stay in d3d9.js;
// this module consumes bounded, immutable geometry/state snapshots in a worker.
const COLOR_SHADER = fixedShader();
const MAX_DEVICES = 4;
const MAX_DIMENSION = 2048;
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
// A disabled stencil test passes every fragment and changes nothing.
const PASS_THROUGH_STENCIL = Object.freeze({
  compare: 'always',
  failOp: 'keep',
  depthFailOp: 'keep',
  passOp: 'keep',
});
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
    this.blending = new D3DBlendRenderer(this);
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
    // Direct3D applications overwhelmingly use block-compressed textures, so the
    // device asks for the BC formats when the adapter offers them. A device
    // created without the feature reports a clear error the moment such a
    // texture is created, which is a worse outcome than asking up front.
    const compressed = [
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
    ].filter((feature) => adapter.features?.has(feature));
    this.compressedFormats = compressed.includes('texture-compression-bc');
    // Native 16-bit normalized attachments require tier1. Their sampled
    // snapshots use filterable float32 to retain every UNORM16 component.
    this.supportsRGBA16Unorm =
      !!adapter.features?.has('texture-formats-tier1') &&
      !!adapter.features?.has('float32-filterable');
    if (this.supportsRGBA16Unorm) compressed.push('texture-formats-tier1', 'float32-filterable');
    this.device = await adapter.requestDevice(
      compressed.length ? { requiredFeatures: compressed } : {},
    );
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
    depthFormat = null,
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
      (depth
        ? !['depth16unorm', 'depth24plus', 'depth24plus-stencil8'].includes(depthFormat)
        : depthFormat !== null) ||
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
            format: depthFormat,
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
      gpuFormat: this.format,
      implicitDepth: depthTexture,
      implicitDepthFormat: depthFormat,
      targets: new Map(),
      depthTargets: new Map(),
      swapEffect,
      interval,
      lastPresented: 0,
      readback,
      bytesPerRow,
      depthTexture,
      depthFormat,
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
          typeof command.clearStencil !== 'boolean' ||
          !integer(command.stencil, 0, 0xff) ||
          (command.clearDepth && !surface.depthTexture) ||
          (command.clearStencil && surface.depthFormat !== 'depth24plus-stencil8') ||
          (command.regions !== undefined &&
            (!Array.isArray(command.regions) ||
              command.regions.length > 256 ||
              command.regions.some((r) => !validRegion(r, surface.width, surface.height))))
        )
          throw Error('Invalid graphics clear command');
        bytes += (command.regions?.length ?? 0) * 16;
      } else if (command.type === 'draw') {
        const layout = fvfLayout(command.fvf);
        if (
          !layout ||
          !validLighting(command.lighting) ||
          (command.specularEnable !== undefined && typeof command.specularEnable !== 'boolean')
        )
          throw Error('Invalid graphics fixed-function state');
        validateTexturing(command.texturing);
        for (const stage of textureStages(command.texturing)) {
          const textureBytes = validateTexturing(stage),
            texture = stage.texture;
          if (!texture) continue;
          if (snapshotFormat(texture) === 'rgba16unorm' && !this.supportsRGBA16Unorm)
            throw Error(
              'RGBA16 UNORM textures require WebGPU texture-formats-tier1 and float32-filterable',
            );
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
          !integer(command.vertexCount, 3, MAX_DRAW_VERTICES) ||
          command.vertexCount % 3 ||
          !integer(command.stride, layout.size, 256) ||
          command.stride % 4 ||
          command.vertices.length < (command.vertexCount - 1) * command.stride + layout.size ||
          !matrix(command.world) ||
          !matrix(command.view) ||
          !matrix(command.projection) ||
          !validRasterState(command) ||
          !validStencil(command) ||
          !validAlphaTest(command) ||
          !validFog(command.fog) ||
          typeof command.depthTest !== 'boolean' ||
          typeof command.depthWrite !== 'boolean' ||
          (command.depthTest && !surface.depthTexture) ||
          (stencilState(command)[52] && surface.depthFormat !== 'depth24plus-stencil8')
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
      blendKey(command),
      !!surface.depthTexture,
      surface.depthFormat,
      command.depthTest,
      command.depthWrite,
      command.depthCompare ?? 'less-equal',
      command.cullMode,
      surface.colorFormat,
      surface.gpuFormat ?? this.format,
      !!command.dither,
      command.fvf ?? 0x42,
      command.lighting
        ? [29, 141, 142, 143, 145, 146, 147, 148].map((k) => command.lighting.states[k]).join(',')
        : 'unlit',
      !!command.specularEnable,
      JSON.stringify(
        textureStages(command.texturing).map((t) => [
          t.stage,
          !!t.texture,
          t.texture?.dimension ?? '2d',
          !!t.sampler[7],
        ]),
      ),
      JSON.stringify(stencilState(command)),
      JSON.stringify(command.alphaTest ?? null),
      JSON.stringify(command.fog ?? null),
    ].join(':');
    if (!this.pipelines.has(key)) {
      if (command.texturing)
        this.textures.initialize(
          textureStages(command.texturing).map((t) => t.texture?.dimension ?? '2d'),
        );
      const feedback = needsBlendFeedback(surface, command);
      if (feedback) this.blending.initialize();
      const code = fixedShader(command);
      const shader =
        command.texturing ||
        command.lighting ||
        command.specularEnable ||
        (command.fvf ?? 0x42) !== 0x42 ||
        surface.colorFormat === 23
          ? this.device.createShaderModule({
              code:
                surface.colorFormat === 23
                  ? rgb565Shader(code, 'fragmentMain', command.dither, feedback ? command : null)
                  : code,
            })
          : this.shader;
      this.pipelines.set(
        key,
        this.device.createRenderPipeline({
          label: 'XYZ diffuse triangle pipeline',
          layout: feedback
            ? this.device.createPipelineLayout({
                bindGroupLayouts: [
                  this.bindLayout,
                  command.texturing ? this.textures.layout : this.blending.emptyLayout,
                  this.blending.layout,
                ],
              })
            : command.texturing
              ? this.textures.pipelineLayout
              : this.pipelineLayout,
          vertex: {
            module: shader,
            entryPoint: 'vertexMain',
            buffers: [
              {
                arrayStride: command.stride,
                attributes: fvfLayout(command.fvf).attributes,
              },
            ],
          },
          fragment: {
            module: shader,
            entryPoint: 'fragmentMain',
            targets: [colorTarget(surface, command, surface.gpuFormat ?? this.format)],
          },
          primitive: primitiveState(command.cullMode),
          ...(surface.depthTexture ? { depthStencil: this.depthStencil(surface, command) } : {}),
        }),
      );
    }
    return this.pipelines.get(key);
  }

  // WebGPU carries D3D's stencil comparison, three operations and reference
  // mask directly. Both faces share one D3D state because two-sided stencil is
  // not advertised.
  depthStencil(surface, command) {
    const descriptor = {
      format: surface.depthFormat,
      depthWriteEnabled: command.depthTest && command.depthWrite,
      depthCompare: command.depthTest ? (command.depthCompare ?? 'less-equal') : 'always',
    };
    if (surface.depthFormat !== 'depth24plus-stencil8') return descriptor;
    const s = stencilState(command),
      face = stencilFace(command),
      enabled = !!s[52];
    // A disabled stencil test still writes nothing and always passes, which is
    // exactly what the WebGPU comparison ALWAYS plus KEEP operations express.
    descriptor.stencilFront = enabled ? face : PASS_THROUGH_STENCIL;
    descriptor.stencilBack = enabled ? face : PASS_THROUGH_STENCIL;
    descriptor.stencilWriteMask = enabled ? s[59] & 0xff : 0;
    descriptor.stencilReadMask = enabled ? s[58] & 0xff : 0xff;
    return descriptor;
  }

  upload(surface, index, command) {
    let slot = surface.slots[index];
    const uniformSize = command.lighting ? 1232 : 192;
    if (!slot || slot.uniform.size !== uniformSize) {
      slot?.uniform.destroy();
      const uniform = this.device.createBuffer({
        size: uniformSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      slot = {
        ...slot,
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
      command.lighting
        ? lightingUniforms(command)
        : new Float32Array([...command.world, ...command.view, ...command.projection]),
    );
    this.textures.upload(surface, slot, command);
    return slot;
  }

  async render({ id, commands, target = null, depth = undefined, readback = false }) {
    const root = this.surfaces.get(id);
    if (!root) throw Error('Graphics device has been released');
    const surface = target ? this.targetSurface(root, target) : root;
    const depthResource = this.depthTarget(root, depth);
    const usesDepth =
      Array.isArray(commands) &&
      commands.some((command) =>
        command.type === 'clear'
          ? command.clearDepth || command.clearStencil
          : command.depthTest || command.depthWrite || stencilState(command)[52],
      );
    // D3D permits color-only work while a differently sized logical depth
    // surface remains selected. Do not attach or alter that unused resource.
    surface.depthTexture = usesDepth ? (depthResource?.texture ?? null) : null;
    surface.depthFormat = usesDepth ? (depthResource?.format ?? null) : null;
    surface.depthInitialized = depthResource?.initialized ?? false;
    if (
      surface.depthTexture &&
      (depthResource.width < surface.width || depthResource.height < surface.height)
    )
      throw Error(
        `Unsupported D3D depth/color attachment size mismatch: color ${surface.width}x${surface.height}, depth ${depthResource.width}x${depthResource.height}, ${commands.length} queued commands`,
      );
    const padding =
      surface.depthTexture &&
      (depthResource.width !== surface.width || depthResource.height !== surface.height)
        ? this.paddedColor(root, surface, depthResource)
        : null;
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
      this.textures.releaseSlot(slot);
      slot.blendUniform?.destroy();
    }
    this.device.pushErrorScope('validation');
    let error;
    try {
      const texture = surface.colors[surface.colorIndex];
      const target = (padding?.texture ?? texture).createView();
      const depthView = surface.depthTexture?.createView();
      const encoder = this.device.createCommandEncoder();
      if (padding)
        encoder.copyTextureToTexture({ texture }, { texture: padding.texture }, [
          surface.width,
          surface.height,
        ]);
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
                  ...(surface.depthFormat === 'depth24plus-stencil8'
                    ? {
                        stencilLoadOp:
                          clear?.clearStencil || !surface.depthInitialized ? 'clear' : 'load',
                        stencilStoreOp: 'store',
                        stencilClearValue: clear?.clearStencil ? clear.stencil : 0,
                      }
                    : {}),
                },
              }
            : {}),
        });
        if (depthView) surface.depthInitialized = true;
      };
      let programmableIndex = 0,
        clearIndex = 0;
      for (const command of commands) {
        if (command.type === 'clear') {
          const regions = command.regions ?? [
            { x: 0, y: 0, width: surface.width, height: surface.height },
          ];
          if (
            // D3D ignores pRects for a stencil clear, so a whole-attachment
            // clear is the only faithful path for one.
            (!padding && command.clearStencil) ||
            (!(padding && (command.clearDepth || command.clearStencil)) &&
              regions.some(
                (r) =>
                  r.x === 0 &&
                  r.y === 0 &&
                  r.width === surface.width &&
                  r.height === surface.height,
              ))
          ) {
            begin(command);
          } else if (regions.some((r) => r.width && r.height)) {
            if (!pass) begin();
            this.clears.draw(pass, surface, clearIndex++, command, regions);
          }
          continue;
        }
        const v = command.viewport ?? defaultViewport(surface.width, surface.height);
        const feedback = needsBlendFeedback(surface, command);
        const prepared =
          command.type === 'draw-programmable' ? programmable[programmableIndex++] : null;
        const slot = prepared ? null : this.upload(surface, drawIndex++, command);
        const pipeline = prepared?.pipeline ?? this.pipeline(surface, command);
        const feedbackGroup =
          prepared?.feedbackGroup ??
          (feedback ? this.blending.prepare(surface, slot, command) : null);
        const draw = (first, count) => {
          if (!pass) begin();
          pass.setViewport(v.x, v.y, v.width, v.height, v.minZ, v.maxZ);
          pass.setScissorRect(0, 0, surface.width, surface.height);
          pass.setBlendConstant(blendConstant(command));
          // The stencil comparison uses this reference, already clamped to the
          // guest's 0-255 STENCILREF byte.
          if (surface.depthFormat === 'depth24plus-stencil8')
            pass.setStencilReference(stencilState(command)[57] & 0xff);
          if (feedback) pass.setBindGroup(2, feedbackGroup);
          if (prepared) this.programmable.draw(pass, prepared, first, count);
          else {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, slot.bindGroup);
            if (command.texturing) pass.setBindGroup(1, slot.textureBindGroup);
            else if (feedback) pass.setBindGroup(1, this.blending.emptyGroup);
            pass.setVertexBuffer(0, slot.vertex);
            pass.draw(count, 1, first);
          }
        };
        if (!v.width || !v.height) continue;
        if (feedback) {
          // Resolve after EACH primitive, including overlapping triangles in
          // one DrawPrimitiveUP. Depth/discard still run in the guest pipeline.
          for (let first = 0; first < command.vertexCount; first += 3) {
            pass?.end();
            pass = null;
            encoder.copyTextureToTexture(
              { texture: padding?.texture ?? texture, origin: [v.x, v.y] },
              { texture: surface.blendFeedback, origin: [v.x, v.y] },
              [v.width, v.height],
            );
            draw(first, 3);
          }
        } else draw(0, command.vertexCount);
      }
      if (!pass) begin();
      pass.end();
      if (padding)
        encoder.copyTextureToTexture({ texture: padding.texture }, { texture }, [
          surface.width,
          surface.height,
        ]);
      this.clears.trim(surface, clearIndex);
      let buffer = null;
      if (readback) {
        const bytesPerRow =
          Math.ceil((surface.width * targetPixelBytes(surface.colorFormat)) / 256) * 256;
        buffer = this.device.createBuffer({
          size: bytesPerRow * surface.height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        encoder.copyTextureToBuffer(
          { texture },
          { buffer, bytesPerRow, rowsPerImage: surface.height },
          [surface.width, surface.height],
        );
        surface.pendingReadback = { buffer, bytesPerRow };
      }
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      this.textures.trim(surface, commands);
    } catch (caught) {
      error = caught;
    }
    const validation = await this.device.popErrorScope();
    if (error || validation) {
      surface.pendingReadback?.buffer.destroy();
      surface.pendingReadback = null;
      throw error ?? Error('WebGPU validation failed: ' + validation.message);
    }
    if (depthResource && usesDepth) depthResource.initialized = surface.depthInitialized;
    this.draws += drawCount + programmable.length;
    const pending = surface.pendingReadback;
    surface.pendingReadback = null;
    if (!pending) return null;
    const { buffer, bytesPerRow } = pending;
    try {
      await buffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint8Array(buffer.getMappedRange());
      const rowBytes = surface.width * targetPixelBytes(surface.colorFormat);
      const pixels = new Uint8Array(rowBytes * surface.height);
      for (let row = 0; row < surface.height; row++)
        pixels.set(
          mapped.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes),
          row * rowBytes,
        );
      if (surface.gpuFormat === 'bgra8unorm')
        for (let i = 0; i < pixels.length; i += 4)
          [pixels[i], pixels[i + 2]] = [pixels[i + 2], pixels[i]];
      return pixels;
    } finally {
      buffer.unmap();
      buffer.destroy();
    }
  }

  targetSurface(root, description) {
    const { id, width, height, colorFormat } = description;
    if (
      !integer(id, 1, 0xffffffff) ||
      !integer(width, 1, MAX_DIMENSION) ||
      !integer(height, 1, MAX_DIMENSION) ||
      !colorTargetFormats.includes(colorFormat) ||
      (colorFormat === 36 && !this.supportsRGBA16Unorm)
    )
      throw Error('Invalid D3D offscreen target');
    let surface = root.targets.get(id);
    if (surface) {
      if (
        surface.width !== width ||
        surface.height !== height ||
        surface.colorFormat !== colorFormat
      )
        throw Error('Conflicting D3D offscreen target description');
      return surface;
    }
    const byteSize = width * height * targetPixelBytes(colorFormat);
    if ((root.targetBytes ?? 0) + byteSize > 32 * 1024 * 1024)
      throw Error('D3D offscreen target storage limit exceeded');
    const texture = this.device.createTexture({
      label: 'D3D offscreen color target',
      size: [width, height],
      format: targetGPUFormat(colorFormat),
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    surface = {
      width,
      height,
      colorFormat,
      gpuFormat: targetGPUFormat(colorFormat),
      colors: [texture],
      colorIndex: 0,
      slots: [],
    };
    root.targets.set(id, surface);
    root.targetBytes = (root.targetBytes ?? 0) + byteSize;
    return surface;
  }

  paddedColor(root, surface, depth) {
    const existing = surface.paddedColor;
    if (existing?.width === depth.width && existing?.height === depth.height) return existing;
    const bytes = depth.width * depth.height * targetPixelBytes(surface.colorFormat);
    const previous = existing?.bytes ?? 0;
    if ((root.targetBytes ?? 0) + (root.paddingBytes ?? 0) - previous + bytes > 32 * 1024 * 1024)
      throw Error('D3D padded attachment storage limit exceeded');
    const texture = this.device.createTexture({
      label: 'D3D color attachment padded to shared depth extent',
      size: [depth.width, depth.height],
      format: surface.gpuFormat,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    existing?.texture.destroy();
    root.paddingBytes = (root.paddingBytes ?? 0) - previous + bytes;
    return (surface.paddedColor = { texture, width: depth.width, height: depth.height, bytes });
  }

  depthTarget(root, description) {
    if (description === null) return null;
    if (description === undefined || description.implicit) {
      if (!root.implicitDepth) return null;
      return (root.implicitDepthResource ??= {
        texture: root.implicitDepth,
        format: root.implicitDepthFormat,
        width: root.width,
        height: root.height,
        initialized: false,
      });
    }
    const { id, width, height, format } = description;
    if (
      !integer(id, 1, 0xffffffff) ||
      !integer(width, 1, MAX_DIMENSION) ||
      !integer(height, 1, MAX_DIMENSION) ||
      !['depth16unorm', 'depth24plus', 'depth24plus-stencil8'].includes(format)
    )
      throw Error('Invalid D3D offscreen depth target');
    let resource = root.depthTargets.get(id);
    if (resource) {
      if (resource.width !== width || resource.height !== height || resource.format !== format)
        throw Error('Conflicting D3D depth target description');
      return resource;
    }
    if ((root.depthTargetBytes ?? 0) + width * height * 4 > 32 * 1024 * 1024)
      throw Error('D3D offscreen depth storage limit exceeded');
    resource = {
      width,
      height,
      format,
      initialized: false,
      texture: this.device.createTexture({
        label: 'D3D offscreen depth target',
        size: [width, height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
    };
    root.depthTargets.set(id, resource);
    root.depthTargetBytes = (root.depthTargetBytes ?? 0) + width * height * 4;
    return resource;
  }

  destroyTarget({ id, targetId }) {
    const root = this.surfaces.get(id);
    if (!root) return;
    const surface = root.targets.get(targetId);
    if (surface) {
      root.paddingBytes = (root.paddingBytes ?? 0) - (surface.paddedColor?.bytes ?? 0);
      this.destroySurfaceResources(surface);
      root.targets.delete(targetId);
      root.targetBytes -= surface.width * surface.height * targetPixelBytes(surface.colorFormat);
    }
    const depth = root.depthTargets.get(targetId);
    if (depth) {
      depth.texture.destroy();
      root.depthTargets.delete(targetId);
      root.depthTargetBytes -= depth.width * depth.height * 4;
    }
  }

  async present({ id, commands, depth = undefined }) {
    await this.render({ id, commands, depth });
    const surface = this.surfaces.get(id);
    const texture = surface.colors[surface.colorIndex];
    const encoder = this.device.createCommandEncoder();
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
      encoder.copyTextureToTexture({ texture }, { texture: surface.context.getCurrentTexture() }, [
        surface.width,
        surface.height,
      ]);
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
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
    for (const target of surface.targets.values()) this.destroySurfaceResources(target);
    for (const depth of surface.depthTargets.values()) depth.texture.destroy();
    surface.implicitDepth?.destroy();
    this.destroySurfaceResources(surface);
    surface.readback?.destroy();
    surface.context?.unconfigure();
    this.surfaces.delete(id);
  }

  destroySurfaceResources(surface) {
    for (const slot of surface.slots) {
      slot.vertex?.destroy();
      slot.uniform.destroy();
      this.textures.releaseSlot(slot);
      slot.blendUniform?.destroy();
    }
    this.programmable.destroySurface(surface);
    this.textures.trim(surface);
    this.clears.trim(surface, 0);
    surface.blendFeedback?.destroy();
    surface.pendingReadback?.buffer.destroy();
    surface.paddedColor?.texture.destroy();
    for (const texture of surface.colors) texture.destroy();
  }

  dispose() {
    this.disposed = true;
    for (const id of this.surfaces.keys()) this.destroyDevice({ id });
    this.device?.destroy();
    this.device = null;
    this.pipelines.clear();
    this.programmable.dispose();
    this.clears.dispose();
    this.blending.dispose();
    this.textures.dispose();
  }
}
