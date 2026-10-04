import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
let browser, server, page;
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
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/gdi-clipping/gdi-clipping.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window');
  await page.waitForFunction(
    () =>
      document.querySelector('.virtual-desktop-title')?.textContent === 'Native clipping passed',
  );
  const pixels = await root.locator('.virtual-desktop-canvas').evaluate((c) => {
    const ctx = c.getContext('2d');
    return [
      [30, 80],
      [140, 80],
      [10, 80],
      [310, 80],
      [30, 10],
      [30, 150],
    ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  });
  assert.deepEqual(pixels, [[24, 100, 200, 255], ...Array(5).fill([255, 255, 255, 255])]);
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/gdi-clipping-gui.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const digest = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await digest('tests/fixtures/gdi-clipping/gdi-clipping.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged PE32 executable compiles x86 blocks in Chromium and exits zero',
      'Native SaveDC/RestoreDC and complex clip classification preserve rectangular holes',
      'GDI pixel access and text respect the selected clip; browser pixels preserve excluded background',
    ],
    scope:
      'Rectangle-piece clipping. General region handles and coordinate transforms remain incomplete.',
  };
  await writeFile(
    'evidence/gdi-clipping-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
