import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } }),
    errors = [];
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
  const entry = manifest.interactive.find((e) => e.name === 'gltfskinning');
  assert.ok(entry);
  const zip = await (await page.request.get(new URL('examples/' + entry.zip, url).href)).body();
  const exe = await (await page.request.get(new URL('examples/' + entry.exe, url).href)).body();
  assert.equal(digest(zip), entry.zipSha256);
  assert.equal(digest(exe), entry.exeSha256);
  const runs = [];
  const modes = process.env.WINEBROWSER_SKINNING_MODES?.split(',') || [
    'zip-upload',
    'folder-upload',
    'hosted-catalog',
  ];
  for (const mode of modes) {
    if (mode === 'hosted-catalog') await page.locator('[data-demo="gltfskinning"]').click();
    else if (mode === 'folder-upload')
      await page.locator('#folder').setInputFiles('public/examples/gltfskinning');
    else
      await page
        .locator('#file')
        .setInputFiles({ name: 'gltfskinning.zip', mimeType: 'application/zip', buffer: zip });
    await page.waitForFunction(
      () => document.querySelector('#state')?.textContent === 'LOADED',
      null,
      { timeout: 60000 },
    );
    assert.ok(await page.locator('#run').isEnabled(), await page.locator('#details').textContent());
    await page.locator('#args').fill('["--width","640","--height","480"]');
    const started = Date.now();
    await page.locator('#run').click();
    const waitFrames = (count) =>
      page.waitForFunction(
        (count) => {
          if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
            throw Error(
              document.querySelector('#output').textContent +
                document.querySelector('#logs').textContent,
            );
          return (
            Number(
              document.querySelector('[data-graphics-api="vulkan"]')?.dataset.graphicsFrames,
            ) >= count
          );
        },
        count,
        { timeout: 120000 },
      );
    await waitFrames(12);
    const canvas = page.locator('[data-graphics-api="vulkan"]');
    const snapshot = () =>
      canvas.evaluate(async (canvas) => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const corner = [...pixels.slice(0, 4)];
        let geometry = 0,
          green = 0,
          blue = 0,
          white = 0;
        const colors = new Set();
        // Exclude the ImGui/FPS rectangle, so scene motion cannot be established
        // by changing text. This rectangle contains the actual skinned mesh.
        const scene = [];
        for (let y = 60; y < 460; y++)
          for (let x = 275; x < 620; x++) {
            const i = (y * canvas.width + x) * 4,
              r = pixels[i],
              g = pixels[i + 1],
              b = pixels[i + 2];
            scene.push(r, g, b, pixels[i + 3]);
            if (r !== corner[0] || g !== corner[1] || b !== corner[2]) geometry++;
            if (g > r + 12 && g > b + 8) green++;
            if (b > r + 12 && b > g + 8) blue++;
            if (Math.min(r, g, b) > 170) white++;
            colors.add(`${r},${g},${b}`);
          }
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(scene))),
        ]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
        return {
          width: canvas.width,
          height: canvas.height,
          frames: Number(canvas.dataset.graphicsFrames),
          draws: Number(canvas.dataset.graphicsDraws),
          corner,
          geometry,
          green,
          blue,
          white,
          colors: colors.size,
          hash,
        };
      });
    const first = await snapshot();
    assert.deepEqual([first.width, first.height], [640, 480]);
    assert.ok(
      first.geometry > 3000 &&
        first.green > 100 &&
        first.blue > 100 &&
        first.white > 100 &&
        first.colors > 100,
      'original lit, textured CesiumMan mesh',
    );
    await waitFrames(first.frames + 24);
    const animated = await snapshot();
    assert.notEqual(
      first.hash,
      animated.hash,
      'bone animation changes geometry pixels outside FPS text',
    );
    await mkdir('evidence', { recursive: true });
    const presentation = process.env.WINEBROWSER_FORCE_READBACK === '1' ? '-readback' : '';
    await page
      .locator('#desktop')
      .screenshot({ path: `evidence/skinning-${mode}${presentation}.png` });
    await canvas.focus();
    await page.keyboard.press('p');
    await waitFrames(animated.frames + 12);
    const paused = await snapshot();
    await page.keyboard.press('F1');
    await waitFrames(paused.frames + 12);
    // An upstream frames-in-flight buffer can contain an earlier paused pose;
    // check three matching frame phases rather than imposing a new guest loop.
    const poses = [];
    for (let i = 0; i < 4; i++) {
      const s = await snapshot();
      poses.push(s);
      await waitFrames(s.frames + 12);
    }
    assert.ok(
      new Set(poses.map((p) => p.hash)).size <= 3,
      'paused bone poses stay within native frame-buffer phases',
    );
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 500, box.y + 240);
    await page.mouse.down();
    await page.mouse.move(box.x + 545, box.y + 260, { steps: 6 });
    await page.mouse.up();
    await waitFrames(poses.at(-1).frames + 20);
    const moved = await snapshot();
    assert.ok(!poses.some((p) => p.hash === moved.hash), 'native mouse drag changes camera view');
    await canvas.focus();
    await page.keyboard.press('p');
    await waitFrames(moved.frames + 24);
    const resumed = await snapshot();
    assert.notEqual(resumed.hash, moved.hash, 'skeletal animation resumes');
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.ok(result.compiledBlocks > 0 && result.wasmBytes > 0);
    for (const name of [
      'vkCmdDrawIndexed',
      'vkCmdBindVertexBuffers',
      'vkCmdBindIndexBuffer',
      'vkCmdPushConstants',
      'vkCmdCopyBuffer',
      'vkCreateGraphicsPipelines',
      'vkCmdBindDescriptorSets',
      'vkQueuePresentKHR',
    ])
      assert.ok(result.apiNames.includes('vulkan-1.dll!' + name), name);
    for (const name of [
      'ntdll.dll',
      'kernel32.dll',
      'kernelbase.dll',
      'ucrtbase.dll',
      'vulkan-1.dll',
      'user32.dll',
      'gdi32.dll',
    ])
      assert.ok(
        result.modules.some((m) => m.name === name),
        'complete module closure: ' + name,
      );
    assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
    runs.push({
      mode,
      first,
      animated,
      paused,
      moved,
      resumed,
      exitCode: result.exitCode,
      elapsedMs: Date.now() - started,
      compiledBlocks: result.compiledBlocks,
      wasmBytes: result.wasmBytes,
      instructions: result.instructions,
      modules: result.modules,
      vulkanCalls: result.apiNames.filter((n) => n.startsWith('vulkan-1.dll!')),
      windowsCalls: result.apiNames.filter((n) => !n.startsWith('vulkan-1.dll!')),
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: entry.exeSha256,
    zipSha256: entry.zipSha256,
    upstreamApplicationAndSceneUnchanged: true,
    browserCompilation: true,
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_FORCE_READBACK === '1'
      ? 'evidence/skinning-readback-results.json'
      : 'evidence/skinning-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
