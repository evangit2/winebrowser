import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(
  process.env.WINEBROWSER_NORMAL_CHROMIUM === '1' ? { headless: false } : webgpuBrowserOptions,
);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const manifest = await (
    await page.request.get(new URL('examples/manifest.json', url).href)
  ).json();
  const entry = manifest.interactive.find((e) => e.name === 'humus-water');
  assert.ok(entry);
  const zip = await (await page.request.get(new URL('examples/' + entry.zip, url).href)).body();
  assert.equal(
    createHash('sha256').update(zip).digest('hex'),
    'b932030521da28ab2c66e01e4d7914101540cd3f9cd9381586f12890f7d9fa70',
  );
  const exe = await (await page.request.get(new URL('examples/' + entry.exe, url).href)).body();
  assert.equal(
    createHash('sha256').update(exe).digest('hex'),
    '435463c13f528a9012daa03004441e4187a7668ed0871f941633d8d53b6d4b0d',
  );
  const capability = await page.evaluate(async () => {
    const source = `
      (async () => {
        try {
          const adapter = await navigator.gpu?.requestAdapter();
          if (!adapter) throw Error('No WebGPU worker adapter');
          postMessage({ features: [...adapter.features], fallback: !!adapter.info?.isFallbackAdapter });
        } catch (error) { postMessage({ error: error.message }); }
      })();`;
    const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(objectUrl);
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(Error(event.message));
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(objectUrl);
    }
  });
  assert.equal(capability.error, undefined);
  if (
    !['texture-formats-tier1', 'float32-filterable'].every((f) => capability.features.includes(f))
  ) {
    const report = {
      status: 'unsupported-adapter',
      scope:
        'Unchanged ZIP/EXE hashes verified; Water rendering acceptance did not run. This adapter lacks precise RGBA16 support.',
      date: new Date().toISOString(),
      browser: browser.version(),
      url,
      capability,
    };
    await writeFile(
      'evidence/water-browser-unsupported-results.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report, null, 2));
    assert.equal(
      process.env.WINEBROWSER_ALLOW_UNSUPPORTED_RGBA16,
      '1',
      'Water acceptance requires precise RGBA16 support',
    );
  } else {
    const runs = [];
    for (const mode of ['zip-upload', 'hosted-zip']) {
      if (mode === 'zip-upload')
        await page.locator('#file').setInputFiles({
          name: 'Water.zip',
          mimeType: 'application/zip',
          buffer: zip,
        });
      else await page.locator('[data-demo="humus-water"]').click();
      await page.waitForFunction(
        () => {
          if (document.querySelector('#state')?.textContent === 'ERROR')
            throw Error(document.querySelector('#status')?.textContent);
          return document.querySelector('#state')?.textContent === 'LOADED';
        },
        null,
        { timeout: 60000 },
      );
      const started = Date.now();
      await page.locator('#run').click();
      const samples = [];
      for (const goal of [8, 40, 120]) {
        await page.waitForFunction(
          (goal) => {
            if (['ERROR', 'EXITED'].includes(document.querySelector('#state')?.textContent))
              throw Error(document.querySelector('#status')?.textContent);
            return (
              Number(document.querySelector('.virtual-desktop-canvas')?.dataset.graphicsFrames) >=
              goal
            );
          },
          goal,
          { timeout: 240000 },
        );
        const sample = await page.locator('.virtual-desktop-canvas').evaluate(async (canvas) => {
          // Exclude the original FPS overlay: only the room/light/shadows may
          // satisfy the animation check.
          const pixels = canvas
            .getContext('2d')
            .getImageData(0, 64, canvas.width, canvas.height - 64).data;
          let dark = 0,
            bright = 0,
            colored = 0;
          const colors = new Set();
          for (let i = 0; i < pixels.length; i += 4) {
            const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]),
              min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
            if (max < 48) dark++;
            if (min > 120) bright++;
            if (max - min > 35) colored++;
            if (colors.size < 4096) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
          }
          return {
            width: canvas.width,
            height: canvas.height,
            frames: Number(canvas.dataset.graphicsFrames),
            draws: Number(canvas.dataset.graphicsDraws),
            dark,
            bright,
            colored,
            colors: colors.size,
            sceneSha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          };
        });
        assert.deepEqual([sample.width, sample.height], [798, 570]);
        assert.ok(
          sample.dark > 10000 &&
            sample.bright > 500 &&
            sample.colored > 5000 &&
            sample.colors >= 1000,
          'reflected landscape and water scene: ' + JSON.stringify(sample),
        );
        samples.push(sample);
      }
      assert.equal(
        new Set(samples.map((s) => s.sceneSha256)).size,
        samples.length,
        'the scene changes independently of FPS text',
      );
      assert.ok(samples.at(-1).draws >= samples.at(-1).frames * 2);
      await page.locator('.virtual-desktop-close').click();
      await page.waitForFunction(
        () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
        null,
        { timeout: 60000 },
      );
      const result = await page.evaluate(() => window.__lastRun);
      assert.equal(result?.exitCode, 0, JSON.stringify(result));
      for (const api of [
        'IDirect3DDevice9.CreateCubeTexture',
        'IDirect3DCubeTexture9.LockRect',
        'IDirect3DDevice9.CreateTexture',
        'IDirect3DTexture9.GetSurfaceLevel',
        'IDirect3DDevice9.DrawPrimitiveUP',
        'IDirect3DDevice9.SetRenderTarget',
        'IDirect3DDevice9.SetDepthStencilSurface',
        'IDirect3DDevice9.DrawIndexedPrimitiveUP',
      ])
        assert.ok(result.apiNames.includes(api), api);
      assert.ok(
        result.compiledBlocks > 1000 && result.wasmBytes > 1000000,
        'native blocks compile to Wasm during browser execution',
      );
      runs.push({
        mode,
        elapsedMs: Date.now() - started,
        samples,
        exitCode: result.exitCode,
        compiledBlocks: result.compiledBlocks,
        wasmBytes: result.wasmBytes,
        instructions: result.instructions,
        x86TranslationMs: result.x86TranslationMs,
        totalCompiledBlocks: result.totalCompiledBlocks,
        apiCalls: result.apiCalls,
      });
    }
    assert.deepEqual(errors, []);
    const report = {
      passed: true,
      date: new Date().toISOString(),
      browser: await browser.version(),
      url,
      exeSha256: entry.exeSha256,
      zipSha256: entry.zipSha256,
      normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
      scope:
        'Unchanged Humus Water archive: ordinary ZIP upload and catalog, original shaders, reflective landscape and ripple simulation, animated scene excluding FPS text, browser x86 and shader compilation, clean exit. Precision and shared-depth storage are independently verified by GPU regressions.',
      runs,
      errors,
    };
    await writeFile('evidence/water-browser-results.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
} finally {
  await browser.close();
}
