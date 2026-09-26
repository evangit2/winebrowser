import { ShaderCompiler } from '../../src/shader-compiler.js';
onmessage = async ({ data }) => {
  let device;
  try {
    const compiler = new ShaderCompiler({ baseURL: new URL('/', location.origin) });
    const start = performance.now();
    const stages = [];
    for (const [entry, profile] of [
      ['VSMain', 'vs_5_0'],
      ['PSMain', 'ps_5_0'],
    ]) {
      const compiled = await compiler.compileHLSL(data.source, entry, profile, 'shaders.hlsl');
      const translated = await compiler.compile(compiled.bytes);
      stages.push({ ...translated, dxbc: compiled.bytes, messages: compiled.messages });
    }
    const compilationMs = performance.now() - start;
    const invalid = [];
    for (const [source, entry, profile] of [
      [new TextEncoder().encode('not a shader'), 'VSMain', 'vs_5_0'],
      [data.source, 'MissingEntry', 'vs_5_0'],
      [data.source, 'VSMain', 'vs_6_0'],
      [new TextEncoder().encode('#include "missing.hlsl"\n'), 'VSMain', 'vs_5_0'],
    ]) {
      try {
        await compiler.compileHLSL(source, entry, profile);
      } catch (error) {
        invalid.push(error.message);
      }
    }
    if (invalid.length !== 4) throw Error('Invalid HLSL unexpectedly compiled');
    // A successful compile after errors must not expose stale result/diagnostics.
    const recovered = await compiler.compileHLSL(data.source, 'VSMain', 'vs_5_0');
    if (recovered.messages || !recovered.bytes.every((v, i) => v === stages[0].dxbc[i]))
      throw Error('HLSL recovery changed output');
    const adapter = await navigator.gpu.requestAdapter();
    device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const modules = stages.map(({ wgsl }) => device.createShaderModule({ code: wgsl }));
    for (const m of modules) {
      const info = await m.getCompilationInfo();
      if (info.messages.some((x) => x.type === 'error')) throw Error(JSON.stringify(info.messages));
    }
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: modules[0],
        buffers: [
          {
            arrayStride: 32,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x4' },
              { shaderLocation: 1, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module: modules[1], targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const vertices = new Float32Array([
      0, 0.8, 0, 1, 1, 0, 0, 1, 0.8, -0.8, 0, 1, 0, 1, 0, 1, -0.8, -0.8, 0, 1, 0, 0, 1, 1,
    ]);
    const vertex = device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertex, 0, vertices);
    const texture = device.createTexture({
      size: [128, 128],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 128 * 128 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0.2, 0.4, 1],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertex);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 512 }, [128, 128]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    const error = await device.popErrorScope();
    if (error) throw Error(error.message);
    postMessage(
      {
        pixels,
        compilationMs,
        invalid,
        stages: stages.map((s) => ({
          dxbcBytes: s.dxbc.length,
          spirvBytes: s.spirv.length,
          wgsl: s.wgsl,
          messages: s.messages,
        })),
      },
      [pixels.buffer],
    );
    vertex.destroy();
    texture.destroy();
    readback.destroy();
  } catch (error) {
    postMessage({ error: error.stack ?? String(error) });
  } finally {
    device?.destroy();
  }
};
