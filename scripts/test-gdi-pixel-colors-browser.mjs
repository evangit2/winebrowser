import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

const oracle = JSON.parse(
  await readFile('tests/fixtures/gdi-pixel-colors/wine-oracle.json', 'utf8'),
);
const colors = [
  [0xffffff, 0x070605, 0x090807, 0x81807f, 0xf8f9fa, 0xb52f13, 0x806040],
  [0x01000001, 0x01000013, 0x020000a5, 0xffabcdef, 0xff00ff, 0xffff00, 0x00ffff],
  [0x10ff0000, 0x10ff0001, 0x10ff0002, 0x10ff0003, 0x10ff0004, 0x10ff000f, 0x10ff00ff],
  [0x10ff0010, 0x10ff0011, 0x10ff0100, 0x10ff0101, 0x10ff01ff, 0x10ffffff, 0x10ff0000],
];
const cases = new Map(oracle.cases.map((row) => [`${row.type}/${row.color}`, row]));
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
  const executable = await readFile('tests/fixtures/gdi-pixel-colors/gdi-pixel-colors.exe'),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'gdi-pixel-colors');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="gdi-pixel-colors"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'gdi-pixel-colors.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'gdi-pixel-colors.exe' : 'gdi-pixel-colors.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/gdi-pixel-colors.exe': executable })),
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
    const verify = async (label, index, clipped = false) => {
      await expect(title).toHaveText('Native bitmap colors - ' + label);
      const pixels = await root.locator('.virtual-desktop-canvas').evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 640);
      assert.equal(pixels.height, 340);
      const expected = new Uint32Array(640 * 244).fill(0x806040);
      for (let type = 0; type < 7; type++)
        for (let row = 0; row < 7; row++) {
          const tile = cases.get(`${type}/${colors[index][row]}`);
          assert.ok(tile);
          for (let y = 112 + row * 32; y < 136 + row * 32; y++)
            for (let x = 16 + type * 88; x < 88 + type * 88; x++) {
              if (!clipped || (x >= 96 && x < 560 && y >= 120 && y < 312))
                expected[(y - 96) * 640 + x] = tile.pixel;
            }
        }
      let changed = 0;
      for (let y = 96; y < 340; y++)
        for (let x = 0; x < 640; x++) {
          const value = expected[(y - 96) * 640 + x],
            color = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255],
            i = (y * 640 + x) * 4;
          if (color.some((v, c) => pixels.bytes[i + c] !== v))
            assert.deepEqual(pixels.bytes.slice(i, i + 4), color, `${label}/${x},${y}`);
          if (value !== 0x806040) changed++;
        }
      observations.push({ label, changedPixels: changed, verifiedPixels: 156160 });
      console.error('Verified', label, '156160 pixels');
    };
    await verify('RGB', 0);
    for (const [button, label, index, clipped] of [
      ['Palette', 'Palette', 1, false],
      ['Indices', 'Indices', 2, false],
      ['Edges', 'Edges', 3, false],
      ['Clip', 'Clipped', 3, true],
      ['Reset', 'RGB', 0, false],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(label, index, clipped);
      if (label === 'Indices' || label === 'Clipped')
        await root.screenshot({ path: `evidence/gdi-pixel-colors-${label}-${runs.length}.png` });
    }
    await root.screenshot({ path: `evidence/gdi-pixel-colors-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE BITMAP COLORS GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreateDIBSection',
      'SetPixel',
      'GetPixel',
      'DeleteObject',
      'SelectClipRgn',
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
      'Unchanged Windows SDK bitmap color GUI translated into Wasm inside browser with actual Wine base DLLs. Startup validates 217 desktop Wine pixel-write cases and actual raw DIB bytes. Six stages in EXE/ZIP/catalog modes compare 156160 drawing-area pixels for seven bitmap formats, RGB and palette colors, direct indices, boundary values and clipping. Universal Windows/DLL compatibility remains incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    'evidence/gdi-pixel-colors-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
