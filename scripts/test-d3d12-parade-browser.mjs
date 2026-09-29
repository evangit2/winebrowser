import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const demo = 'd3d12-parade';
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
  assert.ok(fixture, 'd3d12-parade is cataloged');
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
      canvas.evaluate(async (c) => {
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let colored = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = pixels.slice(i, i + 3);
          if (Math.max(r, g, b) > 80 && Math.max(r, g, b) - Math.min(r, g, b) > 40) {
            colored++;
            if (colors.size < 256) colors.add(`${r},${g},${b}`);
          }
        }
        return {
          width: c.width,
          height: c.height,
          frames: Number(c.dataset.graphicsFrames),
          colored,
          colors: colors.size,
          corner: [...pixels.slice(0, 4)],
          hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
    const first = await sample();
    assert.deepEqual([first.width, first.height], [640, 480]);
    assert.deepEqual(first.corner, [9, 17, 36, 255], 'clear color matches the fixture');
    assert.ok(first.colored > 20000, `multiple solids are visible (${first.colored} px)`);
    assert.ok(first.colors >= 6, `shading produces many distinct colors (${first.colors})`);
    await page.waitForTimeout(500);
    const second = await sample();
    assert.ok(second.frames > first.frames);
    assert.notEqual(first.hash, second.hash, 'the parade animates');
    assert.ok(second.colored > 20000);
    await mkdir('evidence', { recursive: true });
    await page.locator('#desktop').screenshot({ path: 'evidence/d3d12-parade-browser.png' });
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0);
    for (const call of [
      'd3d12.dll!D3D12CreateDevice',
      'ID3D12Device.CreateCommittedResource',
      'ID3D12Resource.Map',
      'ID3D12Resource.Unmap',
      'ID3D12GraphicsCommandList.IASetVertexBuffers',
      'ID3D12GraphicsCommandList.IASetIndexBuffer',
      'ID3D12GraphicsCommandList.DrawIndexedInstanced',
      'ID3D12GraphicsCommandList.ClearDepthStencilView',
      'IDXGISwapChain.Present',
      'ID3D12Fence.GetCompletedValue',
    ])
      assert.ok(result.apiTrace.includes(call), `Guest called ${call}`);
    assert.ok(result.instructions > 0 && result.compiledBlocks > 0);
    runs.push({
      mode,
      firstFourFramesMs,
      first,
      second,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      instructions: result.instructions,
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    demo,
    scope:
      'Native PE32 D3D12 fixture with 27 depth-tested indexed draws per frame, x87 guest transforms and per-vertex lighting, empty root signature, RTV/DSV descriptors, barriers, swapchain and completed fences; not broad D3D12/game compatibility',
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: fixture.exeSha256,
    browserCompilation: true,
    browserShaderCompilation: true,
    nativeVertexTransforms: true,
    vertexArithmetic:
      'x87 runtime rotation, per-vertex diffuse lighting and perspective projection',
    objectsPerFrame: 27,
    runs,
    errors,
  };
  await writeFile(
    'evidence/d3d12-parade-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
