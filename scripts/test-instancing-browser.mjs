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
  const entry = manifest.interactive.find((e) => e.name === 'humus-instancing');
  assert.ok(entry);
  const zip = await (await page.request.get(new URL('examples/' + entry.zip, url).href)).body();
  assert.equal(
    createHash('sha256').update(zip).digest('hex'),
    '9c74c3a787a1320e9cd7e7f708ff923f4a83be5a6e1dc93b80763c3c398e61f7',
  );
  const exe = await (await page.request.get(new URL('examples/' + entry.exe, url).href)).body();
  assert.equal(
    createHash('sha256').update(exe).digest('hex'),
    '37df64605e11c7a23df2d5befeb0bf38d2b9b6d2bf1322ffb1d0a437030b2903',
  );
  const runs = [];
  for (const mode of ['zip-upload', 'hosted-zip']) {
    if (mode === 'zip-upload')
      await page
        .locator('#file')
        .setInputFiles({ name: 'Instancing.zip', mimeType: 'application/zip', buffer: zip });
    else await page.locator('[data-demo="humus-instancing"]').click();
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
    for (const goal of [8, 16, 32, 40, 48]) {
      const key = goal === 40 ? '3' : goal === 48 ? '4' : null;
      if (key) {
        await page.locator('.virtual-desktop-canvas').focus();
        await page.keyboard.down(key);
      }
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
      if (key) await page.keyboard.up(key);
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
      assert.ok(sample.lit > 10000, 'particle scene: ' + JSON.stringify(sample));
      if (sample.colors < 1000) {
        await page
          .locator('.virtual-desktop-canvas')
          .screenshot({ path: 'evidence/instancing-shading-failure.png' });
        await writeFile(
          'evidence/instancing-shading-failure.json',
          JSON.stringify({ mode, goal, sample }, null, 2) + '\n',
        );
      }
      assert.ok(sample.colors >= 1000, 'scene has textured shading: ' + JSON.stringify(sample));
      samples.push({
        path:
          goal <= 32
            ? 'shader-constant batching'
            : goal === 40
              ? 'vertex-buffer upload'
              : 'user-pointer arrays',
        ...sample,
      });
    }
    assert.ok(
      new Set(samples.map((s) => s.hash)).size === samples.length,
      'camera animation changes each sampled scene',
    );
    assert.ok(samples.at(-1).draws > 1000, 'the original particle scene executes');
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0);
    for (const api of [
      'IDirect3DDevice9.DrawIndexedPrimitive',
      'IDirect3DDevice9.CreateVertexDeclaration',
      'IDirect3DDevice9.SetVertexShaderConstantF',
      'IDirect3DDevice9.DrawIndexedPrimitiveUP',
    ])
      assert.ok(result.apiNames.includes(api), api);
    runs.push({
      mode,
      elapsedMs: Date.now() - started,
      samples,
      exitCode: result.exitCode,
      instructions: result.instructions,
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
    'evidence/instancing-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
