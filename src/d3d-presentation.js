// RGB565 is represented by expanded UNORM8 values because WebGPU has no
// RGB565 render attachment. Quantize on the GPU; ordinary presentation never
// reads pixels back to JavaScript on a hardware adapter.
export class D3DPresentation {
  constructor(owner) {
    this.owner = owner;
  }
  quantize(encoder, surface, texture) {
    if (surface.colorFormat !== 23) return;
    const { device, format } = this.owner;
    if (!this.pipeline) {
      const module = device.createShaderModule({
        code: `
@group(0) @binding(0) var source: texture_2d<f32>;
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4(p[i], 0.0, 1.0);
}
@fragment fn fragmentMain(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let rgb = clamp(textureLoad(source, vec2<i32>(p.xy), 0).rgb, vec3(0.0), vec3(1.0));
  let levels = vec3(31.0, 63.0, 31.0);
  return vec4(floor(rgb * levels + vec3(0.5)) / levels, 1.0);
}`,
      });
      this.pipeline = device.createRenderPipeline({
        label: 'RGB565 backbuffer conversion',
        layout: 'auto',
        vertex: { module, entryPoint: 'vertexMain' },
        fragment: { module, entryPoint: 'fragmentMain', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        { view: surface.quantized.createView(), loadOp: 'clear', storeOp: 'store' },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: texture.createView() }],
      }),
    );
    pass.draw(3);
    pass.end();
    encoder.copyTextureToTexture({ texture: surface.quantized }, { texture }, [
      surface.width,
      surface.height,
    ]);
  }
}
