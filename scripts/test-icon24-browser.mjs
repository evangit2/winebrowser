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
  await page.locator('#file').setInputFiles('tests/fixtures/icon24/icon24.exe');
  await page.locator('#run').click();
  const canvas = page.locator('.virtual-desktop-window-icon');
  await canvas.waitFor({ state: 'visible' });
  const pixels = await canvas.evaluate((el) => ({
    width: el.width,
    height: el.height,
    data: [...el.getContext('2d').getImageData(0, 0, el.width, el.height).data],
  }));
  assert.deepEqual([pixels.width, pixels.height], [32, 32]);
  const expected = [];
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      expected.push(
        ...(x === 0 || y === 0 || x === 31 || y === 31
          ? [0, 0, 0, 0]
          : [x * 7, y * 7, x * 3 + y, 255]),
      );
  assert.deepEqual(pixels.data, expected);
  await page.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const result = await page.evaluate(() => window.__lastRun);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(errors, []);
  const executable = await readFile('tests/fixtures/icon24/icon24.exe');
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    exitCode: result.exitCode,
    width: pixels.width,
    height: pixels.height,
    checkedPixels: pixels.data.length / 4,
    rgbaSha256: createHash('sha256').update(Uint8Array.from(pixels.data)).digest('hex'),
    errors,
  };
  await writeFile('evidence/icon24-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
