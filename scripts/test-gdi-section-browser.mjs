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
  if (process.env.WINEBROWSER_GDI_SECTION_EXAMPLE === '1') {
    await page.locator('[data-demo="gdi-section"]').click();
    await expect(page.locator('#exe')).toHaveValue('gdi-section/gdi-section.exe');
  } else {
    await page
      .locator('#file')
      .setInputFiles([
        'tests/fixtures/gdi-section/gdi-section.exe',
        'tests/fixtures/gdi-section/bitmap-producer.dll',
      ]);
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
  const titles = [
    'Shared DIB ready — F6 changes pixels',
    'Shared DIB updated by native DLL',
    'Shared DIB painted by GDI',
    'Shared DIB cleared by CRT',
    'Shared DIB restored',
  ];
  for (let stage = 0; stage < titles.length; stage++) {
    if (stage) await canvas.press('F6');
    await expect(root.locator('.virtual-desktop-title')).toHaveText(titles[stage]);
    await page.waitForFunction((stage) => {
      const c = document.querySelector('.virtual-desktop-canvas');
      if (!c || c.height < 208) return false;
      const data = c.getContext('2d').getImageData(16, 16, 256, 192).data;
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
      for (let y = 0; y < 6; y++)
        for (let x = 0; x < 8; x++) {
          const rgb =
            stage >= 2 && stage <= 3 && y === 2
              ? colors[3]
              : stage === 3 && y === 4
                ? colors[7]
                : colors[((stage >= 1 && stage <= 3 ? 7 - x : x) + y) % 8];
          const at = (y * 32 * 256 + x * 32) * 4;
          if (data[at] !== rgb[0] || data[at + 1] !== rgb[1] || data[at + 2] !== rgb[2])
            return false;
        }
      return true;
    }, stage);
    const pixels = await canvas.evaluate((element, stage) => {
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
        if (y % 32 === 0) rows.push([]);
        for (let x = 0; x < 256; x++) {
          const col = Math.floor(x / 32);
          const rgb =
            stage >= 2 && stage <= 3 && row === 2
              ? colors[3]
              : stage === 3 && row === 4
                ? colors[7]
                : colors[((stage >= 1 && stage <= 3 ? 7 - col : col) + row) % 8];
          const at = (y * 256 + x) * 4;
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
      return { stage, width: 256, height: 192, checkedPixels: 49152, mismatches, rows };
    }, stage);
    assert.equal(pixels.mismatches, 0, JSON.stringify(pixels));
    observations.push(pixels);
    if (stage === 3) await root.screenshot({ path: 'evidence/gdi-section-browser.png' });
  }
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun != null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.ok(run.compiledBlocks > 0);
  assert.deepEqual(errors, []);
  for (const api of [
    'CreateDIBSection',
    'GetDIBColorTable',
    'SetDIBColorTable',
    'GetPixel',
    'SetPixel',
    'BitBlt',
    'StretchBlt',
    'GdiFlush',
  ])
    assert.ok(run.apiNames.includes(`gdi32.dll!${api}`));
  assert.ok(
    run.loadedModules.some(
      (module) => module.name.toLowerCase() === 'ucrtbase.dll' && !module.host,
    ),
    JSON.stringify(run.loadedModules),
  );
  const producer = run.loadedModules.find(
    (module) => module.name.toLowerCase() === 'bitmap-producer.dll',
  );
  assert.ok(producer && producer.host === false, JSON.stringify(run.loadedModules));
  const binaries = {};
  for (const name of ['gdi-section.exe', 'bitmap-producer.dll'])
    binaries[name] = createHash('sha256')
      .update(await readFile('tests/fixtures/gdi-section/' + name))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    url,
    input: process.env.WINEBROWSER_GDI_SECTION_EXAMPLE === '1' ? 'hosted example' : 'local upload',
    executable: 'tests/fixtures/gdi-section/gdi-section.exe',
    sha256: createHash('sha256')
      .update(await readFile('tests/fixtures/gdi-section/gdi-section.exe'))
      .digest('hex'),
    binaries,
    nativeProducer: producer,
    nativeCrt: run.loadedModules.find((module) => module.name.toLowerCase() === 'ucrtbase.dll'),
    apiNames: run.apiNames,
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    browser: browser.version(),
    observations,
    checks: [
      'Unchanged native PE32 EXE loads an authored native DLL; both compile to WebAssembly in Chromium',
      'Native SDK checks CreateDIBSection pointers, DIBSECTION descriptors and VirtualQuery for all six formats in both row orders',
      'Native DLL scalar stores and real CRT memset change pixels visible to GetPixel and StretchBlt',
      'SetPixel, FillRect and BitBlt write actual shared bytes; untouched reserved bytes survive',
      'DIB color tables and compatible-bitmap format inheritance work; deletion frees storage',
      'Chromium independently checks all 49152 displayed pixels in each of five keyboard-driven stages',
      'DLL unload, GDI object release and window destruction exit zero',
    ],
    scope:
      'Private RGB and bitfield DIB sections. File-mapping-backed sections, RLE, full GDI conformance and universal application/DLL support remain unfinished.',
  };
  await writeFile(
    'evidence/gdi-section-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
