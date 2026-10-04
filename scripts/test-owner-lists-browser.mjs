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
  await page.locator('#file').setInputFiles('tests/fixtures/owner-lists/owner-lists.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window');
  const lists = ['Fixed data', 'Variable data', 'Unicode strings'].map((name) =>
    root.getByRole('listbox', { name, exact: true }),
  );
  const title = async (text) => {
    await page.waitForFunction(
      (text) =>
        document.querySelector('.virtual-desktop-title')?.textContent === text ||
        window.__lastRun !== null,
      text,
    );
    assert.equal(await page.evaluate(() => window.__lastRun), null);
  };
  const pixel = (list, x = 8, y = 10) =>
    list
      .locator('..')
      .locator('canvas')
      .evaluate((c, [x, y]) => [...c.getContext('2d').getImageData(x, y, 1, 1).data], [x, y]);
  await title('Owner lists ready');
  assert.deepEqual(await pixel(lists[0]), [24, 100, 200, 255]);
  assert.deepEqual(await pixel(lists[1]), [30, 150, 80, 255]);
  assert.deepEqual(await pixel(lists[2]), [200, 110, 20, 255]);
  assert.deepEqual(
    await pixel(lists[0], 8, 100),
    [255, 255, 255, 255],
    'oversized native item fills cannot paint neighboring rows or empty background',
  );
  for (const list of lists) await expect(list.getByRole('option')).toHaveCount(3);
  await lists[0].getByRole('option').nth(1).click();
  await title('Fixed selection');
  await expect.poll(() => pixel(lists[0], 8, 38)).toEqual([200, 40, 60, 255]);
  assert.deepEqual(await pixel(lists[0], 8, 52), [255, 210, 20, 255]);
  assert.deepEqual(
    await pixel(lists[0], 8, 80),
    [24, 100, 200, 255],
    'previous caret loses its native focus stripe',
  );
  await lists[1].getByRole('option').nth(1).click();
  await title('Variable selection');
  await expect.poll(() => pixel(lists[1], 8, 58)).toEqual([200, 40, 60, 255]);
  await lists[1].press('ArrowDown');
  await expect(lists[1].getByRole('option').nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => pixel(lists[1], 8, 46)).toEqual([200, 40, 60, 255]);
  await lists[2].getByRole('option').nth(1).click();
  await title('Unicode selection');
  await expect.poll(() => pixel(lists[2], 8, 38)).toEqual([200, 40, 60, 255]);
  await root.screenshot({ path: 'evidence/owner-lists-browser.png' });
  await root.getByRole('button', { name: 'Disable fixed list', exact: true }).click();
  await title('List disabled');
  await expect(lists[0]).toHaveAttribute('aria-disabled', 'true');
  assert.deepEqual(await pixel(lists[0]), [110, 110, 110, 255]);
  await root.getByRole('button', { name: 'Enable fixed list', exact: true }).click();
  await title('List enabled');
  await expect(lists[0]).toHaveAttribute('aria-disabled', 'false');
  await root.getByRole('button', { name: 'Scroll variable list', exact: true }).click();
  await title('Variable scrolled');
  await expect.poll(() => pixel(lists[1], 8, 8)).toEqual([30, 150, 80, 255]);
  await expect.poll(() => pixel(lists[1], 8, 46)).toEqual([200, 40, 60, 255]);
  await lists[1].getByRole('option').nth(1).click();
  await expect(lists[1].getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => pixel(lists[1], 8, 8)).toEqual([200, 40, 60, 255]);
  await root.getByRole('button', { name: 'Delete fixed item', exact: true }).click();
  await title('Item deleted');
  await expect(lists[0].getByRole('option')).toHaveCount(2);
  await root.getByRole('button', { name: 'Reset variable list', exact: true }).click();
  await title('List reset');
  await expect(lists[1].getByRole('option')).toHaveCount(0);
  await expect.poll(() => pixel(lists[1])).toEqual([255, 255, 255, 255]);
  await root.getByRole('button', { name: 'Resize Unicode list', exact: true }).click();
  await title('List resized');
  await expect(lists[2].locator('..').locator('canvas')).toHaveAttribute('width', '198');
  await expect(lists[2].locator('..').locator('canvas')).toHaveAttribute('height', '178');
  assert.deepEqual(await pixel(lists[2], 195, 10), [200, 110, 20, 255]);
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/owner-lists-gui.png' });
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
    exeSha256: await digest('tests/fixtures/owner-lists/owner-lists.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged ANSI/Unicode PE32 owner-drawn fixed/variable lists compile and execute inside Chromium',
      'Native WM_MEASUREITEM, WM_COMPAREITEM, WM_DRAWITEM and WM_DELETEITEM structure fields, raw data, geometry, font, clipped HDC and lifecycle pass',
      'Real pixels confirm selection, focus, disabled state, variable height, scrolling, resize and row isolation',
      'Mouse and native keyboard selection, sorted raw-data lookup, Unicode strings, delete/reset and destruction exit zero',
    ],
    scope:
      'Single-selection fixed/variable owner-drawn listboxes. Multi-selection, owner-drawn combo popups, horizontal/multicolumn lists and universal compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/owner-lists-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
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
