import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

let server, browser;
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch(webgpuBrowserOptions);
  const runs = [];
  for (const variant of ['ddraw1', 'ddraw7', 'd3d7']) {
    const bytes = await readFile(`tests/fixtures/directdraw/${variant}.exe`);
    for (const packaged of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } }),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      await page.waitForFunction(
        () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
        null,
        { timeout: 60000 },
      );
      await page
        .locator('#file')
        .setInputFiles({
          name: variant + (packaged ? '.zip' : '.exe'),
          mimeType: 'application/octet-stream',
          buffer: packaged ? Buffer.from(zipSync({ [`test/${variant}.exe`]: bytes })) : bytes,
        });
      await page.waitForFunction(() => !document.querySelector('#run').disabled);
      await page.locator('#run').click();
      const ready = async (min) =>
        page.waitForFunction(
          (min) => {
            if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
              throw Error(
                document.querySelector('#output').textContent + JSON.stringify(window.__lastRun),
              );
            return (
              Number(document.querySelector('.virtual-desktop-canvas')?.dataset.graphicsFrames) >=
              min
            );
          },
          min,
          { timeout: 60000 },
        );
      await ready(3);
      const canvas = page.locator('.virtual-desktop-canvas');
      const sample = () =>
        canvas.evaluate((e, variant) => {
          const data = e.getContext('2d').getImageData(0, 0, e.width, e.height).data;
          const get = (x, y) => [...data.slice((y * e.width + x) * 4, (y * e.width + x) * 4 + 3)];
          let bad = 0;
          const phase = get(0, 0),
            colors = [
              [255, 0, 0],
              [0, 255, 0],
              [0, 0, 255],
              [255, 255, 0],
            ];
          for (let y = 0; y < e.height; y++)
            for (let x = 0; x < e.width; x++) {
              const expected =
                variant === 'd3d7'
                  ? colors[(y >= 240 ? 2 : 0) + (x >= 320 ? 1 : 0)]
                  : x >= 32 && x < 96 && y >= 32 && y < 64
                    ? [0, 0, 255]
                    : phase;
              const p = (y * e.width + x) * 4;
              if (expected.some((v, i) => v !== data[p + i]) || data[p + 3] !== 255) bad++;
            }
          return {
            width: e.width,
            height: e.height,
            frames: Number(e.dataset.graphicsFrames),
            phase,
            bad,
            verifiedPixels: e.width * e.height,
          };
        }, variant);
      const samples = [await sample()];
      await ready(samples[0].frames + 3);
      samples.push(await sample());
      for (const s of samples)
        assert.deepEqual([s.width, s.height, s.bad], [640, 480, 0], JSON.stringify(s));
      if (variant !== 'd3d7') {
        assert.ok(
          [
            [255, 0, 0],
            [0, 255, 0],
          ].some((c) => c.every((v, i) => v === samples[0].phase[i])),
        );
        await page.waitForFunction((phase) => {
          const c = document.querySelector('.virtual-desktop-canvas'),
            d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
          return phase.some((v, i) => v !== d[i]);
        }, samples[0].phase);
      }
      await page.locator('.virtual-desktop-close').evaluate((e) => e.click());
      await page.waitForFunction(
        () => window.__lastRun !== null || document.querySelector('#state').textContent === 'ERROR',
        null,
        { timeout: 30000 },
      );
      const result = await page.evaluate(() => window.__lastRun);
      assert.equal(result?.exitCode, 0, JSON.stringify(result));
      assert.match(await page.locator('#output').innerText(), /DIRECTDRAW CONTRACTS PASS/);
      assert.deepEqual(errors, []);
      runs.push({
        variant,
        upload: packaged ? 'zip' : 'exe',
        exeSha256: createHash('sha256').update(bytes).digest('hex'),
        samples,
        exitCode: result.exitCode,
        apiTrace: result.apiTrace,
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
      'Independent native DD1/DD7 and D3D7 uploads verify public ABI, callbacks, RGB565 lock/blit/overlap/source key, flip, COM release, nearest texture sampling, indexed/nonindexed geometry, D16 occlusion and guest readback; every pixel verified in two presented frames per run.',
    runs,
  };
  await writeFile(
    'evidence/directdraw-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ ...report, runs: runs.map(({ apiTrace, ...run }) => run) }, null, 2),
  );
} finally {
  await browser?.close();
  await server?.close();
}
