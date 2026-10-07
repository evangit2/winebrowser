import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

const oracle = JSON.parse(
  await readFile('tests/fixtures/owned-cursors/shapes-wine-oracle.json', 'utf8'),
);
const tiles = Object.fromEntries(oracle.cases.map((row) => [row.mono, row.pixels]));
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
  const executable = await readFile('tests/fixtures/owned-cursors/owned-cursors.exe'),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'owned-cursors');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="owned-cursors"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'owned-cursors.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'owned-cursors.exe' : 'owned-cursors.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/owned-cursors.exe': executable })),
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
    const canvas = root.locator('.virtual-desktop-canvas');
    const verify = async (label, retired = false) => {
      await expect(title).toHaveText('Native owned cursors - ' + label);
      const pixels = await canvas.evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 640);
      assert.equal(pixels.height, 340);
      const expected = new Uint32Array(640 * 244).fill(0x806040);
      for (let type = 0; type < 4; type++) {
        if (retired && type === 3) continue;
        const tile = tiles[type === 1 ? 1 : 0];
        for (let y = 112; y < 224; y++)
          for (let x = 16 + type * 144; x < 128 + type * 144; x++)
            expected[(y - 96) * 640 + x] =
              tile[Math.floor((y - 112) / 7) * 16 + Math.floor((x - 16 - type * 144) / 7)];
      }
      for (let y = 96; y < 340; y++)
        for (let x = 0; x < 640; x++) {
          const value = expected[(y - 96) * 640 + x],
            i = (y * 640 + x) * 4;
          assert.equal(
            pixels.bytes[i] | (pixels.bytes[i + 1] << 8) | (pixels.bytes[i + 2] << 16),
            value,
            `${label}/${x},${y}`,
          );
          assert.equal(pixels.bytes[i + 3], 255);
        }
      observations.push({ label, verifiedPixels: 156160 });
      console.error('Verified', label, '156160 pixels');
    };
    const cursor = async (label) => {
      await canvas.hover({ position: { x: 600, y: 296 } });
      await page.waitForTimeout(50);
      if (label === 'Mono' || label === 'Offset') {
        const image = page.locator('[data-native-cursor="image"]');
        await expect(image).toBeVisible();
        const state = await image.evaluate((c) => ({
          width: c.width,
          height: c.height,
          left: parseFloat(c.style.left),
          top: parseFloat(c.style.top),
          pixels: Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data),
        }));
        assert.equal(state.width, 16);
        assert.equal(state.height, 16);
        const bounds = await canvas.boundingBox();
        assert.equal(state.left, Math.round(bounds.x + 600 - (label === 'Mono' ? 2 : 19)));
        assert.equal(state.top, Math.round(bounds.y + 296 - (label === 'Mono' ? 4 : 31)));
        if (label === 'Mono') {
          await expect(page.locator('[data-native-cursor="inversion"]')).toBeVisible();
          const screenshot = await page.screenshot({
            clip: { x: state.left, y: state.top, width: 16, height: 16 },
          });
          await page.evaluate(
            async ({ bytes, expected }) => {
              const image = new Image();
              image.src = 'data:image/png;base64,' + bytes;
              await image.decode();
              const c = document.createElement('canvas');
              c.width = c.height = 16;
              const ctx = c.getContext('2d');
              ctx.drawImage(image, 0, 0);
              const actual = ctx.getImageData(0, 0, 16, 16).data;
              for (let i = 0; i < 256; i++) {
                const value = expected[i];
                if (
                  actual[i * 4] !== (value & 255) ||
                  actual[i * 4 + 1] !== ((value >>> 8) & 255) ||
                  actual[i * 4 + 2] !== ((value >>> 16) & 255)
                )
                  throw Error('Inverting cursor screenshot pixel ' + i);
              }
            },
            { bytes: screenshot.toString('base64'), expected: tiles[1] },
          );
          await writeFile(`evidence/owned-cursors-inversion-${runs.length}.png`, screenshot);
        }
        return;
      }
      if (label === 'Hidden') {
        assert.equal(await canvas.evaluate((c) => getComputedStyle(c).cursor), 'none');
        assert.equal(await page.locator('[data-native-cursor]').count(), 0);
        return;
      }
      const result = await canvas.evaluate(async (c) => {
        const css = getComputedStyle(c).cursor;
        const match = /url\("?(data:image\/png;base64,[^"\)]+)"?\) (\d+) (\d+), default/.exec(css);
        if (!match) throw Error('Missing owned cursor ' + css);
        const image = new Image();
        image.src = match[1];
        await image.decode();
        const out = document.createElement('canvas');
        out.width = image.width;
        out.height = image.height;
        const ctx = out.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return {
          width: image.width,
          height: image.height,
          hotX: +match[2],
          hotY: +match[3],
          pixels: Array.from(ctx.getImageData(0, 0, out.width, out.height).data),
        };
      });
      const size = ['Grow', 'Shown', 'Retired'].includes(label) ? 32 : 16;
      assert.deepEqual([result.width, result.height, result.hotX, result.hotY], [size, size, 3, 5]);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const sx = Math.floor((x * 16) / size),
            sy = Math.floor((y * 16) / size),
            at = (y * size + x) * 4;
          assert.deepEqual(
            result.pixels.slice(at, at + 4),
            sx < 8 ? [32, 0, sy < 8 ? 0 : 64, 128] : [0, 160, sy < 8 ? 0 : 96, 255],
          );
        }
    };
    await verify('Alpha');
    await cursor('Alpha');
    for (const [button, label, retired] of [
      ['Mono', 'Mono', false],
      ['Copy', 'Copy', false],
      ['Grow', 'Grow', false],
      ['Hide', 'Hidden', false],
      ['Show', 'Shown', false],
      ['Retire', 'Retired', true],
      ['Reset', 'Alpha', false],
      ['Offset', 'Offset', false],
      ['Reset', 'Alpha', false],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(label, retired);
      await cursor(label);
      if (label === 'Mono' || label === 'Retired')
        await root.screenshot({ path: `evidence/owned-cursors-${label}-${runs.length}.png` });
    }
    await root.screenshot({ path: `evidence/owned-cursors-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE OWNED CURSORS GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreateIconIndirect',
      'GetIconInfo',
      'CopyIcon',
      'CopyImage',
      'SetCursor',
      'GetCursor',
      'ShowCursor',
      'DestroyCursor',
      'DestroyIcon',
      'DrawIconEx',
    ])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
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
      'Unchanged Windows SDK owned cursor GUI translated into Wasm inside browser with actual Wine base DLLs. Native bitmap-created cursors, metadata, copy/scaling, visibility, offset hotspots and active destruction are exercised. Ten stages in EXE/ZIP/catalog modes compare 156160 drawing-area pixels against native Wine, plus actual CSS PNG cursor pixels and a destination-inverting overlay screenshot. Universal Windows/DLL compatibility remains incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    'evidence/owned-cursors-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
