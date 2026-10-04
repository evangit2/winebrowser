import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
let server, browser, page;
try {
  const exe = await readFile('.cache/metapad-le/metapad.exe');
  const sha256 = createHash('sha256').update(exe).digest('hex');
  assert.equal(sha256, 'dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b');
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
  const owner = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /metapad$/ }) });
  const edit = owner.getByRole('textbox');
  const input = { name: 'metapad.exe', mimeType: 'application/octet-stream', buffer: exe };
  await page.locator('#file').setInputFiles(input);
  await page.locator('#run').click();
  await edit.waitFor();
  await expect(edit).toHaveValue('');
  await expect(page.locator('#messagebox')).not.toBeVisible();
  assert.ok((await owner.locator('.virtual-desktop-control-toolbar button canvas').count()) >= 15);
  await edit.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello metapad\r\n'], 'browser-notes.txt', { type: 'text/plain' }));
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: Math.round(rect.left) + 10,
        clientY: Math.round(rect.top) + 10,
      }),
    );
  });
  await expect(edit).toHaveValue('hello metapad\n');
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('browser-notes.txt - metapad');
  const saved = 'saved from the unchanged native editor';
  await edit.fill(saved);
  await edit.press('Control+s');
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('browser-notes.txt - metapad');
  const picker = page.locator('#file-picker');
  await edit.press('Control+F2');
  await picker.waitFor({ state: 'visible' });
  await expect(page.locator('#file-picker-title')).toHaveText(/Save/i);
  await page.locator('#file-picker-directory').selectOption('');
  await page.locator('#file-picker-name').fill('metapad-saved');
  await picker.screenshot({ path: 'evidence/metapad-save-dialog-browser.png' });
  await page.locator('#file-picker-ok').click();
  await expect(picker).not.toBeVisible();
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('metapad-saved.txt - metapad');
  // Actual native Open, including a cancelled picker and opening an imported
  // browser snapshot. The untouched EXE remains the code performing reads.
  await edit.press('Control+o');
  await picker.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(edit).toHaveValue(saved);
  await edit.press('Control+o');
  await picker.waitFor({ state: 'visible' });
  await page.locator('#file-picker-name').fill('missing-native-file.txt');
  await page.locator('#file-picker-ok').click();
  await expect(page.locator('#file-picker-error')).toHaveText('That file does not exist.');
  await expect(picker).toBeVisible();
  await page.locator('#file-picker-import').setInputFiles({
    name: 'imported.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('opened through native dialog\r\n'),
  });
  await expect(page.locator('#file-picker-name')).toHaveValue('imported.txt');
  await page.locator('#file-picker-ok').click();
  await expect(edit).toHaveValue('opened through native dialog\n');
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('imported.txt - metapad');
  const replaced = 'native overwrite confirmed';
  await edit.fill(replaced);
  await edit.press('Control+F2');
  await picker.waitFor({ state: 'visible' });
  await page.locator('#file-picker-directory').selectOption('');
  await page.locator('#file-picker-name').fill('metapad-saved.txt');
  await page.locator('#file-picker-ok').click();
  await expect(page.locator('#file-picker-confirmation')).toBeVisible();
  await page.locator('#file-picker-confirm-no').click();
  await expect(picker).toBeVisible();
  await page.locator('#file-picker-ok').click();
  await page.locator('#file-picker-confirm-yes').click();
  await expect(picker).not.toBeVisible();
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('metapad-saved.txt - metapad');
  await edit.press('Control+o');
  await picker.waitFor({ state: 'visible' });
  await page.locator('#file-picker-directory').selectOption('');
  await page.locator('#file-picker-list').selectOption('metapad-saved.txt');
  await page.locator('#file-picker-ok').click();
  await expect(edit).toHaveValue(replaced);
  await owner.screenshot({ path: 'evidence/metapad-editor-browser.png' });
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const first = await page.evaluate(() => window.__lastRun);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  const output = first.outputs.find((f) => f.path === '_dropped/1/browser-notes.txt');
  assert.ok(output);
  const bytes = new Uint8Array(Object.values(output.bytes));
  assert.equal(new TextDecoder('windows-1252').decode(bytes), saved);
  const saveAsOutput = first.outputs.find((f) => f.path === 'metapad-saved.txt');
  assert.ok(saveAsOutput);
  assert.equal(
    new TextDecoder().decode(new Uint8Array(Object.values(saveAsOutput.bytes))),
    replaced,
  );
  assert.ok(!first.outputs.some((f) => f.path === '_opened/1/imported.txt'));
  assert.ok(first.compiledBlocks > 0);
  assert.ok(first.apiTrace.includes('advapi32.dll!IsTextUnicode'));
  // Re-upload the real native save output, then use the app's unchanged argv
  // file-opening path to prove persistence across a new runtime session.
  await page
    .locator('#file')
    .setInputFiles([
      input,
      { name: 'browser-notes.txt', mimeType: 'text/plain', buffer: Buffer.from(bytes) },
    ]);
  await page.locator('#args').fill(JSON.stringify(['browser-notes.txt']));
  await page.locator('#run').click();
  await expect(edit).toHaveValue(saved);
  await expect(owner.locator('.virtual-desktop-title')).toHaveText('browser-notes.txt - metapad');
  await expect(page.locator('#messagebox')).not.toBeVisible();
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const second = await page.evaluate(() => window.__lastRun);
  assert.equal(second.exitCode, 0, JSON.stringify(second));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed-editor-file-dialogs',
    target: 'Metapad 3.6 Light Edition, unchanged official native i386 executable',
    exeSha256: sha256,
    binarySource: 'https://liquidninja.com/metapad/downloads/metapad36LE.zip',
    upstreamSource: 'https://github.com/alexd/metapad',
    runs: [first, second].map((r) => ({
      exitCode: r.exitCode,
      compiledBlocks: r.compiledBlocks,
      x86TranslationMs: r.x86TranslationMs,
      instructions: r.instructions,
      elapsedMs: r.elapsedMs,
    })),
    checks: [
      'Unchanged native editor starts without error notices; native toolbar bitmap cells render',
      'Browser text-file drop invokes native shell queries, real file reads and editor loading',
      'DOM editing plus native Ctrl+S accelerator writes real filesystem output; app closes with exit zero',
      'Native Save As writes a selected name with default .txt extension; Cancel preserves the current editor',
      'Native Open rejects a missing file, imports a local text snapshot and reads it through ordinary guest file APIs',
      'Native Save As overwrite No stays open; Yes replaces the real file, which native Open reopens with matching text',
      'Exported native output is re-uploaded with the same EXE and reopens through its command-line file path',
    ],
    scope:
      'ANSI editing/drop/save/reopen and standard Open/Save As dialogs. Find/Replace, option/property pages, encodings and advanced editing commands remain unverified or incomplete; file-dialog hooks/templates and legacy multiselect remain incomplete; printing has no installed queues. Executable remains privately cached, not published. This does not establish arbitrary Windows compatibility.',
  };
  await writeFile(
    'evidence/metapad-gui-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        notice: document.querySelector('#messagebox')?.innerText,
        run: window.__lastRun && {
          exitCode: window.__lastRun.exitCode,
          error: window.__lastRun.error,
          trace: window.__lastRun.apiTrace?.slice(-25),
        },
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
