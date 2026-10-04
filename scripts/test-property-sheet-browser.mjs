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
  const toggle = async (parent, name, checked) => {
    const control = parent.getByRole('checkbox', { name });
    await control.click();
    await expect(control).toHaveAttribute('aria-checked', String(checked));
  };
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
      'tests/fixtures/property-sheet/property-sheet.exe',
      'tests/fixtures/property-sheet/settings-pages.dll',
    ]);
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native property sheet EXE and DLL' }),
  });
  await owner.getByText('Settings ready', { exact: true }).waitFor();
  await owner.getByRole('button', { name: 'Modal settings', exact: true }).click();
  const sheet = (name) =>
    page
      .locator('.virtual-desktop-window')
      .filter({ has: page.locator('.virtual-desktop-title', { hasText: name }) });
  const modal = sheet('Modal native settings');
  await modal.getByRole('textbox').waitFor();
  await modal.getByRole('textbox').fill('edited by browser');
  await modal.getByRole('textbox').press('Tab');
  await expect(modal.getByRole('checkbox', { name: 'Keep this page active' })).toBeFocused();
  await toggle(modal, 'Keep this page active', true);
  await modal.getByRole('tab', { name: 'Appearance Ω', exact: true }).click();
  await modal.getByText('Native tab veto', { exact: true }).waitFor();
  await expect(modal.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await toggle(modal, 'Keep this page active', false);
  await modal.getByRole('tab', { name: 'Appearance Ω', exact: true }).click();
  await toggle(modal, 'Reject Apply', true);
  await modal.getByRole('button', { name: 'Apply', exact: true }).click();
  await modal.getByText('Native Apply veto', { exact: true }).waitFor();
  await toggle(modal, 'Reject Apply', false);
  await modal.getByRole('button', { name: 'Apply', exact: true }).click();
  await modal
    .locator('[data-control-id="22"]')
    .getByText('Applied by native DLL', { exact: true })
    .waitFor();
  await expect(modal.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await modal.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(modal.getByRole('textbox')).toHaveValue('edited by browser');
  await modal.screenshot({ path: 'evidence/property-sheet-browser.png' });
  await modal.getByRole('button', { name: 'OK', exact: true }).click();
  await owner.getByText('Modal native success', { exact: true }).waitFor();
  await expect(modal).toHaveCount(0);
  await owner.getByRole('button', { name: 'Modeless settings', exact: true }).click();
  const modeless = sheet('Modeless native settings');
  await modeless.getByRole('textbox').waitFor();
  await modeless.getByRole('tab', { name: 'Appearance Ω', exact: true }).click();
  await toggle(modeless, 'Reject Cancel', true);
  await modeless.getByRole('button', { name: 'Cancel', exact: true }).click();
  await modeless.getByText('Native Cancel veto', { exact: true }).waitFor();
  await toggle(modeless, 'Reject Cancel', false);
  await modeless.locator('.virtual-desktop-close').click();
  await owner.getByText('Settings callbacks verified', { exact: true }).waitFor();
  await expect(modeless).toHaveCount(0);
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const hash = async (p) =>
    createHash('sha256')
      .update(await readFile(p))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await hash('tests/fixtures/property-sheet/property-sheet.exe'),
    dllSha256: await hash('tests/fixtures/property-sheet/settings-pages.dll'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native Unicode property sheets use DLL dialog resources and preserve page edits across tabs',
      'PSN_KILLACTIVE, PSN_APPLY and PSN_QUERYCANCEL validation vetoes execute inside native DLL procedures',
      'Apply clears dirty state, OK returns modal success and restores the owner',
      'Modeless closure exposes native result/current-page state; application destroys the sheet and verifies all page initialization/reset/release callbacks',
    ],
    scope:
      'Classic tabbed modal/modeless property sheets; wizard flows, dynamic page insertion/removal, icons/help/RTL and printing remain unsupported. This authored fixture does not prove unchanged Metapad or arbitrary Windows application execution.',
  };
  await writeFile(
    'evidence/property-sheet-browser-results.json',
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
