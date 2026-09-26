import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(webgpuBrowserOptions);
  const runs = [];
  for (const version of [8, 9]) {
    const bytes = await readFile(`tests/fixtures/textures/d3d${version}.exe`);
    for (const [name, buffer] of [
      [`d3d${version}.exe`, bytes],
      [`d3d${version}.zip`, Buffer.from(zipSync({ [`game/d3d${version}.exe`]: bytes }))],
    ]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await page
        .locator('#file')
        .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await page.locator('#run').click();
      await page.waitForFunction(() => {
        if (document.querySelector('#state').textContent === 'ERROR')
          throw Error(document.querySelector('#output').textContent);
        if (window.__lastRun)
          throw Error('Fixture exited early: ' + JSON.stringify(window.__lastRun));
        return (
          Number(document.querySelector('[data-renderer="webgpu"]')?.dataset.graphicsFrames) >= 4
        );
      });
      const canvas = page.locator('[data-renderer="webgpu"]');
      const pixels = await canvas.evaluate((e) => {
        const data = e.getContext('2d').getImageData(0, 0, e.width, e.height).data;
        const colors = [
          [255, 0, 0],
          [0, 255, 0],
          [255, 255, 0],
          [0, 255, 255],
          [0, 0, 255],
          [255, 255, 255],
          [255, 0, 255],
          [128, 128, 128],
        ];
        let bad = 0;
        for (let y = 0; y < 128; y++)
          for (let x = 0; x < 256; x++) {
            const expected = colors[Math.floor(y / 64) * 4 + Math.floor(x / 64)],
              offset = (y * 256 + x) * 4;
            if (expected.some((v, i) => data[offset + i] !== v) || data[offset + 3] !== 255) bad++;
          }
        return {
          width: e.width,
          height: e.height,
          frames: Number(e.dataset.graphicsFrames),
          bad,
          verifiedPixels: e.width * e.height,
        };
      });
      assert.deepEqual(
        [pixels.width, pixels.height, pixels.bad],
        [256, 128, 0],
        JSON.stringify(pixels),
      );
      await canvas.click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => window.__lastRun !== null || document.querySelector('#state').textContent === 'ERROR',
      );
      const result = await page.evaluate(() => window.__lastRun);
      assert.equal(result?.exitCode, 0, JSON.stringify(result));
      assert.ok(result.apiTrace.includes(`IDirect3DDevice${version}.DrawPrimitiveUP`));
      assert.deepEqual(errors, []);
      runs.push({
        name,
        exeSha256: createHash('sha256').update(bytes).digest('hex'),
        pixels,
        exitCode: result.exitCode,
        instructions: result.instructions,
        errors,
      });
      await page.close();
    }
  }
  const report = {
    passed: true,
    date: new Date().toISOString(),
    browser: browser.version(),
    scope:
      'Native D3D8 and D3D9 PE32 EXE/ZIP uploads: mip descriptors, COM binding lifetime, rectangular texture uploads, two revisions in one frame, all 32,768 displayed pixels, and Escape shutdown.',
    runs,
  };
  await writeFile('evidence/textures-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
