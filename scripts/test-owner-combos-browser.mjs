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
  await page.locator('#file').setInputFiles('tests/fixtures/owner-combos/owner-combos.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window');
  const title = async (text) => {
    await page.waitForFunction(
      (text) =>
        document.querySelector('.virtual-desktop-title')?.textContent === text ||
        window.__lastRun !== null ||
        document.querySelector('#state')?.textContent === 'ERROR',
      text,
    );
    const early = await page.evaluate(() => ({
      exitCode: window.__lastRun?.exitCode,
      state: document.querySelector('#state')?.textContent,
    }));
    assert.ok(early.exitCode === undefined && early.state !== 'ERROR', JSON.stringify(early));
    await expect(root.locator('.virtual-desktop-title')).toHaveText(text);
  };
  const pixel = (control, x = 8, y = 10) =>
    control
      .locator('..')
      .locator('canvas.virtual-desktop-control-drawing')
      .evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
  await title('Owner combos ready');
  const combos = root.locator('[data-control-type="combobox"]');
  await expect(combos).toHaveCount(3);
  const raw = root.getByRole('combobox', { name: 'Raw colors', exact: true }),
    editable = root.getByRole('combobox', { name: 'Editable colors', exact: true }),
    simple = root.getByRole('combobox', { name: 'Simple colors', exact: true });
  const popup = async (combo) =>
    page.locator(
      `[role="listbox"][data-parent-id="${await combo.getAttribute('data-window-id')}"]`,
    );
  const rawList = await popup(raw),
    editList = await popup(editable),
    simpleList = await popup(simple);
  const nativeEdit = (combo) => combo.locator('..').locator('input');
  assert.deepEqual(await pixel(raw), [24, 100, 200, 255]);
  assert.deepEqual(
    await pixel(raw, 205, 10),
    [0, 0, 0, 0],
    'native selected-item drawing leaves the browser arrow uncovered',
  );
  assert.deepEqual(await pixel(simpleList, 8, 40), [200, 110, 20, 255]);
  await expect(nativeEdit(editable)).toHaveValue('Wide λ');
  await root.getByRole('button', { name: 'Show raw popup', exact: true }).click();
  await title('Raw popup visible');
  await expect(rawList).toBeVisible();
  const bounds = await rawList.boundingBox(),
    parent = await root.boundingBox();
  assert.ok(
    bounds.y + bounds.height > parent.y + parent.height,
    'native popup extends outside parent',
  );
  await expect.poll(() => pixel(rawList, 8, 42)).toEqual([24, 100, 200, 255]);
  await expect.poll(() => pixel(rawList, 8, 110)).toEqual([255, 255, 255, 255]);
  await page.locator('.virtual-desktop').screenshot({ path: '.scratch/owner-combos-popup.png' });
  await rawList.getByRole('option').nth(2).click();
  await title('Raw accepted');
  await expect(rawList).toBeHidden();
  await expect(raw).toHaveAttribute('aria-expanded', 'false');
  await raw.press('F4');
  await expect(rawList).toBeVisible();
  await raw.press('ArrowUp');
  await title('Raw selection');
  await expect.poll(() => pixel(rawList, 8, 38)).toEqual([200, 40, 60, 255]);
  await expect.poll(() => pixel(rawList, 8, 62)).toEqual([255, 210, 20, 255]);
  await raw.press('Escape');
  await title('Popup cancelled');
  await expect(rawList).toBeHidden();
  await raw.click({ position: { x: 8, y: 10 } });
  await expect(rawList).toBeVisible();
  await root.locator('.virtual-desktop-title').click();
  await expect(rawList).toBeHidden();
  await expect(raw).toHaveAttribute('aria-expanded', 'false');
  await editable.getByRole('button').click();
  await expect(editList).toBeVisible();
  await expect.poll(() => pixel(editList, 8, 42)).toEqual([30, 150, 80, 255]);
  await editList.getByRole('option').nth(1).click();
  await title('Variable accepted');
  await expect(nativeEdit(editable)).toHaveValue('Wide Ω');
  await nativeEdit(editable).fill('Typed λ');
  await title('Editable changed');
  await simpleList.getByRole('option').nth(1).click();
  await title('Simple selection');
  await expect(nativeEdit(simple)).toHaveValue('Wide Ω');
  await page.locator('.virtual-desktop').screenshot({ path: 'evidence/owner-combos-browser.png' });
  await root.getByRole('button', { name: 'Disable combo', exact: true }).click();
  await title('Combo disabled');
  await expect.poll(() => pixel(raw)).toEqual([110, 110, 110, 255]);
  await root.getByRole('button', { name: 'Enable combo', exact: true }).click();
  await title('Combo enabled');
  await root.getByRole('button', { name: 'Resize editable combo', exact: true }).click();
  await title('Combo resized');
  await expect(nativeEdit(editable)).toHaveCSS('height', '32px');
  await root.getByRole('button', { name: 'Set native edit text', exact: true }).click();
  await title('Native edit setter');
  await expect(nativeEdit(editable)).toHaveValue('Program λ');
  await root.getByRole('button', { name: 'Reset raw combo', exact: true }).click();
  await title('Raw reset');
  await root.getByRole('button', { name: 'Destroy simple combo', exact: true }).click();
  await title('Simple destroyed');
  await expect(combos).toHaveCount(2);
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
    exeSha256: await digest('tests/fixtures/owner-combos/owner-combos.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged ANSI/Unicode PE32 owner-drawn combos compile and execute inside Chromium',
      'Native text/row measurement, sorted raw data, Unicode, real edit/list HWNDs, list subclass, clipped drawing and lifecycle assertions pass',
      'Real pixels confirm selection, focus, disabled colors, variable rows and popup outside its parent',
      'Mouse/keyboard selection, F4, Escape, editable input, native text setters, resize, reset and destruction exit zero',
    ],
    scope:
      'Fixed/variable owner-drawn dropdown-list, editable dropdown and simple combo boxes. Universal Windows compatibility remains incomplete.',
  };
  await writeFile(
    'evidence/owner-combos-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: '.scratch/owner-combos-failure.png' });
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun && {
          exitCode: window.__lastRun.exitCode,
          error: window.__lastRun.error,
          apiTrace: window.__lastRun.apiTrace?.slice(-30),
        },
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
