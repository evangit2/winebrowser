import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// Verifies the D3D12 constant-buffer path end to end: an upload-heap buffer, a
// CBV recorded with CreateConstantBufferView into a shader-visible heap, a CBV
// descriptor range in the root signature, and SetGraphicsRootDescriptorTable.
// The demo rotates a cube from the constant-buffer matrix, so the image must
// contain face colours and change between frames without any vertex re-upload.
const demo = 'd3d12-constbuffer';
// The six tinted cube faces from this demo's vertex data. A vertex colour is a
// float the rasteriser quantises to RGBA8, so a face can land one unit away
// from the value the source literal implies; matching allows for that.
const FACE_COLOURS = ['230,102,84', '92,196,240', '242,194,48', '64,209,97', '171,87,232', '240,117,43'];
const channel = (value) => Number(value);
const matchFace = (colour) => {
  const [r, g, b] = colour.split(',').map(channel);
  return FACE_COLOURS.find((face) => {
    const [fr, fg, fb] = face.split(',').map(channel);
    return Math.abs(fr - r) <= 2 && Math.abs(fg - g) <= 2 && Math.abs(fb - b) <= 2;
  });
};
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
  assert.ok(fixture, 'd3d12-texture is not in the demo catalog');
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
      canvas.evaluate(async (element) => {
        const pixels = element
          .getContext('2d')
          .getImageData(0, 0, element.width, element.height).data;
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        const counts = new Map();
        for (let i = 0; i < pixels.length; i += 4) {
          const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return {
          width: element.width,
          height: element.height,
          counts: [...counts.entries()].sort((a, b) => b[1] - a[1]),
          hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
        };
      });
    const first = await sample();
    // The cube yaws and pitches, so a single instant shows one to three faces.
    // Sampling across a full turn proves every face is drawn from the
    // constant-buffer transform rather than the image merely changing.
    const seen = new Set();
    let last = first;
    for (let i = 0; i < 8; i++) {
      for (const [colour, count] of last.counts) {
        if (count <= 200 || colour === '9,17,36') continue;
        const face = matchFace(colour);
        if (face) seen.add(face);
      }
      await page.waitForTimeout(1800);
      last = await sample();
    }
    const visible = FACE_COLOURS.filter((colour) => seen.has(colour));
    assert.equal(
      visible.length,
      FACE_COLOURS.length,
      `expected all ${FACE_COLOURS.length} tinted cube faces across a rotation, saw ${[...seen].join(' ')}`,
    );
    assert.ok(last.hash !== first.hash, 'the rotating cube did not change between frames');
    runs.push({
      mode,
      firstFourFramesMs,
      width: first.width,
      height: first.height,
      facePixels: Object.fromEntries(
        FACE_COLOURS.map((c) => [c, first.counts.find(([k]) => k === c)?.[1] ?? 0]),
      ),
      visibleFaces: visible.length,
      first,
      second: last,
    });
    await page.locator('#stop').click().catch(() => {});
  }

  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/d3d12-constbuffer-browser.json',
    JSON.stringify(
      {
        scope:
          'D3D12 constant-buffer cube: upload-heap CBV through a descriptor table, on the EXE-upload and hosted-ZIP paths',
        url,
        browser: browser.version(),
        exeSha256: fixture.exeSha256,
        zipSha256: fixture.zipSha256,
        faceColours: FACE_COLOURS,
        runs,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ runs: runs.map((r) => ({ mode: r.mode, visibleFaces: r.visibleFaces, facePixels: r.facePixels })) }, null, 1));
} finally {
  await browser?.close();
}
