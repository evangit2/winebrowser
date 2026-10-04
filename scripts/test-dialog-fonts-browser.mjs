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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const path = 'tests/fixtures/dialog-fonts/dialog-fonts.exe';
  await page.locator('#file').setInputFiles(path);
  await page.locator('#run').click();
  const dialog = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Extended resource font verified' }),
  });
  await dialog.getByRole('button', { name: 'Close', exact: true }).waitFor();
  const caption = dialog.getByText('Bold italic resource caption', { exact: true });
  const css = await caption.evaluate((e) => ({
    weight: getComputedStyle(e).fontWeight,
    style: getComputedStyle(e).fontStyle,
    size: getComputedStyle(e).fontSize,
  }));
  assert.deepEqual(css, { weight: '700', style: 'italic', size: '15px' });
  await expect(dialog.getByRole('textbox')).toHaveCSS('font-style', 'italic');
  await dialog.screenshot({ path: 'evidence/dialog-fonts-browser.png' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native A classic and W extended dialog resources create real HFONTs before WM_INITDIALOG; GetObjectW preserves logical height, face, weight, italic and charset',
      'Child WM_GETFONT agrees with the dialog font; actual browser caption and edit use bold italic 15px text',
      'Native MapDialogRect agrees with child position and dimensions and dialog client size; fontless dialogs retain default units',
      'Native GetObjectW rejects resource font handles after DestroyWindow; modal callbacks and closure return exit zero',
    ],
    scope:
      'Resource fonts use host Canvas metrics and font substitution at 96dpi; pixel-identical Windows font rasterization, per-monitor DPI and mixed-font property sheet sizing are not proven.',
  };
  await writeFile(
    'evidence/dialog-fonts-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
        desktop: document.querySelector('#desktop')?.textContent,
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
