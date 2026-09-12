import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.getElementById('platform')?.textContent === 'ISOLATED / WASM READY',
  );
  await page.locator('[data-demo="breakout"]').click();
  await page.locator('#run').click();
  const windows = page.locator('.virtual-desktop-window:visible');
  await windows.nth(1).waitFor();
  const game = windows
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: 'Breakout' }) })
    .first();
  const canvas = game.locator('canvas');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.virtual-desktop-window canvas')].some(
      (c) =>
        c.width > 300 &&
        c
          .getContext('2d')
          .getImageData(0, 0, c.width, c.height)
          .data.some((v, i) => i % 4 !== 3 && v !== 0),
    ),
  );
  const pixels = async () =>
    canvas.evaluate(async (c) => {
      const bytes = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join('');
    });
  const first = await pixels();
  await page.waitForTimeout(200);
  assert.notDeepEqual(await pixels(), first, 'Guest timer animates the game');
  await canvas.click({ position: { x: 100, y: 180 } });
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  const paused = await pixels();
  await page.waitForTimeout(160);
  assert.deepEqual(await pixels(), paused, 'Space pauses guest timer movement');
  await canvas.hover({ position: { x: 300, y: 180 } });
  await page.waitForFunction(() => {
    const c = document.querySelector('.virtual-desktop-canvas');
    const p = c.getContext('2d').getImageData(264, 300, 1, 1).data;
    return p[0] === 60 && p[1] === 190 && p[2] === 140;
  });
  await page.keyboard.press('r');
  await page.keyboard.down('ArrowLeft');
  await page.waitForFunction(() => {
    const c = document.querySelector('.virtual-desktop-canvas');
    const p = c.getContext('2d').getImageData(188, 300, 1, 1).data;
    return p[0] === 60 && p[1] === 190 && p[2] === 140;
  });
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.press('Space');
  const box = await game.boundingBox(),
    bar = game.locator('.virtual-desktop-titlebar');
  const barBox = await bar.boundingBox();
  await page.mouse.move(barBox.x + 80, barBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(barBox.x + 120, barBox.y + 42);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const moved = await game.boundingBox();
  assert.equal(Math.round(moved.x - box.x), 40);
  assert.equal(Math.round(moved.y - box.y), 30);
  const sizeBefore = await canvas.evaluate((c) => [c.width, c.height]);
  const resize = game.locator('.virtual-desktop-resize');
  await resize.scrollIntoViewIfNeeded();
  const handle = await resize.boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 45, handle.y + 35);
  await page.mouse.up();
  await page.waitForFunction(
    ([w, h]) =>
      [...document.querySelectorAll('.virtual-desktop-window canvas')].some(
        (c) => c.width === w + 40 && c.height === h + 30,
      ),
    sizeBefore,
  );
  // Each Close must be handled by the EXE's WndProc before the UI removes it.
  await mkdir('evidence', { recursive: true });
  await page.locator('#desktop').screenshot({ path: 'evidence/windows-browser.png' });
  await windows.first().locator('.virtual-desktop-close').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.virtual-desktop-window').length === 1,
  );
  assert.equal(await page.locator('#state').textContent(), 'RUNNING');
  await windows.first().locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  assert.equal(await page.evaluate(() => window.__lastRun.exitCode), 0);
  assert.equal(await windows.count(), 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    nativeGame: 'breakout',
    windows: 2,
    animation: true,
    keyboardPause: true,
    mousePaddle: true,
    keyboardPaddle: true,
    drag: true,
    resize: true,
    guestClose: true,
    exitCode: 0,
    errors,
  };
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/windows-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
