import { selectNativeCombo, nativeComboEdit } from './lib/native-combo-input.mjs';
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
  await page.locator('#file').setInputFiles('tests/fixtures/native-combos/native-combos.exe');
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
  await title('Native combos ready');
  const combos = ['String dropdown', 'Native editable', 'Native simple'].map((name) =>
    root.getByRole('combobox', { name, exact: true }),
  );
  await selectNativeCombo(combos[0], { label: 'Banana' });
  await title('Dropdown selected');
  await selectNativeCombo(combos[0], { label: 'Ωmega' });
  const edit = nativeComboEdit(combos[1]);
  await expect(edit).toHaveAttribute('maxlength', '5');
  await edit.press('Home');
  await edit.fill('typed-too-long');
  await expect(edit).toHaveValue('typed');
  await title('Native edit changed');
  await selectNativeCombo(combos[2], { label: 'Apricot' });
  await title('Simple selected');
  await expect(nativeComboEdit(combos[2])).toHaveValue('Apricot');
  await root.getByRole('button', { name: 'Verify native handles', exact: true }).click();
  await title('Native combo handles verified');
  await root.screenshot({ path: 'evidence/native-combos-browser.png' });
  await root.getByRole('button', { name: 'Reset editable combo', exact: true }).click();
  await title('Native edit cleared on reset');
  await expect(edit).toHaveValue('');
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
    exeSha256: await digest('tests/fixtures/native-combos/native-combos.exe'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged native PE32 ordinary sorted dropdown, editable dropdown and simple string combos compile and execute in Chromium',
      'GetComboBoxInfo and CB_GETCOMBOBOXINFO expose actual ComboLBox/EDIT HWNDs with class names, parents, buffer guards and visibility state',
      'GetFocus reaches the native EDIT; CB_LIMITTEXT and CB_SETEDITSEL forward to the actual child and preserve native query results',
      'Trusted keyboard/text input enters a real guest EDIT subclass and forwards through the callable original procedure',
      'Native popup mouse selection, sorting, selected text, simple lists and programmatic notification suppression pass',
      'CB_RESETCONTENT clears native edit/list state and destroys all child handles before exit zero',
    ],
    scope:
      'Native child HWNDs and string controls for ordinary ANSI/Unicode combo boxes. Complete native dropdown geometry, monitor-edge placement and universal GUI/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/native-combos-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: '.scratch/native-combos-failure.png' });
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
