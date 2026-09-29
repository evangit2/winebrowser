import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Regression gate for the first independent third-party Direct3D 9 application
// in the catalog: the unchanged Humus "Dynamic Branching" demo, published as a
// hosted example. WineBrowser does not patch it or substitute its shaders; the
// guest x86 blocks and the demo's own VS 1.1 / PS 2.0 shaders are translated
// during browser execution. The test asserts the scene actually renders (a
// large, richly shaded, animated 798x570 image) and that the guest's own
// Direct3D 9 calls reach the host, rather than only that a window appeared.
const example = 'humus-dynamic-branching';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(url);
  await page.waitForFunction(
    () => document.getElementById('platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );

  // The published archive and its pinned executable must be served unchanged.
  const manifest = await (
    await page.request.get(new URL('examples/manifest.json', url).href)
  ).json();
  const fixture = manifest.interactive.find((entry) => entry.name === example);
  assert.ok(fixture, 'humus-dynamic-branching is in the published example catalog');
  const zip = await (await page.request.get(new URL('examples/' + fixture.zip, url).href)).body();
  assert.equal(createHash('sha256').update(zip).digest('hex'), fixture.zipSha256);
  const executable = await (
    await page.request.get(new URL('examples/' + fixture.exe, url).href)
  ).body();
  assert.equal(createHash('sha256').update(executable).digest('hex'), fixture.exeSha256);
  assert.equal(
    fixture.exeSha256,
    '7664f1f55d71593b6af9475bef06aba811bbe8a5ec3ba690ec559064d6207bc5',
  );

  const run = async (mode) => {
    // The demo reads its own DDS textures, HMDL model and .shd shaders from
    // relative paths, so it can only run from a package. Both modes below are
    // the arbitrary drop-in path the harness offers: the published example
    // button, and the unchanged upstream ZIP uploaded as an ordinary file.
    if (mode === 'hosted-zip') await page.locator(`[data-demo="${example}"]`).click();
    else
      await page.locator('#file').setInputFiles({
        name: 'DynamicBranching.zip',
        mimeType: 'application/zip',
        buffer: zip,
      });
    await page.waitForFunction(() => !document.getElementById('run').disabled, null, {
      timeout: 120000,
    });
    const start = Date.now();
    await page.locator('#run').click();
    await page.waitForFunction(
      () => {
        const state = document.querySelector('#state')?.textContent;
        if (state === 'ERROR' || state === 'EXITED')
          throw Error(
            document.querySelector('#output').textContent +
              ' ' +
              document.querySelector('#status').textContent,
          );
        return (
          Number(document.querySelector('.virtual-desktop-canvas')?.dataset.graphicsFrames) >= 4
        );
      },
      null,
      { timeout: 300000 },
    );
    const firstFramesMs = Date.now() - start;
    const canvas = page.locator('.virtual-desktop-canvas');
    const sample = () =>
      canvas.evaluate(async (element) => {
        const pixels = element
          .getContext('2d')
          .getImageData(0, 0, element.width, element.height).data;
        // The pillar room covers the whole client area, so almost every pixel
        // is scene rather than the demo's dark clear color.
        let lit = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) <= 24) continue;
          lit++;
          if (colors.size < 4096) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        }
        return {
          width: element.width,
          height: element.height,
          frames: Number(element.dataset.graphicsFrames),
          lit,
          colors: colors.size,
          corner: [...pixels.slice(0, 4)],
          hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
    const first = await sample();
    assert.deepEqual([first.width, first.height], [798, 570], 'the demo renders at its own size');
    // The pillar room fills essentially the whole client area, so an almost
    // black frame (a missing draw) or a frame at a single flat color (a lost
    // shader or texture stage) both fail here.
    assert.ok(first.lit > 300000, `the room scene is rendered (${first.lit} lit pixels)`);
    assert.ok(first.colors >= 1000, `textures and lighting produce many colors (${first.colors})`);
    await page.waitForTimeout(3000);
    const second = await sample();
    assert.ok(second.frames > first.frames, 'the guest keeps presenting frames');
    assert.notEqual(first.hash, second.hash, 'the scene animates');
    assert.ok(second.lit > 300000 && second.colors >= 1000);

    await mkdir('evidence', { recursive: true });
    await page.locator('#desktop').screenshot({ path: `evidence/humus-d3d9-${mode}.png` });
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 120000 });
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, 'the demo exits cleanly');
    // A real application makes far more calls than the bounded, ordered trace
    // retains, so the complete deduplicated set is what proves its API surface.
    const reached = new Set(result.apiNames ?? result.apiTrace);
    const missing = [];
    for (const call of [
      'd3d9.dll!Direct3DCreate9',
      'IDirect3D9.GetDeviceCaps',
      'IDirect3D9.CreateDevice',
      // The demo's own model path: its HMDL room arrives as locked vertex and
      // index buffers, and the stencil-shadow scene is drawn with its own
      // VS 1.1 / PS 2.0 shaders and DXT-sampled textures.
      'IDirect3DDevice9.CreateVertexBuffer',
      'IDirect3DVertexBuffer9.Lock',
      'IDirect3DDevice9.CreateIndexBuffer',
      'IDirect3DIndexBuffer9.Lock',
      'IDirect3DDevice9.CreateTexture',
      'IDirect3DTexture9.LockRect',
      'IDirect3DDevice9.CreateVertexShader',
      'IDirect3DDevice9.CreatePixelShader',
      'IDirect3DDevice9.CreateVertexDeclaration',
      'IDirect3DDevice9.SetVertexDeclaration',
      'IDirect3DDevice9.SetTexture',
      'IDirect3DDevice9.SetVertexShader',
      'IDirect3DDevice9.SetPixelShader',
      'IDirect3DDevice9.SetSamplerState',
      'IDirect3DDevice9.SetVertexShaderConstantF',
      'IDirect3DDevice9.SetPixelShaderConstantF',
      'IDirect3DDevice9.BeginScene',
      'IDirect3DDevice9.DrawIndexedPrimitive',
      'IDirect3DDevice9.EndScene',
      'IDirect3DDevice9.Present',
      'IDirect3DDevice9.Release',
    ])
      if (!reached.has(call)) missing.push(call);
    if (missing.length) throw Error('missing API trace entries: ' + JSON.stringify(missing));
    assert.ok(
      result.instructions > 0 && result.compiledBlocks > 0,
      'the PE executes through browser Wasm translation',
    );
    return {
      mode,
      firstFramesMs,
      first,
      second,
      exitCode: result.exitCode,
      instructions: result.instructions,
      compiledBlocks: result.compiledBlocks,
      apiCalls: result.apiCalls,
    };
  };

  const runs = [await run('hosted-zip'), await run('dropped-zip')];
  assert.deepEqual(errors, []);
  const report = {
    example,
    scope:
      'Unchanged third-party Humus "Dynamic Branching" D3D9 demo executed through the ordinary browser host-API path: guest x86 blocks and the demo’s own shaders are translated during browser execution, and its DXT textures, HMDL model and stencil-shadow scene render in a virtual window. This is one independent application, not broad D3D9 game compatibility.',
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: fixture.exeSha256,
    archiveSha256: fixture.zipSha256,
    browserCompilation: true,
    browserShaderCompilation: true,
    runs,
    errors,
  };
  await writeFile(
    'evidence/humus-d3d9-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
