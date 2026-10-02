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
    const { defaultSampler, defaultStage } = await import('/src/d3d-texture-state.js');
    const errors = [],
      pixels = [],
      canvas = new OffscreenCanvas(64, 64),
      ctx = canvas.getContext('2d');
    const renderer = new WebGPURenderer({
      emit(m) {
        if (m.type === 'frame') {
          ctx.drawImage(m.bitmap, 0, 0);
          m.bitmap.close();
          for (let face = 0; face < 6; face++)
            pixels.push([...ctx.getImageData(Math.floor(((face + 0.5) * 64) / 6), 32, 1, 1).data]);
        }
      },
    });
    await renderer.createDevice({ id: 1, windowId: 1, width: 64, height: 64, depth: false });
    renderer.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const bytecode = (words) => new Uint8Array(new Uint32Array(words).buffer);
    const directions = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const vertexData = [];
    for (let face = 0; face < 6; face++) {
      const left = -1 + face / 3,
        right = left + 1 / 3;
      for (const [x, y] of [
        [left, -1],
        [right, -1],
        [right, 1],
        [left, -1],
        [right, 1],
        [left, 1],
      ])
        vertexData.push(x, y, 0, 1, ...directions[face], 0);
    }
    const vertices = new Float32Array(vertexData);
    const command = {
      type: 'draw-programmable',
      vertices: new Uint8Array(vertices.buffer),
      vertexCount: 36,
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
        0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x98000000, 0xa00f0800,
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
              dimension: 'cube',
              levels: [
                {
                  width: 1,
                  height: 1,
                  rgba: new Uint8Array([
                    255, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 0, 255, 255, 0, 255,
                    255, 0, 255, 255, 255,
                  ]),
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
      const fixedBytes = new Uint8Array(36 * 28),
        fixedView = new DataView(fixedBytes.buffer);
      for (let i = 0; i < 36; i++) {
        for (let c = 0; c < 3; c++) fixedView.setFloat32(i * 28 + c * 4, vertices[i * 8 + c], true);
        fixedView.setUint32(i * 28 + 12, 0xffffffff, true);
        for (let c = 0; c < 3; c++)
          fixedView.setFloat32(i * 28 + 16 + c * 4, vertices[i * 8 + 4 + c], true);
      }
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      await renderer.present({
        id: 1,
        commands: [
          {
            type: 'draw',
            vertices: fixedBytes,
            vertexCount: 36,
            stride: 28,
            fvf: 0x10142,
            world: identity,
            view: identity,
            projection: identity,
            depthTest: false,
            depthWrite: false,
            cullMode: 'none',
            texturing: {
              texture: command.textures.get(0).snapshot,
              stage: defaultStage(0),
              sampler: defaultSampler(),
              lod: 0,
            },
          },
        ],
      });
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
  const expectedFaces = [
    [255, 0, 0, 255],
    [0, 0, 255, 255],
    [0, 255, 0, 255],
    [255, 255, 0, 255],
    [255, 0, 255, 255],
    [0, 255, 255, 255],
  ];
  assert.deepEqual(report.pixels, [...expectedFaces, ...expectedFaces]);
  assert.deepEqual(report.errors, []);
  assert.equal(report.mismatchedDimensionRejected, true);
  await writeFile(
    'evidence/d3d9-cubemap-backend-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: browser.version(),
        ...report,
        scope:
          'Real PS2 samplerCube compilation and all six directed face pixels through both programmable and fixed-function paths; no third-party scene claim.',
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
