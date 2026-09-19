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
const forceReadback = process.argv.includes('--force-readback');
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/tests/fixtures/desktop-controls.html');
  const report = await page.evaluate(async (forceReadback) => {
    const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = 130; // Exercise padded rows in software-adapter readback.
    canvas.height = 128;
    document.body.append(canvas);
    const context = canvas.getContext('2d');
    const frames = [];
    const logs = [];
    const renderer = new WebGPURenderer({
      forceReadback,
      emit: (message) => {
        if (message.type === 'log') logs.push(message.text);
        if (message.type !== 'frame') return;
        context.drawImage(message.bitmap, 0, 0);
        message.bitmap.close();
        const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
        frames.push({ center: pixel(64, 64), corner: pixel(0, 0) });
      },
    });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const vertices = (z, color) => {
      const bytes = new Uint8Array(48),
        data = new DataView(bytes.buffer);
      for (const [i, [x, y]] of [
        [-0.75, -0.75],
        [0.75, -0.75],
        [0, 0.75],
      ].entries()) {
        data.setFloat32(i * 16, x, true);
        data.setFloat32(i * 16 + 4, y, true);
        data.setFloat32(i * 16 + 8, z, true);
        data.setUint32(i * 16 + 12, color, true);
      }
      return bytes;
    };
    const draw = (z, color, depthTest = true, world = identity) => ({
      type: 'draw',
      vertices: vertices(z, color),
      vertexCount: 3,
      stride: 16,
      world,
      view: identity,
      projection: identity,
      depthTest,
      depthWrite: true,
      cullMode: 'none',
    });
    const clear = {
      type: 'clear',
      clearColor: true,
      clearDepth: true,
      color: 0x00252d41, // Guest window presentation is opaque despite clear alpha.
      depth: 1,
    };
    const legacyShader = async (path) =>
      new Uint8Array(await (await fetch('/tests/fixtures/shaders/legacy/' + path)).arrayBuffer());
    const programmable = async (pixelOnly = false) => {
      const data = new Float32Array([
        -0.75, -0.75, 0.25, 1, 1, 1, 1, 1, 0.75, -0.75, 0.25, 1, 1, 1, 1, 1, 0, 0.75, 0.25, 1, 1, 1,
        1, 1,
      ]);
      const vertexConstants = new Float32Array(256 * 4);
      if (!pixelOnly) vertexConstants.set([1, 0.5, 0.25, 1]);
      const pixelConstants = new Float32Array(224 * 4);
      if (pixelOnly) {
        pixelConstants.set([0.25, 0.25, 0.5, 0.5], 4); // c1
        pixelConstants.set([0, 0.25, 0.25, 0.5], 8); // c2
      }
      return {
        type: 'draw-programmable',
        vertices: new Uint8Array(data.buffer),
        vertexCount: 3,
        stride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
        ],
        vertexShader: await legacyShader(
          pixelOnly ? 'wine-color.vs11.d3dbc' : 'wine-color-constant.vs11.d3dbc',
        ),
        pixelShader: await legacyShader(
          pixelOnly ? 'wine-pixel-constant.ps20.d3dbc' : 'wine-color.ps20.d3dbc',
        ),
        vertexShaderId: pixelOnly ? 3 : 1,
        pixelShaderId: pixelOnly ? 4 : 2,
        vertexConstants,
        pixelConstants,
        depthTest: true,
        depthWrite: true,
        cullMode: 'none',
      };
    };
    try {
      await renderer.createDevice({ id: 1, windowId: 1, width: 130, height: 128, depth: true });
      await renderer.present({
        id: 1,
        commands: [clear, draw(0.25, 0xffff0000), draw(0.75, 0xff0000ff)],
      });
      await renderer.present({
        id: 1,
        commands: [clear, draw(0.25, 0xffff0000), draw(0.75, 0xff0000ff, false)],
      });
      const translated = [...identity];
      translated[12] = 2;
      await renderer.present({
        id: 1,
        commands: [clear, draw(0.25, 0xffff0000, true, translated)],
      });
      await renderer.present({ id: 1, commands: [clear, await programmable()] });
      await renderer.present({ id: 1, commands: [clear, await programmable(true)] });
      const cases = [];
      for (const command of [
        { ...draw(0.5, 0xff00ff00), stride: 12 },
        { ...draw(0.5, 0xff00ff00), vertices: new Uint8Array(4) },
        { ...clear, depth: 2 },
      ]) {
        let rejected = false;
        try {
          await renderer.present({ id: 1, commands: [command] });
        } catch {
          rejected = true;
        }
        if (!rejected) throw Error('Invalid graphics command was accepted');
        cases.push('invalid command rejected');
      }
      return {
        scope:
          'WebGPU backend geometry/depth/transform tests, separate from Windows executable acceptance',
        frames,
        submittedFrames: renderer.frames,
        draws: renderer.draws,
        presentationMode: renderer.presentationMode,
        fallbackAdapter: renderer.fallbackAdapter,
        logs,
        cases,
      };
    } finally {
      renderer.dispose();
    }
  }, forceReadback);
  assert.equal(
    report.presentationMode,
    forceReadback || report.fallbackAdapter ? 'readback' : 'canvas',
  );
  assert.ok(report.logs.some((line) => line.includes(`${report.presentationMode} presentation`)));
  assert.deepEqual(
    report.frames.map((f) => f.center),
    [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [37, 45, 65, 255],
      [255, 128, 64, 255],
      [64, 128, 191, 255],
    ],
  );
  assert.ok(
    report.frames.every((f) => JSON.stringify(f.corner) === JSON.stringify([37, 45, 65, 255])),
  );
  assert.equal(report.submittedFrames, 5);
  assert.equal(report.draws, 7);
  assert.deepEqual(errors, []);
  await writeFile(
    forceReadback
      ? 'evidence/webgpu-backend-readback-results.json'
      : 'evidence/webgpu-backend-results.json',
    JSON.stringify(
      { ...report, date: new Date().toISOString(), browser: await browser.version(), passed: true },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
