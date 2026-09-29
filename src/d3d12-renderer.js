import { ShaderCompiler } from './shader-compiler.js';
import { reflectDXBCInputSignature } from './dxbc-signature.js';
import { validateIndexSnapshot } from './d3d12-indices.js';
import {
  canonicalBindings,
  DRAW_PARAMETER_GROUP,
  resolveDescriptorPlacement,
} from './d3d12-bindings.js';

const DESCRIPTOR_KIND_NAMES = ['shader resource view', 'unordered access view', 'constant buffer', 'sampler'];

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

// D3D12_FILTER -> WebGPU min/mag/mip filter and anisotropy. The equality and
// comparison filters are unsupported (the backend has no shadow sampler path),
// which is reported rather than silently changed to a filtering sampler.
const D3D12_ADDRESS = { 1: 'repeat', 2: 'mirror-repeat', 3: 'clamp-to-edge' };
// DXGI_FORMAT -> WebGPU format and sample type for the sampled textures this
// backend models. The D3D12 format codes match the ones the frontend accepts.
const DXGI_TEXTURE_FORMATS = {
  28: { format: 'rgba8unorm', sampleType: 'float' },
  87: { format: 'bgra8unorm', sampleType: 'float' },
  49: { format: 'r16unorm', sampleType: 'float' },
  61: { format: 'r8unorm', sampleType: 'float' },
};
const TEXTURE_FORMAT_BYTES = { 28: 4, 87: 4, 49: 2, 61: 1 };
function sampleTypeForFormat(format) {
  return DXGI_TEXTURE_FORMATS[format]?.sampleType ?? 'float';
}
function toSamplerDescriptor(sampler) {
  if (sampler.comparison) throw Error('Unsupported D3D12 comparison sampler');
  const filter = sampler.filter;
  if (!Number.isInteger(filter) || filter > 0x155) throw Error('Unsupported D3D12 sampler filter');
  const point = (value) => (value ? 'nearest' : 'linear');
  const anisotropic = (filter & 0x55) === 0x55 && (filter & 0xf) !== 0;
  const mag = point(filter & 0x4);
  const min = point(filter & 0x10);
  const mip = point(filter & 0x100);
  const address = (mode) => {
    const mapped = D3D12_ADDRESS[mode];
    if (!mapped) throw Error('Unsupported D3D12 sampler address mode ' + mode);
    return mapped;
  };
  return {
    magFilter: mag,
    minFilter: min,
    mipmapFilter: mip,
    addressModeU: address(sampler.addressU),
    addressModeV: address(sampler.addressV),
    addressModeW: address(sampler.addressW),
    ...(anisotropic && sampler.maxAnisotropy > 1
      ? { maxAnisotropy: Math.min(16, sampler.maxAnisotropy) }
      : {}),
  };
}

// The binding table a stage must be compiled against. Every declared register
// is placed at its canonical group/binding; the record keeps the descriptor's
// own resource kind so the bridge can set the matching binding flag.
function placementsFor(plan, descriptors) {
  return descriptors.map((descriptor) => {
    const assignment = plan.lookup.get(
      `${descriptor.type}:${descriptor.space}:${descriptor.register}`,
    );
    return {
      type: descriptor.type,
      space: descriptor.space,
      register: descriptor.register,
      resourceType: descriptor.resourceType,
      count: descriptor.count ?? 1,
      group: assignment?.group ?? 0,
      binding: assignment?.binding ?? 0,
    };
  });
}
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

  /**
   * Serializes an application-declared root signature from the flattened
   * description the frontend parsed out of the guest structure.
   */
  async buildRootSignature(words) {
    return this.compiler.buildRootSignature(words);
  }

  /**
   * Parses a serialized root signature into its structured form plus the raw
   * inspection words, which the frontend keeps to resolve bindings at draw
   * time and to derive the canonical WebGPU layout.
   */
  async inspectRootSignature(bytes) {
    return this.compiler.inspectRootSignature(bytes);
  }

  /**
   * Enumerates the D3D descriptors a compiled shader declares, so a pipeline
   * can be compiled against the canonical bindings its root signature implies.
   */
  async scanShader(bytes) {
    return this.compiler.scanDescriptors(bytes);
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
      !['depth', 'texture'].includes(kind) ||
      !integer(width, 1, 2048) ||
      !integer(height, 1, 2048) ||
      typeof format !== 'string'
    )
      throw Error('Unsupported D3D12 texture resource');
    if (kind === 'depth' && format !== 'depth16unorm')
      throw Error('Unsupported D3D12 depth resource');
    await this.initialize();
    this.device.pushErrorScope('validation');
    // A sampled texture is uploaded through CopyTextureRegion and then read by
    // a shader, so it needs both a copy destination and a binding usage.
    const texture = this.device.createTexture({
      label: `D3D12 ${kind} resource`,
      size: [width, height],
      format,
      usage:
        kind === 'depth'
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const error = await this.device.popErrorScope();
    if (error) {
      texture.destroy();
      throw Error(error.message);
    }
    this.resources.set(id, { kind, width, height, format, texture });
  }

  async createPipeline({
    id,
    vertex,
    pixel,
    inputLayout = [],
    vertexStride = 0,
    depth = null,
    cullMode = 'none',
    frontFace = 'cw',
    rootPlan = null,
  }) {
    if (!integer(id, 1, 0xffffffff) || this.pipelines.has(id) || this.pipelines.size >= 32)
      throw Error('D3D12 pipeline limit exceeded');
    if (!Array.isArray(inputLayout)) throw Error('Unsupported D3D12 input layout');
    const widthOf = (format) =>
      ({ float32x2: 2, float32x3: 3, float32x4: 4, sint32x4: 4, uint32x4: 4 })[format] ?? 0;
    if (!(
      (inputLayout.length === 0 && vertexStride === 0) ||
      (inputLayout.length &&
        Number.isInteger(vertexStride) &&
        vertexStride >= 4 &&
        vertexStride % 4 === 0 &&
        vertexStride <= 256 &&
        inputLayout.every(
          (attribute, index) =>
            Number.isInteger(attribute.offset) &&
            attribute.offset % 4 === 0 &&
            attribute.offset + widthOf(attribute.format) * 4 <= vertexStride &&
            (index === 0 || attribute.offset > inputLayout[index - 1].offset),
        ) &&
        inputLayout.every(
          (attribute) => widthOf(attribute.format) > 0 && !!attribute.semanticName,
        ))
    ))
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
    const attributes = inputLayout.map((attribute) => {
      const semantic = (attribute.semanticName ?? attribute.semantic ?? '').toUpperCase();
      const entry = signature.find(
        (input) =>
          input.semanticName.toUpperCase() === semantic &&
          input.semanticIndex === attribute.semanticIndex,
      );
      if (!entry || entry.register > 15)
        throw Error('Unsupported D3D12 vertex shader input: ' + semantic);
      // The declared format may supply fewer components than the shader reads:
      // the D3D input assembler fills the remainder (w=1 for position) and
      // WebGPU does the same for a smaller buffer format bound to a larger
      // shader location. Supplying more components than the shader reads is
      // allowed too, matching D3D's unused-component behavior.
      if (!widthOf(attribute.format))
        throw Error('Unsupported D3D12 vertex format: ' + attribute.format);
      return {
        shaderLocation: entry.register,
        format: attribute.format,
        offset: attribute.offset,
      };
    });
    await this.initialize();
    // When the root signature declares any root parameter, the pipeline's two
    // stages may reference constant buffers, textures or samplers. Scan both
    // for their declared registers, give each register one canonical
    // (group, binding), and compile each stage against that layout so the
    // emitted SPIR-V matches the explicit pipeline layout built below. A root
    // signature with no parameters keeps the long-standing empty-layout path.
    const declaresResources = !!rootPlan && rootPlan.parameterCount > 0;
    let plan = null;
    if (declaresResources) {
      const scanned = [
        ...(await this.compiler.scanDescriptors(vertex)),
        ...(await this.compiler.scanDescriptors(pixel)),
      ];
      plan = canonicalBindings(scanned);
      // Every register the shaders use must be reachable through the
      // signature; an unreachable one would silently read nothing at draw time.
      for (const binding of plan.bindings) {
        if (!resolveDescriptorPlacement(rootPlan, binding))
          throw Error(
            `D3D12 root signature does not declare ${DESCRIPTOR_KIND_NAMES[binding.type]}` +
              ` register ${binding.register}, space ${binding.space}`,
          );
      }
    }
    const descriptors = plan ? plan.bindings : [];
    const vs = plan
      ? await this.compiler.compileBound(vertex, placementsFor(plan, descriptors))
      : await this.compiler.compile(vertex);
    const ps = plan
      ? await this.compiler.compileBound(pixel, placementsFor(plan, descriptors))
      : await this.compiler.compile(pixel);
    const canonical = plan ? this.pipelineLayout(plan) : null;
    const layout = canonical?.layout ?? this.layout;
    this.device.pushErrorScope('validation');
    let pipeline, failure;
    try {
      pipeline = await this.device.createRenderPipelineAsync({
        label: 'D3D12 translated DXBC pipeline',
        layout,
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
        primitive: { topology: 'triangle-list', cullMode, frontFace },
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
    this.pipelines.set(id, {
      pipeline,
      vertexStride,
      depth,
      cullMode,
      frontFace,
      plan,
      bindings: plan?.bindings ?? [],
      groupLayouts: canonical?.groupLayouts ?? null,
    });
    this.graphics.emit({
      type: 'log',
      text: plan
        ? `D3D12 DXBC shaders compiled to WGSL with ${plan.bindings.length} canonical bindings`
        : 'D3D12 DXBC shaders compiled to WGSL in the browser worker',
    });
    return { bindings: plan?.bindings ?? [] };
  }

  // The pipeline layout implied by a canonical binding plan. Groups 0..2 carry
  // the constant buffers, SRVs/UAVs and samplers; group 3 stays the draw
  // parameter uniform vkd3d-shader emits for base vertex/instance.
  pipelineLayout(plan) {
    const entriesKey = plan.layouts
      .map((entry) => `${entry.group}:${entry.entries.map((e) => e.binding).join(',')}`)
      .join('|');
    this.canonicalLayouts ??= new Map();
    const cached = this.canonicalLayouts.get(entriesKey);
    if (cached) return cached;
    // One bind group layout per canonical group. These exact objects are reused
    // to build the draw-time bind groups, because WebGPU requires a bind group's
    // layout to be equivalent to the pipeline layout's group.
    const groupLayouts = plan.layouts.map((entry) =>
      entry.entries.length
        ? this.device.createBindGroupLayout({ entries: entry.entries })
        : this.emptyLayout,
    );
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [...groupLayouts.slice(0, DRAW_PARAMETER_GROUP), this.drawLayout],
    });
    const record = { layout, groupLayouts };
    this.canonicalLayouts.set(entriesKey, record);
    return record;
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

  /**
   * Builds one WebGPU bind group per canonical group from a draw's resolved
   * bindings. Uniform (constant buffer and inline constant) data is uploaded to
   * a reused per-slot buffer; samplers and texture views bind the resources the
   * backend created for them.
   */
  bindingGroups(bindings, drawIndex, groupLayouts) {
    // A pipeline built from a parameterless root signature binds only the
    // built-in empty groups, which the caller supplies.
    if (!groupLayouts) return null;
    const entries = new Map([
      [0, []],
      [1, []],
      [2, []],
    ]);
    for (const binding of bindings ?? []) {
      const resource = this.bindingResource(binding, drawIndex);
      if (!resource) throw Error('D3D12 binding has no bound resource');
      const list = entries.get(binding.group);
      if (!list) throw Error(`D3D12 binding group ${binding.group} is outside the canonical groups`);
      list.push({ binding: binding.binding, resource: resource.resource });
    }
    const groups = [null, null, null];
    for (const [group, list] of entries) {
      // Every group the pipeline declares is bound, even when empty, so the
      // pipeline's layout and the bound groups stay aligned.
      const layout = groupLayouts[group];
      const expected = layout === this.emptyLayout ? [] : list;
      groups[group] = this.device.createBindGroup({ layout, entries: expected });
    }
    return groups;
  }

  /**
   * The concrete WebGPU resource for one resolved binding, or null when the
   * binding carries no drawable data. Uniform bytes go through a per-slot
   * staging buffer so a later upload cannot change an already-recorded draw.
   */
  bindingResource(binding, drawIndex) {
    if (binding.kind === 'sampler') {
      const cache = (this.samplerCache ??= new Map());
      const key = JSON.stringify(binding.sampler);
      let sampler = cache.get(key);
      if (!sampler) {
        sampler = this.device.createSampler(toSamplerDescriptor(binding.sampler));
        cache.set(key, sampler);
      }
      return { layout: { sampler: { type: binding.sampler.comparison ? 'comparison' : 'filtering' } }, resource: sampler };
    }
    if (binding.kind === 'uniform') {
      const slot = this.uniformSlot(drawIndex, binding.group, binding.binding);
      this.device.queue.writeBuffer(slot.buffer, 0, binding.bytes);
      return {
        layout: { buffer: { type: 'uniform' } },
        resource: { buffer: slot.buffer, offset: 0, size: binding.bytes.length },
      };
    }
    if (binding.kind === 'texture-view') {
      const view = this.textureBindingResource(binding.descriptor);
      if (view) return view;
    }
    return null;
  }

  uniformSlot(drawIndex, group, binding) {
    const key = `${drawIndex}:${group}:${binding}`;
    let slot = this.uniformSlots?.get(key);
    if (!slot) {
      slot = { buffer: this.device.createBuffer({ size: 65536, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) };
      this.uniformSlots ??= new Map();
      this.uniformSlots.set(key, slot);
    }
    return slot;
  }

  async execute({ commands }) {
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
          // A pipeline built from a parameterless root signature has no
          // canonical layout and binds only the built-in empty groups.
          const groups =
            this.bindingGroups(
              command.bindings,
              draws,
              this.pipelines.get(command.pipeline)?.groupLayouts,
            ) ?? [];
          for (let group = 0; group < 3; group++)
            pass.setBindGroup(group, groups[group] ?? this.emptyGroup);
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

  /**
   * Uploads one subresource of a texture from a placed-footprint source buffer.
   * `rows` already carries the source row pitch, so the copy preserves the
   * D3D12 layout the application computed through GetCopyableFootprints.
   */
  async uploadTexture({ id, width, height, bytesPerRow, rows }) {
    await this.initialize();
    const resource = this.resources.get(id);
    if (!resource || resource.kind !== 'texture')
      throw Error('D3D12 texture upload target is missing');
    if (!(rows instanceof Uint8Array) || !bytesPerRow)
      throw Error('D3D12 texture upload data is invalid');
    if (bytesPerRow < width * TEXTURE_FORMAT_BYTES[resource.format])
      throw Error('D3D12 texture upload row pitch is too small');
    if (rows.length < bytesPerRow * height)
      throw Error('D3D12 texture upload covers too few rows');
    this.device.queue.writeTexture(
      { texture: resource.texture },
      rows.subarray(0, bytesPerRow * height),
      { bytesPerRow, rowsPerImage: height },
      [width, height, 1],
    );
  }

  /** A texture view for a shader resource descriptor, or null when unsupported. */
  textureBindingResource(descriptor) {
    const resource = this.resources.get(descriptor.resource.pointer);
    if (!resource || resource.kind !== 'texture') return null;
    const key = `${descriptor.resource.pointer}:${descriptor.format ?? resource.format}`;
    this.textureViews ??= new Map();
    let view = this.textureViews.get(key);
    if (!view) {
      view = resource.texture.createView();
      this.textureViews.set(key, view);
    }
    return {
      layout: { texture: { sampleType: sampleTypeForFormat(resource.format) } },
      resource: view,
    };
  }

  destroyPipeline({ id }) {
    this.pipelines.delete(id);
  }

  destroyResource({ id }) {
    const resource = this.resources.get(id);
    if (!resource || resource.kind === 'color') return;
    for (const key of this.textureViews?.keys() ?? [])
      if (key.startsWith(`${id}:`)) this.textureViews.delete(key);
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
    for (const slot of this.uniformSlots?.values() ?? []) slot.buffer.destroy();
    this.uniformSlots?.clear();
    this.samplerCache?.clear();
    this.drawSlots.length = 0;
    this.vertexSlots.length = 0;
    this.indexSlots.length = 0;
    this.pipelines.clear();
  }
}
