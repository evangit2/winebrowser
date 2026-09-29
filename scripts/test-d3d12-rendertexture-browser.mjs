import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Verifies D3D12 render-to-texture by checking the composite result against the
// arithmetic: the offscreen pass writes the gradient (u, v, 1-u), the composite
// pass samples it and multiplies by 0.5, so the final image must be
// (u/2, v/2, (1-u)/2). A missing barrier, an unbound SRV or a texture that was
// never rendered into would produce a visibly different image.
const demo = 'd3d12-rendertexture';
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
  assert.ok(fixture, 'd3d12-rendertexture is not in the demo catalog');
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
    const sample = await page.locator('[data-graphics-api="d3d12"]').evaluate((element) => {
      const pixels = element
        .getContext('2d')
        .getImageData(0, 0, element.width, element.height).data;
      const at = (x, y) => {
        const i = (y * element.width + x) * 4;
        return [pixels[i], pixels[i + 1], pixels[i + 2]];
      };
      return {
        width: element.width,
        height: element.height,
        bottomLeft: at(Math.round(element.width * 0.05), Math.round(element.height * 0.95)),
        topRight: at(Math.round(element.width * 0.95), Math.round(element.height * 0.05)),
        centre: at(element.width >> 1, element.height >> 1),
      };
    });
    // The offscreen pass writes (u, v, 1-u) and the composite halves it, so
    // for every pixel R + B must be about 255/2 regardless of orientation, and
    // G must track the same u or v coordinate. An unrendered texture (magenta
    // clear) or a texture that was never sampled would break both relations.
    const channelSum = (colour) => colour[0] + colour[2];
    const gradientError = (colour) => Math.abs(channelSum(colour) - 128);
    for (const [label, colour] of [
      ['bottom-left', sample.bottomLeft],
      ['top-right', sample.topRight],
      ['centre', sample.centre],
    ])
      assert.ok(
        gradientError(colour) <= 12,
        `${label} ${colour.join(',')} is not the halved (u,v,1-u) gradient: R+B is ${channelSum(colour)}, expected about 128`,
      );
    // The corners must differ, proving the gradient varies rather than being a
    // flat fill of the clear colour.
    assert.ok(
      sample.bottomLeft[0] !== sample.topRight[0],
      `the gradient does not vary: both corners are ${sample.bottomLeft.join(',')}`,
    );
    // Green is 128 at the far corner of whichever axis v runs along, so neither
    // corner may be fully black.
    assert.ok(
      Math.max(sample.bottomLeft[1], sample.topRight[1]) > 100,
      `no corner reaches the green end of the gradient: ${sample.bottomLeft} / ${sample.topRight}`,
    );
    runs.push({ mode, sample });
    await page
      .locator('#stop')
      .click()
      .catch(() => {});
  }

  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-rendertexture-browser.json',
    JSON.stringify(
      {
        scope:
          'D3D12 render-to-texture: offscreen gradient pass, RTV/SRV over one resource, barrier to PIXEL_SHADER_RESOURCE, and a composite pass that samples it',
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
      {
        runs: runs.map((r) => ({
          mode: r.mode,
          corners: [r.sample.bottomLeft, r.sample.topRight],
        })),
      },
      null,
      1,
    ),
  );
} finally {
  await browser?.close();
}
