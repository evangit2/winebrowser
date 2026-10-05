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
  await page.locator('#file').setInputFiles('tests/fixtures/multi-lists/multi-lists.exe');
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
  await title('Multi lists ready');
  const lists = ['Multiple strings', 'Extended raw', 'Variable extended'].map((name) =>
    root.getByRole('listbox', { name, exact: true }),
  );
  const rows = lists.map((list) => list.getByRole('option'));
  const selected = async (i, expected) => {
    await expect
      .poll(() =>
        rows[i].evaluateAll((rows) =>
          rows.flatMap((row, i) => (row.getAttribute('aria-selected') === 'true' ? [i] : [])),
        ),
      )
      .toEqual(expected);
  };
  for (const list of lists) await expect(list).toHaveAttribute('aria-multiselectable', 'true');
  await rows[0].nth(0).click();
  await selected(0, [0]);
  await rows[0].nth(2).click();
  await selected(0, [0, 2]);
  await rows[0].nth(0).click();
  await selected(0, [2]);
  await lists[0].press('ArrowDown');
  await selected(0, [2]);
  await lists[0].press('Space');
  await selected(0, [1, 2]);
  await expect(rows[0].nth(1)).toHaveCSS('outline-style', 'dotted');
  await rows[1].nth(0).click();
  await selected(1, [0]);
  await rows[1].nth(3).click({ modifiers: ['ControlOrMeta'] });
  await selected(1, [0, 3]);
  await rows[1].nth(1).click({ modifiers: ['Shift'] });
  await selected(1, [1, 2, 3]);
  await lists[1].press('Control+ArrowDown');
  await expect(lists[1]).toHaveAttribute(
    'aria-activedescendant',
    await rows[1].nth(2).getAttribute('id'),
  );
  await selected(1, [1, 2, 3]);
  await lists[1].press('Control+Space');
  await selected(1, [1, 3]);
  await expect.poll(() => pixel(lists[1], 8, 60)).toEqual([24, 100, 200, 255]);
  await expect.poll(() => pixel(lists[1], 8, 82)).toEqual([255, 210, 20, 255]);
  await lists[1].press('Shift+ArrowUp');
  await selected(1, [1, 2]);
  await expect.poll(() => pixel(lists[1], 8, 34)).toEqual([200, 40, 60, 255]);
  await lists[1].press('Space');
  await selected(1, [1]);
  await lists[1].press('Control+Space');
  await selected(1, []);
  await rows[2].nth(0).click();
  await selected(2, [0]);
  await rows[2].nth(2).click({ modifiers: ['Shift'] });
  await selected(2, [0, 1, 2]);
  await rows[2].nth(4).click({ modifiers: ['ControlOrMeta'] });
  await selected(2, [0, 1, 2, 4]);
  await lists[2].press('Shift+Home');
  await selected(2, [0, 1, 2, 3, 4]);
  await lists[2].press('Control+End');
  await selected(2, [0, 1, 2, 3, 4]);
  await lists[2].press('Control+Space');
  await selected(2, [0, 1, 2, 3, 4, 5]);
  await root.getByRole('button', { name: 'Insert before selection', exact: true }).click();
  await title('Selection preserved on insert');
  await selected(0, [2, 3]);
  await root.getByRole('button', { name: 'Delete inserted item', exact: true }).click();
  await title('Selection preserved on delete');
  await selected(0, [1, 2]);
  await root.getByRole('button', { name: 'Select all programmatically', exact: true }).click();
  await title('Programmatic all selected');
  await selected(1, [0, 1, 2, 3, 4, 5]);
  await root.getByRole('button', { name: 'Restore raw selection', exact: true }).click();
  await title('Native selection restored');
  await selected(1, [1, 2]);
  await root.getByRole('button', { name: 'Disable raw list', exact: true }).click();
  await title('Multi disabled');
  await expect(lists[1]).toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => pixel(lists[1])).toEqual([110, 110, 110, 255]);
  await root.getByRole('button', { name: 'Enable raw list', exact: true }).click();
  await title('Multi enabled');
  await root.screenshot({ path: 'evidence/multi-lists-browser.png' });
  await root.getByRole('button', { name: 'Reset variable list', exact: true }).click();
  await title('Multi reset');
  await expect(rows[2]).toHaveCount(0);
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
    exeSha256: await digest('tests/fixtures/multi-lists/multi-lists.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged native PE32 multiple string, extended raw owner-drawn and variable Unicode listboxes compile and run inside Chromium',
      'Native LB_SETSEL/GETSEL/GETSELCOUNT/GETSELITEMS, packed/reversed ranges, caret and anchor API contracts, buffer limits and zero programmatic notifications pass',
      'Independent selections, Control toggles, Shift ranges, Space toggles and caret-only keyboard moves match real native item queries',
      'Owner callbacks and real pixels distinguish selection from focus, retain disabled state and clip fixed/variable rows while scrolling',
      'Insertion/deletion preserve selected items; select-all, reset, destruction and owner item cleanup exit zero',
    ],
    scope:
      'Multiple and extended selection on ordinary string and fixed/variable owner-drawn listboxes. Held-pointer selection/autoscroll, full native typeahead and universal Windows compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/multi-lists-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: '.scratch/multi-lists-failure.png' });
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
