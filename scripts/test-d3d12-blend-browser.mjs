import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Verifies D3D12 pipeline blend states by checking the arithmetic the GPU
// actually performed, not merely that a pipeline was created. Each expected
// colour is what the corresponding blend factor pair computes on the demo's
// background, so a substituted or ignored blend state would fail.
const demo = 'd3d12-blend';
// Opaque background, then 50% red over it, then additive green over that.
const EXPECTED = {
  background: [26, 36, 97],
  sourceAlphaOver: [128, 33, 61],
  additive: [154, 250, 125],
};
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
  assert.ok(fixture, 'd3d12-blend is not in the demo catalog');
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
    const counts = await page.locator('[data-graphics-api="d3d12"]').evaluate((element) => {
      const pixels = element
        .getContext('2d')
        .getImageData(0, 0, element.width, element.height).data;
      const map = new Map();
      for (let i = 0; i < pixels.length; i += 4) {
        const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    });
    const observed = new Map(counts);
    for (const [name, colour] of Object.entries(EXPECTED)) {
      const key = colour.join(',');
      assert.ok(
        (observed.get(key) ?? 0) > 2000,
        `expected the ${name} blend result ${key} to cover a visible area; saw ${[...observed]
          .slice(0, 8)
          .map(([k, n]) => `${k}:${n}`)
          .join(' ')}`,
      );
    }
    runs.push({ mode, counts: counts.slice(0, 8) });
    await page
      .locator('#stop')
      .click()
      .catch(() => {});
  }

  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-blend-browser.json',
    JSON.stringify(
      {
        scope:
          'D3D12 pipeline blend states: unblended, SRC_ALPHA/INV_SRC_ALPHA and additive ONE/ONE, verified against the colours each factor pair computes',
        url,
        browser: browser.version(),
        exeSha256: fixture.exeSha256,
        zipSha256: fixture.zipSha256,
        expected: EXPECTED,
        runs,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      { runs: runs.map((r) => ({ mode: r.mode, top: r.counts.slice(0, 4) })) },
      null,
      1,
    ),
  );
} finally {
  await browser?.close();
}
