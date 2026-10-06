import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/gdi-screen/gdi-screen.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    canvas = page.locator('#display');
  const titles = [
    'GDI screen 1024x768 ready',
    'GDI screen 800x600 ready',
    'GDI screen 640x480 ready',
    'GDI screen restored',
  ];
  const observations = [];
  for (const [i, [width, height]] of [
    [1024, 768],
    [800, 600],
    [640, 480],
    [1024, 768],
  ].entries()) {
    if (i) await root.locator('.virtual-desktop-canvas').press('F6');
    await page.waitForFunction(
      (title) =>
        document.querySelector('.virtual-desktop-title')?.textContent === title ||
        window.__lastRun != null ||
        document.querySelector('#state')?.textContent === 'ERROR',
      titles[i],
    );
    await expect(root.locator('.virtual-desktop-title')).toHaveText(titles[i]);
    await expect(canvas).toBeVisible();
    await page.waitForFunction(
      ([width, height]) => {
        const canvas = document.querySelector('#display');
        if (canvas.width !== width || canvas.height !== height) return false;
        return canvas
          .getContext('2d')
          .getImageData(width - 1, height - 1, 1, 1)
          .data.slice(0, 3)
          .every((v) => v === 255);
      },
      [width, height],
    );
    const observed = await canvas.evaluate((element) => {
      const w = element.width,
        h = element.height,
        data = element.getContext('2d').getImageData(0, 0, w, h).data;
      const pixel = (x, y) => [...data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)];
      let colored = 0;
      for (let p = 0; p < data.length; p += 4) if (data[p] || data[p + 1] || data[p + 2]) colored++;
      return {
        width: w,
        height: h,
        colored,
        corners: [pixel(0, 0), pixel(w - 1, 0), pixel(0, h - 1), pixel(w - 1, h - 1)],
        center: pixel(w >> 1, h >> 1),
      };
    });
    assert.deepEqual(observed.corners, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 255, 255],
    ]);
    assert.deepEqual(observed.center, [0, 0, 0, 255]);
    assert.equal(observed.colored, 256);
    observations.push(observed);
    if (i === 0) await canvas.screenshot({ path: 'evidence/gdi-screen-browser.png' });
  }
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun != null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/gdi-screen/gdi-screen.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    observations,
    checks: [
      'Unchanged authored MIT PE32 queries GetDeviceCaps using SDK constants on screen, window and memory DCs',
      'Screen DC clipping and EnumDisplayMonitors agree with USER32 at 1024x768, 800x600, 640x480 and restoration',
      'Native corner drawing/readback and independent full browser pixel scans verify full-size, resized and restored GDI frames',
      'Native GDI handle release, invalid DC rejection and window destruction exit zero',
    ],
    scope:
      'One virtual monitor, a 96-dpi 32-bit CPU GDI raster surface, supported raster capability flags and shared virtual display dimensions. Full DPI, printer devices, color management, mapping transforms and universal application/DLL support remain unfinished.',
  };
  await writeFile(
    'evidence/gdi-screen-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        details: document.querySelector('#details')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        titles: [...document.querySelectorAll('.virtual-desktop-title')].map(
          (element) => element.textContent,
        ),
        run: window.__lastRun,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
