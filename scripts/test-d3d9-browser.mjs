import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.getElementById('platform')?.textContent === 'ISOLATED / WASM READY',
  );
  const manifest = await (await page.request.get(new URL('demos/manifest.json', url).href)).json();
  const fixture = manifest.interactive.find((entry) => entry.name === 'd3d9-cube');
  assert.ok(fixture, 'D3D9 fixture is listed in the published harness');
  const exe = await readFile('public/demos/' + fixture.exe);
  assert.equal(createHash('sha256').update(exe).digest('hex'), fixture.exeSha256);
  const zip = await page.request.get(new URL('demos/' + fixture.zip, url).href);
  assert.ok(zip.ok());
  assert.equal(
    createHash('sha256')
      .update(await zip.body())
      .digest('hex'),
    fixture.zipSha256,
  );
  // Exercise both a standalone EXE upload and the hosted example ZIP.
  const runs = [];
  for (const mode of ['exe-upload', 'hosted-zip']) {
    if (mode === 'exe-upload')
      await page.locator('#file').setInputFiles('public/demos/' + fixture.exe);
    else {
      let resume;
      const download = new Promise((resolve) => (resume = resolve));
      await page.route('**/demos/d3d9-cube.zip', async (route) => {
        await download;
        await route.continue();
      });
      await page.locator('[data-demo="d3d9-cube"]').click();
      assert.equal(
        await page.locator('#run').isDisabled(),
        true,
        'Run waits for the new example download',
      );
      resume();
    }
    await page.locator('#run').click();
    const canvas = page.locator('.virtual-desktop-canvas[data-renderer="webgpu"]');
    await page.waitForFunction(() => {
      if (document.querySelector('#state').textContent === 'ERROR')
        throw Error(document.querySelector('#output').textContent);
      return (
        Number(document.querySelector('[data-renderer="webgpu"]')?.dataset.graphicsFrames) >= 4
      );
    });
    const snapshot = () =>
      canvas.evaluate(async (element) => {
        const pixels = element
          .getContext('2d')
          .getImageData(0, 0, element.width, element.height).data;
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        let coloredPixels = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === 23 && pixels[i + 1] === 29 && pixels[i + 2] === 49) continue;
          coloredPixels++;
          colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        }
        return {
          width: element.width,
          height: element.height,
          frames: Number(element.dataset.graphicsFrames),
          hash: [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join(''),
          corner: [...pixels.slice(0, 4)],
          coloredPixels,
          colors: [...colors],
        };
      });
    const first = await snapshot();
    assert.deepEqual([first.width, first.height], [640, 480]);
    assert.deepEqual(first.corner, [23, 29, 49, 255]);
    assert.ok(first.coloredPixels > 10000 && first.coloredPixels < 200000, 'Visible cube geometry');
    const faceColors = new Set([
      '232,101,84',
      '93,197,239',
      '242,207,91',
      '121,216,117',
      '191,143,233',
      '236,157,86',
    ]);
    assert.ok(
      first.colors.some((entry) => faceColors.has(entry)),
      'Guest vertex colors reach the GPU',
    );
    await page.waitForTimeout(250);
    const second = await snapshot();
    assert.ok(second.frames > first.frames, 'Guest continues presenting');
    assert.notEqual(second.hash, first.hash, 'Guest transform animates the geometry');
    await mkdir('evidence', { recursive: true });
    await page.locator('#desktop').screenshot({ path: 'evidence/d3d9-browser.png' });
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.compiledBlocks > 0 && result.instructions > 0,
      'PE executes through browser Wasm translation',
    );
    for (const call of [
      'd3d9.dll!Direct3DCreate9',
      'IDirect3D9.CreateDevice',
      'IDirect3DDevice9.DrawPrimitiveUP',
      'IDirect3DDevice9.Present',
      'IDirect3DDevice9.Release',
    ])
      assert.ok(result.apiTrace.includes(call), `Guest called ${call}`);
    assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
    runs.push({
      mode,
      exeSha256: fixture.exeSha256,
      first,
      second,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      instructions: result.instructions,
      apiCalls: result.apiCalls,
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    nativeGame: 'd3d9-cube',
    browserCompilation: true,
    workerWebGPU: true,
    runs,
    errors,
  };
  await writeFile('evidence/d3d9-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
