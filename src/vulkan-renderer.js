// Vulkan graphics use the same worker-owned WebGPU device as Direct3D.
// Shaders, geometry, descriptors and transforms always come from the guest.
import { ShaderCompiler } from './shader-compiler.js';
export class VulkanRenderer {
  constructor(graphics) {
    if (!graphics) throw Error('Vulkan requires the worker WebGPU backend');
    this.graphics = graphics;
    this.compiler = new ShaderCompiler();
    this.resources = new Set();
    this.chains = new Set();
    this.frames = 0;
    this.draws = 0;
    this.pipelines = new WeakMap();
  }
  async initialize() {
    await this.graphics.initialize();
    this.device = this.graphics.device;
  }
  async shader(bytes) {
    await this.compiler.initialize();
    const code = this.compiler.naga.vulkan_spirv_to_wgsl(bytes);
    const module = this.device.createShaderModule({ code, label: 'guest Vulkan SPIR-V' });
    const diagnostics = await module.getCompilationInfo();
    const errors = diagnostics.messages.filter((message) => message.type === 'error');
    if (errors.length) throw Error(errors.map((message) => message.message).join('\n'));
    return module;
  }
  async createChain(chain) {
    await this.initialize();
    const software = this.graphics.presentationMode === 'readback';
    const canvas = new OffscreenCanvas(chain.width, chain.height);
    const context = canvas.getContext(software ? '2d' : 'webgpu');
    if (!context) throw Error('Vulkan presentation context unavailable');
    const format = 'rgba8unorm';
    if (!software)
      context.configure({
        device: this.device,
        format,
        alphaMode: 'opaque',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
    Object.assign(chain, { canvas, context, software, format });
    for (const image of chain.images) {
      image.texture = this.device.createTexture({
        size: [chain.width, chain.height],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      this.resources.add(image.texture);
    }
    if (software) {
      chain.bytesPerRow = Math.ceil((chain.width * 4) / 256) * 256;
      chain.readback = this.device.createBuffer({
        size: chain.bytesPerRow * chain.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.resources.add(chain.readback);
    }
    this.chains.add(chain);
  }
  destroyChain(chain) {
    for (const image of chain.images) this.destroy(image.texture);
    this.destroy(chain.readback);
    if (!chain.software) chain.context.unconfigure();
    this.chains.delete(chain);
  }
  destroy(resource) {
    if (!resource) return;
    resource.destroy();
    this.resources.delete(resource);
  }
  texture(image, runtime) {
    if (!image.texture) {
      const format = {
        37: 'rgba8unorm',
        43: 'rgba8unorm-srgb',
        44: 'bgra8unorm',
        50: 'bgra8unorm-srgb',
        124: 'depth16unorm',
      }[image.format];
      if (!format) throw Error('Unsupported Vulkan image format ' + image.format);
      image.texture = this.device.createTexture({
        size: [image.width, image.height],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          (image.format === 124 ? 0 : GPUTextureUsage.COPY_DST),
      });
      this.resources.add(image.texture);
    }
    if (image.format !== 124 && image.dirty && image.memory) {
      const address = image.memory.address + image.offset;
      const bytes = image.width * image.height * 4;
      runtime.check(address, bytes);
      this.device.queue.writeTexture(
        { texture: image.texture },
        runtime.data.subarray(address, address + bytes),
        { bytesPerRow: image.width * 4, rowsPerImage: image.height },
        [image.width, image.height],
      );
      image.dirty = false;
    }
    return image.texture;
  }
  layouts(layout, compute = false) {
    const layouts = layout.layouts.map((set) =>
      this.device.createBindGroupLayout({
        entries: [...set.bindings].flatMap(([binding, value]) => {
          const visibility =
            (value.stages & 1 ? GPUShaderStage.VERTEX : 0) |
            (value.stages & 16 ? GPUShaderStage.FRAGMENT : 0) |
            (value.stages & 32 ? GPUShaderStage.COMPUTE : 0);
          if (value.type === 1)
            return [
              { binding: binding * 2, visibility, texture: { sampleType: 'float' } },
              { binding: binding * 2 + 1, visibility, sampler: { type: 'filtering' } },
            ];
          return [
            {
              binding: binding * 2,
              visibility,
              buffer: {
                type: value.type === 6 ? 'uniform' : compute ? 'storage' : 'read-only-storage',
              },
            },
          ];
        }),
      }),
    );
    if (layout.ranges.length) {
      while (layouts.length < 3) layouts.push(this.device.createBindGroupLayout({ entries: [] }));
      const stages = layout.ranges.reduce((mask, range) => mask | range.stages, 0);
      layouts.push(
        this.device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility:
                (stages & 1 ? GPUShaderStage.VERTEX : 0) |
                (stages & 16 ? GPUShaderStage.FRAGMENT : 0) |
                (stages & 32 ? GPUShaderStage.COMPUTE : 0),
              buffer: { type: 'uniform' },
            },
          ],
        }),
      );
    }
    return layouts;
  }
  async computePipeline(description) {
    await this.initialize();
    const module = await this.shader(description.stage.bytes);
    this.device.pushErrorScope('validation');
    try {
      const pipeline = await this.device.createComputePipelineAsync({
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: this.layouts(description.layout, true),
        }),
        compute: { module, entryPoint: description.stage.entry },
      });
      this.pipelines.set(pipeline, description);
      return pipeline;
    } finally {
      const error = await this.device.popErrorScope();
      if (error) throw Error('Vulkan compute pipeline: ' + error.message);
    }
  }
  async pipeline(description) {
    await this.initialize();
    const stages = [];
    for (const stage of description.stages)
      stages.push({ ...stage, module: await this.shader(stage.bytes) });
    const vertex = stages.find((stage) => stage.stage === 1),
      fragment = stages.find((stage) => stage.stage === 16);
    if (!vertex || !fragment) throw Error('Vulkan pipeline requires vertex and fragment stages');
    this.device.pushErrorScope('validation');
    let pipeline;
    try {
      const layouts = this.layouts(description.layout);
      const vertexFormats = {
        37: ['unorm8x4', 4],
        98: ['uint32', 4],
        100: ['float32', 4],
        101: ['uint32x2', 8],
        103: ['float32x2', 8],
        104: ['uint32x3', 12],
        106: ['float32x3', 12],
        107: ['uint32x4', 16],
        109: ['float32x4', 16],
      };
      const buffers = [];
      const locations = new Set();
      for (const binding of description.vertexBindings) {
        if (buffers[binding.binding]) throw Error('Duplicate Vulkan vertex binding');
        buffers[binding.binding] = {
          arrayStride: binding.stride,
          stepMode: binding.rate ? 'instance' : 'vertex',
          attributes: [],
        };
      }
      for (const attribute of description.vertexAttributes) {
        const format = vertexFormats[attribute.format],
          buffer = buffers[attribute.binding];
        if (
          !format ||
          !buffer ||
          attribute.location >= 16 ||
          locations.has(attribute.location) ||
          attribute.offset % 4 ||
          attribute.offset + format[1] > buffer.arrayStride
        )
          throw Error('Unsupported Vulkan vertex attribute');
        locations.add(attribute.location);
        buffer.attributes.push({
          shaderLocation: attribute.location,
          offset: attribute.offset,
          format: format[0],
        });
      }
      for (let i = 0; i < buffers.length; i++) buffers[i] ??= null;
      const factors = [
        'zero',
        'one',
        'src',
        'one-minus-src',
        'dst',
        'one-minus-dst',
        'src-alpha',
        'one-minus-src-alpha',
        'dst-alpha',
        'one-minus-dst-alpha',
      ];
      const operations = ['add', 'subtract', 'reverse-subtract', 'min', 'max'];
      let blend;
      if (description.blending.blendEnable) {
        const b = description.blending;
        blend = {
          color: {
            srcFactor: factors[b.srcColorBlendFactor],
            dstFactor: factors[b.dstColorBlendFactor],
            operation: operations[b.colorBlendOp],
          },
          alpha: {
            srcFactor: factors[b.srcAlphaBlendFactor],
            dstFactor: factors[b.dstAlphaBlendFactor],
            operation: operations[b.alphaBlendOp],
          },
        };
        if (Object.values(blend).some((c) => Object.values(c).some((v) => v === undefined)))
          throw Error('Unsupported Vulkan blending');
      }
      pipeline = await this.device.createRenderPipelineAsync({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module: vertex.module, entryPoint: vertex.entry, buffers },
        fragment: {
          module: fragment.module,
          entryPoint: fragment.entry,
          targets: [{ format: 'rgba8unorm', writeMask: description.writeMask, blend }],
        },
        primitive: {
          topology: 'triangle-list',
          frontFace: description.frontFace ? 'cw' : 'ccw',
          cullMode: ['none', 'front', 'back'][description.cullMode],
        },
        depthStencil: {
          format: 'depth16unorm',
          depthWriteEnabled: description.depthWrite,
          depthCompare: [
            'never',
            'less',
            'equal',
            'less-equal',
            'greater',
            'not-equal',
            'greater-equal',
            'always',
          ][description.depthCompare],
        },
      });
      this.pipelines.set(pipeline, description);
    } finally {
      const error = await this.device.popErrorScope();
      if (error) throw Error('Vulkan pipeline: ' + error.message);
    }
    return pipeline;
  }
  buffer(buffer) {
    if (!buffer.memory) throw Error('Vulkan buffer memory is unbound');
    if (!buffer.gpu) {
      buffer.gpu = this.device.createBuffer({
        size: Math.ceil(buffer.size / 16) * 16,
        usage:
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC |
          GPUBufferUsage.VERTEX |
          GPUBufferUsage.INDEX |
          GPUBufferUsage.UNIFORM |
          GPUBufferUsage.STORAGE,
      });
      this.resources.add(buffer.gpu);
    }
    return buffer.gpu;
  }
  syncBuffer(runtime, buffer, uploaded) {
    const gpu = this.buffer(buffer);
    if (!uploaded.has(buffer)) {
      const address = buffer.memory.address + buffer.offset;
      runtime.check(address, buffer.size);
      const bytes = new Uint8Array(Math.ceil(buffer.size / 4) * 4);
      bytes.set(runtime.data.subarray(address, address + buffer.size));
      this.device.queue.writeBuffer(gpu, 0, bytes);
      uploaded.add(buffer);
    }
    return gpu;
  }
  bindings(runtime, pipeline, sets, uploaded) {
    const groups = [];
    for (const [setIndex, set] of sets.entries()) {
      if (!set) continue;
      const entries = [];
      for (const [binding, descriptor] of set.bindings) {
        if (descriptor.type === 6 || descriptor.type === 7) {
          const buffer = descriptor.buffer;
          const address = buffer.memory.address + buffer.offset + descriptor.offset;
          runtime.check(address, descriptor.range);
          this.syncBuffer(runtime, buffer, uploaded);
          entries.push({
            binding: binding * 2,
            resource: { buffer: buffer.gpu, offset: descriptor.offset, size: descriptor.range },
          });
        } else if (descriptor.type === 1) {
          entries.push({
            binding: binding * 2,
            resource: this.texture(descriptor.view.image, runtime).createView(),
          });
          entries.push({ binding: binding * 2 + 1, resource: descriptor.sampler.gpu });
        } else throw Error('Unsupported Vulkan descriptor type ' + descriptor.type);
      }
      groups.push([
        setIndex,
        this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(setIndex), entries }),
      ]);
    }
    return groups;
  }
  async execute(runtime, commands) {
    await this.initialize();
    const encoder = this.device.createCommandEncoder();
    const uploaded = new Set(),
      temporaries = [],
      vertices = [];
    const push = new Uint8Array(128);
    let indices, computePipeline;
    const computeSets = [],
      computed = new Set();
    let pass,
      pipeline,
      sets = [],
      viewport,
      scissor;
    const readbacks = [];
    try {
      for (const command of commands) {
        if (command.type === 'begin-pass') {
          if (pass) throw Error('Nested Vulkan render pass');
          const [color, depth] = command.framebuffer.attachments.map((view) => view.image);
          pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: this.texture(color, runtime).createView(),
                clearValue: command.color,
                loadOp: 'clear',
                storeOp: 'store',
              },
            ],
            depthStencilAttachment: {
              view: this.texture(depth, runtime).createView(),
              depthClearValue: command.depth,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
            },
          });
        } else if (command.type === 'end-pass') {
          if (!pass) throw Error('Vulkan render pass is not active');
          pass.end();
          pass = null;
        } else if (command.type === 'pipeline') {
          if (command.point) computePipeline = command.pipeline.gpu;
          else pipeline = command.pipeline.gpu;
        } else if (command.type === 'sets')
          command.sets.forEach(
            (set, i) => ((command.point ? computeSets : sets)[command.first + i] = set),
          );
        else if (command.type === 'vertices')
          command.buffers.forEach((buffer, i) => (vertices[command.first + i] = buffer));
        else if (command.type === 'indices') indices = command;
        else if (command.type === 'push') push.set(command.bytes, command.offset);
        else if (command.type === 'viewport') viewport = command.values;
        else if (command.type === 'scissor') scissor = command.values;
        else if (command.type === 'draw' || command.type === 'draw-indexed') {
          if (!pass || !pipeline || !viewport || !scissor)
            throw Error('Incomplete Vulkan draw state');
          pass.setPipeline(pipeline);
          pass.setViewport(...viewport);
          pass.setScissorRect(...scissor);
          const description = this.pipelines.get(pipeline);
          for (const binding of description.vertexBindings) {
            const entry = vertices[binding.binding];
            if (!entry) throw Error('Vulkan vertex buffer is not bound');
            pass.setVertexBuffer(
              binding.binding,
              this.syncBuffer(runtime, entry.buffer, uploaded),
              entry.offset,
            );
          }
          for (const [index, group] of this.bindings(
            runtime,
            pipeline,
            sets.slice(0, description.layout.layouts.length),
            uploaded,
          ))
            pass.setBindGroup(index, group);
          if (description.layout.ranges.length) {
            const buffer = this.device.createBuffer({
              size: 128,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            temporaries.push(buffer);
            this.device.queue.writeBuffer(buffer, 0, push);
            pass.setBindGroup(
              3,
              this.device.createBindGroup({
                layout: pipeline.getBindGroupLayout(3),
                entries: [{ binding: 0, resource: { buffer } }],
              }),
            );
          }
          if (command.type === 'draw-indexed') {
            if (!indices) throw Error('Vulkan index buffer is not bound');
            const size = indices.format === 'uint32' ? 4 : 2;
            if (
              (command.values[0] + command.values[2]) * size >
              indices.buffer.size - indices.offset
            )
              throw Error('Vulkan indexed draw exceeds index buffer');
            pass.setIndexBuffer(
              this.syncBuffer(runtime, indices.buffer, uploaded),
              indices.format,
              indices.offset,
            );
            pass.drawIndexed(...command.values);
          } else pass.draw(...command.values);
          this.draws++;
        } else if (command.type === 'dispatch') {
          if (pass || !computePipeline) throw Error('Incomplete Vulkan compute state');
          const description = this.pipelines.get(computePipeline);
          const compute = encoder.beginComputePass();
          compute.setPipeline(computePipeline);
          for (const [index, group] of this.bindings(
            runtime,
            computePipeline,
            computeSets.slice(0, description.layout.layouts.length),
            uploaded,
          ))
            compute.setBindGroup(index, group);
          if (description.layout.ranges.length) {
            const buffer = this.device.createBuffer({
              size: 128,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            temporaries.push(buffer);
            this.device.queue.writeBuffer(buffer, 0, push);
            compute.setBindGroup(
              3,
              this.device.createBindGroup({
                layout: computePipeline.getBindGroupLayout(3),
                entries: [{ binding: 0, resource: { buffer } }],
              }),
            );
          }
          compute.dispatchWorkgroups(...command.values);
          compute.end();
          for (const set of computeSets)
            for (const descriptor of set?.bindings.values() || [])
              if (descriptor.type === 7) computed.add(descriptor.buffer);
        } else if (command.type === 'copy-buffer') {
          if (pass) throw Error('Vulkan buffer copy inside render pass');
          const { source, target, sourceOffset, targetOffset, size } = command;
          const a = source.memory.address + source.offset + sourceOffset,
            b = target.memory.address + target.offset + targetOffset;
          runtime.check(a, size);
          runtime.check(b, size, true);
          encoder.copyBufferToBuffer(
            this.syncBuffer(runtime, source, uploaded),
            sourceOffset,
            this.syncBuffer(runtime, target, uploaded),
            targetOffset,
            size,
          );
          runtime.data.set(runtime.data.slice(a, a + size), b);
          uploaded.add(target);
          if (computed.has(source)) computed.add(target);
        } else if (command.type === 'copy-buffer-image') {
          if (pass) throw Error('Vulkan copy inside render pass');
          const { buffer, image, offset } = command;
          if (computed.has(buffer))
            throw Error('Vulkan GPU-written buffer-to-image transfers are unavailable');
          const length = image.width * image.height * 4;
          const source = buffer.memory.address + buffer.offset + offset;
          const destination = image.memory.address + image.offset;
          runtime.check(source, length);
          runtime.check(destination, length, true);
          runtime.data.set(runtime.data.slice(source, source + length), destination);
          image.dirty = true;
        } else if (command.type !== 'barrier') throw Error('Unknown Vulkan command');
      }
      if (pass) throw Error('Unfinished Vulkan render pass');
      for (const buffer of computed) {
        const copy = this.device.createBuffer({
          size: Math.ceil(buffer.size / 4) * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        encoder.copyBufferToBuffer(buffer.gpu, 0, copy, 0, Math.ceil(buffer.size / 4) * 4);
        readbacks.push({ buffer, copy });
      }
      this.device.queue.submit([encoder.finish()]);
      await this.device.queue.onSubmittedWorkDone();
      for (const { buffer, copy } of readbacks) {
        await copy.mapAsync(GPUMapMode.READ);
        const address = buffer.memory.address + buffer.offset;
        runtime.check(address, buffer.size, true);
        runtime.data.set(new Uint8Array(copy.getMappedRange()).subarray(0, buffer.size), address);
      }
      if (this.graphics.failure) throw Error(this.graphics.failure);
    } finally {
      for (const { copy } of readbacks) {
        if (copy.mapState === 'mapped') copy.unmap();
        copy.destroy();
      }
      for (const buffer of temporaries) buffer.destroy();
    }
  }
  async present(chain, index) {
    const encoder = this.device.createCommandEncoder();
    const image = chain.images[index];
    if (!image) throw Error('Invalid Vulkan swapchain image index');
    if (chain.software)
      encoder.copyTextureToBuffer(
        { texture: image.texture },
        { buffer: chain.readback, bytesPerRow: chain.bytesPerRow },
        [chain.width, chain.height],
      );
    else
      encoder.copyTextureToTexture(
        { texture: image.texture },
        { texture: chain.context.getCurrentTexture() },
        [chain.width, chain.height],
      );
    this.device.queue.submit([encoder.finish()]);
    if (chain.software) {
      await chain.readback.mapAsync(GPUMapMode.READ);
      try {
        const mapped = new Uint8Array(chain.readback.getMappedRange());
        const pixels = new Uint8ClampedArray(chain.width * chain.height * 4);
        for (let row = 0; row < chain.height; row++)
          pixels.set(
            mapped.subarray(row * chain.bytesPerRow, row * chain.bytesPerRow + chain.width * 4),
            row * chain.width * 4,
          );
        // VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR ignores the attachment alpha,
        // matching the hardware canvas alphaMode on the readback path.
        for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255;
        chain.context.putImageData(new ImageData(pixels, chain.width, chain.height), 0, 0);
      } finally {
        chain.readback.unmap();
      }
    }
    this.frames++;
    this.graphics.emit({
      type: 'frame',
      windowId: chain.windowId,
      width: chain.width,
      height: chain.height,
      bitmap: chain.canvas.transferToImageBitmap(),
      renderer: 'webgpu',
      graphicsApi: 'vulkan',
      graphicsFrames: this.frames,
      graphicsDraws: this.draws,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  dispose() {
    for (const chain of [...this.chains]) this.destroyChain(chain);
    for (const resource of this.resources) resource.destroy();
    this.resources.clear();
  }
}
