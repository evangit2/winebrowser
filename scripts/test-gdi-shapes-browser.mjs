import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

const oracle = JSON.parse(await readFile('tests/fixtures/gdi-shapes/wine-oracle.json', 'utf8'));
const cases = Object.fromEntries(
  ['alternate', 'winding', 'rounded', 'ellipse', 'hole'].map((name, i) => [
    name,
    oracle.cases[278 + i].rects,
  ]),
);
cases['copied clip'] = cases.winding;
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
  const executable = await readFile('tests/fixtures/gdi-shapes/gdi-shapes.exe'),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'gdi-shapes');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="gdi-shapes"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'gdi-shapes.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'gdi-shapes.exe' : 'gdi-shapes.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/gdi-shapes.exe': executable })),
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
      await expect(title).toHaveText('Native shapes - ' + mode);
      const pixels = await root.locator('.virtual-desktop-canvas').evaluate((canvas) => {
        const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return { width: canvas.width, height: canvas.height, bytes: Array.from(bytes) };
      });
      assert.equal(pixels.width, 480);
      assert.equal(pixels.height, 280);
      const inside = (x, y) =>
        cases[mode].some(([l, t, r, b]) => x >= l && y >= t && x < r && y < b);
      let filled = 0,
        framed = 0;
      for (let y = 80; y < 280; y++)
        for (let x = 0; x < 480; x++) {
          const ink = inside(x, y),
            edge =
              ink &&
              !(inside(x - 3, y) && inside(x + 3, y) && inside(x, y - 3) && inside(x, y + 3));
          const color = !ink
            ? [255, 255, 255, 255]
            : edge
              ? [240, 145, 30, 255]
              : mode === 'copied clip'
                ? [25, 130, 90, 255]
                : [28, 85, 138, 255];
          const i = (y * 480 + x) * 4;
          if (color.some((v, channel) => pixels.bytes[i + channel] !== v))
            assert.deepEqual(pixels.bytes.slice(i, i + 4), color, `${mode}/${x},${y}`);
          if (edge) framed++;
          else if (ink) filled++;
        }
      assert.ok(filled > 0 && framed > 0);
      observations.push({ mode, filled, framed, verifiedPixels: 96000 });
    };
    await verify('alternate');
    for (const [button, mode] of [
      ['Winding', 'winding'],
      ['Hole', 'hole'],
      ['Rounded', 'rounded'],
      ['Ellipse', 'ellipse'],
      ['Clip', 'copied clip'],
      ['Alternate', 'alternate'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(mode);
    }
    await root.screenshot({ path: `evidence/gdi-shapes-${mode}.png` });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE SHAPES GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of ['BeginPaint', 'EndPaint'])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    for (const api of [
      'CreatePolygonRgn',
      'CreatePolyPolygonRgn',
      'CreateRoundRectRgn',
      'CreateEllipticRgn',
      'CreateEllipticRgnIndirect',
      'PtInRegion',
      'GetRgnBox',
      'SelectClipRgn',
      'GetClipRgn',
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
      'Unchanged native Windows SDK shape GUI compiled to Wasm inside browser with actual Wine base DLLs. Seven stages per run verify 96000 rendered pixels against desktop Wine 11 geometry: alternate/winding self-intersections, polygon holes, rounded/ellipse boundaries and copied clipping after source deletion. Native SDK/GetPixel assertions and trusted buttons; EXE/ZIP/catalog modes. Broader GUI/DLL compatibility remains incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    'evidence/gdi-shapes-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
