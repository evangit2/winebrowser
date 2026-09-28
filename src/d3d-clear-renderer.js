import { clearColor } from './d3d-presentation.js';
// Partial clears are attachment writes clipped to viewport/rectangle bounds.
// They must not inherit guest shaders, depth comparisons or viewport depth range.
const SHADER = `
struct Clear { color: vec4<f32>, depth: vec4<f32> }
@group(0) @binding(0) var<uniform> value: Clear;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4(p[i], value.depth.x, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return value.color; }
`;

export class D3DClearRenderer {
  constructor(owner) {
    this.owner = owner;
    this.pipelines = new Map();
  }

  pipeline(surface, command) {
    const { device, format } = this.owner;
    this.shader ??= device.createShaderModule({ code: SHADER });
    this.layout ??= device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const key = [
      !!surface.depthTexture,
      surface.depthFormat,
      command.clearColor,
      command.clearDepth,
    ].join(':');
    if (!this.pipelines.has(key))
      this.pipelines.set(
        key,
        device.createRenderPipeline({
          label: 'Viewport rectangle clear',
          layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
          vertex: { module: this.shader, entryPoint: 'vs' },
          fragment: {
            module: this.shader,
            entryPoint: 'fs',
            targets: [
              {
                format,
                writeMask: command.clearColor ? GPUColorWrite.ALL : 0,
              },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          ...(surface.depthTexture
            ? {
                depthStencil: {
                  format: surface.depthFormat,
                  depthWriteEnabled: command.clearDepth,
                  depthCompare: 'always',
                },
              }
            : {}),
        }),
      );
    return this.pipelines.get(key);
  }

  draw(pass, surface, index, command, regions) {
    const { device } = this.owner;
    pass.setPipeline(this.pipeline(surface, command));
    surface.clearSlots ??= [];
    let slot = surface.clearSlots[index];
    if (!slot) {
      const uniform = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      slot = {
        uniform,
        group: device.createBindGroup({
          layout: this.layout,
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        }),
      };
      surface.clearSlots[index] = slot;
    }
    const c = clearColor(command.color, surface.colorFormat);
    device.queue.writeBuffer(
      slot.uniform,
      0,
      new Float32Array([c.r, c.g, c.b, c.a, command.clearDepth ? command.depth : 0, 0, 0, 0]),
    );
    pass.setBindGroup(0, slot.group);
    pass.setViewport(0, 0, surface.width, surface.height, 0, 1);
    for (const r of regions)
      if (r.width && r.height) {
        pass.setScissorRect(r.x, r.y, r.width, r.height);
        pass.draw(3);
      }
  }

  trim(surface, count) {
    for (const slot of surface.clearSlots?.splice(count) ?? []) slot.uniform.destroy();
  }
  dispose() {
    this.pipelines.clear();
    this.shader = this.layout = null;
  }
}
