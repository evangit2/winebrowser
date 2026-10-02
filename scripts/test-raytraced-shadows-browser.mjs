import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
import { parsePE } from '../src/pe.js';
import { API_NAMES } from '../src/win32.js';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
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
  const fixture = manifest.interactive.find((x) => x.name === 'humus-raytraced-shadows');
  assert.ok(fixture);
  const zip = await (await page.request.get(new URL('examples/' + fixture.zip, url).href)).body();
  const exe = await (await page.request.get(new URL('examples/' + fixture.exe, url).href)).body();
  assert.equal(hash(zip), '126b68f89cddb8cefa41f3fe3ba74b64bbbf5a2ef2c402bbe659042295773b08');
  assert.equal(hash(exe), '3f1d94477ed652d91ead86196d48c9b595bd83713420cd5fd5cf482810668449');
  const pe = parsePE(exe);
  const dependencyAudit = [...new Set(pe.imports.map((x) => x.dll))].map((dll) => ({
    dll,
    provider: 'browser Win32/OpenGL API bridge',
    imports: pe.imports.filter((x) => x.dll === dll).map((x) => x.name),
    unresolved: pe.imports
      .filter((x) => x.dll === dll && !API_NAMES[dll.toLowerCase()]?.includes(x.name))
      .map((x) => x.name),
  }));
  assert.deepEqual(dependencyAudit.map((x) => x.dll.toLowerCase()).sort(), [
    'advapi32.dll',
    'gdi32.dll',
    'kernel32.dll',
    'opengl32.dll',
    'shell32.dll',
    'user32.dll',
  ]);
  assert.ok(
    dependencyAudit.every((x) => x.unresolved.length === 0),
    'every imported DLL and symbol maps before execution',
  );
  const upload = async () => {
    await page
      .locator('#file')
      .setInputFiles({ name: 'RaytracedShadows.zip', mimeType: 'application/zip', buffer: zip });
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
  };
  const ready = async (frames = 8) =>
    page.waitForFunction(
      (n) => {
        if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
          throw Error(
            document.querySelector('#output').textContent +
              document.querySelector('#logs').textContent,
          );
        return (
          Number(document.querySelector('[data-graphics-api="opengl"]')?.dataset.graphicsFrames) >=
          n
        );
      },
      frames,
      { timeout: 90000 },
    );
  const canvas = page.locator('[data-graphics-api="opengl"]');
  const snapshot = () =>
    canvas.evaluate(async (c) => {
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const colors = new Set();
      let shaded = 0,
        opaque = 0,
        menuYellowPixels = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 90) shaded++;
        if (data[i + 3] === 255) opaque++;
        const x = (i / 4) % c.width,
          y = Math.floor(i / 4 / c.width);
        if (
          x > c.width * 0.15 &&
          x < c.width * 0.85 &&
          y > c.height * 0.3 &&
          y < c.height * 0.43 &&
          data[i] > 180 &&
          data[i + 1] > 180 &&
          data[i + 2] < 60
        )
          menuYellowPixels++;
        if (colors.size < 8192) colors.add(data[i] * 65536 + data[i + 1] * 256 + data[i + 2]);
      }
      return {
        width: c.width,
        height: c.height,
        frames: Number(c.dataset.graphicsFrames),
        draws: Number(c.dataset.graphicsDraws),
        modelView: JSON.parse(c.dataset.graphicsModelView || 'null'),
        shaded,
        opaque,
        menuYellowPixels,
        colors: colors.size,
        hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join(''),
      };
    });
  const after = async (frame, count = 3) => ready(frame.frames + count);
  const runs = [];
  for (const mode of ['ordinary-zip-upload', 'hosted-catalog']) {
    if (mode === 'ordinary-zip-upload') await upload();
    else {
      await page.locator('[data-demo="humus-raytraced-shadows"]').click();
      await page.waitForFunction(() => !document.querySelector('#run').disabled);
    }
    await page.locator('#run').click();
    await ready();
    const first = await snapshot();
    assert.ok(first.width >= 640 && first.height >= 480);
    assert.ok(
      first.colors > 3000 && first.shaded > 100000 && first.draws > first.frames * 25,
      'textured, multi-pass 3D scene renders',
    );
    assert.equal(
      first.opaque,
      first.width * first.height,
      'destination alpha stays internal to an opaque Windows window',
    );
    assert.ok(first.modelView?.length === 16);
    await after(first);
    const animated = await snapshot();
    assert.notEqual(animated.hash, first.hash, 'native physics and moving light animate');
    assert.deepEqual(animated.modelView, first.modelView, 'animation does not move the camera');
    await canvas.click();
    await page.keyboard.down('w');
    await page.keyboard.down('ArrowUp');
    await after(animated, 6);
    await page.keyboard.up('w');
    await page.keyboard.up('ArrowUp');
    await after(await snapshot(), 3);
    const camera = await snapshot();
    assert.notDeepEqual(
      camera.modelView,
      first.modelView,
      'held forward input changes the actual guest perspective model-view matrix',
    );
    await page.keyboard.press('F1');
    await after(camera, 3);
    const settings = await snapshot();
    assert.ok(settings.menuYellowPixels > 500, 'original yellow settings-menu glyphs render');
    await mkdir('evidence', { recursive: true });
    await page
      .locator('#desktop')
      .screenshot({ path: 'evidence/raytraced-shadows-' + mode + '-settings.png' });
    await page.keyboard.press('F1');
    await after(settings, 3);
    // SwapBuffers frames already queued on the main thread can precede input
    // delivery to the guest message pump. Wait for the observable menu change.
    await page.waitForFunction(
      (limit) => {
        const c = document.querySelector('[data-graphics-api="opengl"]');
        const x0 = Math.floor(c.width * 0.15) + 1,
          y0 = Math.floor(c.height * 0.3) + 1,
          w = Math.ceil(c.width * 0.85) - x0,
          h = Math.ceil(c.height * 0.43) - y0;
        const data = c.getContext('2d').getImageData(x0, y0, w, h).data;
        let yellow = 0;
        for (let i = 0; i < data.length; i += 4)
          if (data[i] > 180 && data[i + 1] > 180 && data[i + 2] < 60) yellow++;
        return yellow < limit;
      },
      settings.menuYellowPixels / 2,
      { timeout: 30000 },
    );
    const restored = await snapshot();
    await page
      .locator('#desktop')
      .screenshot({ path: 'evidence/raytraced-shadows-' + mode + '.png' });
    assert.ok(
      restored.menuYellowPixels < settings.menuYellowPixels / 2,
      `F1 hides the settings menu (${settings.menuYellowPixels} -> ${restored.menuYellowPixels})`,
    );
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => window.__lastRun || document.querySelector('#state').textContent === 'ERROR',
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result?.exitCode, 0, 'shader, texture, WGL, window and CRT cleanup completes');
    assert.ok(
      result.instructions > 1000000 && result.compiledBlocks > 1000 && result.wasmBytes > 10000,
    );
    for (const api of [
      'glCreateProgramObjectARB',
      'glCompileShaderARB',
      'glCompressedTexImage2DARB',
      'glTexImage2D',
      'glVertexPointer',
      'glVertexAttribPointerARB',
      'glDrawElements',
      'glDrawArrays',
      'glUniform4fvARB',
      'glMatrixMode',
      'glLoadMatrixf',
      'glBlendFunc',
      'glColorMask',
      'glBegin',
      'glEnd',
      'glDeleteTextures',
      'glDeleteObjectARB',
      'wglDeleteContext',
    ])
      assert.ok(result.apiNames.includes('opengl32.dll!' + api), api + ' executed');
    for (const api of [
      'kernel32.dll!ReadFile',
      'advapi32.dll!RegSetValueExA',
      'user32.dll!DispatchMessageA',
      'gdi32.dll!SwapBuffers',
    ])
      assert.ok(result.apiNames.includes(api));
    const logs = await page.locator('#logs').textContent();
    assert.ok((logs.match(/shader compiled in browser \(success\)/g) || []).length >= 10);
    runs.push({
      mode,
      first,
      animated,
      camera,
      settings,
      restored,
      exitCode: result.exitCode,
      instructions: result.instructions,
      compiledBlocks: result.compiledBlocks,
      wasmBytes: result.wasmBytes,
      apiNames: result.apiNames,
    });
  }
  await upload();
  await page.locator('#run').click();
  await ready(3);
  await page.locator('#stop').click();
  assert.equal(await page.locator('#state').textContent(), 'STOPPED');
  await upload();
  await page.locator('#run').click();
  await ready(3);
  await page.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun);
  assert.equal((await page.evaluate(() => window.__lastRun)).exitCode, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    'evidence/raytraced-shadows-browser-results.json',
    JSON.stringify(
      {
        url,
        exeSha256: hash(exe),
        archiveSha256: hash(zip),
        dependencyAudit,
        runs,
        stopAndReupload: true,
        pageErrors: errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Original Humus OpenGL: all six DLL import tables resolve; textures, physics, shadows, camera, settings, cleanup and Stop/reupload passed.',
  );
} finally {
  await browser.close();
}
