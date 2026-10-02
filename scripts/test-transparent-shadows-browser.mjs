import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const manifest = await (
    await page.request.get(new URL('examples/manifest.json', url).href)
  ).json();
  const entry = manifest.interactive.find((e) => e.name === 'humus-transparent-shadows');
  assert.ok(entry);
  const zip = await (await page.request.get(new URL('examples/' + entry.zip, url).href)).body();
  assert.equal(
    createHash('sha256').update(zip).digest('hex'),
    'da7446674a70947d4c5ec43d70bbd9ceb6e71468fc1830faaeb7def1f4d45cb5',
  );
  const exe = await (await page.request.get(new URL('examples/' + entry.exe, url).href)).body();
  assert.equal(
    createHash('sha256').update(exe).digest('hex'),
    '7364e6f1ff3fe694dc0c939ded55eeee526f61bfae6073e3e4530dd549a926cf',
  );
  const runs = [];
  for (const mode of ['zip-upload', 'hosted-zip']) {
    if (mode === 'zip-upload')
      await page.locator('#file').setInputFiles({
        name: 'TransparentShadowMapping.zip',
        mimeType: 'application/zip',
        buffer: zip,
      });
    else await page.locator('[data-demo="humus-transparent-shadows"]').click();
    await page.waitForFunction(
      () => {
        if (document.querySelector('#state')?.textContent === 'ERROR')
          throw Error(document.querySelector('#status')?.textContent);
        return document.querySelector('#state')?.textContent === 'LOADED';
      },
      null,
      { timeout: 60000 },
    );
    const started = Date.now();
    await page.locator('#run').click();
    const samples = [];
    for (const goal of [8, 24, 48]) {
      await page.waitForFunction(
        (goal) => {
          if (['ERROR', 'EXITED'].includes(document.querySelector('#state')?.textContent))
            throw Error(document.querySelector('#status')?.textContent);
          return (
            Number(document.querySelector('.virtual-desktop-canvas')?.dataset.graphicsFrames) >=
            goal
          );
        },
        goal,
        { timeout: 240000 },
      );
      const sample = await page.locator('.virtual-desktop-canvas').evaluate(async (canvas) => {
        // Exclude the original FPS overlay: only the room/light/shadows may
        // satisfy the animation check.
        const pixels = canvas
          .getContext('2d')
          .getImageData(0, 64, canvas.width, canvas.height - 64).data;
        let dark = 0,
          bright = 0,
          colored = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]),
            min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
          if (max < 48) dark++;
          if (min > 120) bright++;
          if (max - min > 35) colored++;
          if (colors.size < 4096) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        }
        return {
          width: canvas.width,
          height: canvas.height,
          frames: Number(canvas.dataset.graphicsFrames),
          draws: Number(canvas.dataset.graphicsDraws),
          dark,
          bright,
          colored,
          colors: colors.size,
          sceneSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
      assert.deepEqual([sample.width, sample.height], [798, 570]);
      assert.ok(
        sample.dark > 10000 &&
          sample.bright > 500 &&
          sample.colored > 5000 &&
          sample.colors >= 1000,
        'room/stained-glass scene: ' + JSON.stringify(sample),
      );
      samples.push(sample);
    }
    assert.equal(
      new Set(samples.map((s) => s.sceneSha256)).size,
      samples.length,
      'the scene changes independently of FPS text',
    );
    assert.ok(samples.at(-1).draws > 1000);
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result?.exitCode, 0, JSON.stringify(result));
    for (const api of [
      'IDirect3DDevice9.CreateCubeTexture',
      'IDirect3DCubeTexture9.GetCubeMapSurface',
      'IDirect3DDevice9.SetRenderTarget',
      'IDirect3DDevice9.SetDepthStencilSurface',
      'IDirect3DDevice9.DrawIndexedPrimitiveUP',
    ])
      assert.ok(result.apiNames.includes(api), api);
    assert.ok(
      result.compiledBlocks > 1000 && result.wasmBytes > 1000000,
      'native blocks compile to Wasm during browser execution',
    );
    runs.push({
      mode,
      elapsedMs: Date.now() - started,
      samples,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      wasmBytes: result.wasmBytes,
      instructions: result.instructions,
      apiCalls: result.apiCalls,
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    date: new Date().toISOString(),
    browser: await browser.version(),
    url,
    exeSha256: entry.exeSha256,
    zipSha256: entry.zipSha256,
    scope:
      'Unchanged original archive: ordinary ZIP upload and catalog, six-face cubemap API path, animated room/stained-glass scene excluding FPS text, browser-time x86 compilation and clean exit. Exact target storage/sampling has a separate native render-target regression.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/transparent-shadows-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
