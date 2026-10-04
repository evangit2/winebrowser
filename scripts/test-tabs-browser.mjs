import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  await page.locator('#file').setInputFiles('tests/fixtures/tabs/tabs.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    tabs = root.getByRole('tablist', { name: 'Settings', exact: true });
  const title = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.virtual-desktop-title')?.textContent === text,
      text,
    );
  const tab = (name) => tabs.getByRole('tab', { name, exact: true });
  const edit = (id) => root.locator(`input[data-control-id="${id}"]`);
  await tab('Advanced').waitFor();
  await expect(edit(80)).toBeVisible();
  await tab('Display').click();
  await title('Change vetoed');
  assert.equal(await tab('General').getAttribute('aria-selected'), 'true');
  await expect(edit(81)).toBeHidden();
  await root.getByRole('button', { name: 'Allow changes', exact: true }).click();
  await title('Changes allowed');
  await tab('Display').click();
  await title('Selected Display');
  await expect(edit(80)).toBeHidden();
  await expect(edit(81)).toBeVisible();
  await edit(81).fill('Browser profile');
  await tab('Advanced').click();
  await title('Selected Advanced');
  await expect(edit(82)).toBeVisible();
  await expect(edit(81)).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await title('Selected Display');
  assert.equal(await edit(81).inputValue(), 'Browser profile');
  await tabs.press('ArrowLeft');
  await title('Selected General');
  assert.equal(await tab('General').getAttribute('aria-selected'), 'true');
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/tabs-gui.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/tabs/tabs.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'PE32 TCITEMA/W text and LPARAM, insert/delete, selected/focused state and programmatic selection without notifications',
      'Fixed tab rectangles, hit testing and reversible page/client rectangle conversion',
      'Native WM_NOTIFY selection veto, mouse change and packed NMTCKEYDOWN keyboard navigation',
      'Application-owned page visibility and edited text survive tab changes; destruction exits zero',
    ],
    scope:
      'Horizontal single-row text tabs in ordinary Chromium. Native code owns pages. Images, vertical/multiline/button/owner-drawn tabs, tooltip windows, custom item data sizes and universal common-control coverage remain incomplete. Resource-font variable text widths use host Canvas metrics with bounded fallback; default widths remain estimates.',
  };
  await writeFile('evidence/tabs-browser-results.json', JSON.stringify(report, null, 2) + '\n');
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
