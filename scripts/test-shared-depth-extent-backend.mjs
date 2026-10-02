import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
let server, browser;
try {
  server = await createServer({
    base: '/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  browser = await chromium.launch(
    process.env.WINEBROWSER_NORMAL_CHROMIUM === '1' ? { headless: false } : webgpuBrowserOptions,
  );
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const report = await page.evaluate(async () => {
    const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
    const { defaultStencil } = await import('/src/d3d-stencil.js');
    const renderer = new WebGPURenderer(),
      errors = [],
      cases = [];
    try {
      await renderer.createDevice({
        id: 1,
        windowId: 1,
        width: 8,
        height: 8,
        depth: true,
        depthFormat: 'depth24plus-stencil8',
      });
      renderer.device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const clear = (color, depth = 1, stencil = 0) => ({
        type: 'clear',
        color,
        depth,
        stencil,
        clearColor: true,
        clearDepth: true,
        clearStencil: true,
      });
      const triangle = (color, z, stencil = null) => {
        const vertices = new Uint8Array(48),
          v = new DataView(vertices.buffer);
        [
          [-1, -1],
          [3, -1],
          [-1, 3],
        ].forEach(([x, y], i) => {
          v.setFloat32(i * 16, x, true);
          v.setFloat32(i * 16 + 4, y, true);
          v.setFloat32(i * 16 + 8, z, true);
          v.setUint32(i * 16 + 12, color, true);
        });
        return {
          type: 'draw',
          vertices,
          vertexCount: 3,
          stride: 16,
          fvf: 0x42,
          world: identity,
          view: identity,
          projection: identity,
          depthTest: true,
          depthWrite: true,
          depthCompare: 'less-equal',
          cullMode: 'none',
          ...(stencil ? { stencil } : {}),
        };
      };
      // Initialize the full shared depth to 0.25 and stencil to 7.
      await renderer.render({ id: 1, commands: [clear(0xff000000, 0.25, 7)] });
      // Clear only the small target's 4x3 region to depth 1 and stencil 9.
      const target = { id: 2, width: 4, height: 3, colorFormat: 21 };
      await renderer.render({ id: 1, target, commands: [clear(0xff000000, 1, 9)] });
      // Depth 0.5 now passes only inside that region of the original depth.
      const pixels = await renderer.render({
        id: 1,
        readback: true,
        commands: [triangle(0xffff0000, 0.5)],
      });
      cases.push({ name: 'shared-depth-clear-preserves-outside', pixels: [...pixels] });
      const green = await renderer.render({
        id: 1,
        readback: true,
        commands: [triangle(0xff00ff00, 0.1, { ...defaultStencil(), 52: 1, 56: 3, 57: 9 })],
      });
      cases.push({ name: 'shared-stencil-clear-preserves-outside', pixels: [...green] });
      // Logical attachment stays selected, but unused color clears do not
      // mutate it, even when the color target is larger than the depth.
      const large = { id: 3, width: 16, height: 16, colorFormat: 21 };
      await renderer.render({
        id: 1,
        target: large,
        commands: [{ ...clear(0xff123456), clearDepth: false, clearStencil: false }],
      });
      let smallerDepthRejected = false;
      try {
        await renderer.render({ id: 1, target: large, commands: [triangle(0xffff0000, 0.2)] });
      } catch (e) {
        smallerDepthRejected = /size mismatch/.test(e.message);
      }
      const paddingBytes = renderer.surfaces.get(1).paddingBytes;
      renderer.destroyTarget({ id: 1, targetId: 2 });
      return {
        cases,
        errors,
        smallerDepthRejected,
        paddingBytes,
        paddingBytesAfterRelease: renderer.surfaces.get(1).paddingBytes,
      };
    } finally {
      renderer.dispose();
    }
  });
  for (const { name, pixels } of report.cases)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const expected =
          x < 4 && y < 3
            ? name.startsWith('shared-depth')
              ? [255, 0, 0, 255]
              : [0, 255, 0, 255]
            : [0, 0, 0, 255];
        assert.deepEqual(
          pixels.slice((y * 8 + x) * 4, (y * 8 + x + 1) * 4),
          expected,
          `${name} ${x},${y}`,
        );
      }
  assert.equal(report.paddingBytes, 8 * 8 * 4);
  assert.equal(report.paddingBytesAfterRelease, 0);
  assert.equal(report.smallerDepthRejected, true);
  assert.deepEqual(report.errors, []);
  const result = { date: new Date().toISOString(), browser: browser.version(), ...report };
  await writeFile(
    'evidence/shared-depth-extent-backend-results.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
