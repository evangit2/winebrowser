import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (process.env.WINEBROWSER_FORCE_READBACK === '1')
    await page.addInitScript(() => {
      const send = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (data, ...rest) {
        return send.call(
          this,
          data?.type === 'run' ? { ...data, forceReadback: true } : data,
          ...rest,
        );
      };
    });
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const manifest = await (
    await page.request.get(new URL('examples/manifest.json', url).href)
  ).json();
  const entry = manifest.interactive.find((entry) => entry.name === 'vkcube');
  assert.ok(entry, 'upstream Vulkan demo is available in the hosted catalog');
  const exeResponse = await page.request.get(new URL('examples/' + entry.exe, url).href);
  const zipResponse = await page.request.get(new URL('examples/' + entry.zip, url).href);
  assert.ok(exeResponse.ok() && zipResponse.ok());
  const exe = await exeResponse.body(),
    zip = await zipResponse.body();
  assert.equal(sha256(exe), entry.exeSha256);
  assert.equal(sha256(zip), entry.zipSha256);
  const runs = [];
  for (const mode of ['exe-upload', 'zip-upload', 'hosted-catalog', 'staging-upload']) {
    if (mode === 'hosted-catalog') await page.locator('[data-demo="vkcube"]').click();
    else
      await page.locator('#file').setInputFiles({
        name: mode === 'zip-upload' ? 'vkcube.zip' : 'vkcube.exe',
        mimeType: 'application/octet-stream',
        buffer: mode === 'zip-upload' ? zip : exe,
      });
    await page.waitForFunction(
      () =>
        document.querySelector('#state')?.textContent === 'LOADED' &&
        !document.querySelector('#run').disabled,
      null,
      { timeout: 60000 },
    );
    await page.locator('#args').fill(mode === 'staging-upload' ? '["--use_staging"]' : '[]');
    const started = Date.now();
    await page.locator('#run').click();
    const waitFrames = (count) =>
      page.waitForFunction(
        (count) => {
          if (document.querySelector('#state').textContent === 'ERROR')
            throw Error(
              document.querySelector('#output').textContent +
                document.querySelector('#status').textContent,
            );
          return (
            Number(
              document.querySelector('[data-graphics-api="vulkan"]')?.dataset.graphicsFrames,
            ) >= count
          );
        },
        count,
        { timeout: 60000 },
      );
    await waitFrames(12);
    const canvas = page.locator('[data-graphics-api="vulkan"]');
    const snapshot = () =>
      canvas.evaluate(async (canvas) => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const corner = [...pixels.slice(0, 4)];
        let geometry = 0,
          teal = 0,
          white = 0;
        const colors = new Set();
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] !== corner[0] || pixels[i + 1] !== corner[1] || pixels[i + 2] !== corner[2])
            geometry++;
          if (pixels[i + 1] > pixels[i] + 20 && pixels[i + 2] > pixels[i] + 20) teal++;
          if (Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 180) white++;
          colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
        }
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        return {
          width: canvas.width,
          height: canvas.height,
          frames: Number(canvas.dataset.graphicsFrames),
          draws: Number(canvas.dataset.graphicsDraws),
          corner,
          geometry,
          teal,
          white,
          colors: colors.size,
          hash: [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join(''),
        };
      });
    const first = await snapshot();
    assert.deepEqual([first.width, first.height], [500, 500]);
    assert.deepEqual(first.corner, [51, 51, 51, 255]);
    assert.ok(first.geometry > 20000 && first.geometry < 150000, 'actual 3D cube geometry');
    assert.ok(
      first.teal > 1000 && first.white > 50 && first.colors > 100,
      'original LunarG texture and lettering',
    );
    await waitFrames(first.frames + 24);
    const second = await snapshot();
    // The native Win32 loop uses WaitMessage while paused. An internal paint
    // request must not keep it spinning and animating without input.
    await canvas.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    const paused = await snapshot();
    await page.waitForTimeout(200);
    const stillPaused = await snapshot();
    assert.equal(stillPaused.frames, paused.frames, 'Space pauses native rendering');
    assert.equal(stillPaused.hash, paused.hash, 'paused scene pixels stay unchanged');
    await page.keyboard.press('Space');
    await waitFrames(stillPaused.frames + 8);
    assert.notEqual(second.hash, first.hash, 'original guest matrix animates the textured cube');
    assert.ok(second.draws > first.draws, 'native Vulkan draws continue');
    await mkdir('evidence', { recursive: true });
    await page.locator('#desktop').screenshot({ path: `evidence/vulkan-${mode}.png` });
    await canvas.focus();
    await page.keyboard.press('ArrowLeft');
    await waitFrames(second.frames + 8);
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0);
    assert.ok(
      result.compiledBlocks > 0 && result.instructions > 0 && result.wasmBytes > 0,
      'uploaded x86 is compiled in browser',
    );
    for (const name of [
      'vkCreateInstance',
      'vkCreateDevice',
      'vkCreateWin32SurfaceKHR',
      'vkCreateSwapchainKHR',
      'vkCreateShaderModule',
      'vkCreateGraphicsPipelines',
      'vkMapMemory',
      'vkUpdateDescriptorSets',
      'vkCmdDraw',
      'vkQueueSubmit',
      'vkQueuePresentKHR',
      'vkDestroySwapchainKHR',
      'vkDestroyDevice',
      'vkDestroyInstance',
    ])
      assert.ok(result.apiNames.includes('vulkan-1.dll!' + name), 'native API called: ' + name);
    if (mode === 'staging-upload')
      assert.ok(result.apiNames.includes('vulkan-1.dll!vkCmdCopyBufferToImage'));
    else assert.ok(result.apiNames.includes('vulkan-1.dll!vkGetImageSubresourceLayout'));
    assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
    runs.push({
      mode,
      first,
      second,
      pauseResume: true,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      wasmBytes: result.wasmBytes,
      instructions: result.instructions,
      elapsedMs: Date.now() - started,
      vulkanCalls: result.apiNames.filter((name) => name.startsWith('vulkan-1.dll!')).sort(),
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: entry.exeSha256,
    zipSha256: entry.zipSha256,
    browserCompilation: true,
    workerWebGPU: true,
    upstreamSceneUnchanged: true,
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_FORCE_READBACK === '1'
      ? 'evidence/vulkan-readback-results.json'
      : 'evidence/vulkan-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
