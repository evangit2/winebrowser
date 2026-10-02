import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const root = '.cache/opengl-upstream/';
const provenance = JSON.parse(await readFile(root + 'provenance.json', 'utf8'));
for (const [name, expected] of [
  ['3DAnimation.exe', provenance.exeSha256],
  ['glew32.dll', provenance.dllSha256],
]) {
  assert.equal(
    createHash('sha256')
      .update(await readFile(root + name))
      .digest('hex'),
    expected,
  );
}
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
  const runs = [];
  for (const mode of ['multi-file', 'zip']) {
    await page
      .locator('#file')
      .setInputFiles(
        mode === 'zip' ? root + '3DAnimation.zip' : [root + '3DAnimation.exe', root + 'glew32.dll'],
      );
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    await page.locator('#run').click();
    await page.waitForFunction(
      () => {
        if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
          throw Error(document.querySelector('#output').textContent);
        return (
          Number(document.querySelector('[data-graphics-api="opengl"]')?.dataset.graphicsFrames) >=
          8
        );
      },
      null,
      { timeout: 90000 },
    );
    const canvas = page.locator('[data-graphics-api="opengl"]');
    const snapshot = () =>
      canvas.evaluate(async (c) => {
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let colored = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            Math.max(data[i], data[i + 1], data[i + 2]) -
              Math.min(data[i], data[i + 1], data[i + 2]) >
            40
          )
            colored++;
        return {
          frames: Number(c.dataset.graphicsFrames),
          draws: Number(c.dataset.graphicsDraws),
          colored,
          hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join(''),
        };
      });
    const first = await snapshot();
    assert.ok(first.colored > 10000 && first.draws >= 16, 'original pyramid and cube render');
    await page.waitForFunction(
      (n) =>
        Number(document.querySelector('[data-graphics-api="opengl"]')?.dataset.graphicsFrames) >= n,
      first.frames + 10,
    );
    const animated = await snapshot();
    assert.notEqual(animated.hash, first.hash, 'original application animates its transforms');
    await page
      .locator('#desktop')
      .screenshot({ path: 'evidence/opengl-upstream-' + mode + '.png' });
    await page.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => window.__lastRun || document.querySelector('#state').textContent === 'ERROR',
    );
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result?.exitCode, 0, 'unchanged application and native GLEW CRT exit cleanly');
    assert.ok(result.instructions > 100000 && result.wasmBytes > 1000);
    for (const name of [
      'wglGetProcAddress',
      'glGetStringi',
      'glCompileShader',
      'glUniformMatrix4fv',
      'glDrawArrays',
      'glDeleteProgram',
      'wglDeleteContext',
    ])
      assert.ok(result.apiNames.includes('opengl32.dll!' + name));
    const logs = await page.locator('#logs').textContent();
    assert.match(logs, /OpenGL GLSL vertex shader compiled in browser \(success\)/);
    assert.match(logs, /OpenGL GLSL fragment shader compiled in browser \(success\)/);
    const renderLog = result.outputs.find((x) => x.path.endsWith('renderlog.txt'));
    assert.match(Buffer.from(renderLog.bytes).toString(), /Program Completed Successfully/);
    runs.push({
      mode,
      first,
      animated,
      exitCode: result.exitCode,
      compiledBlocks: result.compiledBlocks,
      wasmBytes: result.wasmBytes,
      instructions: result.instructions,
      apiNames: result.apiNames,
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    'evidence/opengl-upstream-browser-results.json',
    JSON.stringify({ url, provenance, runs, pageErrors: errors }, null, 2) + '\n',
  );
  console.log(
    'Unchanged published OpenGL EXE + native GLEW: multi-file and ZIP uploads, animation, browser shader compilation and clean exit passed.',
  );
} finally {
  await browser.close();
}
