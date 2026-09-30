import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const demo = 'd3d12-knot';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
  );
  const manifest = await (await page.request.get(new URL('demos/manifest.json', url).href)).json();
  const fixture = manifest.interactive.find((entry) => entry.name === demo);
  assert.ok(fixture, 'd3d12-knot is cataloged');
  const executable = await (
    await page.request.get(new URL('demos/' + fixture.exe, url).href)
  ).body();
  assert.equal(createHash('sha256').update(executable).digest('hex'), fixture.exeSha256);
  const zip = await (await page.request.get(new URL('demos/' + fixture.zip, url).href)).body();
  assert.equal(createHash('sha256').update(zip).digest('hex'), fixture.zipSha256);

  const runs = [];
  for (const mode of ['exe-upload', 'hosted-zip']) {
    if (mode === 'exe-upload')
      await page.locator('#file').setInputFiles({
        name: demo + '.exe',
        mimeType: 'application/octet-stream',
        buffer: executable,
      });
    else await page.locator(`[data-demo="${demo}"]`).click();
    const start = Date.now();
    await page.locator('#run').click();
    await page.waitForFunction(
      () => {
        const state = document.querySelector('#state').textContent;
        if (state === 'ERROR' || state === 'EXITED')
          throw Error(
            document.querySelector('#output').textContent +
              ' ' +
              document.querySelector('#status').textContent,
          );
        return (
          Number(document.querySelector('[data-graphics-api="d3d12"]')?.dataset.graphicsFrames) >= 4
        );
      },
      null,
      { timeout: 60000 },
    );
    const firstFourFramesMs = Date.now() - start;
    // Resolve the canvas fresh on every sample: a later frame may belong to a
    // new canvas node, and the frame counter lives on the element itself.
    const sample = () =>
      page.evaluate(async () => {
        const c = document.querySelector('[data-graphics-api="d3d12"]');
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        // `bright` counts pixels well above the dark clear colour, so it
        // measures the lit tube rather than the cleared background.
        let bright = 0;
        const colors = new Set();
        let digest = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i],
            g = pixels[i + 1],
            b = pixels[i + 2];
          if (r + g + b > 120) bright++;
          colors.add((r << 16) | (g << 8) | b);
          digest = (digest * 31 + r + g * 3 + b * 7) >>> 0;
        }
        return {
          width: c.width,
          height: c.height,
          frames: Number(c.dataset.graphicsFrames),
          bright,
          colors: colors.size,
          digest,
        };
      });
    const first = await sample();
    // The knot is a closed tube: every frame must fill a large connected area
    // with many distinct shades, not a single flat colour.
    assert.equal(first.width, 640);
    assert.equal(first.height, 480);
    assert.ok(first.bright > 6000, `the lit tube covers the frame (${first.bright} px)`);
    assert.ok(first.colors > 2000, `the tube is shaded (${first.colors} colours)`);
    await page.waitForTimeout(900);
    const second = await sample();
    assert.ok(second.frames > first.frames, 'the knot keeps presenting frames');
    assert.ok(second.bright > 6000, 'the tube is still drawn');
    assert.notEqual(second.digest, first.digest, 'the knot animates');
    if (mode === 'exe-upload')
      await page.locator('#desktop').screenshot({ path: 'evidence/d3d12-knot-browser.png' });
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, 'the knot exits cleanly');
    runs.push({
      mode,
      firstFourFramesMs,
      first,
      second,
      instructions: result.instructions ?? null,
    });
  }
  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-knot-browser-results.json',
    JSON.stringify({ demo, url, runs, errors }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ demo, runs }, null, 2));
} finally {
  await browser.close();
}
