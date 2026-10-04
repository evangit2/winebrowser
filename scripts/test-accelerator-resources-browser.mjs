import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
let server, browser, page;
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page
    .locator('#file')
    .setInputFiles('tests/fixtures/accelerator-resources/accelerator-resources.exe');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native accelerator resources' }),
  });
  await owner.getByText('Native keyboard shortcuts ready', { exact: true }).waitFor();
  const canvas = owner.locator('.virtual-desktop-canvas').first();
  await canvas.focus();
  await canvas.press('x');
  await owner.getByText('Character accelerator received', { exact: true }).waitFor();
  await canvas.press('Control+a');
  await owner.getByText('Control accelerator received', { exact: true }).waitFor();
  await canvas.press('Alt+Shift+z');
  await owner.getByText('Final accelerator received', { exact: true }).waitFor();
  await owner.screenshot({ path: 'evidence/accelerator-resources-browser.png' });
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  assert.equal(run.outputs.length, 0);
  assert.ok(run.compiledBlocks > 0);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/accelerator-resources/accelerator-resources.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Real windres PE accelerator table loads all entries, including a zero-flag initial character shortcut and final marked shortcut',
      'Character, Ctrl virtual-key and Alt+Shift virtual-key accelerators invoke native WM_COMMAND with accelerator notification',
      'ANSI/Unicode resource loads share the table and the unchanged native fixture exits zero',
    ],
    scope:
      'Authored native resource regression; menu-state accelerator suppression and arbitrary editor workflows remain unverified.',
  };
  await writeFile(
    'evidence/accelerator-resources-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun && {
          error: window.__lastRun.error,
          exitCode: window.__lastRun.exitCode,
          trace: window.__lastRun.apiTrace?.slice(-20),
        },
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
