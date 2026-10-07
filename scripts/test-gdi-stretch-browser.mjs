import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

const oracle = JSON.parse(await readFile('tests/fixtures/gdi-stretch/wine-oracle.json', 'utf8'));
const modeCases = JSON.parse(
  await readFile('tests/fixtures/gdi-stretch/modes-wine-oracle.json', 'utf8'),
).cases;
const cases = Object.fromEntries(oracle.cases.map((row) => [row.name, row]));
let server, browser;
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
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chromium',
    headless: process.env.HEADED !== '1',
  });
  const executable = await readFile('tests/fixtures/gdi-stretch/gdi-stretch.exe'),
    sha256 = createHash('sha256').update(executable).digest('hex'),
    runs = [],
    errors = [];
  for (const mode of ['exe-upload', 'zip-upload', 'hosted-example']) {
    console.error('Starting', mode);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    if (mode === 'hosted-example') {
      const response = await page.request.get(new URL('examples/manifest.json', url).href);
      assert.ok(response.ok());
      const entry = (await response.json()).interactive.find((e) => e.name === 'gdi-stretch');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="gdi-stretch"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'gdi-stretch.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'gdi-stretch.exe' : 'gdi-stretch.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/gdi-stretch.exe': executable })),
      });
    }
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    assert.equal(
      await page.locator('#run').isEnabled(),
      true,
      await page.locator('#details').textContent(),
    );
    await page.locator('#run').click();
    await page.waitForFunction(
      () =>
        document.querySelector('.virtual-desktop-window') ||
        window.__lastRun ||
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
      title = root.locator('.virtual-desktop-title');
    const observations = [];
    const verify = async (mode) => {
      await expect(title).toHaveText('Native bitmap scaling - ' + mode);
      const pixels = await root.locator('.virtual-desktop-canvas').evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 640);
      assert.equal(pixels.height, 304);
      const expected = new Uint32Array(640 * 196).fill(0x806040);
      for (let channel = 0; channel < 4; channel++) {
        const number = channel + 1;
        const names = {
          zoom: `geometry-mode-${number}-1-0`,
          mirror: `geometry-mode-${number}-1-4`,
          clipped: `clipped-mode-${number}-1`,
          crop: `geometry-mode-${number}-1-3`,
          ink: `rop-mode-${number}-1-2-0`,
          saved: `geometry-mode-${number}-1-0`,
          shrink: `geometry-mode-${number}-1-2`,
        };
        // Shrink uses the independent 3 -> 2 native mode snapshot.
        const tile =
          mode === 'empty'
            ? null
            : mode === 'shrink'
              ? modeCases.find((c) => c.name === `mode-${number}-pattern-1-size-1`)
              : cases[names[mode]];
        if (mode !== 'empty') assert.ok(tile);
        for (let y = 136; y < 264; y++)
          for (let x = 16 + channel * 160; x < 144 + channel * 160; x++) {
            const xx = x - 16 - channel * 160,
              yy = y - 136;
            expected[(y - 108) * 640 + x] = tile
              ? tile.pixels[
                  mode === 'shrink'
                    ? (2 + Math.floor(yy / 64)) * 16 + 2 + Math.floor(xx / 64)
                    : Math.floor(yy / 8) * 16 + Math.floor(xx / 8)
                ]
              : 0x806040;
          }
      }
      let changed = 0;
      for (let y = 108; y < 304; y++)
        for (let x = 0; x < 640; x++) {
          const value = expected[(y - 108) * 640 + x],
            color = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255],
            i = (y * 640 + x) * 4;
          if (color.some((v, c) => pixels.bytes[i + c] !== v))
            assert.deepEqual(pixels.bytes.slice(i, i + 4), color, `${mode}/${x},${y}`);
          if (value !== 0x806040) changed++;
        }
      observations.push({ mode, changedPixels: changed, verifiedPixels: 125440 });
      console.error('Verified', mode, '125440 pixels');
    };
    await verify('zoom');
    for (const [button, mode] of [
      ['Mirror', 'mirror'],
      ['Clip', 'clipped'],
      ['Crop', 'crop'],
      ['Ink', 'ink'],
      ['Save', 'saved'],
      ['Clear', 'empty'],
      ['Shrink', 'shrink'],
      ['Zoom', 'zoom'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(mode);
      if (mode === 'shrink')
        await root.screenshot({ path: `evidence/gdi-stretch-shrink-${runs.length}.png` });
      if (mode === 'clipped')
        await root.screenshot({ path: `evidence/gdi-stretch-clipped-${runs.length}.png` });
    }
    await root.screenshot({ path: `evidence/gdi-stretch-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE BITMAP SCALING GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreateDIBSection',
      'StretchDIBits',
      'GetStretchBltMode',
      'SetStretchBltMode',
      'DeleteObject',
      'SaveDC',
      'RestoreDC',
      'SelectClipRgn',
      'CombineRgn',
      'StretchBlt',
    ])
      assert.ok(result.run.apiNames.includes('gdi32.dll!' + api), api);
    assert.ok(result.run.x86TranslationMs > 0 && result.run.totalCompiledBlocks > 0);
    assert.deepEqual(result.run.outputs, []);
    assert.deepEqual(result.run.deletedFiles, []);
    runs.push({ mode, observations, ...result });
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    headedBrowser: process.env.HEADED === '1',
    exeSha256: sha256,
    scope:
      'Unchanged Windows SDK bitmap scaling GUI translated into Wasm inside browser with actual Wine base DLLs. Nine stages in EXE/ZIP/catalog modes compare 125440 drawing-area pixels against native Wine snapshots: four scaling modes, mirroring, crops, complex clipping, XOR raster operations, saved DC modes and shrinking. Guest checks raw alpha bytes and object cleanup. Universal Windows/DLL compatibility remains incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    'evidence/gdi-stretch-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
