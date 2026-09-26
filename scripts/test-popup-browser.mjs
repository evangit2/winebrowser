import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  await page.locator('#file').setInputFiles('tests/fixtures/popup/popup.exe');
  await page.locator('#run').click();
  const first = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('canvas[aria-label="First popup guest display"]') });
  const second = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('canvas[aria-label="Second popup guest display"]') });
  const normal = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('canvas[aria-label="Ordinary window guest display"]') });
  await normal.waitFor({ state: 'visible' });
  const ids = await Promise.all(
    [first, second, normal].map((el) => el.getAttribute('data-window-id')),
  );
  const geometry = await first.evaluate((el) => {
    const outer = el.getBoundingClientRect(),
      client = el.querySelector('.virtual-desktop-canvas').getBoundingClientRect();
    return [
      outer.width,
      outer.height,
      client.x - outer.x,
      client.y - outer.y,
      client.width,
      client.height,
    ];
  });
  assert.deepEqual(geometry, [180, 100, 0, 0, 180, 100]);
  assert.equal(await first.locator('.virtual-desktop-titlebar').isVisible(), false);
  assert.equal(await first.locator('.virtual-desktop-resize').isVisible(), false);
  const overlap = await second.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return [rect.x + 5, rect.y + 5];
  });
  const top = () =>
    page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.closest('.virtual-desktop-window')?.dataset.windowId,
      overlap,
    );
  assert.equal(await top(), ids[1]);
  await normal.locator('.virtual-desktop-canvas').click({ position: { x: 5, y: 5 } });
  assert.equal(await top(), ids[1], 'activating ordinary windows does not cover topmost popups');
  await first.locator('.virtual-desktop-canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('v');
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-window-id="${id}"] .virtual-desktop-title`)?.textContent ===
      'Verified native order',
    ids[0],
  );
  assert.equal(await top(), ids[0]);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__lastRun !== null);
  const result = await page.evaluate(() => window.__lastRun);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(errors, []);
  const executable = await readFile('tests/fixtures/popup/popup.exe');
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    exitCode: result.exitCode,
    borderlessGeometry: geometry,
    topmostOrderAndNativeLookup: true,
    errors,
  };
  await writeFile('evidence/popup-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
