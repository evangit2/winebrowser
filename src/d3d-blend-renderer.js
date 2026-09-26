import { blendConstant } from './d3d-blending.js';

// WebGPU has no RGB565 render attachment or portable framebuffer fetch.
// One reusable GPU texture supplies the result preceding each triangle. It
// never crosses the worker/CPU boundary and is independent of swap-chain flips.
export class D3DBlendRenderer {
  constructor(owner) {
    this.owner = owner;
  }
  initialize() {
    if (this.layout) return;
    const device = this.owner.device;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    this.emptyLayout = device.createBindGroupLayout({ entries: [] });
    this.emptyGroup = device.createBindGroup({ layout: this.emptyLayout, entries: [] });
  }
  prepare(surface, slot, command, layout = this.layout, constant = true) {
    this.initialize();
    const device = this.owner.device;
    if (!surface.blendFeedback) {
      surface.blendFeedback = device.createTexture({
        label: 'RGB565 previous triangle',
        size: [surface.width, surface.height],
        format: this.owner.format,
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      surface.blendFeedbackView = surface.blendFeedback.createView();
    }
    slot.blendUniform ??= device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(slot.blendUniform, 0, new Float32Array(blendConstant(command)));
    return device.createBindGroup({
      layout: layout ?? this.layout,
      entries: [
        { binding: 0, resource: surface.blendFeedbackView },
        ...(constant ? [{ binding: 1, resource: { buffer: slot.blendUniform } }] : []),
      ],
    });
  }
  dispose() {
    this.layout = this.emptyLayout = this.emptyGroup = null;
  }
}
