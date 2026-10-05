import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { nativeComboList } from './lib/native-combo-input.mjs';
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
  await page.locator('#file').setInputFiles('tests/fixtures/list-pointer/list-pointer.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window');
  const title = async (text) => {
    await page.waitForFunction(
      (text) =>
        document.querySelector('.virtual-desktop-title')?.textContent === text ||
        window.__lastRun != null ||
        document.querySelector('#state')?.textContent === 'ERROR',
      text,
    );
    await expect(root.locator('.virtual-desktop-title')).toHaveText(text);
  };
  await title('Native pointer ready');
  const lists = ['Native single', 'Native extended', 'Native multiple', 'Variable pointer'].map(
    (name) => root.getByRole('listbox', { name, exact: true }),
  );
  const rows = lists.map((list) => list.getByRole('option'));
  const selected = async (i, expected) =>
    expect
      .poll(() =>
        rows[i].evaluateAll((rows) =>
          rows.flatMap((row, i) => (row.getAttribute('aria-selected') === 'true' ? [i] : [])),
        ),
      )
      .toEqual(expected);
  const point = async (i, index) => {
    let bounds;
    await expect
      .poll(async () => {
        bounds = await rows[i].nth(index).boundingBox();
        return bounds;
      })
      .not.toBeNull();
    return { x: Math.round(bounds.x + 12), y: Math.round(bounds.y + bounds.height / 2) };
  };
  const move = async (i, index) => {
    const p = await point(i, index);
    await page.mouse.move(p.x, p.y);
  };
  const begin = async (i, index) => {
    await move(i, index);
    await page.mouse.down();
  };
  const verify = async (label, status) => {
    await root.getByRole('button', { name: label, exact: true }).click();
    await title(status);
  };
  await begin(0, 0);
  await move(0, 2);
  await selected(0, [2]);
  await page.mouse.up();
  await verify('Verify single drag', 'Single pointer verified');
  await begin(1, 1);
  await move(1, 4);
  await selected(1, [1, 2, 3, 4]);
  await move(1, 2);
  await selected(1, [1, 2]);
  await page.mouse.up();
  await verify('Verify extended shrink', 'Extended shrink verified');
  await begin(2, 1);
  await move(2, 3);
  await selected(2, [1]);
  await expect(lists[2]).toHaveAttribute(
    'aria-activedescendant',
    await rows[2].nth(3).getAttribute('id'),
  );
  await page.mouse.up();
  await verify('Verify multiple caret', 'Multiple caret verified');
  await begin(3, 0);
  await move(3, 3);
  await selected(3, [0, 1, 2, 3]);
  await expect
    .poll(() =>
      lists[3]
        .locator('..')
        .locator('canvas.virtual-desktop-control-drawing')
        // Stay clear of the white native TextOutW glyphs at x=6.
        .evaluate((canvas) => {
          if (canvas.width < 181 || canvas.height < 9)
            throw new Error(`Unexpected owner-drawn canvas ${canvas.width}x${canvas.height}`);
          return [...canvas.getContext('2d').getImageData(180, 8, 1, 1).data];
        }),
    )
    .toEqual([24, 100, 200, 255]);
  await page.mouse.up();
  await verify('Verify variable rows', 'Variable pointer verified');
  await begin(3, 0);
  const bounds = await lists[3].boundingBox();
  await page.mouse.move(bounds.x + 12, bounds.y + bounds.height + 32);
  await expect
    .poll(() =>
      lists[3].evaluate((element) =>
        Array.from(element.querySelectorAll('[role="option"]')).findIndex(
          (row) => row.id === element.getAttribute('aria-activedescendant'),
        ),
      ),
    )
    .toBeGreaterThanOrEqual(9);
  await page.mouse.up();
  await verify('Verify stationary autoscroll', 'Stationary autoscroll verified');
  await page.keyboard.down('Control');
  await begin(1, 3);
  await move(1, 5);
  await selected(1, [3, 4, 5]);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await verify('Verify Control drag', 'Control pointer verified');
  await page.keyboard.down('Shift');
  await begin(1, 4);
  await move(1, 6);
  await selected(1, [3, 4, 5, 6]);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await verify('Verify Shift drag', 'Shift pointer verified');
  const combo = root.getByRole('combobox', { name: 'Pointer combo', exact: true });
  await combo.press('F4');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  const popup = await nativeComboList(combo),
    popupRows = popup.getByRole('option');
  let box = await popupRows.nth(0).boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await page.mouse.down();
  box = await popupRows.nth(2).boundingBox();
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await expect(popupRows.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.mouse.up();
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify('Verify combo drag', 'Combo pointer verified');
  await begin(1, 1);
  const cancelBounds = await lists[1].boundingBox();
  await page.mouse.move(cancelBounds.x + 12, cancelBounds.y + cancelBounds.height + 30);
  await lists[1].press('F6');
  await page.mouse.up();
  await verify('Verify cancel mode', 'Native cancel mode verified');
  await begin(1, 2);
  await move(1, 5);
  await lists[1].press('F7');
  await page.mouse.up();
  await verify('Verify capture transfer', 'Native pointer checks complete');
  await root.screenshot({ path: 'evidence/list-pointer-browser.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun != null);
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
      .update(await readFile('tests/fixtures/list-pointer/list-pointer.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged native PE32 receives actual WM_LBUTTONDOWN/MOVE/UP through guest LISTBOX subclasses and callable originals',
      'Single-string drag selection, extended grow/shrink, Control toggles/ranges, Shift anchors and multiple caret-only tracking pass native queries',
      'Variable owner-drawn row hit-testing and stationary out-of-client autoscroll use native capture and WM_SYSTIMER',
      'Application WM_TIMER ID 2 remains independent of private list system timer ID 2; native release queries capture zero and real LBN_SELCHANGE HWNDs',
      'Native WM_CANCELMODE during stationary autoscroll and SetCapture transfer while dragging cancel tracking through the actual original list procedure',
      'Guest CB_SHOWDROPDOWN(FALSE) during a captured out-of-client combo drag hides the popup and releases its real HWND capture',
      'Actual ComboLBox pointer drag selects and commits native combo state; all stage assertions and native window destruction exit zero',
    ],
    scope:
      'Native pointer capture and vertical autoscroll on ordinary, multiple, extended and owner-drawn listboxes and combo list children. Horizontal/multicolumn lists, complete popup hover tracking and universal Windows/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/list-pointer-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.scratch/list-pointer-failure.png' });
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
