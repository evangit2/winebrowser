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
  page = await browser.newPage({ viewport: { width: 1280, height: 1300 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page
    .locator('#file')
    .setInputFiles([
      'tests/fixtures/toolbar/toolbar.exe',
      'tests/fixtures/toolbar/toolbar-resources.dll',
    ]);
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native toolbar EXE and DLL' }),
  });
  const status = owner.locator('[data-control-id="10"]'),
    bar = owner.getByRole('toolbar');
  await status.getByText('Native toolbar ready', { exact: true }).waitFor();
  await expect(bar.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await bar.getByRole('button', { name: 'New', exact: true }).click();
  await status.getByText('New: native toolbar command', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Enable save', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await bar.getByRole('button', { name: 'Save', exact: true }).click();
  await status.getByText('Save: native toolbar command', { exact: true }).waitFor();
  const check = bar.locator('[data-toolbar-command="103"]');
  const pixel = await check
    .locator('canvas')
    .evaluate((c) => Array.from(c.getContext('2d').getImageData(5, 5, 1, 1).data));
  assert.deepEqual(pixel, [220, 40, 30, 255]);
  await check.click();
  await expect(check).toHaveAttribute('aria-pressed', 'true');
  await status.getByText('Check: native toolbar state', { exact: true }).waitFor();
  const first = bar.locator('[data-toolbar-command="104"]'),
    second = bar.locator('[data-toolbar-command="105"]');
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await second.click();
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Ω€', exact: true }).click();
  await status.getByText('Unicode: native toolbar command', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Change label', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Search', exact: true })).toBeVisible();
  assert.equal(
    Math.round(
      (await bar.getByRole('button', { name: 'Search', exact: true }).boundingBox()).width,
    ),
    80,
  );
  await owner.screenshot({ path: 'evidence/toolbar-browser.png' });
  await owner.getByRole('button', { name: 'Hide/delete', exact: true }).click();
  await expect(bar.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Ω€', exact: true })).toHaveCount(0);
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const hash = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await hash('tests/fixtures/toolbar/toolbar.exe'),
    dllSha256: await hash('tests/fixtures/toolbar/toolbar-resources.dll'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native DLL calls the 13-argument CreateToolbarEx API and loads standard Wine toolbar strips and its own RT_BITMAP strip; EXE retains text/pixels after unloading the DLL',
      'Native TBBUTTON count/index/data, rectangles, one-row sizing and Unicode insertion/text queries are checked',
      'Browser New/Save/check/group/Unicode buttons dispatch actual native WM_COMMAND callbacks; disabled buttons and exclusive checked groups use native state',
      'Custom DLL bitmap pixels are verified; native TBBUTTONINFO changes text and width, and hide/delete updates the toolbar',
      'Native window destruction exits zero with no page errors',
    ],
    scope:
      'Shared horizontal ToolbarWindow32/CreateToolbarEx controls and bitmap strips, bounded state/text/list/geometry messages and native WM_COMMAND callbacks. Image-list APIs, dropdown/customization notifications, tooltip callbacks, complete native mouse/keyboard parity and arbitrary editor execution remain incomplete.',
  };
  await writeFile('evidence/toolbar-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
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
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
