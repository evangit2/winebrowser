import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outbound = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(origin + '/')) outbound.push(r.url());
  });
  await page.goto(origin + '/tests/fixtures/desktop-controls.html');
  const source = await readFile('tests/fixtures/shaders/microsoft-hello-triangle/shaders.hlsl');
  const pin = JSON.parse(
    await readFile('runtime/target-builds/microsoft-hello-triangle.json', 'utf8'),
  );
  assert.equal(createHash('sha256').update(source).digest('hex'), pin.files['shaders.hlsl']);
  const report = await page.evaluate(
    (source) =>
      new Promise((resolve, reject) => {
        const worker = new Worker('/tests/fixtures/hlsl-worker.js', { type: 'module' });
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(Error('HLSL worker timed out'));
        }, 45000);
        worker.onerror = (e) => {
          clearTimeout(timeout);
          worker.terminate();
          reject(Error(e.message));
        };
        worker.onmessage = ({ data }) => {
          clearTimeout(timeout);
          worker.terminate();
          if (data.error) return reject(Error(data.error));
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 128;
          canvas
            .getContext('2d')
            .putImageData(new ImageData(new Uint8ClampedArray(data.pixels), 128, 128), 0, 0);
          document.body.append(canvas);
          const sample = (x, y) => [...data.pixels.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
          const { pixels, ...rest } = data;
          let coverage = 0,
            opaque = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 0) coverage++;
            if (pixels[i + 3] === 255) opaque++;
          }
          resolve({
            ...rest,
            coverage,
            opaque,
            corner: sample(0, 0),
            center: sample(64, 64),
            top: sample(64, 20),
            left: sample(25, 105),
            right: sample(103, 105),
          });
        };
        worker.postMessage({ source: Uint8Array.from(source) });
      }),
    [...source],
  );
  assert.deepEqual(report.corner, [0, 51, 102, 255]);
  assert.ok(report.coverage > 5000 && report.coverage < 5400);
  assert.equal(report.opaque, 128 * 128);
  assert.ok(report.top[0] > 200 && report.left[2] > 200 && report.right[1] > 200);
  assert.ok(report.center.slice(0, 3).every((x) => x > 50 && x < 150));
  assert.equal(report.invalid.length, 4);
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  await page.locator('canvas').screenshot({ path: 'evidence/hlsl-browser.png' });
  const result = {
    scope:
      'Original Microsoft HelloTriangle HLSL compiled in a browser worker to DXBC, SPIR-V and WGSL, then rendered with WebGPU. This compiler test does not execute the upstream C++ EXE.',
    browser: browser.version(),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    ...report,
    errors,
    outbound,
  };
  await writeFile('evidence/hlsl-browser-results.json', JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        ...result,
        stages: result.stages.map(({ wgsl, ...s }) => ({ ...s, wgslBytes: wgsl.length })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
