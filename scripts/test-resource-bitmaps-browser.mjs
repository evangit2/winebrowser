import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
let server, browser, page;
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page
    .locator('#file')
    .setInputFiles([
      'tests/fixtures/resource-bitmaps/resource-bitmaps.exe',
      'tests/fixtures/resource-bitmaps/bitmap-resources.dll',
    ]);
  await page.locator('#run').click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-window') || window.__lastRun !== null,
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.evaluate(() => window.__lastRun), null);
  const window = page.locator('.virtual-desktop-window'),
    canvas = window.locator('.virtual-desktop-canvas');
  await page.waitForFunction(() => {
    const c = document.querySelector('.virtual-desktop-canvas');
    return c?.width === 320 && c.getContext('2d').getImageData(120, 50, 1, 1).data[0] === 220;
  });
  const pixel = (x, y) =>
    canvas.evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
  const original = [
      [0, 0, 0, 255],
      [128, 128, 128, 255],
      [192, 192, 192, 255],
      [255, 255, 255, 255],
    ],
    mapped = [
      [220, 20, 30, 255],
      [20, 180, 60, 255],
      [20, 70, 220, 255],
      [240, 180, 20, 255],
    ];
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await pixel(20 + i, 50), original[i]);
    assert.deepEqual(await pixel(120 + i, 50), mapped[i]);
    assert.deepEqual(await pixel(220 + i, 50), original[i]);
  }
  assert.deepEqual(await pixel(120, 51), mapped[3]);
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const hash = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await hash('tests/fixtures/resource-bitmaps/resource-bitmaps.exe'),
    dllSha256: await hash('tests/fixtures/resource-bitmaps/bitmap-resources.dll'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged native EXE and companion DLL load resources by name/ID; DLL process-attach and export calls execute through in-browser x86 compilation',
      'COMCTL32 ordinal 8 equals the named CreateMappedBitmap procedure; explicit/default maps preserve source resource palettes and first duplicate-map precedence',
      'LoadBitmap A/W and CreateMappedBitmap support indexed/CORE/monochrome/top-down RGB24/32 and RGB565 resource DIBs',
      'Independent GDI bitmap pixels survive DLL unload; native GetObject/GetPixel and browser SRCCOPY framebuffer pixels match',
      'Masked flags, invalid map counts and absent resources fail visibly; native GDI object cleanup and close exit zero',
    ],
    scope:
      'Shared PE RT_BITMAP loading and palette mapping in ordinary Chromium. CMB_MASKED, predefined OEM system bitmaps, compressed/embedded-image DIBs and complete Windows graphics/control support remain incomplete.',
  };
  await writeFile(
    'evidence/resource-bitmaps-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun && {
          exitCode: window.__lastRun.exitCode,
          error: window.__lastRun.error,
          apiTrace: window.__lastRun.apiTrace?.slice(-30),
        },
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
