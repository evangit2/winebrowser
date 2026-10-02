import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
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
    const errors = [],
      pixels = [],
      canvas = new OffscreenCanvas(64, 64),
      ctx = canvas.getContext('2d');
    const renderer = new WebGPURenderer({
      emit(m) {
        if (m.type === 'frame') {
          ctx.drawImage(m.bitmap, 0, 0);
          m.bitmap.close();
          pixels.push(
            [...ctx.getImageData(16, 32, 1, 1).data],
            [...ctx.getImageData(48, 32, 1, 1).data],
          );
        }
      },
    });
    await renderer.createDevice({ id: 1, windowId: 1, width: 64, height: 64, depth: false });
    renderer.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const bytecode = (words) => new Uint8Array(new Uint32Array(words).buffer);
    const vertices = new Float32Array([
      -1, -1, 0, 1, 0.5, 0.5, 0.25, 0, 1, -1, 0, 1, 0.5, 0.5, 0.75, 0, 1, 1, 0, 1, 0.5, 0.5, 0.75,
      0, -1, -1, 0, 1, 0.5, 0.5, 0.25, 0, 1, 1, 0, 1, 0.5, 0.5, 0.75, 0, -1, 1, 0, 1, 0.5, 0.5,
      0.25, 0,
    ]);
    const command = {
      type: 'draw-programmable',
      vertices: new Uint8Array(vertices.buffer),
      vertexCount: 6,
      stride: 32,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        { shaderLocation: 1, offset: 16, format: 'float32x4' },
      ],
      vertexShader: bytecode([
        0xfffe0101, 0x0000001f, 0x80000000, 0x900f0000, 0x0000001f, 0x80000005, 0x900f0001, 1,
        0xc00f0000, 0x90e40000, 1, 0xe00f0000, 0x90e40001, 0xffff,
      ]),
      pixelShader: bytecode([
        0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0xa0000000, 0xa00f0800,
        0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x02000001, 0x800f0800, 0x80e40000, 0xffff,
      ]),
      vertexShaderId: 1,
      pixelShaderId: 2,
      vertexConstants: new Float32Array(1024),
      pixelConstants: new Float32Array(896),
      depthTest: false,
      depthWrite: false,
      cullMode: 'none',
      textures: new Map([
        [
          0,
          {
            snapshot: {
              id: 3,
              revision: 0,
              dimension: '3d',
              levels: [
                {
                  width: 1,
                  height: 1,
                  depth: 2,
                  rgba: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]),
                },
              ],
            },
            sampler: { 1: 3, 2: 3, 3: 3, 5: 1, 6: 1, 7: 0 },
          },
        ],
      ]),
    };
    try {
      await renderer.present({ id: 1, commands: [command] });
      const mismatch = {
        ...command,
        textures: new Map([
          [
            0,
            {
              ...command.textures.get(0),
              snapshot: {
                id: 4,
                revision: 0,
                levels: [{ width: 1, height: 1, rgba: new Uint8Array([255, 0, 0, 255]) }],
              },
            },
          ],
        ]),
      };
      let rejected = false;
      try {
        await renderer.present({ id: 1, commands: [mismatch] });
      } catch (e) {
        rejected = /dimension/.test(e.message);
      }
      await renderer.device.queue.onSubmittedWorkDone();
      return { pixels, errors, mismatchedDimensionRejected: rejected };
    } finally {
      renderer.dispose();
    }
  });
  assert.deepEqual(report.pixels, [
    [255, 0, 0, 255],
    [0, 0, 255, 255],
  ]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.mismatchedDimensionRejected, true);
  await writeFile(
    'evidence/d3d9-volume-backend-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: browser.version(),
        ...report,
        scope:
          'Real PS2 sampler3D compilation and two depth-slice pixels; no third-party scene claim.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await server.close();
}
