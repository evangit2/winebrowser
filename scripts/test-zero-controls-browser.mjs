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
  await page.locator('#file').setInputFiles('tests/fixtures/zero-controls/zero-controls.exe');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native zero-size controls' }),
  });
  await owner.getByText('Native tiny-control geometry verified', { exact: true }).waitFor();
  const edit = owner.getByRole('textbox');
  await expect(edit).toHaveValue('preserved while empty');
  await edit.fill('browser native editing');
  await owner.getByText('Native editing verified', { exact: true }).waitFor();
  const initial = await owner.boundingBox(),
    grip = owner.locator('.virtual-desktop-status-grip');
  await grip.scrollIntoViewIfNeeded();
  const box = await grip.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 75, box.y + box.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await owner.boundingBox()).width)
    .toBeGreaterThan(initial.width + 50);
  await expect(edit).toHaveValue('browser native editing');
  await owner.screenshot({ path: 'evidence/zero-controls-browser.png' });
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
      .update(await readFile('tests/fixtures/zero-controls/zero-controls.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native framed EDIT starts at 0x0, keeps its HWND/text and exposes exact outer/client bounds',
      'Native 2x3 resize suppresses a frame that cannot fit; 320x80 resize restores the 2-pixel client edge, matching Wine',
      'Native zero-size status bar with WS_EX_DLGMODALFRAME auto-lays out normally',
      'Browser editing calls native EN_CHANGE; dragging SBARS_SIZEGRIP resizes the native parent and preserves edit content through layout callbacks',
    ],
    scope:
      'Bounded child-window geometry, ordinary EDIT and status-bar resize-grip acceptance; arbitrary GUI frameworks remain unproved.',
  };
  await writeFile(
    'evidence/zero-controls-browser-results.json',
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
