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
  await page.locator('#file').setInputFiles('tests/fixtures/list-keyboard/list-keyboard.exe');
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
  await title('Keyboard ready');
  const lists = [
    'ANSI callbacks',
    'Raw callbacks',
    'Multiple Unicode',
    'Extended Unicode',
    'Tabbed strings',
  ].map((name) => root.getByRole('listbox', { name, exact: true }));
  const current = async (list, index) => {
    const row = list.getByRole('option').nth(index);
    await expect(list).toHaveAttribute('aria-activedescendant', await row.getAttribute('id'));
  };
  const selected = async (list, expected) => {
    await expect
      .poll(() =>
        list
          .getByRole('option')
          .evaluateAll((rows) =>
            rows.flatMap((row, i) => (row.getAttribute('aria-selected') === 'true' ? [i] : [])),
          ),
      )
      .toEqual(expected);
  };
  const input = await page.context().newCDPSession(page);
  const character = async (control, key) => {
    await control.focus();
    // Use the Windows VK; host-native key codes differ between macOS and Linux.
    const data = { key, code: 'KeyE', windowsVirtualKeyCode: 69 };
    await input.send('Input.dispatchKeyEvent', {
      ...data,
      type: 'keyDown',
      text: key,
      unmodifiedText: key,
    });
    await input.send('Input.dispatchKeyEvent', { ...data, type: 'keyUp' });
  };
  await lists[0].press('a');
  await selected(lists[0], [1]);
  await lists[0].press('a');
  await selected(lists[0], [0]);
  await lists[0].press('F2');
  await selected(lists[0], [2]);
  await lists[0].press('F3');
  await selected(lists[0], [2]);
  await lists[0].press('F5');
  await selected(lists[0], [2]);
  await character(lists[0], 'é');
  await selected(lists[0], [3]);
  await character(lists[0], '€');
  await selected(lists[0], [4]);
  await lists[1].press('F2');
  await selected(lists[1], [2]);
  await lists[1].press('F6');
  await selected(lists[1], [0]);
  await lists[1].press('F2');
  await selected(lists[1], [2]);
  await lists[1].press('!');
  await selected(lists[1], [2]);
  await lists[1].press('#');
  await selected(lists[1], [1]);
  await lists[1].press('z');
  await selected(lists[1], [1]);
  await character(lists[2], 'Ω');
  await current(lists[2], 5);
  await selected(lists[2], [0, 2]);
  await character(lists[3], '€');
  await current(lists[3], 4);
  await selected(lists[3], [1, 2, 3, 4]);
  await lists[4].press('b');
  await selected(lists[4], [2]);
  const combo = root.getByRole('combobox', { name: 'Owner Unicode combo', exact: true });
  await combo.press('a');
  await title('Combo changed');
  await combo.press('F4');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  await character(combo, 'Ω');
  const popup = page.getByRole('listbox', { name: 'Combo choices', exact: true });
  await selected(popup, [5]);
  await title('Combo changed');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  await combo.press('Enter');
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => pixel(lists[1], 8, 40)).toEqual([180, 30, 70, 255]);
  await root.getByRole('button', { name: 'Verify native keyboard', exact: true }).click();
  await title('Native keyboard verified');
  await root.screenshot({ path: 'evidence/list-keyboard-browser.png' });
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
    exeSha256: await digest('tests/fixtures/list-keyboard/list-keyboard.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged native ANSI/Unicode PE32 list and owner-combo controls execute browser-compiled x86 blocks in Chromium',
      'WM_VKEYTOITEM/WM_CHARTOITEM validate caret, actual HWND, signed default/handled returns, explicit index zero and rejected out-of-range targets',
      'Real character input cycles prefixes, wraps, selects Windows-1252 euro/accented rows and Unicode Greek rows',
      'Multiple character search preserves selected flags; extended search retains its anchor and selects the native range',
      'Tabbed string lists use native keyboard selection; owner-combo character forwarding retains the popup until Enter',
      'Native guest queries, callback counters, owner drawing pixels and exit-zero assertions pass',
    ],
    scope:
      'Character cycling and application keyboard callbacks for owner-drawn, multi-selection, tabbed and WANTKEYBOARDINPUT listboxes, plus owner-drawn dropdown-list combos. Held-pointer ranges/autoscroll and universal Windows compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/list-keyboard-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: '.scratch/list-keyboard-failure.png' });
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
