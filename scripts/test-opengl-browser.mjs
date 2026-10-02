import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(webgpuBrowserOptions);
const hash = (data) => createHash('sha256').update(data).digest('hex');
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const manifest = await (await page.request.get(new URL('demos/manifest.json', url).href)).json();
  const fixture = manifest.interactive.find((x) => x.name === 'opengl-raymarch');
  assert.ok(fixture, 'modern OpenGL demo is in the published catalog');
  const exe = await (await page.request.get(new URL('demos/' + fixture.exe, url).href)).body();
  const zip = await (await page.request.get(new URL('demos/' + fixture.zip, url).href)).body();
  assert.equal(hash(exe), fixture.exeSha256);
  assert.equal(hash(zip), fixture.zipSha256);
  assert.equal(exe.toString('ascii', 0, 2), 'MZ', 'input is a native Windows binary');

  const upload = async (buffer = exe) => {
    await page
      .locator('#file')
      .setInputFiles({ name: 'opengl-raymarch.exe', mimeType: 'application/octet-stream', buffer });
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
  };
  const ready = async () => {
    await page.waitForFunction(
      () => {
        if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
          throw Error(
            document.querySelector('#output').textContent +
              document.querySelector('#logs').textContent,
          );
        return (
          Number(document.querySelector('[data-graphics-api="opengl"]')?.dataset.graphicsFrames) >=
          8
        );
      },
      null,
      { timeout: 60000 },
    );
  };
  const canvas = page.locator('[data-graphics-api="opengl"]');
  const snapshot = () =>
    canvas.evaluate(async (element) => {
      const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
      const colors = new Set();
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.max(data[i], data[i + 1], data[i + 2]) > 64) bright++;
        if (colors.size < 8192) colors.add(data[i] * 65536 + data[i + 1] * 256 + data[i + 2]);
      }
      return {
        width: element.width,
        height: element.height,
        frames: Number(element.dataset.graphicsFrames),
        draws: Number(element.dataset.graphicsDraws),
        colors: colors.size,
        bright,
        hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join(''),
      };
    });
  const framesAfter = async (frame, count) =>
    page.waitForFunction(
      (n) =>
        Number(document.querySelector('[data-graphics-api="opengl"]')?.dataset.graphicsFrames) >= n,
      frame.frames + count,
      { timeout: 30000 },
    );
  const runs = [];
  for (const mode of ['exe-upload', 'hosted-zip']) {
    if (mode === 'exe-upload') await upload();
    else {
      await page.locator('[data-demo="opengl-raymarch"]').click();
      await page.waitForFunction(() => !document.querySelector('#run').disabled);
    }
    const start = Date.now();
    await page.locator('#run').click();
    await ready();
    const first = await snapshot(),
      firstFramesMs = Date.now() - start;
    assert.deepEqual([first.width, first.height], [800, 600]);
    console.log(mode, first);
    assert.ok(
      first.colors >= 2000 && first.bright > 150000,
      'richly shaded 3D scene covers the client area',
    );
    await framesAfter(first, 8);
    const animated = await snapshot();
    assert.notEqual(animated.hash, first.hash, 'the guest animates its own shader uniforms');
    await canvas.click();
    await page.keyboard.press('Space');
    await framesAfter(animated, 8);
    const paused = await snapshot();
    await framesAfter(paused, 8);
    const still = await snapshot();
    assert.equal(
      paused.hash,
      still.hash,
      'guest Space pauses the animation while rendering continues',
    );
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await framesAfter(still, 8);
    const camera = await snapshot();
    assert.notEqual(camera.hash, still.hash, 'guest arrow keys change the 3D camera');
    await framesAfter(camera, 8);
    assert.equal((await snapshot()).hash, camera.hash, 'paused camera view stays stable');
    await mkdir('evidence', { recursive: true });
    await page.locator('#desktop').screenshot({ path: 'evidence/opengl-' + mode + '.png' });
    assert.match(
      await page.locator('#logs').textContent(),
      /OpenGL GLSL vertex shader compiled in browser \(success\)/,
    );
    assert.match(
      await page.locator('#logs').textContent(),
      /OpenGL GLSL fragment shader compiled in browser \(success\)/,
    );
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => window.__lastRun || document.querySelector('#state').textContent === 'ERROR',
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result?.exitCode, 0, 'native WGL, shader, buffer and window cleanup exits zero');
    assert.ok(
      result.compiledBlocks > 50 && result.wasmBytes > 10000 && result.instructions > 1000,
      'native x86 instructions compiled to Wasm during this run',
    );
    const reached = new Set(result.apiNames);
    for (const call of [
      'wglCreateContextAttribsARB',
      'glShaderSource',
      'glCompileShader',
      'glLinkProgram',
      'glGenVertexArrays',
      'glBufferData',
      'glUniform1f',
      'glDrawArrays',
      'glDeleteProgram',
    ])
      assert.ok(reached.has('opengl32.dll!' + call), 'guest reached ' + call);
    assert.ok(reached.has('gdi32.dll!SwapBuffers'));
    runs.push({
      mode,
      firstFramesMs,
      first,
      animated,
      paused,
      camera,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      wasmBytes: result.wasmBytes,
      instructions: result.instructions,
      apiNames: result.apiNames,
    });
  }
  // Stop must terminate a live GL worker, and a fresh ordinary upload must work.
  await upload();
  await page.locator('#run').click();
  await ready();
  await page.locator('#stop').click();
  assert.equal(await page.locator('#state').innerText(), 'STOPPED');
  await upload();
  await page.locator('#run').click();
  await ready();
  await canvas.click();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__lastRun);
  assert.equal((await page.evaluate(() => window.__lastRun)).exitCode, 0);
  assert.deepEqual(errors, []);
  const report = {
    format: 1,
    url,
    executableSha256: fixture.exeSha256,
    zipSha256: fixture.zipSha256,
    backend: 'desktop GLSL vertex/fragment subset on worker WebGL2',
    runs,
    stopAndReupload: true,
    pageErrors: errors,
  };
  await writeFile('evidence/opengl-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    'OpenGL: EXE upload, hosted ZIP, shader compilation, animation, pause, camera, clean exit and Stop/reupload passed.',
  );
} finally {
  await browser.close();
}
