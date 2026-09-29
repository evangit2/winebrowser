import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Verifies the D3D12 texture path end to end: GetCopyableFootprints,
// CopyTextureRegion into a default-heap texture, an SRV descriptor table, a
// static sampler, and root constants for the transform. The rendered pixels are
// checked against the two colours the demo generates, so the image proves the
// uploaded texels reached the shader rather than merely that something drew.
const demo = 'd3d12-texture';
// The demo writes cell (235, 90, 45) and (40, 170, 210) with alpha 255.
const CELL_COLOURS = ['235,90,45', '40,170,210'];
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
  assert.ok(fixture, 'd3d12-texture is not in the demo catalog');
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
      { timeout: 45000 },
    );
    const firstFourFramesMs = Date.now() - start;
    const canvas = page.locator('[data-graphics-api="d3d12"]');
    const sample = () =>
      canvas.evaluate(async (element) => {
        const pixels = element
          .getContext('2d')
          .getImageData(0, 0, element.width, element.height).data;
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        const counts = new Map();
        for (let i = 0; i < pixels.length; i += 4) {
          const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return {
          width: element.width,
          height: element.height,
          counts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
          hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
      });
    const first = await sample();
    await page.waitForTimeout(2500);
    const second = await sample();
    const counts = new Map(first.counts);
    for (const colour of CELL_COLOURS)
      assert.ok(
        (counts.get(colour) ?? 0) > 1000,
        `expected the uploaded texel colour ${colour} to cover a visible area, saw ${counts.get(colour) ?? 0} pixels`,
      );
    // The cube rotates, so the visible texel mix must change between frames.
    assert.ok(first.hash !== second.hash, 'the rotating cube did not change between frames');
    runs.push({
      mode,
      firstFourFramesMs,
      width: first.width,
      height: first.height,
      cellPixels: Object.fromEntries(CELL_COLOURS.map((c) => [c, counts.get(c) ?? 0])),
      first,
      second,
    });
    await page.locator('#stop').click().catch(() => {});
  }

  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-texture-browser.json',
    JSON.stringify(
      {
        scope:
          'D3D12 textured cube: GetCopyableFootprints + CopyTextureRegion upload, SRV descriptor table, static sampler and root constants, on the EXE-upload and hosted-ZIP paths',
        url,
        browser: browser.version(),
        exeSha256: fixture.exeSha256,
        zipSha256: fixture.zipSha256,
        cellColours: CELL_COLOURS,
        runs,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ runs: runs.map((r) => ({ mode: r.mode, cellPixels: r.cellPixels })) }, null, 1));
} finally {
  await browser?.close();
}
