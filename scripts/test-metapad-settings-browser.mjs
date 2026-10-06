import { selectNativeCombo, nativeComboText } from './lib/native-combo-input.mjs';
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
  const exeSha256 = createHash('sha256').update(exe).digest('hex');
  assert.equal(exeSha256, 'dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b');
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
  const upload = async (ini) => {
    await page.locator('#file').setInputFiles([
      { name: 'metapad.exe', mimeType: 'application/octet-stream', buffer: exe },
      { name: 'settings.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
      { name: 'metapad.ini', mimeType: 'text/plain', buffer: ini },
    ]);
    await page.locator('#args').fill(JSON.stringify(['/i', 'settings.txt']));
    await page.locator('#run').click();
  };
  await upload(
    Buffer.from('; native portable preferences\r\n[Options]\r\nnTabStops=4\r\nbInsertSpaces=0\r\n'),
  );
  const owner = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /metapad$/ }) });
  const edit = owner.getByRole('textbox');
  const sheet = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Settings$/ }) });
  const tabs = sheet.getByRole('tab');
  const tabSize = sheet.locator('[data-control-id="1025"]');
  const spaces = sheet.getByRole('checkbox', { name: 'Insert tabs as spaces', exact: true });
  const format = sheet.locator('[data-control-type="combobox"][data-control-id="1074"]');
  const open = async () => {
    await edit.press('Alt+Enter');
    await expect(tabSize).toHaveValue('4');
  };
  // Wait for the real EDIT child after native cold startup/browser compilation.
  await expect(edit).toHaveValue('alpha', { timeout: 30000 });
  await open();
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(2)).toHaveText('Buffers & Language');
  const layout = await tabs.evaluateAll((elements) =>
    elements.map((e) => {
      const canvas = document.createElement('canvas'),
        context = canvas.getContext('2d');
      context.font = getComputedStyle(e).font;
      return {
        width: parseFloat(e.style.width),
        textWidth: context.measureText(e.textContent).width,
      };
    }),
  );
  for (const item of layout) {
    assert.ok(item.width >= item.textWidth + 19);
    assert.ok(item.width <= Math.max(48, Math.ceil(item.textWidth) + 20) + 1);
  }
  await tabSize.fill('0');
  await tabs.nth(1).click();
  await expect(page.locator('#dialog-text')).toHaveText('Enter a tab size between 1 and 100');
  await page.locator('#dialog-ok').click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await tabSize.fill('6');
  await spaces.click();
  await expect(spaces).toHaveAttribute('aria-checked', 'true');
  for (const index of [1, 2, 3]) {
    await tabs.nth(index).click();
    await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true');
  }
  await selectNativeCombo(format, { label: 'UNIX Text' });
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(edit).toHaveValue('alpha');
  await open();
  await expect(spaces).toHaveAttribute('aria-checked', 'false');
  await tabs.nth(3).click();
  await expect.poll(() => nativeComboText(format)).toBe('DOS Text');
  await tabs.nth(0).click();
  await tabSize.fill('6');
  await spaces.click();
  await tabs.nth(3).click();
  await selectNativeCombo(format, { label: 'UNIX Text' });
  await sheet.screenshot({ path: 'evidence/metapad-settings-browser.png' });
  await sheet.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await edit.press('Home');
  await edit.press('Tab');
  await expect(edit).toHaveValue('      alpha');
  await edit.press('Control+s');
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const first = await page.evaluate(() => window.__lastRun);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  const ini = first.outputs.find((f) => f.path === 'metapad.ini');
  assert.ok(ini);
  const iniBytes = Buffer.from(Object.values(ini.bytes));
  const iniText = iniBytes.toString('utf8');
  assert.match(iniText, /nTabStops=6/i);
  assert.match(iniText, /bInsertSpaces=1/i);
  assert.match(iniText, /nFormatIndex=1/i);
  assert.match(iniText, /; native portable preferences/);
  const text = first.outputs.find((f) => f.path === 'settings.txt');
  assert.ok(text);
  assert.equal(Buffer.from(Object.values(text.bytes)).toString(), '      alpha');
  await upload(iniBytes);
  await expect(edit).toHaveValue('alpha', { timeout: 30000 });
  await edit.press('Alt+Enter');
  await expect(tabSize).toHaveValue('6');
  await expect(spaces).toHaveAttribute('aria-checked', 'true');
  await tabs.nth(3).click();
  await expect.poll(() => nativeComboText(format)).toBe('UNIX Text');
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const second = await page.evaluate(() => window.__lastRun);
  assert.equal(second.exitCode, 0, JSON.stringify(second));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256,
    status: 'passed-settings-and-portable-persistence',
    exitCodes: [first.exitCode, second.exitCode],
    compiledBlocks: first.compiledBlocks,
    x86TranslationMs: first.x86TranslationMs,
    checks: [
      'Unchanged native Metapad opens all four property pages; General validation rejects tab size zero through native PSN_KILLACTIVE and preserves the active tab',
      'Cancel discards changed tab size, spaces checkbox and file-format ComboBox; reopening reads the original settings',
      'OK applies six-space indentation to the actual editor; native Ctrl+S writes the resulting text',
      'Native WritePrivateProfileStringA exports metapad.ini preserving its comment; uploaded output restores tab size, checkbox and UNIX format in a fresh run',
      'Resource-font geometry renders readable Settings; tab captions honor escaped ampersands and widths follow the actual font; both native runs exit zero',
    ],
    scope:
      'Bounded unchanged Metapad LE property pages and portable preferences; font/color pickers, language plugins, printing and arbitrary GUI applications are not proven.',
  };
  await writeFile(
    'evidence/metapad-settings-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        notice: document.querySelector('#dialog-text')?.textContent,
        run: window.__lastRun,
        windows: [...document.querySelectorAll('.virtual-desktop-window')].map((e) => e.innerText),
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
