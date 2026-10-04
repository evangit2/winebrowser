import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
let server, browser;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/menus/menus.exe');
  await page.locator('#run').click();
  const window = page.locator('.virtual-desktop-window');
  await window.waitFor();
  const canvas = window.locator('.virtual-desktop-canvas');
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.virtual-desktop-window .virtual-desktop-canvas');
    return canvas?.width === 240 && canvas?.height === 140;
  });
  assert.deepEqual(await canvas.evaluate((c) => [c.width, c.height]), [240, 140]);
  const edit = window.locator('input[data-control-id="50"]');
  assert.equal(await edit.inputValue(), 'Read only');
  assert.equal(await edit.evaluate((el) => el.readOnly), true);
  assert.equal(await edit.evaluate((el) => getComputedStyle(el).borderLeftWidth), '1px');
  assert.deepEqual(await edit.evaluate((el) => [el.offsetWidth, el.offsetHeight]), [110, 24]);
  const childCanvas = window.locator('canvas[data-control-id="60"]');
  await page.waitForFunction(
    () => document.querySelector('canvas[data-control-id="60"]')?.width === 110,
  );
  const pixel = (x, y) =>
    childCanvas.evaluate(
      (c, [x, y]) => [...c.getContext('2d').getImageData(x, y, 1, 1).data],
      [x, y],
    );
  assert.deepEqual(await pixel(10, 10), [17, 34, 51, 255]);
  assert.deepEqual(await pixel(2, 3), [171, 205, 239, 255]);
  await window.getByRole('button', { name: 'Repaint child', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('canvas[data-control-id="60"]')?.width === 100,
  );
  assert.deepEqual(await childCanvas.evaluate((c) => [c.width, c.height]), [100, 50]);
  assert.deepEqual(await pixel(10, 10), [90, 80, 70, 255]);
  assert.equal(await childCanvas.getAttribute('aria-label'), 'Resized native child');
  await window.getByRole('menuitem', { name: 'Actions', exact: true }).click();
  assert.equal(
    await window.getByRole('menuitem', { name: 'Disabled', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await window
      .getByRole('menuitemcheckbox', { name: 'Checked', exact: true })
      .getAttribute('aria-checked'),
    'true',
  );
  await page.keyboard.press('Escape');
  const popup = window.locator('.virtual-desktop-context-menu');
  await canvas.click({ position: { x: 25, y: 40 }, button: 'right' });
  await popup.waitFor();
  assert.equal(
    await popup.getByRole('menuitem', { name: 'Disabled', exact: true }).isDisabled(),
    true,
  );
  await popup.getByRole('menuitemcheckbox', { name: 'Checked', exact: true }).click();
  await popup.waitFor({ state: 'detached' });
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Returned 8',
  );
  await canvas.click({ position: { x: 45, y: 50 }, button: 'right' });
  await popup.waitFor();
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'detached' });
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Cancelled',
  );
  await canvas.click({ position: { x: 65, y: 60 }, button: 'right' });
  await popup.waitFor();
  await page.keyboard.press('r');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'WM_COMMAND 7',
  );
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/menus/menus.exe'))
      .digest('hex'),
    exitCode: run.exitCode,
    checks: [
      'Native dynamic menu bar honors disabled and checked items and client geometry',
      'Native PE32 MENUITEMINFO A/W updates and queries preserve IDs/data/default/radio state, nested command lookup and bounded CP1252/Unicode strings',
      'Native radio selection by position/command retains radio type; rejected submenu cycles and unsupported types leave original items intact',
      'Native 44/48-byte MENUITEMINFO layouts validate size and incompatible masks',
      'Native WS_EX_STATICEDGE read-only edit preserves one-pixel frame and client dimensions',
      'Native EM_SETREADONLY toggles ES_READONLY while programmatic WM_SETTEXT remains available',
      'Native GetUserNameA size probe retries with BOOL success and ERROR_INSUFFICIENT_BUFFER',
      'Native custom dialog class retains DLGWINDOWEXTRA context and DefDlgProc dispatches the application dialog procedure',
      'Native DefDlgProc paints default COLOR_BTNFACE and honors application WM_CTLCOLORDLG brushes',
      'Native SS_OWNERDRAW parent callback paints an isolated child HDC and repaints after text, resize and disabled-state changes',
      'TrackPopupMenu waits for the actual second command and returns ID 8',
      'TrackPopupMenuEx Escape cancels and returns zero',
      'Context-menu R mnemonic dispatches WM_COMMAND 7 without TPM_RETURNCMD',
      'Guest close exits zero',
    ],
    scope:
      'Independent native Win32 contract fixture, translated inside ordinary Chromium. Owner-drawn static controls and left/top aligned text popups are tested; owner-drawn/bitmap menus, alignment/exclusion rectangles and MENUEX are not.',
  };
  await writeFile('evidence/menus-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
