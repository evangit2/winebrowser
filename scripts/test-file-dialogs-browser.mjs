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
  const exe = await readFile('tests/fixtures/file-dialogs/file-dialogs.exe');
  const upload = [
    { path: 'file-dialogs.exe', bytes: [...exe] },
    { path: 'docs/one.txt', bytes: [...Buffer.from('first')] },
    { path: 'docs/two.txt', bytes: [...Buffer.from('second')] },
    { path: 'docs/hidden.exe', bytes: [0] },
  ];
  // Upload browser File entries with directory paths just like folder input.
  async function load() {
    await page.evaluate(async (entries) => {
      const input = document.querySelector('#file'),
        dt = new DataTransfer();
      for (const entry of entries) {
        const file = new File([new Uint8Array(entry.bytes)], entry.path.split('/').pop());
        Object.defineProperty(file, 'webkitRelativePath', { value: entry.path });
        dt.items.add(file);
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, upload);
    await page.locator('#exe').selectOption('file-dialogs.exe');
    await expect(page.locator('#run')).toBeEnabled();
    await page.locator('#run').click();
  }
  const picker = page.locator('#file-picker');
  async function title(value) {
    await expect(page.locator('#file-picker-title')).toHaveText(value);
    await expect(picker).toBeVisible();
  }
  async function exercise() {
    await title('Native cancel preserves filename');
    await expect(page.locator('#file-picker-name')).toHaveValue('keep');
    await page.locator('#file-picker-import').setInputFiles({
      name: 'cancelled-import.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('must not enter guest filesystem'),
    });
    await expect(page.locator('#file-picker-name')).toHaveValue('cancelled-import.txt');
    await page.keyboard.press('Escape');
    await title('Native A text selection');
    assert.equal(await page.locator('#file-picker-directory option[value="_opened/1"]').count(), 0);
    await page.locator('#file-picker-list').selectOption('docs');
    await page
      .locator('#file-picker-list')
      .evaluate((el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await expect(page.locator('#file-picker-directory')).toHaveValue('docs');
    assert.equal(await page.locator('#file-picker-list option').count(), 2);
    await page.locator('#file-picker-filter').selectOption('2');
    assert.equal(await page.locator('#file-picker-list option').count(), 3);
    await page.locator('#file-picker-filter').selectOption('1');
    await page.locator('#file-picker-list').selectOption('docs/one.txt');
    await page.locator('#file-picker-ok').click();
    await title('Native Unicode Save As');
    await page.locator('#file-picker-directory').selectOption('docs');
    await page.locator('#file-picker-name').fill('unicode-Ω');
    await page.locator('#file-picker-ok').click();
    await title('Native Unicode multiselect');
    await page.locator('#file-picker-directory').selectOption('docs');
    await page.locator('#file-picker-list').selectOption(['docs/one.txt', 'docs/two.txt']);
    await page.locator('#file-picker-ok').click();
    await title('Native capacity error');
    await page.locator('#file-picker-directory').selectOption('docs');
    await page.locator('#file-picker-name').fill('one.txt');
    await page.locator('#file-picker-ok').click();
    await title('Native stop lifecycle');
  }
  await load();
  await exercise();
  await picker.screenshot({ path: 'evidence/file-dialog-browser.png' });
  await page.locator('#file-picker-cancel').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  const saved = run.outputs.find((f) => f.path === 'docs/unicode-ω.txt');
  assert.ok(saved);
  assert.equal(new TextDecoder().decode(new Uint8Array(Object.values(saved.bytes))), 'native save');
  await load();
  await exercise();
  await page.locator('#file-picker-stop').click();
  await expect(picker).not.toBeVisible();
  await expect(page.locator('#state')).toHaveText('STOPPED');
  // Selecting a replacement package while the native picker is outstanding
  // must close it and must not leak a reply into the replacement worker.
  await load();
  await title('Native cancel preserves filename');
  await page.locator('#file').setInputFiles('tests/fixtures/file-dialogs/file-dialogs.exe');
  await expect(picker).not.toBeVisible();
  await expect(page.locator('#run')).toBeEnabled();
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256').update(exe).digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native OPENFILENAME v4 A Escape cancellation preserves caller filename and clears extended error',
      'Folder navigation and filters select real guest files; native A offsets/title and actual ReadFile validated',
      'Native W Save As returns Unicode name, offsets and default extension; caller creates/writes exact output bytes',
      'Native W Explorer multiselect returns directory and filenames as native double-NUL buffer',
      'Native insufficient-capacity selection returns FNERR_BUFFERTOOSMALL and required WORD size',
      'Stop dismisses waiting picker and terminates app; replacing package dismisses picker without leaking replies',
    ],
    scope:
      'Standard A/W PE32 file dialogs, local import snapshots, shared guest files and native file I/O. Native hooks/templates/help, old-style multiselect, shell namespace extensions and modern IFileDialog COM remain incomplete. Not arbitrary Windows compatibility.',
  };
  await writeFile(
    'evidence/file-dialog-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        picker: document.querySelector('#file-picker')?.innerText,
        run: window.__lastRun,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
