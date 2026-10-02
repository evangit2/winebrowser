// Real browser compilation and sampling of two different 3D texture slices.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ ...webgpuBrowserOptions, headless: true });
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const report = await page.evaluate(async () => {
    const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
    const { D3D12Renderer } = await import('/src/d3d12-renderer.js');
    const pixels = [],
      errors = [];
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const graphics = new WebGPURenderer({
      emit(message) {
        if (message.type === 'frame') {
          ctx.drawImage(message.bitmap, 0, 0);
          message.bitmap.close();
          pixels.push(
            [...ctx.getImageData(16, 32, 1, 1).data],
            [...ctx.getImageData(48, 32, 1, 1).data],
          );
        }
      },
    });
    const renderer = new D3D12Renderer(graphics);
    await renderer.createSwapChain({
      id: 1,
      windowId: 1,
      width: 64,
      height: 64,
      bufferIds: [2, 3],
    });
    renderer.device.addEventListener('uncapturederror', (event) =>
      errors.push(event.error.message),
    );
    const encode = (text) => new TextEncoder().encode(text);
    const { bytes: vertex } = await renderer.compiler.compileHLSL(
      encode(`float4 main(float4 p : POSITION) : SV_Position { return p; }`),
      'main',
      'vs_4_0',
    );
    const { bytes: pixel } = await renderer.compiler.compileHLSL(
      encode(`Texture3D<float4> volume : register(t0);
      float4 main(float4 p : SV_Position) : SV_Target { return volume.Load(int4(0, 0, p.x < 32.0 ? 0 : 1, 0)); }`),
      'main',
      'ps_4_0',
    );
    const stagePlan = await renderer.planD3D10Bindings(vertex, pixel);
    await renderer.createResource({
      id: 4,
      kind: 'texture',
      width: 1,
      height: 1,
      depth: 2,
      dimension: '3d',
      format: 'rgba8unorm',
    });
    await renderer.uploadTexture({
      id: 4,
      width: 1,
      height: 1,
      depth: 2,
      bytesPerRow: 4,
      rowsPerImage: 1,
      rows: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]),
    });
    await renderer.createPipeline({
      id: 5,
      vertex,
      pixel,
      stagePlan,
      inputLayout: [{ semanticName: 'POSITION', semanticIndex: 0, offset: 0, format: 'float32x4' }],
      vertexStride: 16,
    });
    const texture = stagePlan.bindings.find((binding) => binding.type === 0);
    await renderer.execute({
      commands: [
        {
          type: 'draw',
          target: 2,
          pipeline: 5,
          bindings: [
            {
              group: texture.group,
              binding: texture.binding,
              type: 0,
              kind: 'texture-view',
              descriptor: { resource: { pointer: 4 } },
            },
          ],
          vertices: new Uint8Array(
            new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]).buffer,
          ),
          vertexStride: 16,
          vertexCount: 3,
          instanceCount: 1,
          firstVertex: 0,
          firstInstance: 0,
          viewport: { x: 0, y: 0, width: 64, height: 64, minDepth: 0, maxDepth: 1 },
          scissor: { left: 0, top: 0, right: 64, bottom: 64 },
          depthTarget: 0,
        },
      ],
    });
    await renderer.present({ id: 1, index: 0 });
    await renderer.device.queue.onSubmittedWorkDone();
    const { bytes: texturePixel } = await renderer.compiler.compileHLSL(
      encode(
        'Texture2D<float4> tex : register(t0); float4 main(float4 p : SV_Position) : SV_Target { return tex.Load(int3(0, 0, 0)); }',
      ),
      'main',
      'ps_4_0',
    );
    const texturePlan = await renderer.planD3D10Bindings(vertex, texturePixel);
    await renderer.createPipeline({
      id: 7,
      vertex,
      pixel: texturePixel,
      stagePlan: texturePlan,
      inputLayout: [{ semanticName: 'POSITION', semanticIndex: 0, offset: 0, format: 'float32x4' }],
      vertexStride: 16,
    });
    const compressionCases = [];
    for (const [format, block, expected] of [
      ['bc4-r-unorm', [128, 64, 0, 0, 0, 0, 0, 0], [128, 0, 0, 255]],
      ['bc4-r-snorm', [64, 0, 0, 0, 0, 0, 0, 0], [129, 0, 0, 255]],
      ['bc5-rg-unorm', [192, 0, 0, 0, 0, 0, 0, 0, 96, 0, 0, 0, 0, 0, 0, 0], [192, 96, 0, 255]],
      ['bc5-rg-snorm', [127, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0], [255, 0, 0, 255]],
    ]) {
      await renderer.createResource({ id: 6, kind: 'texture', width: 4, height: 4, format });
      await renderer.uploadTexture({
        id: 6,
        width: 4,
        height: 4,
        bytesPerRow: block.length,
        rows: Uint8Array.from(block),
      });
      const binding = texturePlan.bindings.find((b) => b.type === 0);
      await renderer.execute({
        commands: [
          {
            type: 'draw',
            target: 2,
            pipeline: 7,
            bindings: [
              {
                group: binding.group,
                binding: binding.binding,
                type: 0,
                kind: 'texture-view',
                descriptor: { resource: { pointer: 6 } },
              },
            ],
            vertices: new Uint8Array(
              new Float32Array([-1, -1, 0, 1, 3, -1, 0, 1, -1, 3, 0, 1]).buffer,
            ),
            vertexStride: 16,
            vertexCount: 3,
            instanceCount: 1,
            firstVertex: 0,
            firstInstance: 0,
            viewport: { x: 0, y: 0, width: 64, height: 64, minDepth: 0, maxDepth: 1 },
            scissor: { left: 0, top: 0, right: 64, bottom: 64 },
            depthTarget: 0,
          },
        ],
      });
      await renderer.present({ id: 1, index: 0 });
      compressionCases.push({ format, expected, actual: pixels.at(-1) });
      renderer.destroyResource({ id: 6 });
    }
    renderer.destroyResource({ id: 4 });
    return {
      pixels: pixels.slice(0, 2),
      compressionCases,
      errors,
      descriptors: stagePlan.bindings,
      scope:
        'Browser-compiled SM4 shaders sampling 3D slices and BC4/BC5 UNORM/SNORM textures through successive pipelines',
    };
  });
  assert.deepEqual(report.pixels, [
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
  assert.deepEqual(report.errors, []);
  for (const c of report.compressionCases) assert.deepEqual(c.actual, c.expected, c.format);
  await writeFile(
    'evidence/volume-backend-results.json',
    JSON.stringify(
      { date: new Date().toISOString(), browser: browser.version(), ...report },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await server.close();
}
