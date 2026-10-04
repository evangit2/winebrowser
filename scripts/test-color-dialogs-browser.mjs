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
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const path = 'tests/fixtures/color-dialogs/color-dialogs.exe';
  const upload = async () => {
    await page.locator('#file').setInputFiles(path);
    await page.locator('#run').click();
  };
  await upload();
  const dialog = page.locator('#color-dialog');
  const next = async (action) => {
    const token = await dialog.getAttribute('data-request-token');
    await action();
    await page.waitForFunction((previous) => {
      const d = document.querySelector('#color-dialog');
      return d?.open && d.dataset.requestToken !== previous;
    }, token);
  };
  await expect(dialog).toBeVisible();
  await expect(page.locator('#color-rgb')).toHaveValue('#010203');
  await next(() => page.keyboard.press('Escape'));
  await page.locator('#color-rgb').fill('#1450a0');
  await page.locator('#color-add').click();
  await next(() => page.locator('#color-ok').click()); // native owner veto
  await expect(page.locator('#color-rgb')).toHaveValue('#1450a0');
  await expect(page.locator('[data-color-slot="0"]')).toHaveAttribute('aria-label', /1450a0/);
  await page.locator('#color-rgb').fill('#2878c8');
  await page.locator('#color-add').click();
  await expect(page.locator('[data-color-slot="8"]')).toHaveAttribute('aria-label', /2878c8/);
  await dialog.screenshot({ path: 'evidence/color-dialogs-browser.png' });
  await next(() => page.locator('#color-ok').click());
  await page.locator('#color-red').fill('200');
  await page.locator('#color-green').fill('100');
  await page.locator('#color-blue').fill('50');
  await expect(page.locator('#color-rgb')).toHaveValue('#c86432');
  await page.locator('#color-add').click();
  await next(() => page.locator('#color-cancel').click());
  await expect(page.locator('#color-advanced')).toBeHidden();
  await expect(page.locator('#color-expand')).toBeDisabled();
  await expect(page.locator('#color-preview')).toHaveText('#000000');
  await page.locator('[data-color-slot="0"]').click();
  await expect(page.locator('#color-preview')).toHaveText('#C86432');
  await page.locator('#color-ok').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  await upload();
  await expect(dialog).toBeVisible();
  await page.locator('#color-stop').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#state')).toHaveText('STOPPED');
  await upload();
  await expect(dialog).toBeVisible();
  await page.locator('#file').setInputFiles('public/demos/console/console.exe');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  assert.equal((await page.evaluate(() => window.__lastRun)).exitCode, 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native ChooseColorA/W share a real picker and COLORREF byte order; initial RGB and Escape cancellation preserve result and untouched custom palette',
      'Native registered ColorOK owner veto reopens the pending selection, preserves palette and next custom slot, then accepts a different RGB color; disabled owner is restored',
      'Custom colors use native column order and survive Cancel; RGB numeric fields and selected custom colors feed unchanged native memory',
      'CC_PREVENTFULLOPEN hides/disables custom expansion even with CC_FULLOPEN; unsupported hooks return an explicit common-dialog error',
      'Stop and replacement dismiss pending pickers; replacement native executable receives no stale response and exits zero',
    ],
    scope:
      'Solid RGB A/W color selection, custom colors and owner ColorOK validation. Native dialog HWNDs/hooks/templates/help, arbitrary GUI frameworks, palette devices and exact Windows dialog rendering remain incomplete.',
  };
  await writeFile(
    'evidence/color-dialogs-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
