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
  const executable = await readFile('tests/fixtures/dinput-state/dinput-state.exe'),
    results = [];
  for (const [name, mimeType, buffer] of [
    ['dinput-state.exe', 'application/octet-stream', executable],
    [
      'dinput-state.zip',
      'application/zip',
      Buffer.from(zipSync({ 'program/dinput-state.exe': executable })),
    ],
  ]) {
    const page = await browser.newPage(),
      errors = [],
      stages = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const waitTitle = async (title) => {
      await page.waitForFunction(
        (title) =>
          window.__lastRun ||
          document.querySelector('.virtual-desktop-title')?.textContent === title,
        title,
      );
      assert.equal(
        await page.evaluate(() => window.__lastRun),
        null,
        `Guest exited before ${title}: ${JSON.stringify(await page.evaluate(() => window.__lastRun))}`,
      );
      stages.push(title);
    };
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await page.locator('#run').click();
    await waitTitle('Input ready');
    const canvas = page.locator('.virtual-desktop-canvas');
    await canvas.click({ position: { x: 50, y: 50 } });
    await page.keyboard.down('a');
    await page.keyboard.down('ControlRight');
    await waitTitle('Keys down');
    await page.keyboard.up('a');
    await page.keyboard.up('ControlRight');
    await waitTitle('Keys released');
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 74, bounds.y + 62);
    await page.mouse.down({ button: 'right' });
    await waitTitle('Mouse down');
    await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, 120);
    await waitTitle('Input verified');
    await page.keyboard.down('b');
    await page.locator('#stop').focus();
    await waitTitle('Input lost');
    await canvas.click({ position: { x: 100, y: 100 } });
    await waitTitle('Input reacquired');
    await page.keyboard.up('b');
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
      stages,
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
      'Original native PE through ordinary EXE and ZIP upload; standard keyboard/mouse formats, immediate and buffered physical-key states, exact 24/12 relative movement, right button, wheel -120, focus loss and clean reacquisition.',
    results,
  };
  await writeFile(
    'evidence/dinput-state-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
