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
  await owner.screenshot({ path: 'evidence/metapad-editor-browser.png' });
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const first = await page.evaluate(() => window.__lastRun);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  const output = first.outputs.find((f) => f.path === '_dropped/1/browser-notes.txt');
  assert.ok(output);
  const bytes = new Uint8Array(Object.values(output.bytes));
  assert.equal(new TextDecoder('windows-1252').decode(bytes), saved);
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
    status: 'passed-basic-editor',
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
      'Exported native output is re-uploaded with the same EXE and reopens through its command-line file path',
    ],
    scope:
      'Basic ANSI text editing/drop/save/reopen acceptance only. Open/Save As common dialogs, Find/Replace, option/property pages, encodings and advanced editing commands remain unverified or incomplete; printing has no installed queues. Executable remains privately cached, not published. This does not establish arbitrary Windows compatibility.',
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
