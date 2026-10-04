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
  await page.locator('#file').setInputFiles('tests/fixtures/owner-buttons/owner-buttons.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    button = root.getByRole('button', { name: 'Draw button', exact: true }),
    wide = root.getByRole('button', { name: 'Wide λ', exact: true });
  const title = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.virtual-desktop-title')?.textContent === text,
      text,
    );
  const pixel = (target, x = 10, y = 10) =>
    target
      .locator('canvas')
      .evaluate(
        (c, [x, y]) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data),
        [x, y],
      );
  await title('Owner buttons ready');
  assert.deepEqual(await pixel(button), [24, 100, 200, 255]);
  assert.deepEqual(await pixel(wide), [30, 150, 80, 255]);
  assert.equal(await button.locator('canvas').getAttribute('width'), '280');
  const point = await button.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + 30, y: r.y + 20 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect.poll(() => pixel(button)).toEqual([200, 40, 60, 255]);
  assert.deepEqual(await pixel(button, 10, 54), [255, 210, 20, 255], 'focused guest painting');
  await page.mouse.move(point.x + 340, point.y);
  await expect.poll(() => pixel(button)).toEqual([24, 100, 200, 255]);
  await page.mouse.up();
  await title('Owner buttons ready');
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect.poll(() => pixel(button)).toEqual([200, 40, 60, 255]);
  await page.mouse.up();
  await title('Mouse clicked');
  assert.deepEqual(await pixel(button), [24, 100, 200, 255]);
  await button.press('Space');
  await title('Space clicked');
  await button.press('Enter');
  await title('Enter clicked');
  await wide.click();
  await title('Wide clicked');
  await root.getByRole('button', { name: 'Disable draw button', exact: true }).click();
  await title('Disabled drawing');
  await expect(button).toBeDisabled();
  assert.deepEqual(await pixel(button), [110, 110, 110, 255]);
  await root.getByRole('button', { name: 'Enable draw button', exact: true }).click();
  await title('Enabled drawing');
  await expect(button).toBeEnabled();
  assert.deepEqual(await pixel(button), [24, 100, 200, 255]);
  await root.getByRole('button', { name: 'Set pushed', exact: true }).click();
  await title('Manual pushed');
  assert.deepEqual(await pixel(button), [200, 40, 60, 255]);
  await root.getByRole('button', { name: 'Clear pushed', exact: true }).click();
  await title('Manual released');
  assert.deepEqual(await pixel(button), [24, 100, 200, 255]);
  await root.getByRole('button', { name: 'Native BM_CLICK', exact: true }).click();
  await title('Programmatic clicked');
  assert.deepEqual(await pixel(button), [24, 100, 200, 255]);
  await root.getByRole('button', { name: 'Resize wide button', exact: true }).click();
  await title('Wide resized');
  await expect(wide.locator('canvas')).toHaveAttribute('width', '320');
  await expect(wide.locator('canvas')).toHaveAttribute('height', '64');
  assert.deepEqual(await pixel(wide, 315, 10), [30, 150, 80, 255]);
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/owner-buttons-gui.png' });
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
    exeSha256: await digest('tests/fixtures/owner-buttons/owner-buttons.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged ANSI/Unicode BS_OWNERDRAW buttons call native WM_DRAWITEM with ODT_BUTTON, client RECT, child HWND and font-selected HDC after WM_CTLCOLORBTN',
      'ODA_DRAWENTIRE/SELECT/FOCUS and ODS_SELECTED/DISABLED/FOCUS match native BM_GETSTATE; actual pressed/focused/disabled GDI pixels visible in Chromium',
      'Held pointer, drag-out cancellation and release, Space, Enter, native BM_SETSTATE and BM_CLICK; each activation delivers exactly one native command after clearing pushed state',
      'Disabled button rejects BM_CLICK; Unicode button paints native text; SetWindowPos resizes its canvas; destruction and native exit zero',
    ],
    scope:
      'Owner-drawn fixed-style BUTTON controls in ordinary Chromium. Owner-drawn lists/menus, dynamic BM_SETSTYLE, exact native capture/nonclient behavior and universal GUI/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/owner-buttons-browser-results.json',
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
