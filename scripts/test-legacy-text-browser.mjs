import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
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
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/legacy-text/legacy-text.exe');
  await page.locator('#run').click();
  await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.match(await page.locator('#output').textContent(), /legacy-text-ok/);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/legacy-text/legacy-text.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native lstrcpy/lstrcpyn/lstrcat A/W calls preserve CP1252 bytes and UTF-16 units, return the destination and terminate bounded copies',
      'ANSI/Unicode character classification shares bootstrap CT_CTYPE1 categories; letters and digits stay distinct',
      'CP1252/CP437 OEM conversion handles embedded NULs, exact counts, unchanged sentinels and overlapping buffers',
      'Native five-argument GetStringTypeA and four-argument GetStringTypeW calls preserve PE32 stack ABI and include NUL for count -1',
      'Dialog base units agree with the virtual default dialog mapping',
    ],
    scope:
      'Shared bootstrap text services in ordinary Chromium. ANSI/OEM pages are 1252/437; Unicode category data follows the browser. CT_CTYPE2/3 and other locale/code-page behavior are not claimed.',
  };
  await writeFile(
    'evidence/legacy-text-browser-results.json',
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
