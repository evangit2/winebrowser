import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
const forceReadback = process.argv.includes('--force-readback');
let browser;
try {
  await server.listen();
  const vertex = await readFile('demos/d3d12-cube/shaders/cube.vs.dxbc');
  const pixel = await readFile('demos/d3d12-cube/shaders/cube.ps.dxbc');
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const report = await page.evaluate(
    async ({ vertex, pixel, forceReadback }) => {
      const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
      const { D3D12Renderer } = await import('/src/d3d12-renderer.js');
      const frames = [],
        logs = [];
      const canvas = document.createElement('canvas');
      canvas.width = 130;
      canvas.height = 128;
      document.body.append(canvas);
      const context = canvas.getContext('2d');
      const graphics = new WebGPURenderer({
        forceReadback,
        emit(message) {
          if (message.type === 'log') logs.push(message.text);
          if (message.type !== 'frame') return;
          context.drawImage(message.bitmap, 0, 0);
          message.bitmap.close();
          const pixelAt = (x, y) => [...context.getImageData(x, y, 1, 1).data];
          frames.push({ center: pixelAt(64, 64), corner: pixelAt(0, 0) });
        },
      });
      const renderer = new D3D12Renderer(graphics);
      try {
        await renderer.execute({ commands: [] }); // Empty queue works before creating surfaces.
        await renderer.createSwapChain({
          id: 1,
          windowId: 1,
          width: 130,
          height: 128,
          bufferIds: [2, 3],
        });
        await renderer.createResource({
          id: 4,
          kind: 'depth',
          width: 130,
          height: 128,
          format: 'depth16unorm',
        });
        const inputLayout = [0, 1].map((index) => ({
          shaderLocation: index,
          offset: index * 16,
          format: 'float32x4',
        }));
        const pipeline = {
          vertex: Uint8Array.from(vertex),
          pixel: Uint8Array.from(pixel),
          inputLayout,
          vertexStride: 32,
        };
        await renderer.createPipeline({
          ...pipeline,
          id: 5,
          depth: { format: 'depth16unorm', writeEnabled: true, compare: 'less-equal' },
        });
        await renderer.createPipeline({ ...pipeline, id: 6 });
        const vertices = (z, color, firstVertex = 0) => {
          const data = new Float32Array((3 + firstVertex) * 8);
          [
            [-0.75, -0.75],
            [0.75, -0.75],
            [0, 0.75],
          ].forEach(([x, y], i) => data.set([x, y, z, 1, ...color], (i + firstVertex) * 8));
          return new Uint8Array(data.buffer);
        };
        const draw = (z, color, depth = true, firstVertex = 0) => ({
          type: 'draw',
          target: 2,
          pipeline: depth ? 5 : 6,
          depthTarget: depth ? 4 : null,
          vertices: vertices(z, color, firstVertex),
          vertexStride: 32,
          viewport: { x: 0, y: 0, width: 130, height: 128, minDepth: 0, maxDepth: 1 },
          scissor: { left: 0, top: 0, right: 130, bottom: 128 },
          vertexCount: 3,
          instanceCount: 1,
          firstVertex,
          firstInstance: 0,
        });
        const indexedDraw = (width, color, values, firstIndex = 0, baseVertex = 0) => {
          const command = draw(0.25, color, true, Math.max(baseVertex, 0));
          delete command.vertexCount;
          delete command.firstVertex;
          return {
            ...command,
            indices: new Uint8Array(
              (width === 2 ? new Uint16Array(values) : new Uint32Array(values)).buffer,
            ),
            indexFormat: width === 2 ? 'uint16' : 'uint32',
            indexCount: 3,
            firstIndex,
            baseVertex,
          };
        };
        const clear = { type: 'clear', target: 2, color: [17 / 255, 34 / 255, 51 / 255, 0] };
        const clearDepth = { type: 'clear-depth', target: 4, depth: 1 };
        for (const commands of [
          [clear, clearDepth, draw(0.25, [1, 0, 0, 1]), draw(0.75, [0, 0, 1, 1])],
          [clear, clearDepth, draw(0.25, [1, 0, 0, 1]), draw(0.75, [0, 0, 1, 1], false)],
          [clear, clearDepth, draw(0.25, [0, 1, 0, 1], true, 3)],
          [clear, { ...clearDepth, depth: 0.1 }, draw(0.25, [1, 0, 0, 1])],
          [clear, clearDepth, indexedDraw(2, [1, 1, 0, 1], [0, 1, 2])],
          [clear, clearDepth, indexedDraw(2, [1, 0, 1, 1], [99, 3, 1, 2], 1, -1)],
          [clear, clearDepth, indexedDraw(4, [0, 1, 1, 1], [99, 0, 1, 2], 1, 3)],
        ]) {
          await renderer.execute({ commands });
          await renderer.present({ id: 1, index: 0 });
        }
        const cases = [];
        for (const command of [
          { ...draw(0.25, [1, 0, 0, 1]), vertices: new Uint8Array(8) },
          { ...draw(0.25, [1, 0, 0, 1]), vertexStride: 16 },
          { ...draw(0.25, [1, 0, 0, 1]), depthTarget: 2 },
          { ...clearDepth, depth: 2 },
          { ...clear, target: 4 },
          indexedDraw(2, [1, 0, 0, 1], [0, 1, 3]),
          indexedDraw(4, [1, 0, 0, 1], [0, 1, 0xffffffff]),
          indexedDraw(2, [1, 0, 0, 1], [0, 1, 2], 0, -1),
          indexedDraw(4, [1, 0, 0, 1], [0, 1, 2], 1),
        ]) {
          let rejected = false;
          try {
            await renderer.execute({ commands: [command] });
          } catch {
            rejected = true;
          }
          if (!rejected) throw Error('Invalid D3D12 resource command accepted');
          cases.push('invalid command rejected');
        }
        renderer.destroyResource({ id: 4 });
        let releasedRejected = false;
        try {
          await renderer.execute({ commands: [clearDepth] });
        } catch {
          releasedRejected = true;
        }
        if (!releasedRejected) throw Error('Released depth resource accepted');
        return {
          frames,
          draws: renderer.draws,
          presentationMode: graphics.presentationMode,
          fallbackAdapter: graphics.fallbackAdapter,
          cases,
          releasedRejected,
          logs,
        };
      } finally {
        renderer.dispose();
        graphics.dispose();
      }
    },
    { vertex: [...vertex], pixel: [...pixel], forceReadback },
  );
  assert.deepEqual(
    report.frames.map((frame) => frame.center),
    [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [0, 255, 0, 255],
      [17, 34, 51, 255],
      [255, 255, 0, 255],
      [255, 0, 255, 255],
      [0, 255, 255, 255],
    ],
  );
  assert.ok(
    report.frames.every(
      (frame) => JSON.stringify(frame.corner) === JSON.stringify([17, 34, 51, 255]),
    ),
  );
  assert.equal(report.draws, 9);
  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  const filename = forceReadback
    ? 'evidence/d3d12-backend-readback-results.json'
    : 'evidence/d3d12-backend-results.json';
  await writeFile(
    filename,
    JSON.stringify(
      {
        scope:
          'Actual DXBC shader compilation, vertex input, R16/R32 indexed draws with signed base vertex and first index, and D16 depth rendering; separate from native EXE acceptance',
        date: new Date().toISOString(),
        browser: browser.version(),
        passed: true,
        ...report,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
