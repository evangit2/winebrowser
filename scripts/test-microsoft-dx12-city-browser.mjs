import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { parsePE } from '../src/pe.js';
import { resolveApiSet } from '../src/api-sets.js';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const demo = 'microsoft-dx12-city';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = JSON.parse(await readFile('runtime/target-builds/microsoft-dx12-city.json'));
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
  browser = await chromium.launch(
    process.argv.includes('--ordinary')
      ? { channel: process.env.BROWSER_CHANNEL || 'chrome' }
      : webgpuBrowserOptions,
  );
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
  const entry = JSON.parse(await fetch('manifest.json')).interactive.find((e) => e.name === demo);
  assert.ok(entry, 'City appears in the public catalog');
  const zip = await fetch(entry.zip),
    executable = await fetch(entry.exe);
  assert.equal(sha(zip), entry.zipSha256);
  assert.equal(sha(executable), entry.exeSha256);
  const importGroups = Map.groupBy(parsePE(executable).imports, (i) => i.dll.toLowerCase());
  const nativeLibraries = new Map();
  const wineManifest = await page.request.get(new URL('runtime/wine-base/manifest.json', url).href);
  assert.equal(wineManifest.status(), 200);
  const wineFiles = (await wineManifest.json()).dlls;
  for (const name of [
    'ntdll.dll',
    'kernel32.dll',
    'kernelbase.dll',
    'ucrtbase.dll',
    'shell32.dll',
  ]) {
    const artifact = wineFiles.find((file) => file.name === name);
    const path = artifact ? 'runtime/wine-base/' + artifact.path : 'runtime/' + name;
    const response = await page.request.get(new URL(path, url).href);
    assert.equal(response.status(), 200, path);
    const bytes = await response.body();
    if (artifact) assert.equal(sha(bytes), artifact.sha256, name);
    nativeLibraries.set(name, {
      path,
      sha256: sha(bytes),
      imports: parsePE(bytes, { allowDll: true }).imports,
    });
  }
  const assets = await Promise.all(
    ['occcity.bin', ...Object.keys(pin.shaders)].map(async (name) => {
      const buffer = await fetch(demo + '/' + name);
      assert.equal(sha(buffer), pin.shaders[name] ?? pin.files[name], name);
      return { name, buffer, mimeType: 'application/octet-stream' };
    }),
  );
  const runs = [];
  for (const mode of ['zip-upload', 'exe-and-assets-upload', 'hosted-example']) {
    if (mode === 'hosted-example') await page.locator(`[data-demo="${demo}"]`).click();
    else
      await page.locator('#file').setInputFiles(
        mode === 'zip-upload'
          ? { name: 'D3D12City-x86.zip', mimeType: 'application/zip', buffer: zip }
          : [
              {
                name: 'D3D12Bundles.exe',
                buffer: executable,
                mimeType: 'application/octet-stream',
              },
              ...assets,
            ],
      );
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    const started = Date.now();
    await page.locator('#run').click();
    const waitFrames = async (goal) =>
      page.waitForFunction(
        (goal) => {
          if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
            throw Error(
              document.querySelector('#status').textContent +
                '\n' +
                document.querySelector('#logs').textContent,
            );
          if (document.querySelector('#messagebox')?.open)
            throw Error(document.querySelector('#messagebox').textContent);
          return (
            Number(document.querySelector('[data-graphics-api="d3d12"]')?.dataset.graphicsFrames) >=
            goal
          );
        },
        goal,
        { timeout: 90000 },
      );
    await waitFrames(6);
    const firstFramesMs = Date.now() - started;
    const canvas = page.locator('[data-graphics-api="d3d12"]');
    const sample = () =>
      canvas.evaluate(async (c) => {
        const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let foreground = 0,
          green = 0,
          gray = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i],
            g = pixels[i + 1],
            b = pixels[i + 2];
          if (r !== pixels[0] || g !== pixels[1] || b !== pixels[2]) {
            foreground++;
            if (g > r + 30 && g > b + 30) green++;
            if (Math.max(r, g, b) - Math.min(r, g, b) < 20 && r > 50) gray++;
            colors.add(`${r},${g},${b}`);
          }
        }
        return {
          width: c.width,
          height: c.height,
          frames: Number(c.dataset.graphicsFrames),
          draws: Number(c.dataset.graphicsDraws),
          foreground,
          green,
          gray,
          colors: colors.size,
          hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
    const first = await sample();
    assert.deepEqual([first.width, first.height], [1280, 720]);
    assert.ok(first.foreground > 100000 && first.foreground < 700000, JSON.stringify(first));
    assert.ok(
      first.green > 10000 && first.gray > 10000 && first.colors > 1000,
      'Both original shaders and the city texture are visible: ' + JSON.stringify(first),
    );
    assert.ok(first.draws >= first.frames * 30, 'All 30 native city draws execute per frame');
    await canvas.focus();
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    await page.keyboard.up('w');
    await waitFrames(first.frames + 3);
    const moved = await sample();
    assert.notEqual(moved.hash, first.hash, 'W moves the native camera');
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowRight');
    await waitFrames(moved.frames + 3);
    const turned = await sample();
    assert.notEqual(turned.hash, moved.hash, 'Arrow key turns the native camera');
    await page.keyboard.press('Escape');
    await waitFrames(turned.frames + 3);
    const reset = await sample();
    assert.equal(reset.hash, first.hash, 'Escape restores the original camera image');
    await mkdir('evidence', { recursive: true });
    const png = await canvas.evaluate((c) => c.toDataURL('image/png'));
    await writeFile(
      process.env.WINEBROWSER_SCREENSHOT_PATH || 'evidence/microsoft-dx12-city-browser.png',
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
    assert.ok(result.compiledBlocks > 1000 && result.instructions > 1000000);
    for (const api of [
      'd3d12.dll!D3D12CreateDevice',
      'ID3D12Device.CreateGraphicsPipelineState',
      'ID3D12GraphicsCommandList.CopyBufferRegion',
      'ID3D12GraphicsCommandList.CopyTextureRegion',
      'ID3D12Device.CreateSampler',
      'ID3D12GraphicsCommandList.ExecuteBundle',
      'ID3D12GraphicsCommandList.SetGraphicsRootDescriptorTable',
      'ID3D12GraphicsCommandList.DrawIndexedInstanced',
      'ID3D12GraphicsCommandList.ClearDepthStencilView',
      'IDXGISwapChain.Present',
      'user32.dll!PeekMessageW',
      'user32.dll!DispatchMessageW',
      'ntdll.dll!NtReadFile',
      'ntdll.dll!NtQueryPerformanceCounter',
    ])
      assert.ok(result.apiNames.includes(api), 'Native application call: ' + api);
    const dependencies = [...importGroups].map(([dll, imports]) => {
      const provider = resolveApiSet(dll).toLowerCase();
      const module = result.modules.find((m) => m.name.toLowerCase() === provider);
      assert.ok(module, 'Complete import provider: ' + dll + ' -> ' + provider);
      return {
        dll,
        provider,
        host: module.host,
        imports: imports.map((i) => i.name ?? `#${i.ordinal}`),
      };
    });
    for (const name of [
      'ntdll.dll',
      'kernel32.dll',
      'kernelbase.dll',
      'ucrtbase.dll',
      'shell32.dll',
    ])
      assert.ok(
        result.modules.some((m) => m.name === name && !m.host),
        'Native PE library: ' + name,
      );
    const nativeClosure = [...nativeLibraries].map(([name, library]) => {
      const providers = [
        ...new Set(library.imports.map((i) => resolveApiSet(i.dll.toLowerCase()).toLowerCase())),
      ];
      for (const provider of providers)
        assert.ok(
          result.modules.some((m) => m.name.toLowerCase() === provider),
          name + ' dependency ' + provider,
        );
      return {
        name,
        path: library.path,
        sha256: library.sha256,
        importedSymbols: library.imports.length,
        providers,
      };
    });
    assert.match(
      await page.locator('#logs').textContent(),
      /D3D12 DXBC shaders compiled to WGSL with 3 canonical bindings/,
    );
    assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
    runs.push({
      mode,
      firstFramesMs,
      first,
      moved,
      turned,
      reset,
      dependencies,
      nativeClosure,
      modules: result.modules,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      instructions: result.instructions,
      x86TranslationMs: result.x86TranslationMs,
      wasmBytes: result.wasmBytes,
      apiCalls: result.apiCalls,
    });
    console.log(
      `${mode}: 30 textured city meshes, movement/turn/reset verified, ${result.compiledBlocks} Wasm blocks, exit 0`,
    );
  }
  assert.deepEqual(errors, []);
  const report = {
    demo,
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    ordinaryBrowser: process.argv.includes('--ordinary'),
    upstreamRevision: pin.revision,
    exeSha256: entry.exeSha256,
    zipSha256: entry.zipSha256,
    browserCompilation: true,
    browserShaderCompilation: true,
    scene:
      '30 OCC city meshes, 18,642 indices per mesh, two original shaders, BC1 texture and D32 depth',
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_EVIDENCE_PATH || 'evidence/microsoft-dx12-city-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  await mkdir('.cache', { recursive: true });
  if (page)
    await writeFile(
      '.cache/city-browser-diagnostic.json',
      JSON.stringify(
        await page.evaluate(() => ({
          state: document.querySelector('#state').textContent,
          status: document.querySelector('#status').textContent,
          logs: document.querySelector('#logs').textContent,
          output: document.querySelector('#output').textContent,
          run: window.__lastRun,
        })),
        null,
        2,
      ),
    );
  await browser?.close();
  await server?.close();
}
