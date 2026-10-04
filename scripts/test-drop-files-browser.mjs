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
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/drop-files/drop-files.exe');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native dropped file editor' }),
  });
  await owner.getByText('Drop text files here', { exact: true }).waitFor();
  const drop = async () => {
    // Exercise browser DataTransfer/File -> desktop -> worker -> native WM_DROPFILES.
    await owner.locator('.virtual-desktop-viewport').evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['hello'], 'plain.txt', { type: 'text/plain' }));
      const text = 'café Ω',
        body = new Uint8Array(2 + text.length * 2),
        view = new DataView(body.buffer);
      view.setUint16(0, 0xfeff, true);
      for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
      transfer.items.add(new File([body], 'café Ω.txt', { type: 'text/plain' }));
      const rect = element.querySelector(':scope > canvas').getBoundingClientRect();
      element.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: Math.round(rect.left) + 24,
          clientY: Math.round(rect.top) + 76,
        }),
      );
      element.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: Math.round(rect.left) + 24,
          clientY: Math.round(rect.top) + 76,
        }),
      );
    });
  };
  await drop();
  await owner.getByText('Native read: hello and Unicode café Ω', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Disable file drops', exact: true }).click();
  await owner.getByRole('button', { name: 'Enable file drops', exact: true }).waitFor();
  await drop();
  await page.waitForTimeout(250);
  await expect(
    owner.getByText('Native read: hello and Unicode café Ω', { exact: true }),
  ).toBeVisible();
  await owner.getByRole('button', { name: 'Enable file drops', exact: true }).click();
  await owner.getByRole('button', { name: 'Disable file drops', exact: true }).waitFor();
  await drop();
  await owner.getByText('Second native file drop verified', { exact: true }).waitFor();
  await owner.screenshot({ path: 'evidence/drop-files-browser.png' });
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  assert.equal(run.outputs.length, 0);
  assert.ok(run.compiledBlocks > 0);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/drop-files/drop-files.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Browser File/DataTransfer drops deliver real Unicode HGLOBAL WM_DROPFILES to a native PE32 window',
      'ANSI/Unicode filename count, length and bounded copy calls execute natively; POINT carries actual client coordinates',
      'Native CreateFileW/ReadFile reads ASCII and UTF16 files; IsTextUnicode distinguishes them',
      'DragAcceptFiles disables/re-enables drops, two batches stay isolated, DragFinish frees the allocation',
      'Dropped input files do not become generated downloads',
    ],
    scope:
      'Classic top-level/child file drops within the isolated package filesystem; directory dragging and OLE IDataObject drag/drop remain unsupported. Authored fixture does not establish arbitrary Windows compatibility.',
  };
  await writeFile(
    'evidence/drop-files-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun && {
          error: window.__lastRun.error,
          exitCode: window.__lastRun.exitCode,
          trace: window.__lastRun.apiTrace?.slice(-20),
        },
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
