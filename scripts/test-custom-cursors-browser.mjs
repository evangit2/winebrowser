import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const exe = await readFile('tests/fixtures/custom-cursors/cursors.exe'),
    dll = await readFile('tests/fixtures/custom-cursors/cursors.dll'),
    runs = [];
  for (const zip of [false, true]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    const file = (name, buffer) => ({ name, mimeType: 'application/octet-stream', buffer });
    await page
      .locator('#file')
      .setInputFiles(
        zip
          ? [
              file(
                'cursors.zip',
                Buffer.from(zipSync({ 'game/cursors.exe': exe, 'game/cursors.dll': dll })),
              ),
            ]
          : [file('cursors.exe', exe), file('cursors.dll', dll)],
      );
    await page.locator('#run').click();
    const canvas = page.locator('.virtual-desktop-canvas').first();
    await canvas.waitFor();
    await canvas.click({ position: { x: 20, y: 20 } });
    const observed = [];
    for (const [key, kind, hot] of [
      ['1', 'mono', [3, 5]],
      ['2', 'four', [3, 5]],
      ['3', 'eight', [3, 5]],
      ['4', 'truecolor', [3, 5]],
      ['5', 'alpha', [3, 5]],
      ['6', 'four', [5, 7]],
      ['7', 'blank', [0, 0]],
      ['8', 'small', [4, 6]],
      ['D', 'eight', [3, 5]],
    ]) {
      const previous = await canvas.evaluate((e) => getComputedStyle(e).cursor);
      await page.keyboard.press(key);
      if (key !== '1')
        await page.waitForFunction(
          (old) =>
            getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor !== old,
          previous,
        );
      await page.waitForFunction(() =>
        getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor.startsWith(
          'url(',
        ),
      );
      const result = await canvas.evaluate(
        async (e, { kind, hot }) => {
          const css = getComputedStyle(e).cursor,
            match = /url\("?(data:image\/png;base64,[^"\)]+)"?\) (\d+) (\d+), default/.exec(css);
          if (!match) throw Error('Missing native image cursor: ' + css);
          if (+match[2] !== hot[0] || +match[3] !== hot[1]) throw Error('Wrong hotspot: ' + css);
          const image = new Image();
          image.src = match[1];
          await image.decode();
          if (image.width !== 32 || image.height !== 32) throw Error('Wrong cursor size');
          const bitmap = document.createElement('canvas');
          bitmap.width = 32;
          bitmap.height = 32;
          const context = bitmap.getContext('2d');
          context.drawImage(image, 0, 0);
          const data = context.getImageData(0, 0, 32, 32).data;
          let bad = 0;
          for (let y = 0; y < 32; y++)
            for (let x = 0; x < 32; x++) {
              const sx = kind === 'small' ? Math.floor(x / 2) : x,
                sy = kind === 'small' ? Math.floor(y / 2) : y;
              let expected;
              if (kind === 'blank' || sx === 0 || sy === 0) expected = [0, 0, 0, 0];
              else if (kind === 'mono')
                expected = [
                  ...Array(3).fill((Math.floor(sx / 8) + Math.floor(sy / 8)) % 2 ? 255 : 0),
                  255,
                ];
              else if (kind === 'four' || kind === 'small')
                expected = [
                  ...[
                    [255, 0, 0],
                    [0, 255, 0],
                    [0, 0, 255],
                  ][(Math.floor(sx / 8) + Math.floor(sy / 8)) % 3],
                  255,
                ];
              else if (kind === 'eight') {
                const n = ((sx + 3 * sy) % 255) + 1;
                expected = [n, 255 - n, (3 * n) % 256, 255];
              } else if (kind === 'truecolor')
                expected = [(sx * 7) % 256, (sy * 5) % 256, ((sx + sy) * 3) % 256, 255];
              else expected = sx < 16 ? [255, 0, 0, 128] : [0, 255, 0, 255];
              if (expected.some((n, c) => data[(y * 32 + x) * 4 + c] !== n)) bad++;
            }
          if (bad) throw Error(kind + ': incorrect cursor pixels ' + bad);
          return { kind, hotspot: hot, pixels: 1024, bad };
        },
        { kind, hot },
      );
      observed.push(result);
      await canvas.hover({ position: { x: 30, y: 30 } });
    }
    const custom = await canvas.evaluate((e) => getComputedStyle(e).cursor);
    await page.keyboard.press('h');
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor === 'none',
    );
    await page.keyboard.press('s');
    await page.waitForFunction(
      (css) => getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor === css,
      custom,
    );
    await page.keyboard.press('n');
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor === 'none',
    );
    await page.keyboard.press('r');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor.startsWith('url('),
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(errors, []);
    runs.push({
      package: zip ? 'ZIP' : 'EXE and DLL',
      observed,
      exitCode: result.exitCode,
      instructions: result.instructions,
      errors,
    });
    await page.close();
  }
  const validationPage = await browser.newPage();
  await validationPage.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  await validationPage.evaluate(async () => {
    const { VirtualDesktop } = await import('/src/desktop.js');
    const container = document.querySelector('#desktop'),
      desktop = new VirtualDesktop(container);
    const image = { width: 32, height: 32, hotX: 3, hotY: 5, pixels: new Uint8Array(4096) };
    for (let i = 0; i < 4096; i += 4) {
      image.pixels[i] = 255;
      image.pixels[i + 3] = 255;
    }
    desktop.setCursor(image, 0x63000000);
    const old = container.style.getPropertyValue('--guest-cursor');
    for (const bad of [
      { width: 33 },
      { height: 0 },
      { hotX: 0x100000000 },
      { hotY: -1 },
      { hotX: 0.5 },
      { pixels: new Uint8Array(4) },
    ]) {
      let failed = false;
      try {
        desktop.setCursor({ ...image, ...bad }, 0x63000000);
      } catch {
        failed = true;
      }
      if (!failed || container.style.getPropertyValue('--guest-cursor') !== old)
        throw Error('Malformed cursor changed CSS');
    }
    for (const handle of [0, 0x63000001, 0x100000000]) {
      let failed = false;
      try {
        desktop.setCursor(image, handle);
      } catch {
        failed = true;
      }
      if (!failed) throw Error('Invalid image handle accepted');
    }
    // Native owned images may have hotspots outside the bitmap and handles
    // issued after earlier images were released. They use a positioned overlay.
    desktop.setCursor({ ...image, hotX: 39, hotY: 47 }, 0x62000400);
    if (
      container.style.getPropertyValue('--guest-cursor') !== 'none' ||
      document.querySelectorAll('[data-native-cursor]').length !== 1
    )
      throw Error('Native offset cursor was rejected');
    desktop.reset();
    if (
      container.style.getPropertyValue('--guest-cursor') ||
      desktop.cursorImages.size ||
      document.querySelectorAll('[data-native-cursor]').length
    )
      throw Error('Cursor cache survived reset');
    for (let i = 0; i < 4096; i += 4) {
      image.pixels[i] = 0;
      image.pixels[i + 2] = 255;
    }
    desktop.setCursor(image, 0x63000000);
    if (container.style.getPropertyValue('--guest-cursor') === old)
      throw Error('Reused handle retained stale cursor image');
    desktop.reset();
  });
  await validationPage.close();
  const report = {
    passed: true,
    desktopImageValidation: true,
    browser: browser.version(),
    date: new Date().toISOString(),
    exeSha256: createHash('sha256').update(exe).digest('hex'),
    dllSha256: createHash('sha256').update(dll).digest('hex'),
    runs,
  };
  await writeFile(
    'evidence/custom-cursors-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
