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
      pipeline = await this.device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module: vertex.module, entryPoint: vertex.entry, buffers: [] },
        fragment: {
          module: fragment.module,
          entryPoint: fragment.entry,
          targets: [{ format: 'rgba8unorm', writeMask: description.writeMask }],
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
    } finally {
      const error = await this.device.popErrorScope();
      if (error) throw Error('Vulkan pipeline: ' + error.message);
    }
    return pipeline;
  }
  bindings(runtime, pipeline, sets) {
    const groups = [];
    for (const [setIndex, set] of sets.entries()) {
      if (!set) continue;
      const entries = [];
      for (const [binding, descriptor] of set.bindings) {
        if (descriptor.type === 6) {
          const buffer = descriptor.buffer;
          const address = buffer.memory.address + buffer.offset + descriptor.offset;
          runtime.check(address, descriptor.range);
          if (!buffer.gpu) {
            buffer.gpu = this.device.createBuffer({
              size: Math.ceil(buffer.size / 16) * 16,
              usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            this.resources.add(buffer.gpu);
          }
          this.device.queue.writeBuffer(
            buffer.gpu,
            descriptor.offset,
            runtime.data.subarray(address, address + descriptor.range),
          );
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
    let pass,
      pipeline,
      sets = [],
      viewport,
      scissor;
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
      } else if (command.type === 'pipeline') pipeline = command.pipeline.gpu;
      else if (command.type === 'sets') sets = command.sets;
      else if (command.type === 'viewport') viewport = command.values;
      else if (command.type === 'scissor') scissor = command.values;
      else if (command.type === 'draw') {
        if (!pass || !pipeline || !viewport || !scissor)
          throw Error('Incomplete Vulkan draw state');
        pass.setPipeline(pipeline);
        pass.setViewport(...viewport);
        pass.setScissorRect(...scissor);
        for (const [index, group] of this.bindings(runtime, pipeline, sets))
          pass.setBindGroup(index, group);
        pass.draw(...command.values);
        this.draws++;
      } else if (command.type === 'copy-buffer-image') {
        if (pass) throw Error('Vulkan copy inside render pass');
        const { buffer, image, offset } = command;
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
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    if (this.graphics.failure) throw Error(this.graphics.failure);
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
