import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Exercises the D3D12 root-constants path: a real root signature with a
// 32-bit-constants parameter, SetGraphicsRoot32BitConstants, and shaders
// compiled against the canonical binding that parameter implies. Pixels and
// frame-to-frame change are checked on both the EXE-upload and hosted-ZIP
// paths, so the demo is verified as a whole program rather than a code path.
const demo = 'd3d12-constants';
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
  assert.ok(fixture, 'd3d12-constants is not in the demo catalog');
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
        let colored = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) > 60) {
            colored++;
            colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
          }
        }
        return {
          width: element.width,
          height: element.height,
          colored,
          colors: colors.size,
          hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
      });
    const first = await sample();
    await page.waitForTimeout(2500);
    const second = await sample();
    // A root-constants transform is applied per frame, so the image must
    // change even though no geometry was re-uploaded.
    assert.ok(
      first.hash !== second.hash,
      'the root-constant transform did not change between frames',
    );
    assert.ok(first.colored > 100000, `only ${first.colored} lit pixels were drawn`);
    assert.ok(first.colors >= 4, `expected at least four face colours, saw ${first.colors}`);
    runs.push({ mode, firstFourFramesMs, first, second });
    await page
      .locator('#stop')
      .click()
      .catch(() => {});
  }

  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-constants-browser.json',
    JSON.stringify(
      {
        scope:
          'D3D12 root-constants cube (32-bit-constants root parameter, canonical shader bindings) on the EXE-upload and hosted-ZIP paths',
        url,
        browser: browser.version(),
        exeSha256: fixture.exeSha256,
        zipSha256: fixture.zipSha256,
        runs,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      { runs: runs.map((r) => ({ mode: r.mode, first: r.first.colored, colors: r.first.colors })) },
      null,
      1,
    ),
  );
} finally {
  await browser?.close();
}
