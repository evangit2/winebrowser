import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
const hash = (b) => createHash('sha256').update(b).digest('hex');
let server, browser, page;
const runs = [],
  errors = [];
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const select = async (edit, start, end) => {
    await edit.focus();
    await edit.evaluate(
      (el, [start, end]) => {
        el.setSelectionRange(start, end);
        el.dispatchEvent(new Event('select', { bubbles: true }));
      },
      [start, end],
    );
  };
  const ready = async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
  };
  const finish = async (profile, sha256) => {
    await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.__lastRun);
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    assert.ok(r.compiledBlocks > 0);
    runs.push({
      profile,
      exeSha256: sha256,
      exitCode: r.exitCode,
      instructions: r.instructions,
      compiledBlocks: r.compiledBlocks,
      elapsedMs: r.elapsedMs,
      x86TranslationMs: r.x86TranslationMs,
      modules: r.modules,
      apiTrace: r.apiTrace,
    });
    await page.close();
    return r;
  };
  const exe = await readFile('tests/fixtures/clipboard/clipboard.exe');
  for (const mode of ['exe-upload', 'zip-upload', 'hosted-example']) {
    await ready();
    console.error('clipboard', mode);
    if (mode === 'hosted-example') await page.locator('[data-demo="clipboard-editor"]').click();
    else
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'clipboard.exe' : 'clipboard.zip',
        mimeType: 'application/octet-stream',
        buffer: mode === 'exe-upload' ? exe : Buffer.from(zipSync({ 'nested/renamed.exe': exe })),
      });
    await page.locator('#run').click();
    const owner = page.locator('.virtual-desktop-window').filter({
      has: page.locator('.virtual-desktop-title', { hasText: 'Native clipboard editor' }),
    });
    const first = owner.locator('[data-control-id="1"]'),
      second = owner.locator('[data-control-id="2"]');
    await expect(first).toHaveValue('select text, then use Copy / Paste or Ctrl+C / Ctrl+V', {
      timeout: 60000,
    });
    await expect(page.locator('#output')).toContainText('clipboard native startup checks passed');
    await first.fill('café — clipboard');
    await select(first, 0, 4);
    await first.press('Control+c');
    await second.fill('');
    await second.press('Control+v');
    await expect(second).toHaveValue('café');
    await second.press('Control+v');
    await expect(second).toHaveValue('cafécafé');
    await second.fill('Ω 😀 Unicode');
    await select(second, 0, 4);
    await second.press('Control+x');
    await expect(second).toHaveValue(' Unicode');
    await owner.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(second).toHaveValue('Ω 😀 Unicode');
    await select(second, 0, 4);
    await second.press('Control+c');
    await first.fill('');
    await first.press('Control+v');
    await expect(first).toHaveValue('Ω 😀');
    // Browser context-menu plain-text import follows the native paste message.
    await second.fill('');
    await second.evaluate((el) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'imported Ω\nsecond line');
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
      );
    });
    await expect(second).toHaveValue('imported Ω\nsecond line');
    await owner.screenshot({
      path: process.env.CLIPBOARD_SCREENSHOT || 'evidence/clipboard-editor.png',
    });
    await owner.locator('.virtual-desktop-close').click();
    await finish(mode, hash(exe));
  }
  const metapad = await readFile('.cache/metapad-le/metapad.exe'),
    pin = 'dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b';
  assert.equal(hash(metapad), pin);
  for (const mode of ['metapad-exe', 'metapad-zip']) {
    await ready();
    console.error('clipboard', mode);
    await page.locator('#file').setInputFiles({
      name: mode === 'metapad-exe' ? 'metapad.exe' : 'editor.zip',
      mimeType: 'application/octet-stream',
      buffer:
        mode === 'metapad-exe' ? metapad : Buffer.from(zipSync({ 'editor/original.exe': metapad })),
    });
    await page.locator('#run').click();
    const owner = page
        .locator('.virtual-desktop-window')
        .filter({ has: page.locator('.virtual-desktop-title', { hasText: /metapad$/ }) }),
      edit = owner.getByRole('textbox');
    await expect(edit).toHaveValue('', { timeout: 60000 });
    await edit.fill('native copy café');
    await select(edit, 7, 11);
    await edit.press('Control+c');
    await edit.fill('');
    await edit.press('Control+v');
    await expect(edit).toHaveValue('copy');
    await edit.press('Control+v');
    await expect(edit).toHaveValue('copycopy');
    await select(edit, 0, 4);
    await edit.press('Control+x');
    await expect(edit).toHaveValue('copy');
    await edit.press('Control+z');
    await expect(edit).toHaveValue('copycopy');
    await edit.press('Control+s');
    await expect(page.locator('#file-picker')).toBeVisible();
    await page.locator('#file-picker-name').fill('clipboard.txt');
    await page.locator('#file-picker-ok').click();
    await expect(page.locator('#file-picker')).not.toBeVisible();
    await owner.locator('.virtual-desktop-close').click();
    const result = await finish(mode, pin);
    const saved = result.outputs.find((f) => f.path.split('/').at(-1) === 'clipboard.txt');
    assert.ok(saved, 'Metapad saved an actual clipboard.txt output');
    assert.equal(Buffer.from(Object.values(saved.bytes)).toString(), 'copycopy');
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    runs,
    checks: [
      'Native SDK startup: persistent HGLOBAL, ANSI/Unicode/OEM conversion, format enumeration, native memory locking and delayed owner callbacks',
      'Unchanged Metapad PE32 EXE and renamed ZIP: real Copy/Paste/Cut/Undo accelerators, repeated paste, native save and exit zero',
      'ANSI and Unicode native edit controls: keyboard copy/cut/paste, button Undo and browser plain-text paste import',
    ],
    scope:
      'Per-runtime clipboard text and opaque HGLOBAL formats; system-wide clipboard sharing, OLE drag/drop, clipboard viewers/listeners and GDI clipboard object formats remain unsupported.',
  };
  await writeFile(
    process.env.CLIPBOARD_EVIDENCE || 'evidence/clipboard-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      status: report.status,
      runs: runs.map(({ profile, exitCode }) => ({ profile, exitCode })),
    }),
  );
} catch (e) {
  if (page && !page.isClosed())
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        output: document.querySelector('#output')?.textContent,
        fault: window.__lastFaultDiagnostic,
        run: window.__lastRun,
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
