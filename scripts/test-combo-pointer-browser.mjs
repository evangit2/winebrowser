import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { nativeComboList, nativeComboEdit } from './lib/native-combo-input.mjs';
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/combo-pointer/combo-pointer.exe');
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
  await title('Native popup ready');
  const combo = root.getByRole('combobox', { name: 'Pointer dropdown', exact: true });
  const editable = root.getByRole('combobox', { name: 'Pointer edit', exact: true });
  const simple = root.getByRole('combobox', { name: 'Pointer simple', exact: true });
  const popup = await nativeComboList(combo);
  const edit = nativeComboEdit(editable);
  const verify = async (target, text, key = 'F6') => {
    await target.press(key);
    await title(text);
  };
  const move = async (list, index) => {
    let box;
    await expect
      .poll(async () => {
        box = await list.getByRole('option').nth(index).boundingBox();
        return box;
      })
      .not.toBeNull();
    await page.mouse.move(Math.round(box.x + 12), Math.round(box.y + box.height / 2));
    await expect(list.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
  };
  const outside = async () => {
    const box = await root.boundingBox();
    await page.mouse.click(box.x + 100, box.y + 300);
  };
  const arrow = combo.getByRole('button', { name: 'Open Pointer dropdown', exact: true });
  const pressArrow = async () => {
    const box = await arrow.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(combo).toHaveAttribute('aria-expanded', 'true');
    await expect(arrow).toHaveAttribute('aria-pressed', 'true');
    await expect(arrow).toHaveCSS('border-top-style', 'inset');
  };
  await combo.press('F4');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  await move(popup, 2);
  await verify(combo, 'Popup hover verified');
  await outside();
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify(combo, 'Outside dismissal verified');
  await pressArrow();
  await verify(combo, 'Arrow press verified');
  await root.screenshot({ path: 'evidence/combo-pointer-arrow-pressed.png' });
  await move(popup, 1);
  await expect(arrow).toHaveAttribute('aria-pressed', 'false');
  await expect(arrow).toHaveCSS('border-top-style', 'outset');
  await move(popup, 2);
  await verify(combo, 'Capture handoff verified');
  await root.screenshot({ path: 'evidence/combo-pointer-handoff.png' });
  await page.mouse.up();
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify(combo, 'Popup release verified');
  await pressArrow();
  await page.mouse.up();
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  await expect(arrow).toHaveAttribute('aria-pressed', 'false');
  await verify(combo, 'Arrow release verified');
  await move(popup, 1);
  await verify(combo, 'Native cancel verified', 'F7');
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await edit.fill('Typed Ω');
  await edit.press('F4');
  await expect(editable).toHaveAttribute('aria-expanded', 'true');
  await move(await nativeComboList(editable), 2);
  await verify(edit, 'Editable hover verified');
  await outside();
  await expect(editable).toHaveAttribute('aria-expanded', 'false');
  await expect(edit).toHaveValue('Typed Ω');
  await verify(edit, 'Editable dismissal verified');
  const simpleList = await nativeComboList(simple);
  // Simple lists do not select on hover, so check without the dropdown helper.
  let box = await simpleList.getByRole('option').nth(2).boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await expect(simpleList.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true');
  await verify(nativeComboEdit(simple), 'Simple hover verified');
  await simpleList.getByRole('option').nth(1).click();
  await verify(nativeComboEdit(simple), 'Simple pointer verified');
  await pressArrow();
  // No selection/capture assertions between these input events: a rapid native
  // handoff must still deliver both row moves and the final release.
  for (const index of [1, 2]) {
    const rowBox = await popup.getByRole('option').nth(index).boundingBox();
    assert.ok(rowBox);
    await page.mouse.move(rowBox.x + 12, rowBox.y + rowBox.height / 2);
  }
  await page.mouse.up();
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify(combo, 'Native popup checks complete');
  await root.screenshot({ path: 'evidence/combo-pointer-browser.png' });
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
      .update(await readFile('tests/fixtures/combo-pointer/combo-pointer.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged authored native PE32 subclasses actual COMBOBOX, ComboLBox and EDIT HWNDs and calls each original procedure',
      'F4 captures ComboLBox; unheld hover updates native selection/caret without selection or edit notifications; outside dismissal restores the opening selection and clears capture',
      'Held arrow down captures COMBOBOX and exposes STATE_SYSTEM_PRESSED; entering the popup transfers HWND capture and signed client coordinates to actual list WM_LBUTTONDOWN',
      'Held drag between native rows and release commits selection with capture released before CBN_SELCHANGE, then CBN_SELENDOK and CBN_CLOSEUP',
      'Rapid arrow-to-row drag and release also commits through native procedures without intermediate selection/capture waits',
      'Arrow down/up leaves the popup open with actual ComboLBox capture; native WM_CANCELMODE closes it and clears capture',
      'Editable unmatched Unicode text is preserved across hover/outside cancellation with no edit/selection notifications',
      'Simple combo hover leaves selection unchanged; actual list down/up selects and notifies; every native stage and native destruction exit zero',
    ],
    scope:
      'Native vertical popup pointer tracking on string combos. Complete monitor-edge placement, horizontal/multicolumn lists and universal Windows/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/combo-pointer-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.scratch/combo-pointer-failure.png' });
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
