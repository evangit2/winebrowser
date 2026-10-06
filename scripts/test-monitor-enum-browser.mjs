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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/monitor-enum/monitor-enum.exe');
  await page.waitForFunction(
    () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.locator('#state').textContent(), 'LOADED');
  assert.equal(
    await page.locator('#run').isEnabled(),
    true,
    await page.locator('#details').textContent(),
  );
  await page.locator('#run').click();
  await page.waitForFunction(
    () => window.__lastRun != null || document.querySelector('#state')?.textContent === 'ERROR',
    null,
    { timeout: 60000 },
  );
  const run = await page.evaluate(() => window.__lastRun);
  assert.ok(run, await page.locator('#status').textContent());
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/monitor-enum/monitor-enum.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged authored MIT PE32 calls EnumDisplayMonitors with actual native stdcall callbacks, monitor queries, cancellation and reentrant enumeration',
      'Optional signed/empty/outside clipping rectangles filter callbacks without changing caller input',
      'Nested HWND DCs return client-relative monitor bounds intersected with GDI clip bounds and optional query rectangles',
      'Partly offscreen HWND DCs clip to the monitor in client coordinates; memory DC enumeration respects the selected bitmap bounds',
      'Invalid and released DCs fail without callbacks; native release and window destruction exit zero',
    ],
    scope:
      'One virtual monitor and the existing MM_TEXT GDI DC model. Multiple monitors, mapping transforms and full visible-region/occlusion semantics remain unfinished.',
  };
  await writeFile(
    'evidence/monitor-enum-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        details: document.querySelector('#details')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
