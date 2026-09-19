import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const cube = process.argv.includes('--cube');
const demo = cube ? 'd3d12-cube' : 'd3d12-triangle';
const evidenceName = cube ? 'd3d12-cube-browser' : 'd3d12-browser';
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
  assert.ok(fixture);
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
      canvas.evaluate(async (c) => {
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let green = 0,
          colored = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          const [r, g, b] = pixels.slice(i, i + 3);
          if (Math.max(r, g, b) > 100 && Math.max(r, g, b) - Math.min(r, g, b) > 50) {
            colored++;
            colors.add(`${r},${g},${b}`);
          }
          if (
            pixels[i] === 0 &&
            pixels[i + 1] === 255 &&
            pixels[i + 2] === 0 &&
            pixels[i + 3] === 255
          )
            green++;
        }
        return {
          width: c.width,
          height: c.height,
          frames: Number(c.dataset.graphicsFrames),
          green,
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
    assert.deepEqual(first.corner, cube ? [9, 17, 36, 255] : [14, 24, 48, 255]);
    if (cube) {
      assert.ok(
        first.colored > 10000 && first.colored < 200000,
        'Cube covers a bounded visible area',
      );
      assert.ok(first.colors >= 1, 'A colored cube face is visible');
    } else
      assert.equal(
        first.green,
        360 * 300,
        'Translated DXBC shader draws exactly the guest viewport',
      );
    await page.waitForTimeout(500);
    const second = await sample();
    if (cube) {
      assert.ok(second.colored > 10000 && second.colors >= 1, JSON.stringify(second));
      assert.ok(
        Math.max(first.colors, second.colors) >= 2,
        'Multiple colored faces visible across animation',
      );
    } else assert.equal(second.green, 360 * 300);
    assert.ok(second.frames > first.frames);
    assert.notEqual(first.hash, second.hash, 'Guest D3D12 draws animate');
    await mkdir('evidence', { recursive: true });
    await page.locator('#desktop').screenshot({ path: `evidence/${evidenceName}.png` });
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0);
    assert.ok(result.compiledBlocks > 0 && result.instructions > 0);
    for (const call of [
      'd3d12.dll!D3D12CreateDevice',
      'd3d12.dll!D3D12SerializeRootSignature',
      'ID3D12Device.CreateGraphicsPipelineState',
      'ID3D12GraphicsCommandList.ResourceBarrier',
      'ID3D12GraphicsCommandList.DrawInstanced',
      'ID3D12CommandQueue.ExecuteCommandLists',
      'IDXGISwapChain.Present',
      'ID3D12CommandQueue.Signal',
      'ID3D12Fence.GetCompletedValue',
      'ID3D12GraphicsCommandList.OMSetRenderTargets',
      'ID3D12GraphicsCommandList.ClearRenderTargetView',
      ...(cube
        ? [
            'ID3D12Device.CreateCommittedResource',
            'ID3D12Resource.Map',
            'ID3D12Resource.Unmap',
            'ID3D12Resource.GetGPUVirtualAddress',
            'ID3D12GraphicsCommandList.IASetVertexBuffers',
            'ID3D12Device.CreateDepthStencilView',
            'ID3D12GraphicsCommandList.ClearDepthStencilView',
            'IDXGISwapChain.GetCurrentBackBufferIndex',
          ]
        : []),
    ])
      assert.ok(result.apiTrace.includes(call), `Guest called ${call}`);
    assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
    assert.match(
      await page.locator('#logs').textContent(),
      /D3D12 DXBC shaders compiled to WGSL in the browser worker/,
    );
    runs.push({
      mode,
      firstFourFramesMs,
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
    demo,
    scope:
      (cube ? 'Rotating 3D cube with upload vertex buffers and D16 depth. ' : '') +
      'Native PE32 D3D12 fixture with SM5 shaders, empty root signature, RTV descriptors, command lists, barriers, swapchain and completed fences; not broad D3D12/game compatibility',
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: fixture.exeSha256,
    browserCompilation: true,
    browserShaderCompilation: true,
    runs,
    errors,
  };
  await writeFile(`evidence/${evidenceName}-results.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
