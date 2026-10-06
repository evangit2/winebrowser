import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const externalUrl = process.env.WINEBROWSER_TEST_URL;
const server = externalUrl
  ? null
  : await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
    });
let browser;
try {
  await server?.listen();
  const url = externalUrl || `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch(webgpuBrowserOptions);
  const bytes = await readFile('tests/fixtures/presentation/fullscreen.exe');
  const runs = [];
  for (const [name, buffer] of [
    ['fullscreen.exe', bytes],
    ['fullscreen.zip', Buffer.from(zipSync({ 'game/fullscreen.exe': bytes }))],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    await page
      .locator('#file')
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    assert.equal(
      await page.locator('#state').textContent(),
      'LOADED',
      await page.locator('#details').textContent(),
    );
    await page.locator('#run').click();
    await page.waitForFunction(() => {
      if (document.querySelector('#state').textContent === 'ERROR')
        throw Error(document.querySelector('#output').textContent);
      if (window.__lastRun)
        throw Error('Fixture exited early: ' + JSON.stringify(window.__lastRun));
      return (
        Number(document.querySelector('[data-renderer="webgpu"]')?.dataset.graphicsFrames) >= 6
      );
    });
    const canvas = page.locator('[data-renderer="webgpu"]');
    const snapshot = () =>
      canvas.evaluate(async (element) => {
        const data = element
          .getContext('2d')
          .getImageData(0, 0, element.width, element.height).data;
        const levels = (n) =>
          new Set(Array.from({ length: n + 1 }, (_, i) => Math.round((i * 255) / n)));
        const r = levels(31),
          g = levels(63),
          b = levels(31);
        let bad = 0,
          colored = 0;
        const colors = new Set();
        for (let i = 0; i < data.length; i += 4) {
          if (!r.has(data[i]) || !g.has(data[i + 1]) || !b.has(data[i + 2]) || data[i + 3] !== 255)
            bad++;
          if (data[i] !== 25 || data[i + 1] !== 28 || data[i + 2] !== 49) colored++;
          colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        }
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
        return {
          hash,
          width: element.width,
          height: element.height,
          frames: Number(element.dataset.graphicsFrames),
          bad,
          colored,
          colors: [...colors],
        };
      });
    const pixels = await snapshot();
    assert.deepEqual([pixels.width, pixels.height], [800, 600]);
    assert.equal(pixels.bad, 0, 'RGB565 quantization reaches the actual displayed pixels');
    assert.ok(pixels.colored > 10000 && pixels.colors.length >= 2, JSON.stringify(pixels));
    await page.waitForTimeout(350);
    const animated = await snapshot();
    assert.ok(animated.frames > pixels.frames);
    assert.notEqual(animated.hash, pixels.hash, 'native transforms animate the RGB565 scene');
    await canvas.click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => window.__lastRun !== null || document.querySelector('#state').textContent === 'ERROR',
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result?.exitCode, 0, JSON.stringify(result));
    assert.ok(result.apiTrace.includes('IDirect3DDevice8.Present'));
    assert.deepEqual(errors, []);
    runs.push({
      name,
      pixels,
      animated,
      exitCode: result.exitCode,
      instructions: result.instructions,
      errors,
    });
    await page.close();
  }
  const report = {
    date: new Date().toISOString(),
    url,
    status: 'passed',
    browser: browser.version(),
    exeSha256: createHash('sha256').update(bytes).digest('hex'),
    scope:
      'Native D3D8 EXE/ZIP: 800x600 RGB565 fullscreen/FLIP/interval ONE, real GPU animation, Escape, and native assertions that desktop mode/window geometry/style restore on release.',
    runs,
  };
  await writeFile(
    'evidence/presentation-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
