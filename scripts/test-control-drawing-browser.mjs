import { selectNativeCombo } from './lib/native-combo-input.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
let browser, server, page;
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/control-drawing/control-drawing.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    label = root.locator('[data-control-id="70"]'),
    edit = root.locator('input[data-control-id="71"]'),
    button = root.locator('button[data-control-id="72"]'),
    combo = root.locator('[data-control-id="73"]');
  const title = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.virtual-desktop-title')?.textContent === text,
      text,
    );
  const overlay = (control) =>
    control
      .locator('..')
      .locator(':scope > .virtual-desktop-control-client > .virtual-desktop-control-drawing');
  const pixel = (control, x = 10, y = 10) =>
    overlay(control).evaluate(
      (c, [x, y]) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data),
      [x, y],
    );
  await title('Drawing ready');
  await expect(overlay(label)).toHaveCount(1);
  assert.deepEqual(await pixel(label), [24, 100, 200, 255]);
  assert.deepEqual(await pixel(edit), [200, 80, 24, 255]);
  assert.deepEqual(await pixel(button), [30, 150, 80, 255]);
  assert.deepEqual(await pixel(combo), [160, 40, 100, 255]);
  assert.deepEqual(
    await pixel(edit, 50, 10),
    [0, 0, 0, 0],
    'untouched native text remains visible',
  );
  assert.equal(await edit.inputValue(), 'native edit');
  const geometry = await overlay(edit).evaluate((c) => ({
    width: c.width,
    height: c.height,
    rect: c.getBoundingClientRect().toJSON(),
    input: c.parentElement.parentElement.querySelector('input').getBoundingClientRect().toJSON(),
  }));
  assert.equal(geometry.width, 296);
  assert.equal(geometry.height, 36);
  assert.equal(geometry.rect.x, geometry.input.x + 2);
  assert.equal(geometry.rect.y, geometry.input.y + 2);
  assert.equal(geometry.rect.width, 296);
  assert.equal(geometry.rect.height, 36);
  const textPixels = await overlay(label).evaluate((c) => {
    const pixels = c.getContext('2d').getImageData(60, 34, 160, 20).data;
    let count = 0,
      soft = 0;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]) count++;
      if (pixels[i] > 0 && pixels[i] < 255) soft++;
    }
    return { count, soft };
  });
  assert.ok(textPixels.count > 50);
  assert.ok(textPixels.soft > 0, 'transparent text retains antialias alpha');
  // Click inside the actual opaque GDI rectangle, proving it cannot capture input.
  await button.click({ position: { x: 10, y: 10 } });
  await title('Clicked through drawing');
  await selectNativeCombo(combo, { index: 1 });
  await title('Combo selection through drawing');
  await edit.fill('typed');
  await title('Typed through drawing');
  await expect(edit).toHaveValue('typed');
  await root.getByRole('button', { name: 'Nested child', exact: true }).click();
  await title('Nested child clicked');
  await root.getByRole('button', { name: 'Clear drawing', exact: true }).click();
  await title('Drawing cleared');
  for (const control of [label, edit, button, combo])
    assert.deepEqual(await pixel(control), [0, 0, 0, 0]);
  await root.getByRole('button', { name: 'Draw directly', exact: true }).click();
  await title('Direct drawing restored');
  assert.deepEqual(await pixel(label), [24, 100, 200, 255]);
  assert.deepEqual(await pixel(edit), [200, 80, 24, 255]);
  await root.getByRole('button', { name: 'Partial repaint', exact: true }).click();
  await title('Partial repaint');
  assert.deepEqual(await pixel(label), [0, 0, 0, 0]);
  assert.deepEqual(await pixel(label, 30, 10), [24, 100, 200, 255]);
  await root.getByRole('button', { name: 'Resize drawing', exact: true }).click();
  await title('Drawing resized');
  await expect(overlay(label)).toHaveAttribute('width', '360');
  await expect(overlay(label)).toHaveAttribute('height', '80');
  assert.deepEqual(await pixel(label), [24, 100, 200, 255]);
  assert.deepEqual(await pixel(label, 350, 75), [0, 0, 0, 0]);
  await root.getByRole('button', { name: 'Recreate control', exact: true }).click();
  await title('Drawing recreated');
  assert.deepEqual(await pixel(label), [24, 100, 200, 255]);
  await expect(overlay(label)).toHaveCount(1);
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/control-drawing-gui.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const digest = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await digest('tests/fixtures/control-drawing/control-drawing.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native GetDC/FillRect/GetPixel on standard STATIC, EDIT, BUTTON and COMBOBOX produce visible independent RGBA client overlays',
      'Bordered edit canvas has real client dimensions/insets; untouched content remains transparent; native TextOut preserves antialias alpha',
      'Opaque drawing passes button clicks, edit input and combo selection; nested child HWND remains interactive above parent drawing',
      'Direct drawing outside WM_PAINT, default/partial repaint, retained HDC across WM_CTLCOLOR and transparent restoration',
      'SetWindowPos resizes backing bitmap; destroyed/recreated HWND has no stale overlay or DC; native exit zero',
    ],
    scope:
      'Visible guest GDI on browser controls. Reading or source-copying uncovered browser-painted pixels fails explicitly with error120; exact native control rasterization, scrolling, native caret/IME and universal GUI/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/control-drawing-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
