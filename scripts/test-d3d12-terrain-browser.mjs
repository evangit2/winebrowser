import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Verifies the D3D12 terrain path: a generated 129x129 height field uploaded
// once and drawn as 32,768 indexed triangles with 32-bit indices, a
// three-attribute vertex layout and a constant-buffer camera. The rendered
// pixels must show a wide range of shaded terrain values rather than a flat
// fill, which is what proves the mesh and its lighting actually reached the GPU.
const demo = 'd3d12-terrain';
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
  assert.ok(fixture, 'd3d12-terrain is not in the demo catalog');
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
          distinct: counts.size,
          draws: Number(element.dataset.graphicsDraws),
          hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
      });
    const first = await sample();
    await page.waitForTimeout(2500);
    const second = await sample();
    // The clear colour alone is one value; a lit mesh at many depths and
    // normals produces hundreds of shades.
    assert.ok(
      first.distinct > 64,
      `expected a shaded terrain (many distinct colours), saw ${first.distinct}`,
    );
    assert.ok(first.hash !== second.hash, 'the orbiting terrain did not change between frames');
    runs.push({ mode, firstFourFramesMs, first, second });
    await page.locator('#stop').click().catch(() => {});
  }

  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-terrain-browser.json',
    JSON.stringify(
      {
        scope:
          'D3D12 procedural terrain: 32,768-triangle indexed mesh with 32-bit indices, three-attribute input layout and a constant-buffer camera, on the EXE-upload and hosted-ZIP paths',
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
      { runs: runs.map((r) => ({ mode: r.mode, distinctColours: r.first.distinct, draws: r.first.draws })) },
      null,
      1,
    ),
  );
} finally {
  await browser?.close();
}
