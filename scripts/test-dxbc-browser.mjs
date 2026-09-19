import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/tests/fixtures/desktop-controls.html');
  const vertex = await readFile('tests/fixtures/shaders/fullscreen.vs.dxbc');
  const fragment = await readFile('tests/fixtures/shaders/green.ps.dxbc');
  const result = await page.evaluate(
    ({ vertex, fragment }) =>
      new Promise((resolve, reject) => {
        const worker = new Worker('/tests/fixtures/shader-compiler-worker.js', { type: 'module' });
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(Error('Shader worker timed out'));
        }, 45000);
        worker.onerror = (error) => {
          clearTimeout(timeout);
          worker.terminate();
          reject(Error(error.message));
        };
        worker.onmessage = ({ data }) => {
          if (data.type !== 'shader-result') return;
          clearTimeout(timeout);
          worker.terminate();
          if (data.error) return reject(Error(data.error));
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 128;
          canvas
            .getContext('2d')
            .putImageData(new ImageData(new Uint8ClampedArray(data.pixels), 128, 128), 0, 0);
          document.body.append(canvas);
          const pixel = (x, y) => [...data.pixels.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)];
          let greenPixels = 0;
          for (let i = 0; i < data.pixels.length; i += 4)
            if (
              data.pixels[i] === 0 &&
              data.pixels[i + 1] === 255 &&
              data.pixels[i + 2] === 0 &&
              data.pixels[i + 3] === 255
            )
              greenPixels++;
          const { pixels, ...report } = data;
          resolve({ ...report, center: pixel(64, 64), corner: pixel(0, 0), greenPixels });
        };
        worker.postMessage({
          vertex: Uint8Array.from(vertex),
          fragment: Uint8Array.from(fragment),
        });
      }),
    { vertex: [...vertex], fragment: [...fragment] },
  );
  assert.deepEqual(result.center, [0, 255, 0, 255]);
  assert.deepEqual(result.corner, [17, 34, 51, 255]);
  assert.equal(result.greenPixels, 96 * 96);
  assert.equal(
    result.drawOffsetPreserved,
    true,
    'Nonzero first vertex is subtracted through draw parameters',
  );
  assert.equal(result.invalid.length, 2);
  assert.deepEqual(
    result.rootSignatures.map((entry) => entry.flags),
    [0, 1],
  );
  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await page.locator('canvas').screenshot({ path: 'evidence/dxbc-shader-browser.png' });
  const report = {
    scope:
      'Browser-worker DXBC SM5 -> SPIR-V -> WGSL compilation and WebGPU draw; separate from Windows EXE or D3D12 frontend acceptance',
    browser: browser.version(),
    sourceHashes: [vertex, fragment].map((bytes) =>
      createHash('sha256').update(bytes).digest('hex'),
    ),
    ...result,
    errors,
  };
  await writeFile(
    'evidence/dxbc-shader-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        shaders: result.shaders.map(({ spirvBytes, wgsl }) => ({
          spirvBytes,
          wgslBytes: wgsl.length,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server.close();
}
