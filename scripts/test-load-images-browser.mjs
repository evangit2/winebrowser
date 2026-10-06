import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const folder = 'tests/fixtures/load-images/';
  const files = [
    'load-images.exe',
    ...(await readdir(folder)).filter((name) => name.endsWith('.bmp')),
  ].map((name) => folder + name);
  files.push('tests/fixtures/load-images/bitmap-resources.dll');
  let hostedInputs = null;
  if (process.env.WINEBROWSER_LOAD_IMAGES_EXAMPLE === '1') {
    const manifestResponse = await fetch(new URL('examples/manifest.json', url));
    assert.ok(manifestResponse.ok);
    const manifest = await manifestResponse.json();
    const example = manifest.interactive.find((entry) => entry.name === 'load-images');
    assert.ok(example);
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/examples/' + example.zip),
    );
    await page.locator('[data-demo="load-images"]').click();
    const response = await responsePromise;
    assert.ok(response.ok());
    const zip = new Uint8Array(await response.body());
    const zipSha256 = createHash('sha256').update(zip).digest('hex');
    assert.equal(zipSha256, example.zipSha256);
    const pkg = await unpackPackage(zip, 'load-images.zip');
    for (const file of files) {
      const name = 'load-images/' + file.split('/').at(-1);
      assert.deepEqual(pkg.files.get(name), new Uint8Array(await readFile(file)), name);
    }
    hostedInputs = { zipSha256, exeSha256: example.exeSha256 };
    await expect(page.locator('#exe')).toHaveValue('load-images/load-images.exe');
  } else await page.locator('#file').setInputFiles(files);
  await page.locator('#run').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.virtual-desktop-window') ||
      window.__lastRun != null ||
      document.querySelector('#state')?.textContent === 'ERROR',
    null,
    { timeout: 60000 },
  );
  assert.equal(
    await page.evaluate(() => window.__lastRun),
    null,
    await page.locator('#logs').textContent(),
  );
  const root = page.locator('.virtual-desktop-window'),
    canvas = root.locator('.virtual-desktop-canvas');
  const observations = [];
  for (const [index, updated] of [false, true, false].entries()) {
    if (index) await canvas.press('F6');
    await expect(root.locator('.virtual-desktop-title')).toHaveText(
      updated
        ? 'LoadImage bitmap updated through native pointer'
        : 'LoadImage resources and BMP files — F6 changes pixels',
    );
    await page.waitForFunction((updated) => {
      const c = document.querySelector('.virtual-desktop-canvas');
      if (!c || c.height < 240) return false;
      const p = c.getContext('2d').getImageData(16, 176, 1, 1).data;
      return (
        p[0] === (updated ? 255 : 10) &&
        p[1] === (updated ? 0 : 20) &&
        p[2] === (updated ? 255 : 30)
      );
    }, updated);
    const pixels = await canvas.evaluate((c, updated) => {
      const colors = [
        [0, 0, 0],
        [128, 128, 128],
        [192, 192, 192],
        [255, 255, 255],
      ];
      const rgbTop = [
          [10, 20, 30],
          [255, 255, 255],
          [255, 255, 0],
        ],
        rgbBottom = [
          [1, 2, 3],
          [4, 5, 6],
          [7, 8, 9],
        ];
      let mismatches = 0;
      const observations = [];
      for (let image = 0; image < 3; image++) {
        const data = c.getContext('2d').getImageData(16, 16 + 80 * image, 256, 64).data;
        let wrong = 0;
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 256; x++) {
            const row = Math.floor(y / 32),
              col = Math.floor((x * (image === 2 ? 3 : 8)) / 256);
            const colorIndex = row ? 3 - (col % 4) : col % 4;
            const rgb =
              image === 2
                ? !row && col === 0 && updated
                  ? [255, 0, 255]
                  : (row ? rgbBottom : rgbTop)[col]
                : colors[image === 1 && colorIndex === 3 ? 2 : colorIndex];
            const at = (y * 256 + x) * 4;
            if (
              data[at] !== rgb[0] ||
              data[at + 1] !== rgb[1] ||
              data[at + 2] !== rgb[2] ||
              data[at + 3] !== 255
            )
              wrong++;
          }
        observations.push({ image, checkedPixels: 16384, mismatches: wrong });
        mismatches += wrong;
      }
      return { updated, checkedPixels: 49152, mismatches, images: observations };
    }, updated);
    assert.equal(pixels.mismatches, 0, JSON.stringify(pixels));
    observations.push(pixels);
    if (updated) await root.screenshot({ path: '.scratch/load-images-browser.png' });
  }
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun != null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.ok(run.compiledBlocks > 0);
  assert.deepEqual(errors, []);
  for (const api of ['user32.dll!LoadImageA', 'user32.dll!LoadImageW', 'gdi32.dll!GetObjectW'])
    assert.ok(run.apiNames.includes(api), api);
  const resourceLibrary = run.loadedModules.find(
    (module) => module.name.toLowerCase() === 'bitmap-resources.dll',
  );
  assert.ok(resourceLibrary && !resourceLibrary.host);
  const nativeRuntime = ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map((name) => {
    const module = run.loadedModules.find((module) => module.name.toLowerCase() === name);
    assert.ok(module && !module.host, name);
    return module;
  });
  const binaries = {};
  for (const file of files)
    binaries[file] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    url,
    browser: browser.version(),
    input: process.env.WINEBROWSER_LOAD_IMAGES_EXAMPLE === '1' ? 'hosted example' : 'local upload',
    binaries,
    hostedInputs,
    resourceLibrary,
    nativeRuntime,
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    observations,
    checks: [
      'Unchanged native SDK EXE calls both six-argument LoadImage interfaces for integer/named bitmap resources, icon and cursor resources',
      'Native Wine SearchPath A/W locates actual BMP and resource DLL inputs; buffers, file-part pointers, extensions, explicit lists and PATH are checked by the SDK client',
      'Native directory creation, traversal, current-directory changes and empty-directory deletion complete without host filesystem access',
      'Seven authored bitmap resources and BMP files cover indexed/CORE/monochrome/RGB24/32 and RGB565; a real file pixel offset skips a deliberate metadata/pixel gap',
      'LR_CREATEDIBSECTION exposes private writable native pointers; bitmap pixels survive resource DLL unload',
      'Requested sizes, system palette mapping and transparent-index color replacement match native GetPixel assertions',
      'Missing/truncated files and invalid sizes fail; native F6 pointer writes repaint actual file-loaded pixels',
      'Chromium independently scans all 49152 displayed pixels in each of three stages and requires native cleanup/exit zero',
    ],
    scope:
      'Native Wine file search and private-volume directory traversal/deletion, plus uncompressed bitmap resource/file loading and nearest-neighbor sizing. HALFTONE resampling, compressed/embedded-image BMPs, OEM bitmap assets, custom-sized/file icons and cursors, and full Windows compatibility remain unfinished.',
  };
  await writeFile(
    'evidence/load-images-browser-results.json',
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
