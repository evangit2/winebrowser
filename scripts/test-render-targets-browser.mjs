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
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(webgpuBrowserOptions);
  const runs = [];
  for (const version of [8, 9]) {
    const bytes = await readFile(`tests/fixtures/render-targets/d3d${version}.exe`);
    for (const [name, buffer] of [
      [`d3d${version}.exe`, bytes],
      [`d3d${version}.zip`, Buffer.from(zipSync({ [`game/d3d${version}.exe`]: bytes }))],
    ]) {
      const page = await browser.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
      await page
        .locator('#file')
        .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
      await page.locator('#run').click();
      const waitForFrame = async (minimum) =>
        page.waitForFunction(
          (minimum) => {
            if (document.querySelector('#state').textContent === 'ERROR')
              throw Error(document.querySelector('#output').textContent);
            if (window.__lastRun)
              throw Error('Fixture exited early: ' + JSON.stringify(window.__lastRun));
            return (
              Number(document.querySelector('[data-renderer="webgpu"]')?.dataset.graphicsFrames) >=
              minimum
            );
          },
          minimum,
          { timeout: 60000 },
        );
      await waitForFrame(4);
      const canvas = page.locator('[data-renderer="webgpu"]');
      await canvas.evaluate((element) => {
        window.__targetSnapshot = () => {
          const pixels = element
            .getContext('2d')
            .getImageData(0, 0, element.width, element.height).data;
          const colors = [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 0],
            [255, 0, 255],
            [0, 255, 255],
          ];
          const first = [...pixels.slice(0, 3)],
            phase = colors.findIndex((color) => color.every((v, i) => v === first[i]));
          let bad = 0;
          for (let y = 0; y < 64; y++)
            for (let x = 0; x < 192; x++) {
              const expected = colors[(Math.floor(x / 32) + phase) % 6],
                offset = (y * 192 + x) * 4;
              if (
                !expected ||
                expected.some((v, i) => pixels[offset + i] !== v) ||
                pixels[offset + 3] !== 255
              )
                bad++;
            }
          return {
            width: element.width,
            height: element.height,
            frames: Number(element.dataset.graphicsFrames),
            bad,
            phase,
            verifiedPixels: element.width * element.height,
          };
        };
      });
      const sample = () => page.evaluate(() => window.__targetSnapshot());
      const samples = [await sample()];
      await waitForFrame(samples[0].frames + 3);
      samples.push(await sample());
      for (const pixels of samples)
        assert.deepEqual(
          [pixels.width, pixels.height, pixels.bad],
          [192, 64, 0],
          JSON.stringify(pixels),
        );
      const animatedHandle = await page.waitForFunction(
        (phase) => {
          const snapshot = window.__targetSnapshot();
          return snapshot.phase !== phase ? snapshot : false;
        },
        samples[0].phase,
        { timeout: 60000 },
      );
      const animated = await animatedHandle.jsonValue();
      await animatedHandle.dispose();
      assert.notEqual(animated.phase, samples[0].phase);
      assert.equal(animated.bad, 0);
      await page.locator('.virtual-desktop-close').click();
      await page.waitForFunction(
        () => window.__lastRun !== null || document.querySelector('#state').textContent === 'ERROR',
      );
      const result = await page.evaluate(() => window.__lastRun);
      assert.equal(result?.exitCode, 0, JSON.stringify(result));
      assert.ok(result.apiTrace.includes(`IDirect3DDevice${version}.SetRenderTarget`));
      assert.ok(
        result.apiTrace.includes(
          `IDirect3DDevice${version}.${version === 8 ? 'CopyRects' : 'GetRenderTargetData'}`,
        ),
      );
      assert.deepEqual(errors, []);
      runs.push({
        name,
        exeSha256: createHash('sha256').update(bytes).digest('hex'),
        samples,
        animated,
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
    browser: await browser.version(),
    scope:
      'Native D3D8/9 EXE and ZIP uploads render all six cube faces with a shared D16 depth attachment, validate center/border readback and standalone RGB565 full/partial clears in guest code, sample those faces in 12,288 exact displayed pixels, animate and exit zero.',
    runs,
  };
  await writeFile(
    'evidence/render-targets-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
