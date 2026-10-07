import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

const oracle = JSON.parse(await readFile('tests/fixtures/icon-bitmap/wine-oracle.json', 'utf8'));
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
  const executable = await readFile('tests/fixtures/icon-bitmap/icon-bitmap.exe'),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'icon-bitmap');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="icon-bitmap"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'icon-bitmap.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'icon-bitmap.exe' : 'icon-bitmap.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/icon-bitmap.exe': executable })),
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
      await expect(title).toHaveText('Native icons - ' + mode);
      const pixels = await root.locator('.virtual-desktop-canvas').evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 480);
      assert.equal(pixels.height, 280);
      const expected = new Uint32Array(480 * 180).fill(0xb49678);
      const type =
        mode === 'alpha' || mode === 'roundtrip' ? 'alpha' : mode === 'mono' ? 'mono' : 'color';
      for (let channel = 0; channel < 3; channel++) {
        const flags = channel === 0 ? 3 : channel === 1 ? 1 : 2;
        const name =
          mode === 'roundtrip' && flags === 3
            ? 'alpha-roundtrip'
            : mode === 'copied' && flags === 3
              ? 'scaled-after-delete'
              : type + '-' + flags;
        const tile = cases[name];
        assert.ok(tile, name);
        for (let y = 120; y < 248; y++)
          for (let x = 16 + channel * 160; x < 144 + channel * 160; x++) {
            const visible =
              mode !== 'clipped' ||
              (x >= 80 &&
                x < 400 &&
                y >= 140 &&
                y < 220 &&
                !(x >= 100 && x < 120 && y >= 160 && y < 180));
            if (visible)
              expected[(y - 100) * 480 + x] =
                tile.pixels[
                  Math.floor((y - 120) / 32) * 4 + Math.floor((x - 16 - channel * 160) / 32)
                ];
          }
      }
      let changed = 0;
      for (let y = 100; y < 280; y++)
        for (let x = 0; x < 480; x++) {
          const value = expected[(y - 100) * 480 + x],
            color = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, 255],
            i = (y * 480 + x) * 4;
          if (color.some((v, c) => pixels.bytes[i + c] !== v))
            assert.deepEqual(pixels.bytes.slice(i, i + 4), color, `${mode}/${x},${y}`);
          if (value !== 0xb49678) changed++;
        }
      observations.push({ mode, changedPixels: changed, verifiedPixels: 86400 });
    };
    await verify('color');
    for (const [button, mode] of [
      ['Alpha', 'alpha'],
      ['Mono', 'mono'],
      ['Copy', 'copied'],
      ['Info', 'roundtrip'],
      ['Clip', 'clipped'],
      ['Color', 'color'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(mode);
      if (mode === 'mono')
        await root.screenshot({ path: `evidence/icon-bitmap-mono-${runs.length}.png` });
    }
    await root.screenshot({ path: `evidence/icon-bitmap-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE BITMAP ICON GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of [
      'BeginPaint',
      'EndPaint',
      'CreateIconIndirect',
      'CopyIcon',
      'CopyImage',
      'GetIconInfo',
      'DrawIconEx',
      'DestroyIcon',
    ])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreateBitmap',
      'CreateDIBSection',
      'GetObjectW',
      'DeleteObject',
      'SaveDC',
      'RestoreDC',
      'SelectClipRgn',
      'CombineRgn',
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
      'Unchanged Windows SDK bitmap icon GUI translated into Wasm inside browser with actual Wine base DLLs. Seven stages in EXE/ZIP/catalog modes verify 86400 drawing-area pixels against actual desktop Wine SDK snapshots: AND/XOR masks, color/alpha/mono channels, independent copies after source deletion, owned GetIconInfo bitmap planes, alpha roundtrip and copied region clips. Universal Windows/DLL support remains incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    'evidence/icon-bitmap-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
