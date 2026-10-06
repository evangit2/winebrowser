import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

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
  const executable = await readFile('tests/fixtures/gdi-region/gdi-region.exe'),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'gdi-region');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="gdi-region"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'gdi-region.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'gdi-region.exe' : 'gdi-region.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/gdi-region.exe': executable })),
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
      await expect(title).toHaveText('Native regions - ' + mode);
      const pixels = await root.locator('.virtual-desktop-canvas').evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 500);
      assert.equal(pixels.height, 260);
      const inside = (x, y) => {
        const a = x >= 20 && x < 300 && y >= 70 && y < 230,
          b = x >= 140 && x < 460 && y >= 100 && y < 250;
        return mode === 'intersection'
          ? a && b
          : mode === 'union'
            ? a || b
            : mode === 'xor'
              ? a !== b
              : a && !b;
      };
      let filled = 0,
        framed = 0;
      for (let y = 60; y < 260; y++)
        for (let x = 0; x < 500; x++) {
          const ink = inside(x, y),
            edge =
              ink &&
              !(inside(x - 3, y) && inside(x + 3, y) && inside(x, y - 3) && inside(x, y + 3));
          const color = !ink
            ? [255, 255, 255, 255]
            : edge
              ? [240, 145, 30, 255]
              : [28, 85, 138, 255];
          const i = (y * 500 + x) * 4;
          if (color.some((v, channel) => pixels.bytes[i + channel] !== v))
            assert.deepEqual(pixels.bytes.slice(i, i + 4), color, `${mode}/${x},${y}`);
          if (edge) framed++;
          else if (ink) filled++;
        }
      assert.ok(filled > 0 && framed > 0);
      observations.push({ mode, filled, framed, verifiedPixels: 100000 });
    };
    await verify('difference');
    for (const [button, mode] of [
      ['Union', 'union'],
      ['Xor', 'xor'],
      ['Intersection', 'intersection'],
      ['Difference', 'difference'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(mode);
    }
    await root.screenshot({ path: `evidence/gdi-region-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE REGION GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreateRectRgn',
      'CreateRectRgnIndirect',
      'SetRectRgn',
      'CombineRgn',
      'GetRgnBox',
      'GetRegionData',
      'ExtCreateRegion',
      'PtInRegion',
      'RectInRegion',
      'EqualRgn',
      'OffsetRgn',
      'GetObjectType',
      'SelectClipRgn',
      'ExtSelectClipRgn',
      'GetClipRgn',
      'RectVisible',
      'FillRgn',
      'FrameRgn',
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
      'Unchanged Windows SDK region GUI compiled to Wasm in browser with real Wine base DLLs. Native aliasing, normalized rectangles, guarded canonical RGNDATA, round-trip reconstruction, offsets, copied clips after source deletion, saved DC clips, visibility and object-type checks. Trusted buttons select four boolean region operations; native pixel assertions and 100000 actual browser pixels per stage verify fill/frame/hole/empty colors. EXE, ZIP and hosted-example modes. Polygon/rounded regions, nonidentity transforms and universal Windows support remain incomplete.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/gdi-region-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
