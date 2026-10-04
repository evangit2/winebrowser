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
  await page.locator('#file').setInputFiles('tests/fixtures/printerless/printerless.exe');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native printerless contracts' }),
  });
  await owner.getByText('Native default-printer and GDI checks passed', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Print', exact: true }).click();
  const notice = page.locator('#messagebox');
  await notice.getByText('No Windows printers are installed.', { exact: true }).waitFor();
  await expect(owner).toHaveAttribute('inert', '');
  await notice.getByRole('button', { name: 'OK', exact: true }).click();
  await owner.getByText('Native PrintDlg: no installed queues', { exact: true }).waitFor();
  await expect(owner).not.toHaveAttribute('inert', '');
  await owner.getByRole('button', { name: 'Page Setup', exact: true }).click();
  await notice.getByText('No default Windows printer is installed.', { exact: true }).waitFor();
  await notice.getByRole('button', { name: 'OK', exact: true }).click();
  await owner.getByText('Native PageSetup: no default printer', { exact: true }).waitFor();
  await owner.screenshot({ path: 'evidence/printerless-browser.png' });
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
      .update(await readFile('tests/fixtures/printerless/printerless.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native A/W default-printer and page-setup queries return genuine missing-printer errors with structure validation',
      'Native display/bitmap DC printing follows Wine null-device results; SetAbortProc executes the native callback and no job starts',
      'Print/Page Setup display real no-printer notices; the owner disables and restores around modal requests',
      'Native app receives FALSE/error results, exits zero and exports no fabricated print output',
    ],
    scope:
      'Runtime has zero installed Windows printer queues and no printer DCs, spool jobs, driver loading or browser print backend. This validates accurate unavailable-device contracts, not printing support.',
  };
  await writeFile(
    'evidence/printerless-browser-results.json',
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
