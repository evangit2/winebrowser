import { selectNativeCombo, nativeComboList, nativeComboEdit } from './lib/native-combo-input.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
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
  await page.locator('#file').setInputFiles('tests/fixtures/lists/lists.exe');
  await page.locator('#run').click();
  const window = page.locator('.virtual-desktop-window');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Native Lists',
  );
  const list = window.locator('[data-control-id="80"]');
  const combo = window.locator('[data-control-id="81"]');
  const editable = window.locator('[data-control-id="82"]');
  const simple = window.locator('[data-control-id="83"]');
  await expect(nativeComboEdit(simple)).toHaveValue('Two');
  assert.deepEqual(await list.getByRole('option').allTextContents(), ['Alpha', 'Beta']);
  await expect(list.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true');
  assert.equal(await nativeComboEdit(editable).inputValue(), 'initial');
  assert.deepEqual(
    await (
      await nativeComboList(editable)
    )
      .getByRole('option', { includeHidden: true })
      .allTextContents(),
    ['Unicode λ', 'Other'],
  );
  await list.getByRole('option', { name: 'Beta', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'List selected Beta',
  );
  await selectNativeCombo(combo, { label: 'Second' });
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Combo selected Second',
  );
  await nativeComboEdit(editable).fill('typed text');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Typed native text',
  );
  await selectNativeCombo(simple, { label: 'One' });
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Simple selected One',
  );
  assert.equal(await nativeComboEdit(simple).inputValue(), 'One');
  const checkbox = window.getByRole('checkbox', { name: 'Enable option' }),
    first = window.getByRole('radio', { name: 'First radio', exact: true }),
    second = window.getByRole('radio', { name: 'Second radio', exact: true });
  await checkbox.click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Checkbox checked',
  );
  assert.equal(await checkbox.getAttribute('aria-checked'), 'true');
  assert.equal(await checkbox.evaluate((el) => getComputedStyle(el, '::before').content), '"✓"');
  await second.click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Second radio checked',
  );
  await first.click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'First radio checked',
  );
  assert.equal(await second.getAttribute('aria-checked'), 'false');
  await first.click();
  // A further native command provides a queue barrier after the repeat click.
  await second.click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Second radio checked',
  );
  assert.equal(await second.getAttribute('aria-checked'), 'true');
  const tabs = window.getByRole('listbox', { name: 'Columns', exact: true });
  const rows = tabs.getByRole('option');
  assert.equal(await rows.count(), 2);
  const columns = await rows.evaluateAll((rows) =>
    rows.map((row) => [...row.children].map((span) => parseFloat(span.style.left))),
  );
  assert.deepEqual(columns[0], columns[1]);
  assert.ok(columns[0][1] > 80 && columns[0][2] > columns[0][1]);
  assert.equal(columns[0][2] - 2, 2 * (columns[0][1] - 2));
  await rows.nth(1).click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Tabbed row one',
  );
  await tabs.press('ArrowUp');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Tabbed row zero',
  );
  assert.equal(await rows.nth(0).getAttribute('aria-selected'), 'true');
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/lists/lists.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    checks: [
      'Native system-path winspool.drv resolves EnumPrinters and reports zero installed queues with correct seven-argument ABI',
      'Native SendDlgItemMessageA/W five-argument stack cleanup',
      'Sorted ListBox strings preserve selected identity and item data',
      'Unicode text round trip through ANSI ComboBox via SendDlgItemMessageW',
      'Mouse ListBox and dropdown ComboBox selections dispatch native WM_COMMAND',
      'Editable and simple ComboBox text/selection reach the guest',
      'Native checkbox indicators and WS_GROUP radio exclusivity in both directions',
      'LB_SETTABSTOPS lays out Unicode columns in font-relative dialog units with native mouse/keyboard selection',
      'Programmatic selection sends no user notifications; close exits zero',
    ],
    scope:
      'Native single-select string controls in ordinary Chromium. Tabbed text uses browser-matched font metrics. Owner-drawn and multi-select lists, dropdown-opening messages and full common-control coverage remain incomplete.',
  };
  await writeFile('evidence/lists-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
