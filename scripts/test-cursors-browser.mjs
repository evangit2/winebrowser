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
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('#file').setInputFiles('tests/fixtures/cursors/cursors.exe');
  await page.locator('#run').click();
  const canvas = page.locator('.virtual-desktop-canvas').first();
  await canvas.waitFor();
  const observed = [];
  async function cursor(expected) {
    await page.waitForFunction(
      (value) =>
        getComputedStyle(document.querySelector('.virtual-desktop-canvas')).cursor === value,
      expected,
    );
    observed.push(await canvas.evaluate((el) => getComputedStyle(el).cursor));
  }
  await canvas.click({ position: { x: 10, y: 10 } });
  await cursor('pointer');
  await page.keyboard.press('w');
  await cursor('wait');
  await canvas.hover({ position: { x: 20, y: 20 } });
  await cursor('wait');
  await page.keyboard.press('h');
  await cursor('none');
  await page.keyboard.press('h');
  await page.keyboard.press('s');
  await cursor('none');
  await page.keyboard.press('s');
  await cursor('wait');
  await page.keyboard.press('n');
  await cursor('none');
  await page.keyboard.press('r');
  await cursor('pointer');
  await page.locator('.virtual-desktop-titlebar button').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const result = await page.evaluate(() => window.__lastRun);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(errors, []);
  const data = await readFile('tests/fixtures/cursors/cursors.exe');
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    exeSha256: createHash('sha256').update(data).digest('hex'),
    browser: browser.version(),
    observed,
    exitCode: result.exitCode,
    errors,
  };
  await writeFile('evidence/cursors-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
