import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';
const oracle = JSON.parse(
  await readFile('tests/fixtures/frame-controls/gui-wine-oracle.json', 'utf8'),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  const executable = await readFile('tests/fixtures/frame-controls/frame-controls.exe'),
    sha256 = digest(executable),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'frame-controls');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="frame-controls"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(digest(bytes), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'frame-controls.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'frame-controls.exe' : 'frame-controls.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/frame-controls.exe': executable })),
      });
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
      title = root.locator('.virtual-desktop-title'),
      canvas = root.locator('.virtual-desktop-canvas');
    const observations = [];
    const verify = async (stage, label) => {
      await expect(title).toHaveText('Native frame controls - ' + label);
      const actual = await canvas.evaluate((canvas) => ({
        width: canvas.width,
        height: canvas.height,
        bytes: Array.from(
          canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
        ),
      }));
      assert.deepEqual([actual.width, actual.height], oracle.size);
      const expected = new Uint32Array(640 * 244).fill(oracle.background);
      for (const [x, y, w, color] of oracle.cases[stage].runs)
        expected.fill(color, (y - 96) * 640 + x, (y - 96) * 640 + x + w);
      for (let y = 96; y < 340; y++)
        for (let x = 0; x < 640; x++) {
          const i = (y * 640 + x) * 4,
            color = actual.bytes[i] | (actual.bytes[i + 1] << 8) | (actual.bytes[i + 2] << 16);
          assert.equal(color, expected[(y - 96) * 640 + x], `${mode}/${label}/${x},${y}`);
          assert.equal(actual.bytes[i + 3], 255);
        }
      observations.push({ label, stage, verifiedPixels: 156160 });
      console.error('Verified', label, '156160 pixels');
      if (['Checked', 'Holes', 'Adjust', 'Tiny'].includes(label))
        await root.screenshot({ path: `evidence/frame-controls-${label}-${runs.length}.png` });
    };
    await verify(0, 'Normal');
    for (const [stage, button, label] of [
      [1, 'Pushed', 'Pushed'],
      [2, 'Checked', 'Checked'],
      [3, 'Disabled', 'Disabled'],
      [4, 'Flat', 'Flat'],
      [5, 'Mono', 'Mono'],
      [6, 'Transp', 'Transp'],
      [7, 'Holes', 'Holes'],
      [8, 'Adjust', 'Adjust'],
      [9, 'Reset', 'Normal'],
      [10, 'Tiny', 'Tiny'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(stage, label);
    }
    await page.screenshot({ path: `evidence/frame-controls-${mode}.png`, fullPage: true });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => window.__lastRun || document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    const run = await page.evaluate(() => window.__lastRun);
    assert.equal(run?.exitCode, 0, await page.locator('#logs').textContent());
    assert.ok(run.compiledBlocks > 1500);
    assert.ok(run.apiNames.includes('user32.dll!DrawFrameControl'));
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        run.loadedModules.some((m) => m.name === name && !m.host),
        name,
      );
    const output = await page.locator('#output').textContent();
    assert.equal(output, 'NATIVE FRAME CONTROLS GUI PASS\n');
    runs.push({
      mode,
      observations,
      run,
      output,
      logs: await page.locator('#logs').textContent(),
      isolated: await page.evaluate(() => crossOriginIsolated),
    });
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
      'Unchanged Windows SDK classic control GUI translated into Wasm inside the browser with native Wine base DLLs. Eleven stages in EXE/ZIP/catalog modes compare 156160 drawing-area pixels per stage against actual desktop Wine with the virtual classic palette. Includes push/check/three-state controls, four scroll arrows, combo arrows, size grips, tiny controls, menu arrow/check, native states, complex clips and adjusted rectangles. Caption/radio controls, menu bullets and universal Windows/DLL compatibility remain incomplete.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_FRAME_CONTROLS_EVIDENCE ||
      'evidence/frame-controls-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
