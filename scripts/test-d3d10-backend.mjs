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
let browser;
try {
  await server.listen();
  const vertex = await readFile('demos/d3d10-cube/shaders/cube.vs.dxbc');
  const pixel = await readFile('demos/d3d10-cube/shaders/cube.ps.dxbc');
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const report = await page.evaluate(
    async ({ vertex, pixel }) => {
      const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
      const { D3D12Renderer } = await import('/src/d3d12-renderer.js');
      const { planStageBindings } = await import('/src/d3d10-bindings.js');
      // The arguments arrive as plain arrays across the page boundary.
      const vsBytes = Uint8Array.from(vertex),
        psBytes = Uint8Array.from(pixel);
      const frames = [],
        logs = [];
      const canvas = document.createElement('canvas');
      canvas.width = 130;
      canvas.height = 128;
      document.body.append(canvas);
      const context = canvas.getContext('2d');
      const graphics = new WebGPURenderer({
        emit(message) {
          if (message.type === 'log') logs.push(message.text);
          if (message.type !== 'frame') return;
          context.drawImage(message.bitmap, 0, 0);
          message.bitmap.close();
          frames.push([...context.getImageData(64, 64, 1, 1).data]);
        },
      });
      const renderer = new D3D12Renderer(graphics);
      try {
        await renderer.createSwapChain({
          id: 1,
          windowId: 1,
          width: 130,
          height: 128,
          bufferIds: [2, 3],
        });
        const planned = await renderer.planD3D10Bindings(vsBytes, psBytes);
        // The D3D10 planner keeps one register file per stage, so a register
        // both stages declare must reach two distinct bindings.
        const raw = await renderer.compiler.scanDescriptors(vsBytes);
        const stage = planStageBindings(raw, []);
        await renderer.createPipeline({
          id: 5,
          vertex: vsBytes.slice(),
          pixel: psBytes.slice(),
          inputLayout: [
            { semanticName: 'POSITION', semanticIndex: 0, offset: 0, format: 'float32x4' },
            { semanticName: 'COLOR', semanticIndex: 0, offset: 16, format: 'float32x4' },
          ],
          vertexStride: 32,
          stagePlan: planned,
        });
        const vertices = new Uint8Array(
          new Float32Array([
            -0.9, -0.9, 0, 1, 1, 0, 0, 1, 0.9, -0.9, 0, 1, 0, 1, 0, 1, 0, 0.9, 0, 1, 0, 0, 1, 1,
          ]).buffer,
        );
        await renderer.execute({
          commands: [
            {
              type: 'draw',
              bindings: [],
              target: 2,
              pipeline: 5,
              viewport: { x: 0, y: 0, width: 130, height: 128, minDepth: 0, maxDepth: 1 },
              scissor: { left: 0, top: 0, right: 130, bottom: 128 },
              vertexCount: 3,
              instanceCount: 1,
              firstVertex: 0,
              firstInstance: 0,
              vertices,
              vertexStride: 32,
              depthTarget: 0,
            },
          ],
        });
        await renderer.present({ id: 1, index: 0 });
        return {
          logs,
          frames,
          stageBindings: stage.bindings,
          planBindings: planned.bindings.map((b) => ({
            stage: b.stage,
            type: b.type,
            register: b.register,
            group: b.group,
            binding: b.binding,
          })),
        };
      } catch (error) {
        const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
        void WebGPURenderer;
        return { logs, frames, error: error.message ?? String(error) };
      }
    },
    { vertex: [...vertex], pixel: [...pixel] },
  );
  assert.equal(report.error, undefined, report.error);
  assert.ok(report.frames.length >= 1, 'the SM4 pipeline presented a frame');
  assert.equal(report.frames[0][3], 255, 'the frame is opaque');
  assert.ok(
    report.frames[0][0] + report.frames[0][1] + report.frames[0][2] > 90,
    `the triangle covers the centre pixel (${report.frames[0].join(',')})`,
  );
  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d10-backend-results.json',
    JSON.stringify({ report, errors }, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
}
