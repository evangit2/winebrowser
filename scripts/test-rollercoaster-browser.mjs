import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(
  process.argv.includes('--ordinary')
    ? { channel: process.env.BROWSER_CHANNEL || 'chrome' }
    : webgpuBrowserOptions,
);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const manifest = await (
    await page.request.get(new URL('examples/manifest.json', url).href)
  ).json();
  const entry = manifest.interactive.find((e) => e.name === 'humus-rollercoaster');
  assert.ok(entry);
  const zip = await (await page.request.get(new URL('examples/' + entry.zip, url).href)).body();
  assert.equal(
    createHash('sha256').update(zip).digest('hex'),
    'fbb55c23ae94469ba12712ce830186d719de1a3abc983a3298a055331f0de0a0',
  );
  const exe = await (await page.request.get(new URL('examples/' + entry.exe, url).href)).body();
  assert.equal(
    createHash('sha256').update(exe).digest('hex'),
    'acf1fed9b4863723b41600d4016e97dd3ec6313dbd5144622919f9b8103e912e',
  );
  const runs = [];
  for (const mode of ['zip-upload', 'hosted-zip']) {
    if (mode === 'zip-upload')
      await page
        .locator('#file')
        .setInputFiles({ name: 'RollerCoaster.zip', mimeType: 'application/zip', buffer: zip });
    else await page.locator('[data-demo="humus-rollercoaster"]').click();
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
    for (const goal of [8, 16, 32]) {
      await page.waitForFunction(
        (goal) => {
          const state = document.querySelector('#state')?.textContent;
          if (['ERROR', 'EXITED'].includes(state))
            throw Error(document.querySelector('#status')?.textContent);
          return (
            Number(document.querySelector('.virtual-desktop-canvas')?.dataset.graphicsFrames) >=
            goal
          );
        },
        goal,
        { timeout: 600000 },
      );
      const sample = await page.locator('.virtual-desktop-canvas').evaluate(async (canvas) => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let lit = 0,
          white = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 24) lit++;
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 245) white++;
          if (colors.size < 4096) colors.add(pixels[i] + ',' + pixels[i + 1] + ',' + pixels[i + 2]);
        }
        return {
          width: canvas.width,
          height: canvas.height,
          frames: Number(canvas.dataset.graphicsFrames),
          draws: Number(canvas.dataset.graphicsDraws),
          lit,
          white,
          colors: colors.size,
          hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
      assert.equal(sample.width, 798);
      assert.equal(sample.height, 570);
      assert.ok(sample.lit > 40000, 'terrain/track scene: ' + JSON.stringify(sample));
      assert.ok(sample.colors >= 1000, 'scene has textured shading');
      assert.ok(
        sample.white < sample.width * sample.height * 0.01,
        'missing secondary textures must not turn lava/water white',
      );
      samples.push(sample);
    }
    assert.ok(
      new Set(samples.map((s) => s.hash)).size === samples.length,
      'camera animation changes each sampled scene',
    );
    assert.ok(samples.at(-1).draws > 18000, 'the original multi-draw scene executes');
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0);
    for (const api of [
      'IDirect3DDevice9.CreateCubeTexture',
      'IDirect3DDevice9.CreateVolumeTexture',
      'IDirect3DDevice9.DrawIndexedPrimitive',
      'IDirect3DDevice9.DrawPrimitiveUP',
      'IDirect3DDevice9.SetPixelShaderConstantF',
    ])
      assert.ok(result.apiNames.includes(api), api);
    runs.push({
      mode,
      elapsedMs: Date.now() - started,
      samples,
      exitCode: result.exitCode,
      instructions: result.instructions,
      x86TranslationMs: result.x86TranslationMs,
      compiledBlocks: result.totalCompiledBlocks,
      apiCalls: result.apiCalls,
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    url,
    exeSha256: entry.exeSha256,
    zipSha256: entry.zipSha256,
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_ROLLERCOASTER_EVIDENCE || 'evidence/rollercoaster-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
