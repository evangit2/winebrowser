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
  const executable = await readFile('tests/fixtures/window-position/window-position.exe');
  const results = [];
  for (const [name, mimeType, buffer] of [
    ['window-position.exe', 'application/octet-stream', executable],
    [
      'window-position.zip',
      'application/zip',
      Buffer.from(zipSync({ 'program/window-position.exe': executable })),
    ],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await page.locator('#run').click();
    const window = page.locator('.virtual-desktop-window').first();
    const front = page.getByText('Front child', { exact: true });
    const back = page.getByText('Back child', { exact: true });
    await back.waitFor({ state: 'visible' });
    const geometry = () =>
      window.evaluate((element) => {
        const bounds = element.getBoundingClientRect(),
          parent = element.parentElement.getBoundingClientRect();
        return [
          parseFloat(element.style.left),
          parseFloat(element.style.top),
          bounds.width,
          bounds.height,
          bounds.x - parent.x - element.parentElement.clientLeft,
          bounds.y - parent.y - element.parentElement.clientTop,
        ];
      });
    const before = await geometry();
    assert.deepEqual(before.slice(0, 4), [40, 50, 320, 240]);
    const top = () =>
      back.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + 10, rect.y + 10)?.textContent;
      });
    assert.equal(await top(), 'Front child');
    await window.locator('canvas.virtual-desktop-canvas').click({ position: { x: 250, y: 190 } });
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => document.querySelector('.virtual-desktop-title')?.textContent === 'Position moved',
    );
    const after = await geometry();
    assert.deepEqual(after.slice(0, 4), [60, 70, 360, 260]);
    assert.equal(await top(), 'Back child');
    const childBounds = await back.evaluate((element) => {
      const r = element.parentElement.getBoundingClientRect();
      return [r.width, r.height];
    });
    assert.deepEqual(childBounds, [140, 50]);
    await page.keyboard.press('h');
    await page.waitForFunction(
      () => document.querySelector('.virtual-desktop-title')?.textContent === 'Position hidden',
    );
    assert.equal(await back.isVisible(), false);
    assert.equal(await front.isVisible(), true);
    await page.keyboard.press('z');
    await page.waitForFunction(
      () =>
        document.querySelector('.virtual-desktop-title')?.textContent ===
        'Position activated behind',
    );
    const topAfterActivation = await page
      .locator('canvas[aria-label="Activation peer guest display"]')
      .evaluate((el) => {
        const box = el.getBoundingClientRect();
        return document.elementFromPoint(box.x + 10, box.y + 10)?.getAttribute('aria-label');
      });
    assert.equal(
      topAfterActivation,
      'Activation peer guest display',
      'native activation preserves explicit sibling placement',
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(errors, []);
    results.push({
      name,
      exitCode: result.exitCode,
      instructions: result.instructions,
      compiledBlocks: result.compiledBlocks,
      before,
      after,
      childBounds,
      errors,
    });
    await page.close();
  }
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Native PE32 through ordinary EXE and ZIP upload; native SetWindowPos callbacks, mutable WINDOWPOS, frame recalculation, topmost transitions, interactive geometry and child stacking/hiding verified in DOM hit testing.',
    results,
  };
  await writeFile(
    'evidence/window-position-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
