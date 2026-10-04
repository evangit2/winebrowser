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
      'tests/fixtures/gdi-objects/gdi-objects.exe',
      'tests/fixtures/gdi-objects/native-fonts.dll',
    ]);
  await page.locator('#run').click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-window') || window.__lastRun !== null,
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.evaluate(() => window.__lastRun), null);
  const guest = page.locator('.virtual-desktop-window');
  await page.waitForFunction(() => {
    const c = document.querySelector('.virtual-desktop-canvas');
    return c?.width === 420 && c.getContext('2d').getImageData(20, 42, 1, 1).data[0] === 20;
  });
  const pixels = await guest.locator('.virtual-desktop-canvas').evaluate((c) => {
    const context = c.getContext('2d');
    const count = (y, rgb) => {
      const data = context.getImageData(20, y, 390, 24).data;
      let exact = 0,
        changed = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i] === rgb[0] &&
          data[i + 1] === rgb[1] &&
          data[i + 2] === rgb[2] &&
          data[i + 3] === 255
        )
          exact++;
        if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) changed++;
      }
      return { exact, changed };
    };
    return {
      first: count(20, [20, 60, 160]),
      second: count(65, [150, 20, 50]),
      background: [...context.getImageData(410, 120, 1, 1).data],
    };
  });
  assert.ok(
    pixels.first.exact > 100 && pixels.first.changed > pixels.first.exact,
    JSON.stringify(pixels),
  );
  assert.ok(
    pixels.second.exact > 50 && pixels.second.changed > pixels.second.exact,
    JSON.stringify(pixels),
  );
  assert.deepEqual(pixels.background, [255, 255, 255, 255]);
  await guest.screenshot({ path: 'evidence/gdi-objects-browser.png' });
  await guest.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.ok(run.compiledBlocks > 0);
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
    exeSha256: await hash('tests/fixtures/gdi-objects/gdi-objects.exe'),
    dllSha256: await hash('tests/fixtures/gdi-objects/native-fonts.dll'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    pixels,
    checks: [
      'Native EXE and companion DLL execute CreateFontIndirectA/W with the one-argument stdcall ABI through in-browser x86 compilation',
      'Native LOGFONTA/LOGFONTW, LOGPEN and LOGBRUSH sizeof queries validate retained flags, names, zero defaults, size probes, every short buffer and untouched tails',
      'Native EXE/DLL character-width calls use four-argument stdcall; proportional ASCII widths, fractional advances, A/W ABC triplets, CP1252 Euro equivalence and buffer tails are checked',
      'TEXTMETRICA/W report the selected font weight, italic/underline/strikeout and charset at their native structure offsets',
      'Font A/W CP1252/Unicode face names survive queries; native font handles survive library unload and GDI text renders in Chromium',
      'Actual framebuffer contains antialiased colored glyphs, underline/strikeout and unchanged white background; native cleanup and close exit zero',
    ],
    scope:
      'Shared PE32 font/GDI object query compatibility. Browser font matching substitutes unavailable faces; rotated text, explicit widths, full Windows font mapping and arbitrary GUI compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/gdi-objects-browser-results.json',
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
