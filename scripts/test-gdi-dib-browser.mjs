import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
let browser, server;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  if (process.env.WINEBROWSER_GDI_DIB_EXAMPLE === '1') {
    await page.locator('[data-demo="gdi-dib"]').click();
    await expect(page.locator('#exe')).toHaveValue('gdi-dib/gdi-dib.exe');
  } else {
    await page.locator('#file').setInputFiles('tests/fixtures/gdi-dib/gdi-dib.exe');
  }
  await page.locator('#run').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.virtual-desktop-window') ||
      window.__lastRun != null ||
      document.querySelector('#state')?.textContent === 'ERROR',
  );
  assert.equal(
    await page.evaluate(() => window.__lastRun),
    null,
    await page.locator('#logs').textContent(),
  );
  const root = page.locator('.virtual-desktop-window'),
    canvas = root.locator('.virtual-desktop-canvas');
  const observations = [];
  for (const [index, updated] of [false, true, false, true].entries()) {
    if (index) await canvas.press('F6');
    await expect(root.locator('.virtual-desktop-title')).toHaveText(
      updated ? 'DIB transfers updated' : 'DIB transfers ready — F6 updates rows',
    );
    await page.waitForFunction((updated) => {
      const c = document.querySelector('.virtual-desktop-canvas');
      if (!c || c.height < 208) return false;
      const pixel = c.getContext('2d').getImageData(16, 112, 1, 1).data;
      return (
        pixel[0] === (updated ? 0 : 255) && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255
      );
    }, updated);
    const pixels = await canvas.evaluate((element, updated) => {
      const data = element.getContext('2d').getImageData(16, 16, 256, 192).data;
      const colors = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255],
        [255, 255, 0],
        [0, 255, 255],
        [255, 0, 255],
        [0, 0, 0],
      ];
      let mismatches = 0;
      const rows = [];
      for (let y = 0; y < 192; y++) {
        const row = Math.floor(y / 32);
        const reverse = updated && (row === 3 || row === 4);
        if (y % 32 === 0) rows.push([]);
        for (let x = 0; x < 256; x++) {
          const col = Math.floor(x / 32),
            rgb = colors[reverse ? 7 - col : col],
            at = (y * 256 + x) * 4;
          if (
            data[at] !== rgb[0] ||
            data[at + 1] !== rgb[1] ||
            data[at + 2] !== rgb[2] ||
            data[at + 3] !== 255
          )
            mismatches++;
          if (y % 32 === 0 && x % 32 === 0) rows[row].push([...data.slice(at, at + 4)]);
        }
      }
      return { updated, width: 256, height: 192, checkedPixels: 49152, mismatches, rows };
    }, updated);
    assert.equal(pixels.mismatches, 0, JSON.stringify(pixels));
    observations.push(pixels);
    if (updated) await root.screenshot({ path: 'evidence/gdi-dib-browser.png' });
  }
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun != null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.ok(run.compiledBlocks > 0);
  assert.deepEqual(errors, []);
  for (const api of ['SetDIBits', 'GetDIBits', 'GetPixel', 'StretchBlt'])
    assert.ok(run.apiTrace.includes(`gdi32.dll!${api}`));
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    url,
    input: process.env.WINEBROWSER_GDI_DIB_EXAMPLE === '1' ? 'hosted example' : 'local upload',
    executable: 'tests/fixtures/gdi-dib/gdi-dib.exe',
    sha256: createHash('sha256')
      .update(await readFile('tests/fixtures/gdi-dib/gdi-dib.exe'))
      .digest('hex'),
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    browser: browser.version(),
    observations,
    checks: [
      'Native SDK SetDIBits/GetDIBits and GetPixel verify 1/4/8/16/24/32-bit images in both row orders, RGB565 and metadata queries',
      'Selected logical palette indices round-trip; palette restoration and custom object release succeed',
      'Invalid handles, masks and color usage fail; native buffer-tail sentinel survives readback',
      'Chromium independently checks every displayed pixel before and after keyboard-triggered partial top-down updates',
      'Native object release and window destruction exit zero',
    ],
    scope:
      'CPU GDI RGB and bitfield DIB transfers with RGB color tables and selected logical palettes. RLE, DIB sections, color management, mapping transforms, printer devices and universal application/DLL support remain unfinished.',
  };
  await writeFile('evidence/gdi-dib-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
