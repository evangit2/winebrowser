import { nativeComboEdit } from './lib/native-combo-input.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
let server, browser, page;
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
  const exe = await readFile('.cache/metapad-le/metapad.exe');
  assert.equal(
    createHash('sha256').update(exe).digest('hex'),
    'dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b',
  );
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles([
    { name: 'metapad.exe', mimeType: 'application/octet-stream', buffer: exe },
    { name: 'find.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha beta alpha') },
  ]);
  await page.locator('#args').fill(JSON.stringify(['find.txt']));
  await page.locator('#run').click();
  const owner = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /metapad$/ }) });
  const edit = owner.getByRole('textbox');
  await expect(edit).toHaveValue('alpha beta alpha');
  await edit.press('Control+f');
  const find = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Find$/ }) });
  const findInput = nativeComboEdit(find.locator('[data-control-id=\"1154\"]'));
  await expect(findInput).toHaveAttribute('maxlength', '100');
  await findInput.fill('x'.repeat(120));
  await expect(findInput).toHaveValue('x'.repeat(100));
  await findInput.fill('beta');
  await find.getByRole('button', { name: 'Find Next', exact: true }).click();
  await expect
    .poll(() => edit.evaluate((e) => e.value.slice(e.selectionStart, e.selectionEnd)))
    .toBe('beta');
  await findInput.fill('alpha');
  await find.getByRole('button', { name: 'Find Next', exact: true }).click();
  await expect
    .poll(() => edit.evaluate((e) => e.value.slice(e.selectionStart, e.selectionEnd)))
    .toBe('alpha');
  await find.screenshot({ path: 'evidence/metapad-find-browser.png' });
  await find.getByRole('button', { name: 'Close', exact: true }).click();
  await edit.press('Control+h');
  const replace = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Replace$/ }) });
  await nativeComboEdit(replace.locator('[data-control-id=\"1154\"]')).waitFor();
  await expect(nativeComboEdit(replace.locator('[data-control-id=\"1153\"]'))).toHaveAttribute(
    'maxlength',
    '100',
  );
  await expect(edit).toHaveValue('alpha beta alpha');
  await nativeComboEdit(replace.locator('[data-control-id=\"1154\"]')).fill('alpha');
  await nativeComboEdit(replace.locator('[data-control-id=\"1153\"]')).fill('gamma');
  await replace.getByRole('button', { name: 'Replace All', exact: true }).click();
  await expect(edit).toHaveValue('gamma beta gamma');
  await expect(page.locator('#dialog-text')).toHaveText(/2/);
  await page.locator('#dialog-ok').click();
  await replace.screenshot({ path: 'evidence/metapad-replace-browser.png' });
  await replace.getByRole('button', { name: 'Close', exact: true }).click();
  await edit.press('Control+s');
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('find.txt - metapad');
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const output = run.outputs.find((f) => f.path === 'find.txt');
  assert.ok(output);
  assert.equal(
    new TextDecoder().decode(new Uint8Array(Object.values(output.bytes))),
    'gamma beta gamma',
  );
  assert.ok(run.apiTrace.includes('comdlg32.dll!FindTextA'));
  assert.ok(run.apiTrace.includes('comdlg32.dll!ReplaceTextA'));
  const report = {
    exeSha256: createHash('sha256').update(exe).digest('hex'),
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed-find-and-replace-all',
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged Metapad native custom Find template/subclass creates editable ComboBox with CB_LIMITTEXT/CB_SETEDITSEL',
      'Native Find Next reads browser ComboBox text and selects matching beta then alpha ranges in the actual native editor',
      'Control+H opens the native custom Replace window without browser Backspace deleting selected editor text; editable ComboBox typing honors the native 100-character limit',
      'Native Replace All produces gamma beta gamma, reports two replacements, and Ctrl+S exports matching actual file bytes',
      'Modeless dialog close notifications, editor shutdown and unchanged executable exit zero',
    ],
    scope:
      'Bounded ANSI Find Next and Replace All workflows with the unchanged native app. RichEdit, advanced matching, encodings, single replacement and options remain unverified. Executable stays privately cached.',
  };
  await writeFile(
    'evidence/metapad-find-browser-results.json',
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
