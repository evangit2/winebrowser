import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
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
  await page
    .locator('#file')
    .setInputFiles([
      'tests/fixtures/host-subclass/host-subclass.exe',
      'tests/fixtures/host-subclass/hook.dll',
    ]);
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    edit = root.locator('input[data-control-id="80"]'),
    sibling = root.locator('input[data-control-id="81"]'),
    wide = root.locator('input[data-control-id="82"]');
  const title = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.virtual-desktop-title')?.textContent === text,
      text,
    );
  await title('Subclass ready');
  assert.equal(await edit.inputValue(), 'native');
  assert.equal(await sibling.inputValue(), 'sibling');
  assert.equal(await wide.inputValue(), 'Unicode λ');
  await edit.fill('reject');
  await title('Text vetoed');
  await expect(edit).toHaveValue('native');
  await edit.fill('typed');
  await title('Typed through subclass');
  assert.equal(await sibling.inputValue(), 'sibling');
  await edit.press('F2');
  await title('Subclass keyboard');
  await edit.press('Tab');
  await title('Tab owned by subclass');
  await expect(edit).toBeFocused();
  const check = root.getByRole('checkbox', { name: 'Hooked checkbox', exact: true });
  await check.click();
  await title('Click vetoed');
  assert.equal(await check.getAttribute('aria-checked'), 'false');
  await root.getByRole('button', { name: 'Allow button', exact: true }).click();
  await title('Button allowed');
  await check.click();
  await title('Click forwarded');
  assert.equal(await check.getAttribute('aria-checked'), 'true');
  const list = root.getByRole('listbox', { name: 'Hooked items', exact: true });
  assert.deepEqual(await list.getByRole('option').allTextContents(), ['Alpha', 'Beta']);
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/host-subclass-gui.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const digest = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await digest('tests/fixtures/host-subclass/host-subclass.exe'),
    dllSha256: await digest('tests/fixtures/host-subclass/hook.dll'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Real callable class procedures for ANSI/Unicode Edit, Button and ListBox; direct guest calls and CallWindowProc use stdcall',
      'Companion native DLL replaces per-window procedures; an EXE adds a second forwarding layer while siblings retain base behavior',
      'Subclass text veto restores browser state; accepted edits reach native EN_CHANGE; keyboard and WM_GETDLGCODE retain Tab focus',
      'Subclass BM_CLICK veto prevents checkbox state/command; forwarded clicks execute base behavior and notify the parent',
      'Original procedures restore cleanly; native destruction callbacks and invalid HWND errors remain correct',
    ],
    scope:
      'Matching-encoding per-window host-control subclassing in ordinary Chromium. Class replacement, cross-encoding procedure handles, full native text/mouse/IME behavior and universal GUI/DLL compatibility remain incomplete. Browser text commits are routed as WM_SETTEXT and semantic button clicks as BM_CLICK.',
  };
  await writeFile(
    'evidence/host-subclass-browser-results.json',
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
