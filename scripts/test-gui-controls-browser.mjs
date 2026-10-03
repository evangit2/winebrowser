import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
let server, browser;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.getByRole('button', { name: 'Load gui-controls', exact: true }).click();
  await page.locator('#run').click();
  const window = page.locator('.virtual-desktop-window'),
    status = window.locator('[data-control-id="22"]'),
    tree = window.getByRole('tree', { name: 'Categories' });
  const reset = 'Choose a category, list item or option.';
  await status.getByText(reset, { exact: true }).waitFor();
  await tree.getByRole('treeitem', { name: 'List box', exact: true }).click();
  await status
    .getByText('ListBox: strings, sorted insertion and selection.', { exact: true })
    .waitFor();
  await window.locator('select[data-control-id="20"]').selectOption({ label: 'Gamma' });
  await status.getByText('Gamma', { exact: true }).waitFor();
  await window.locator('[data-control-id="21"] input').fill('Typed in browser');
  await status.getByText('Typed in browser', { exact: true }).waitFor();
  const checkbox = window.getByRole('checkbox', { name: 'Enable option', exact: true }),
    first = window.getByRole('radio', { name: 'First radio', exact: true }),
    second = window.getByRole('radio', { name: 'Second radio', exact: true });
  await checkbox.click();
  await status.getByText('Checkbox is checked.', { exact: true }).waitFor();
  assert.equal(await checkbox.getAttribute('aria-checked'), 'true');
  await second.click();
  await status
    .getByText('Second radio selected; its group remains exclusive.', { exact: true })
    .waitFor();
  assert.equal(await first.getAttribute('aria-checked'), 'false');
  const canvas = window.locator('canvas[data-control-id="50"]');
  const swatch = () =>
    canvas.evaluate((c) => Array.from(c.getContext('2d').getImageData(12, 12, 1, 1).data));
  await page.waitForFunction(
    () => document.querySelector('canvas[data-control-id="50"]')?.width === 312,
  );
  assert.deepEqual(await swatch(), [28, 110, 210, 255]);
  await window.getByRole('button', { name: 'Change', exact: true }).click();
  await status
    .getByText('Nested button: native child window repainted with GDI.', { exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('canvas[data-control-id="50"]')
        ?.getContext('2d')
        .getImageData(12, 12, 1, 1).data[0] === 230,
  );
  assert.deepEqual(await swatch(), [230, 140, 30, 255]);
  await canvas.click({ position: { x: 30, y: 30 } });
  await status
    .getByText('Custom canvas: mouse input reached its native window procedure.', { exact: true })
    .waitFor();
  await window.getByRole('menuitem', { name: 'Demo', exact: true }).click();
  await window.getByRole('menuitem', { name: 'Reset', exact: true }).click();
  await status.getByText(reset, { exact: true }).waitFor();
  assert.equal(await checkbox.getAttribute('aria-checked'), 'false');
  assert.equal(await first.getAttribute('aria-checked'), 'true');
  await page.waitForFunction(
    () =>
      document
        .querySelector('canvas[data-control-id="50"]')
        ?.getContext('2d')
        .getImageData(12, 12, 1, 1).data[0] === 28,
  );
  await mkdir('.scratch', { recursive: true });
  await window.screenshot({ path: '.scratch/gui-controls-showcase.png' });
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0);
  await page.locator('#file').setInputFiles('public/examples/gui-controls/gui-controls.zip');
  await page.locator('#run').click();
  await status.getByText(reset, { exact: true }).waitFor();
  await page.locator('#stop').click();
  await window.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  const manifest = JSON.parse(
    await readFile('public/examples/manifest.json', 'utf8'),
  ).interactive.find((e) => e.name === 'gui-controls');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exeSha256: manifest.exeSha256,
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Public EXE loads from Pages examples; original x86 callbacks run in the browser',
      'Tree category, sorted list, editable combo, checkbox and radio interactions',
      'Native registered child canvas, nested button command, independent GDI repaint and mouse callback',
      'Native menu Reset restores control state; close exits zero',
      'Public source/license ZIP package runs and Stop removes its window',
    ],
    scope:
      'Original MIT WineBrowser Win32 showcase, separate from upstream applications. This exercises the supported controls; no universal GUI/DLL compatibility claim.',
  };
  await writeFile(
    'evidence/gui-controls-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
