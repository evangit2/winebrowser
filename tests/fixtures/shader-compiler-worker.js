import { ShaderCompiler } from '../../src/shader-compiler.js';

onmessage = async ({ data }) => {
  let device;
  try {
    const compiler = new ShaderCompiler({ baseURL: new URL('/', location.origin) });
    const start = performance.now();
    const vertex = await compiler.compile(data.vertex);
    const fragment = await compiler.compile(data.fragment);
    const compilationMs = performance.now() - start;
    const rootSignatures = [];
    for (const flags of [0, 1]) {
      const bytes = await compiler.serializeRootSignature(flags);
      const parsed = await compiler.validateRootSignature(bytes);
      if (parsed !== flags) throw Error('Root signature flags changed during round trip');
      rootSignatures.push({ flags, bytes: bytes.length });
      bytes[4] ^= 1;
      let rejected = false;
      try {
        await compiler.validateRootSignature(bytes);
      } catch {
        rejected = true;
      }
      if (!rejected) throw Error('Corrupt root signature accepted');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw Error('WebGPU adapter unavailable');
    device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const modules = [vertex, fragment].map(({ wgsl }) => device.createShaderModule({ code: wgsl }));
    for (const module of modules) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === 'error');
      if (errors.length) throw Error(errors.map((error) => error.message).join('\n'));
    }
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: modules[0] },
      fragment: { module: modules[1], targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const texture = device.createTexture({
      size: [128, 128],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 128 * 128 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const drawParameters = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const groups = Array.from({ length: 4 }, (_, index) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(index),
        entries: index === 3 ? [{ binding: 0, resource: { buffer: drawParameters } }] : [],
      }),
    );
    const render = async (firstVertex) => {
      device.queue.writeBuffer(drawParameters, 0, new Int32Array([firstVertex, 0, 0, 0]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [17 / 255, 34 / 255, 51 / 255, 1],
          },
        ],
      });
      pass.setPipeline(pipeline);
      groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.setViewport(16, 16, 96, 96, 0, 1);
      pass.draw(3, 1, firstVertex, 0);
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 512 }, [128, 128]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      return pixels;
    };
    const pixels = await render(0);
    const offsetPixels = await render(7);
    const drawOffsetPreserved = pixels.every((value, index) => value === offsetPixels[index]);
    const validation = await device.popErrorScope();
    if (validation) throw Error(validation.message);
    texture.destroy();
    readback.destroy();
    drawParameters.destroy();

    const invalid = [];
    for (const bytes of [new Uint8Array(32), data.vertex.slice(0, 32)]) {
      try {
        await compiler.compile(bytes);
        throw Error('Malformed shader was accepted');
      } catch (error) {
        if (error.message === 'Malformed shader was accepted') throw error;
        invalid.push(error.message);
      }
    }
    postMessage(
      {
        type: 'shader-result',
        pixels,
        compilationMs,
        drawOffsetPreserved,
        rootSignatures,
        shaders: [vertex, fragment].map(({ spirv, wgsl }) => ({ spirvBytes: spirv.length, wgsl })),
        invalid,
      },
      [pixels.buffer],
    );
  } catch (error) {
    postMessage({ type: 'shader-result', error: error.stack ?? error.message ?? String(error) });
  } finally {
    device?.destroy();
  }
};
