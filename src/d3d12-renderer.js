import { ShaderCompiler } from './shader-compiler.js';
import { reflectDXBCInputSignature } from './dxbc-signature.js';
import { validateIndexSnapshot } from './d3d12-indices.js';
import {
  canonicalBindings,
  DRAW_PARAMETER_GROUP,
  resolveDescriptorPlacement,
} from './d3d12-bindings.js';
import { planStageBindings, stageLayoutEntries } from './d3d10-bindings.js';

const DESCRIPTOR_KIND_NAMES = [
  'shader resource view',
  'unordered access view',
  'constant buffer',
  'sampler',
];

const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;

// D3D12's default is "write all channels"; an absent or disabled target writes
// every channel with blending off.
function colorTargetFor(target, alphaToCoverage, format = 'rgba8unorm') {
  const writeMask = target?.writeMask ?? 0xf;
  if (!target?.enabled) return { format, writeMask };
  return {
    format,
    writeMask,
    blend: {
      color: {
        operation: target.color.operation,
        srcFactor: target.color.srcFactor,
        dstFactor: target.color.dstFactor,
      },
      alpha: {
        operation: target.alpha.operation,
        srcFactor: target.alpha.srcFactor,
        dstFactor: target.alpha.dstFactor,
      },
    },
  };
}

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
// The frontends hand the backend a WebGPU format name (d3d12.js maps the DXGI
// code first), so the byte table is keyed by that name. A DXGI code here would
// make every lookup undefined and a `bytesPerRow < NaN` comparison silently true,
// which is what let an unchecked pitch through before.
const TEXTURE_FORMAT_BYTES = { rgba8unorm: 4, bgra8unorm: 4, r16unorm: 2, r8unorm: 1 };
// The depth attachment formats WebGPU guarantees, in the precision order a
// D3D application names them: D16_UNORM, D32_FLOAT and D24_UNORM_S8_UINT.
const DEPTH_FORMATS = ['depth16unorm', 'depth32float', 'depth24plus-stencil8'];
// Block-compressed sampled formats. WebGPU stores the same 4x4 blocks, so a
// texture in one of these uploads its bytes unchanged; only the copy footprint
// differs, because rows are block rows and a texel is 4x4.
const COMPRESSED_FORMATS = [
  'bc1-rgba-unorm',
  'bc1-rgba-unorm-srgb',
  'bc2-rgba-unorm',
  'bc2-rgba-unorm-srgb',
  'bc3-rgba-unorm',
  'bc3-rgba-unorm-srgb',
  'bc4-r-unorm',
  'bc4-r-snorm',
  'bc5-rg-unorm',
  'bc5-rg-snorm',
];
const compressedBytesPerBlock = (format) =>
  format.startsWith('bc1') || format.startsWith('bc4') ? 8 : 16;
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

  async createSwapChain({ id, windowId, width, height, bufferIds, format = 'rgba8unorm' }) {
    if (
      !integer(id, 1, 0xffffffff) ||
      this.swapchains.has(id) ||
      this.swapchains.size >= 4 ||
      !integer(windowId, 1, 0xffffffff) ||
      !integer(width, 1, 2048) ||
      !integer(height, 1, 2048) ||
      !Array.isArray(bufferIds) ||
      // A bit-block-transfer swap chain may have a single back buffer; D3D10
      // applications request one, and the flip effects request two or three.
      bufferIds.length < 1 ||
      bufferIds.length > 3 ||
      new Set(bufferIds).size !== bufferIds.length ||
      bufferIds.some((key) => !integer(key, 1, 0xffffffff) || this.resources.has(key)) ||
      !['rgba8unorm', 'bgra8unorm'].includes(format)
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
        format,
        alphaMode: 'opaque',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    const chain = {
      id,
      windowId,
      width,
      height,
      bufferIds,
      format,
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
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        chain.textures.push(texture);
        this.resources.set(resourceId, { kind: 'color', width, height, format, chain, texture });
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

  /**
   * Recreates a swap chain's back buffers for a new size or count, preserving
   * the swap chain identity and its window association. ResizeBuffers frees the
   * old back buffers and hands out the same number of new ones.
   */
  async resizeSwapChain({ id, width, height, bufferIds }) {
    const chain = this.swapchains.get(id);
    if (
      !chain ||
      !integer(width, 1, 2048) ||
      !integer(height, 1, 2048) ||
      !Number.isInteger(width) ||
      !Array.isArray(bufferIds) ||
      bufferIds.length < 1 ||
      bufferIds.length > 3 ||
      new Set(bufferIds).size !== bufferIds.length ||
      bufferIds.some((key) => !integer(key, 1, 0xffffffff) || this.resources.has(key))
    )
      throw Error('Unsupported D3D12 swap chain resize');
    for (const key of chain.bufferIds) this.resources.delete(key);
    for (const texture of chain.textures) texture.destroy();
    chain.readback?.destroy();
    if (!chain.software) chain.context.unconfigure();
    chain.width = width;
    chain.height = height;
    chain.bufferIds = [...bufferIds];
    chain.canvas = new OffscreenCanvas(width, height);
    chain.context = chain.canvas.getContext(chain.software ? '2d' : 'webgpu');
    if (!chain.context) throw Error('D3D12 presentation context unavailable');
    if (!chain.software)
      chain.context.configure({
        device: this.device,
        format: chain.format,
        alphaMode: 'opaque',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    chain.textures = [];
    try {
      for (const resourceId of bufferIds) {
        const texture = this.device.createTexture({
          label: 'D3D12 swap chain backbuffer',
          size: [width, height],
          format: chain.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
        chain.textures.push(texture);
        this.resources.set(resourceId, {
          kind: 'color',
          width,
          height,
          format: chain.format,
          chain,
          texture,
        });
      }
      if (chain.software) {
        chain.bytesPerRow = Math.ceil((width * 4) / 256) * 256;
        chain.readback = this.device.createBuffer({
          size: chain.bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      }
    } catch (error) {
      for (const key of bufferIds) this.resources.delete(key);
      for (const texture of chain.textures) texture.destroy();
      chain.readback?.destroy();
      chain.textures = [];
      throw error;
    }
  }

  async createResource({
    id,
    kind,
    width,
    height,
    depth = 1,
    dimension = '2d',
    arrayLayers = 1,
    format,
    mipLevelCount = 1,
  }) {
    if (
      !integer(id, 1, 0xffffffff) ||
      this.resources.has(id) ||
      this.resources.size >= 24 ||
      !['depth', 'texture', 'render-texture'].includes(kind) ||
      !integer(width, 1, 2048) ||
      !integer(height, 1, 2048) ||
      !integer(depth, 1, 2048) ||
      !['2d', '3d'].includes(dimension) ||
      (dimension === '2d' && depth !== 1) ||
      !integer(arrayLayers, 1, 6) ||
      (arrayLayers !== 1 && (dimension !== '2d' || kind !== 'texture')) ||
      (dimension === '3d' && (kind !== 'texture' || COMPRESSED_FORMATS.includes(format))) ||
      !integer(
        mipLevelCount,
        1,
        1 + Math.floor(Math.log2(Math.max(width, height, dimension === '3d' ? depth : 1))),
      ) ||
      typeof format !== 'string'
    )
      throw Error('Unsupported D3D12 texture resource');
    // WebGPU guarantees both depth formats; a D32_FLOAT request is as
    // expressible as a D16_UNORM one, so refusing it would be arbitrary.
    if (kind === 'depth' && !DEPTH_FORMATS.includes(format))
      throw Error('Unsupported D3D12 depth resource');
    if (kind === 'texture' && !TEXTURE_FORMAT_BYTES[format] && !COMPRESSED_FORMATS.includes(format))
      throw Error('Unsupported D3D12 sampled texture format ' + format);
    await this.initialize();
    this.device.pushErrorScope('validation');
    // A sampled texture is uploaded through CopyTextureRegion and then read by
    // a shader, so it needs both a copy destination and a binding usage.
    const texture = this.device.createTexture({
      label: `D3D12 ${kind} resource`,
      size: [width, height, dimension === '3d' ? depth : arrayLayers],
      dimension,
      mipLevelCount,
      format,
      usage:
        kind === 'depth'
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : kind === 'render-texture'
            ? // A render texture is drawn into and then sampled, so it needs
              // both usages and a copy source for readback.
              GPUTextureUsage.RENDER_ATTACHMENT |
              GPUTextureUsage.TEXTURE_BINDING |
              GPUTextureUsage.COPY_SRC
            : GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const error = await this.device.popErrorScope();
    if (error) {
      texture.destroy();
      throw Error(error.message);
    }
    this.resources.set(id, {
      kind,
      width,
      height,
      depth,
      dimension,
      mipLevelCount,
      arrayLayers,
      format,
      texture,
    });
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
    blend = null,
    alphaToCoverage = false,
    rootPlan = null,
    targetFormat = 'rgba8unorm',
    // A D3D10 pipeline has no root signature: its shaders' declared registers
    // are placed by the canonical layout alone, and the frontend resolves each
    // one from its own bound slots at draw time.
    implicitBindings = false,
    // A D3D10 frontend plans its two stages separately (each stage owns its own
    // register file), so it passes the placements it already computed together
    // with the merged plan they came from. Both stages are then compiled
    // against their own table while the pipeline layout covers the union.
    stagePlan = null,
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
        inputLayout.every((attribute) => widthOf(attribute.format) > 0 && !!attribute.semanticName))
    ))
      throw Error('Unsupported D3D12 input layout');
    if (
      depth &&
      (!DEPTH_FORMATS.includes(depth.format) ||
        typeof depth.writeEnabled !== 'boolean' ||
        typeof depth.testEnabled !== 'boolean' ||
        typeof depth.compare !== 'string')
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
    if (stagePlan) {
      if (![vertex, pixel].every((bytes) => bytes instanceof Uint8Array && bytes.length > 0))
        throw Error('D3D10 pipeline requires both shader stages as bytecode');
      // A stage that declares no descriptors compiles unbound, exactly like the
      // parameterless D3D12 path; only a stage with registers needs a table.
      const translate = (bytes, placements) =>
        placements.length
          ? this.compiler.compileBound(bytes, placements)
          : this.compiler.compile(bytes);
      const vs = await translate(vertex, stagePlan.vertex);
      const ps = await translate(pixel, stagePlan.pixel);
      const layout = stagePlan.layout ?? this.layout;
      this.device.pushErrorScope('validation');
      let pipeline, failure;
      try {
        pipeline = await this.device.createRenderPipelineAsync({
          label: 'D3D10 translated DXBC pipeline',
          layout,
          vertex: {
            module: this.device.createShaderModule({ code: vs.wgsl }),
            entryPoint: 'main',
            buffers: attributes.length ? [{ arrayStride: vertexStride, attributes }] : [],
          },
          fragment: {
            module: this.device.createShaderModule({ code: ps.wgsl }),
            entryPoint: 'main',
            targets: [colorTargetFor(blend?.[0], alphaToCoverage, targetFormat)],
          },
          primitive: { topology: 'triangle-list', cullMode, frontFace },
          ...(depth
            ? {
                depthStencil: {
                  format: depth.format,
                  depthWriteEnabled: depth.testEnabled && depth.writeEnabled,
                  depthCompare: depth.testEnabled ? depth.compare : 'always',
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
        plan: stagePlan,
        bindings: stagePlan.bindings,
        groupLayouts: stagePlan.groupLayouts ?? null,
      });
      this.graphics.emit({
        type: 'log',
        text:
          'D3D10 DXBC shaders compiled to WGSL with ' +
          stagePlan.bindings.length +
          ' canonical bindings',
      });
      return { bindings: stagePlan.bindings, plan: stagePlan };
    }
    const declaresResources = !!rootPlan && rootPlan.parameterCount > 0;
    let plan = null;
    if (implicitBindings && !rootPlan) {
      const scanned = [
        ...(await this.compiler.scanDescriptors(vertex)),
        ...(await this.compiler.scanDescriptors(pixel)),
      ];
      plan = canonicalBindings(scanned);
    } else if (declaresResources) {
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
          // Render target 0's blend state becomes the WebGPU target. The
          // backend models exactly one target, and the frontend has already
          // rejected independent blending on later targets.
          targets: [colorTargetFor(blend?.[0], alphaToCoverage, targetFormat)],
        },
        primitive: { topology: 'triangle-list', cullMode, frontFace },
        ...(depth
          ? {
              depthStencil: {
                format: depth.format,
                // DepthEnable=FALSE disables both the test and the write; WebGPU
                // has no separate enable, so the comparison becomes ALWAYS.
                depthWriteEnabled: depth.testEnabled && depth.writeEnabled,
                depthCompare: depth.testEnabled ? depth.compare : 'always',
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
    return { bindings: plan?.bindings ?? [], plan };
  }

  /**
   * Plans a D3D10 pipeline's canonical bindings. D3D10's device has one
   * register file per stage, so the two shaders are planned separately and
   * merged into a single pipeline layout, unlike a D3D12 root signature where
   * both stages share the registers the signature declares.
   */
  async planD3D10Bindings(vertex, pixel) {
    await this.initialize();
    const [vsDescriptors, psDescriptors] = await Promise.all([
      this.compiler.scanDescriptors(vertex),
      this.compiler.scanDescriptors(pixel),
    ]);
    const stage = planStageBindings(vsDescriptors, psDescriptors);
    if (!stage.bindings.length) return { ...stage, layout: null, groupLayouts: null };
    const planned = {
      bindings: stage.bindings,
      layouts: stageLayoutEntries(stage.bindings, GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT),
    };
    const built = this.pipelineLayout(planned);
    return { ...stage, layout: built.layout, groupLayouts: built.groupLayouts };
  }

  /**
   * The canonical (group, binding) assignment for a shader pair, with no root
   * signature involved. A frontend whose API has no signature — D3D10 — scans
   * its shaders once and binds each canonical register directly.
   */
  async planImplicitBindings(vertex, pixel) {
    await this.initialize();
    const scanned = [
      ...(await this.compiler.scanDescriptors(vertex)),
      ...(await this.compiler.scanDescriptors(pixel)),
    ];
    const plan = canonicalBindings(scanned);
    return { plan, layout: plan.bindings.length ? this.pipelineLayout(plan) : null };
  }

  // The pipeline layout implied by a canonical binding plan. Groups 0..2 carry
  // the constant buffers, SRVs/UAVs and samplers; group 3 stays the draw
  // parameter uniform vkd3d-shader emits for base vertex/instance.
  pipelineLayout(plan) {
    // Binding numbers alone do not identify a layout: texture dimension,
    // sample type, buffer/sampler kind and visibility all affect compatibility.
    const entriesKey = JSON.stringify(plan.layouts);
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
      // Swap-chain images carry their extents on the chain; a render texture
      // carries them on the resource itself.
      const extent = resource.chain ?? resource;
      if (command.type === 'clear-depth') {
        if (
          resource.kind !== 'depth' ||
          !finite(command.depth) ||
          command.depth < 0 ||
          command.depth > 1 ||
          (command.clearDepth !== undefined && typeof command.clearDepth !== 'boolean') ||
          (command.clearStencil &&
            (!resource.format.includes('stencil') || !integer(command.stencil, 0, 255)))
        )
          throw Error('Invalid D3D12 depth clear');
        continue;
      }
      if (resource.kind !== 'color' && resource.kind !== 'render-texture')
        throw Error('D3D12 command requires a color target');
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
          (p.depth && p.depth.testEnabled
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
          v.x + v.width > extent.width ||
          v.y + v.height > extent.height ||
          v.minDepth < 0 ||
          v.maxDepth > 1 ||
          v.minDepth > v.maxDepth ||
          !integer(s.left, 0, extent.width) ||
          !integer(s.right, s.left, extent.width) ||
          !integer(s.top, 0, extent.height) ||
          !integer(s.bottom, s.top, extent.height) ||
          (!indexed && !integer(command.vertexCount, 0, 0x7fffffff)) ||
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
      if (!list)
        throw Error(`D3D12 binding group ${binding.group} is outside the canonical groups`);
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
      return {
        layout: { sampler: { type: binding.sampler.comparison ? 'comparison' : 'filtering' } },
        resource: sampler,
      };
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
      slot = {
        buffer: this.device.createBuffer({
          size: 65536,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      };
      this.uniformSlots ??= new Map();
      this.uniformSlots.set(key, slot);
    }
    return slot;
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
        const resource = this.resources.get(command.target);
        const { texture } = resource;
        const clear = command.type === 'clear';
        const clearDepth = command.type === 'clear-depth';
        const depthResource = clearDepth ? resource : this.resources.get(command.depthTarget);
        const depth = depthResource?.texture;
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
                  depthLoadOp: clearDepth && command.clearDepth !== false ? 'clear' : 'load',
                  depthStoreOp: 'store',
                  depthClearValue: clearDepth ? command.depth : 1,
                  ...(depthResource.format.includes('stencil')
                    ? {
                        stencilLoadOp: command.clearStencil ? 'clear' : 'load',
                        stencilStoreOp: 'store',
                        stencilClearValue: command.clearStencil ? command.stencil : 0,
                      }
                    : {}),
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

  async present({ id, index, graphicsApi = 'd3d12' }) {
    const chain = this.swapchains.get(id);
    if (!chain || !integer(index, 0, chain.bufferIds.length - 1))
      throw Error('Invalid D3D12 presentation buffer');
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
        const swizzle = chain.format === 'bgra8unorm';
        for (let row = 0; row < chain.height; row++) {
          const base = row * chain.bytesPerRow;
          const target = row * chain.width * 4;
          for (let x = 0; x < chain.width; x++) {
            const from = base + x * 4;
            const to = target + x * 4;
            pixels[to] = swizzle ? source[from + 2] : source[from];
            pixels[to + 1] = source[from + 1];
            pixels[to + 2] = swizzle ? source[from] : source[from + 2];
            pixels[to + 3] = 255;
          }
        }
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
      // The frontend names the API it translated, so the desktop can label the
      // surface with the graphics family the guest actually used.
      graphicsApi,
      graphicsFrames: ++this.frames,
      graphicsDraws: this.draws,
    });
  }

  /**
   * Uploads one subresource of a texture from a placed-footprint source buffer.
   * `rows` already carries the source row pitch, so the copy preserves the
   * D3D12 layout the application computed through GetCopyableFootprints.
   */
  async uploadTexture({
    id,
    width,
    height,
    depth = 1,
    mipLevel = 0,
    arrayLayer = 0,
    bytesPerRow,
    rowsPerImage,
    rows,
  }) {
    await this.initialize();
    const resource = this.resources.get(id);
    if (!resource || resource.kind !== 'texture')
      throw Error('D3D12 texture upload target is missing');
    if (
      !(rows instanceof Uint8Array) ||
      !integer(bytesPerRow, 1, 0x7fffffff) ||
      !integer(mipLevel, 0, (resource.mipLevelCount ?? 1) - 1) ||
      !integer(arrayLayer, 0, (resource.arrayLayers ?? 1) - 1) ||
      !integer(width, 1, Math.max(1, resource.width >> mipLevel)) ||
      !integer(height, 1, Math.max(1, resource.height >> mipLevel)) ||
      !integer(depth, 1, resource.depth ?? 1)
    )
      throw Error('D3D12 texture upload data is invalid');
    // A block-compressed texture is addressed in 4x4 blocks: a "row" is a block
    // row of ceil(width/4) blocks, and the region is ceil(height/4) block rows.
    const compressed = COMPRESSED_FORMATS.includes(resource.format);
    const rowBytes = compressed
      ? Math.ceil(width / 4) * compressedBytesPerBlock(resource.format)
      : width * TEXTURE_FORMAT_BYTES[resource.format];
    if (bytesPerRow < rowBytes) throw Error('D3D12 texture upload row pitch is too small');
    const rowCount = compressed ? Math.ceil(height / 4) : height;
    rowsPerImage ??= rowCount;
    if (!integer(rowsPerImage, rowCount, 0x7fffffff))
      throw Error('D3D12 texture slice pitch is invalid');
    const byteLength =
      (depth - 1) * rowsPerImage * bytesPerRow + (rowCount - 1) * bytesPerRow + rowBytes;
    if (rows.length < byteLength) throw Error('D3D12 texture upload covers too few rows');
    this.device.queue.writeTexture(
      { texture: resource.texture, mipLevel, origin: [0, 0, arrayLayer] },
      rows.subarray(0, byteLength),
      { bytesPerRow, rowsPerImage },
      compressed
        ? [Math.ceil(width / 4) * 4, Math.ceil(height / 4) * 4, depth]
        : [width, height, depth],
    );
  }

  /** A texture view for a shader resource descriptor, or null when unsupported. */
  textureBindingResource(descriptor) {
    const resource = this.resources.get(descriptor.resource.pointer);
    if (!resource || (resource.kind !== 'texture' && resource.kind !== 'render-texture'))
      return null;
    const baseMipLevel = descriptor.baseMipLevel ?? 0;
    const mipLevelCount = descriptor.mipLevelCount ?? resource.mipLevelCount ?? 1;
    const dimension = descriptor.viewDimension === 9 ? 'cube' : (resource.dimension ?? '2d');
    const key = `${descriptor.resource.pointer}:${descriptor.format ?? resource.format}:${dimension}:${baseMipLevel}:${mipLevelCount}`;
    this.textureViews ??= new Map();
    let view = this.textureViews.get(key);
    if (!view) {
      view = resource.texture.createView({ dimension, baseMipLevel, mipLevelCount });
      this.textureViews.set(key, view);
    }
    return {
      layout: {
        texture: {
          sampleType: sampleTypeForFormat(resource.format),
          viewDimension: dimension,
        },
      },
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
