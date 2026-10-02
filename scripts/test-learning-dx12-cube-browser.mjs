import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const demo = 'learning-dx12-cube';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = JSON.parse(await readFile('runtime/target-builds/learning-dx12-cube.json'));
let server, browser, page;
let url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
if (process.argv.includes('--local')) {
  server = await createServer({
    base: '/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/`;
}
try {
  browser = await chromium.launch(webgpuBrowserOptions);
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
  );
  const fetch = async (path) => {
    const response = await page.request.get(new URL('examples/' + path, url).href);
    assert.equal(response.status(), 200, path);
    return response.body();
  };
  const manifest = JSON.parse(await fetch('manifest.json'));
  const entry = manifest.interactive.find((e) => e.name === demo);
  assert.ok(entry, 'Native demo appears in the hosted catalog');
  const executable = await fetch(entry.exe),
    zip = await fetch(entry.zip);
  assert.equal(sha(executable), entry.exeSha256);
  assert.equal(sha(zip), entry.zipSha256);
  const shaders = await Promise.all(
    Object.entries(pin.release.shaders).map(async ([name, hash]) => {
      const bytes = await fetch(demo + '/' + name);
      assert.equal(sha(bytes), hash, 'Original release shader ' + name);
      return { name, buffer: bytes, mimeType: 'application/octet-stream' };
    }),
  );
  const runs = [];
  for (const mode of ['zip-upload', 'exe-and-shaders-upload', 'hosted-example']) {
    if (mode === 'hosted-example') await page.locator(`[data-demo="${demo}"]`).click();
    else
      await page
        .locator('#file')
        .setInputFiles(
          mode === 'zip-upload'
            ? { name: 'Tutorial2-x86.zip', mimeType: 'application/zip', buffer: zip }
            : [
                { name: 'Tutorial2.exe', mimeType: 'application/octet-stream', buffer: executable },
                ...shaders,
              ],
        );
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    const started = Date.now();
    await page.locator('#run').click();
    await page.waitForFunction(
      () => {
        if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
          throw Error(
            document.querySelector('#status').textContent +
              ' ' +
              document.querySelector('#output').textContent,
          );
        if (document.querySelector('#messagebox')?.open)
          throw Error(document.querySelector('#messagebox').textContent);
        return (
          Number(document.querySelector('[data-graphics-api="d3d12"]')?.dataset.graphicsFrames) >= 6
        );
      },
      null,
      { timeout: 90000 },
    );
    const firstFramesMs = Date.now() - started;
    const canvas = page.locator('[data-graphics-api="d3d12"]');
    const sample = () =>
      canvas.evaluate(async (c) => {
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let colored = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i],
            g = pixels[i + 1],
            b = pixels[i + 2];
          if (
            (r !== pixels[0] || g !== pixels[1] || b !== pixels[2]) &&
            Math.max(r, g, b) - Math.min(r, g, b) > 50
          ) {
            colored++;
            colors.add(`${r},${g},${b}`);
          }
        }
        return {
          width: c.width,
          height: c.height,
          frames: Number(c.dataset.graphicsFrames),
          draws: Number(c.dataset.graphicsDraws),
          colored,
          colors: colors.size,
          corner: [...pixels.slice(0, 4)],
          hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
    const first = await sample();
    await page.waitForTimeout(2500);
    await page.waitForFunction(
      (frames) => {
        if (document.querySelector('#state').textContent === 'ERROR')
          throw Error(document.querySelector('#status').textContent);
        return (
          Number(document.querySelector('[data-graphics-api="d3d12"]')?.dataset.graphicsFrames) >=
          frames + 6
        );
      },
      first.frames,
      { timeout: 30000 },
    );
    const second = await sample();
    for (const pixels of [first, second]) {
      assert.deepEqual([pixels.width, pixels.height], [1280, 720]);
      assert.ok(pixels.colored > 10000 && pixels.colored < 500000, JSON.stringify(pixels));
      assert.ok(pixels.colors > 100, 'Original vertex colors interpolate across the cube');
      assert.ok(pixels.draws > 0);
    }
    assert.notEqual(
      first.hash,
      second.hash,
      'Guest clock and native matrix arithmetic animate the cube',
    );
    await mkdir('evidence', { recursive: true });
    const png = await canvas.evaluate((c) => c.toDataURL('image/png'));
    await writeFile(
      'evidence/learning-dx12-cube-browser.png',
      Buffer.from(png.split(',')[1], 'base64'),
    );
    await page.locator('.virtual-desktop-close').click({ force: true });
    await page.waitForFunction(
      () => window.__lastRun !== null || document.querySelector('#state').textContent === 'ERROR',
      null,
      { timeout: 30000 },
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.ok(result, await page.locator('#status').textContent());
    assert.equal(result.exitCode, 0);
    assert.match(
      await page.locator('#output').textContent(),
      /FPS:/,
      'Native periodic debugger logging runs without interrupting graphics',
    );
    assert.ok(result.compiledBlocks > 0 && result.instructions > 0);
    for (const api of [
      'd3d12.dll!D3D12CreateDevice',
      'd3dcompiler_47.dll!D3DReadFileToBlob',
      'ID3D12Device.CreatePipelineState',
      'ID3D12GraphicsCommandList.CopyBufferRegion',
      'ID3D12GraphicsCommandList.SetGraphicsRoot32BitConstants',
      'ID3D12GraphicsCommandList.DrawIndexedInstanced',
      'ID3D12GraphicsCommandList.ClearDepthStencilView',
      'ID3D12CommandQueue.ExecuteCommandLists',
      'IDXGISwapChain.Present',
    ])
      assert.ok(result.apiTrace.includes(api), 'Native call: ' + api);
    const logs = await page.locator('#logs').textContent();
    assert.match(
      logs,
      /D3D12 DXBC shaders compiled to WGSL (?:in the browser worker|with \d+ canonical bindings)/,
    );
    assert.match(
      logs,
      /DXGI live guest graphics objects: 0/,
      'Native atexit teardown releases graphics objects',
    );
    assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
    runs.push({
      mode,
      firstFramesMs,
      first,
      second,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      instructions: result.instructions,
      apiCalls: result.apiCalls,
    });
    console.log(
      `${mode}: animated cube, ${result.compiledBlocks} compiled Wasm blocks, exit ${result.exitCode}`,
    );
  }
  assert.deepEqual(errors, []);
  const report = {
    demo,
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    provenance:
      'Native PE32 counterpart built from unchanged MIT upstream source; original release is x64. Original release shaders retained.',
    upstreamRevision: pin.revision,
    exeSha256: entry.exeSha256,
    zipSha256: entry.zipSha256,
    browserCompilation: true,
    browserShaderCompilation: true,
    graphics:
      'D3D12 graphics pipeline stream, copy queue uploads, R16 indexed draws, root constants and D32 depth; WebGPU presentation',
    runs,
    errors,
  };
  const destination =
    process.env.WINEBROWSER_EVIDENCE_PATH || 'evidence/learning-dx12-cube-browser-results.json';
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    await page?.evaluate(() => ({
      state: document.querySelector('#state')?.textContent,
      status: document.querySelector('#status')?.textContent,
      logs: document.querySelector('#logs')?.textContent?.slice(-5000),
      run: window.__lastRun,
      fault: globalThis.__lastFaultDiagnostic,
    })),
  );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
