import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

const oracle = JSON.parse(await readFile('tests/fixtures/gdi-pattern/wine-oracle.json', 'utf8'));
const tiles = Object.fromEntries(oracle.tiles.map((tile) => [tile.name, tile]));
const regions = JSON.parse(await readFile('tests/fixtures/gdi-shapes/wine-oracle.json', 'utf8'));
const ellipse = regions.cases[281].rects;
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
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chromium' });
  const executable = await readFile('tests/fixtures/gdi-pattern/gdi-pattern.exe'),
    sha256 = createHash('sha256').update(executable).digest('hex'),
    runs = [],
    errors = [];
  for (const mode of ['exe-upload', 'zip-upload', 'hosted-example']) {
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'gdi-pattern');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="gdi-pattern"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'gdi-pattern.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'gdi-pattern.exe' : 'gdi-pattern.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/gdi-pattern.exe': executable })),
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
      await expect(title).toHaveText('Native tiles - ' + mode);
      const pixels = await root.locator('.virtual-desktop-canvas').evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 480);
      assert.equal(pixels.height, 280);
      const tile = tiles[mode === 'clipped' ? 'shifted' : mode];
      let painted = 0;
      for (let y = 100; y < 280; y++)
        for (let x = 0; x < 480; x++) {
          const visible =
            mode !== 'clipped' ||
            ellipse.some(([l, t, r, b]) => x >= l && y >= t && x < r && y < b);
          const value = visible
            ? tile.pixels[(y % tile.size) * tile.size + (x % tile.size)]
            : 0xffffff;
          const color = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255],
            i = (y * 480 + x) * 4;
          if (color.some((v, c) => pixels.bytes[i + c] !== v))
            assert.deepEqual(pixels.bytes.slice(i, i + 4), color, `${mode}/${x},${y}`);
          if (visible) painted++;
        }
      const label = root.locator('[data-control-type="static"]');
      await expect(label).toBeVisible();
      const controlTile = tiles[mode === 'shifted' || mode === 'clipped' ? 'shifted' : 'color'];
      const readLabel = () =>
        label.evaluate(async (element) => {
          const style = getComputedStyle(element),
            url = style.backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
          if (!url) return null;
          const picture = new Image();
          picture.src = url;
          await picture.decode();
          const canvas = document.createElement('canvas');
          canvas.width = picture.width;
          canvas.height = picture.height;
          const context = canvas.getContext('2d');
          context.drawImage(picture, 0, 0);
          return {
            width: canvas.width,
            height: canvas.height,
            pixels: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
            color: style.color,
          };
        });
      await expect
        .poll(
          async () => {
            const found = await readLabel();
            return (
              found?.width === 16 &&
              found.pixels.every((v, i) => {
                const value = controlTile.pixels[i >> 2];
                return v === (i % 4 === 3 ? 255 : (value >>> ((i % 4) * 8)) & 255);
              })
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
      const control = await readLabel();
      assert.equal(control.height, 16);
      assert.equal(control.color, 'rgb(20, 40, 60)');
      observations.push({ mode, painted, verifiedPixels: 86400, verifiedControlTilePixels: 256 });
    };
    await verify('color');
    for (const [button, mode] of [
      ['Mono', 'mono'],
      ['Shift', 'shifted'],
      ['Hatch', 'hatch'],
      ['Clip', 'clipped'],
      ['Color', 'color'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(mode);
    }
    await root.screenshot({ path: `evidence/gdi-pattern-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE PATTERN GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreatePatternBrush',
      'CreateBrushIndirect',
      'CreateDIBSection',
      'CreateBitmap',
      'CreateHatchBrush',
      'SetBrushOrgEx',
      'GetBrushOrgEx',
      'GetObjectW',
      'SaveDC',
      'RestoreDC',
      'PatBlt',
      'SelectClipRgn',
      'GetClipRgn',
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
    exeSha256: sha256,
    scope:
      'Unchanged native Windows SDK pattern GUI translated to Wasm inside browser with actual Wine base DLLs. Color/mono/indirect copied brush ownership, WORD DDB rows, brush origins and saved state, native hatch phases, copied ellipse clipping and standard control callback backgrounds. Six stages per run verify 86400 actual surface pixels plus 256 actual label tile pixels against desktop Wine. EXE/ZIP/catalog modes; universal DLL support remains incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    'evidence/gdi-pattern-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
