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
  const exe = await readFile('.cache/metapad-le/metapad.exe');
  const exeSha256 = createHash('sha256').update(exe).digest('hex');
  assert.equal(exeSha256, 'dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b');
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const upload = async (ini) => {
    await page.locator('#file').setInputFiles([
      { name: 'metapad.exe', mimeType: 'application/octet-stream', buffer: exe },
      { name: 'settings.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') },
      { name: 'metapad.ini', mimeType: 'text/plain', buffer: ini },
    ]);
    await page.locator('#args').fill(JSON.stringify(['/i', 'settings.txt']));
    await page.locator('#run').click();
  };
  await upload(Buffer.from('; appearance preferences\r\n[Options]\r\n'));
  const owner = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /metapad$/ }) });
  const edit = owner.getByRole('textbox');
  const sheet = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Settings$/ }) });
  await expect(edit).toHaveValue('alpha');
  const openView = async () => {
    await edit.press('Alt+Enter');
    await sheet.getByRole('tab', { name: 'View', exact: true }).click();
  };
  await openView();
  await sheet.locator('[data-control-id="1023"]').click();
  await expect(page.locator('#font-dialog')).toBeVisible();
  await page.locator('#font-face').fill('Arial');
  await page.locator('#font-points').fill('18');
  await page.locator('#font-weight').fill('700');
  await page.locator('#font-italic').check();
  await page.locator('#font-ok').click();
  await expect(sheet.locator('[data-control-id="1023"]')).toHaveCSS('font-size', '24px');
  await expect(sheet.locator('[data-control-id="1020"]')).toHaveAttribute('aria-checked', 'true');
  await sheet.locator('[data-control-id="1050"]').click();
  await sheet.locator('[data-control-id="1049"]').click();
  await expect(page.locator('#color-dialog')).toBeVisible();
  await page.locator('#color-rgb').fill('#1450a0');
  await page.locator('#color-ok').click();
  await sheet.locator('[data-control-id="1048"]').click();
  await expect(page.locator('#color-dialog')).toBeVisible();
  await page.locator('#color-rgb').fill('#e8f0ff');
  await page.locator('#color-ok').click();
  await sheet.screenshot({ path: 'evidence/metapad-appearance-browser.png' });
  await sheet.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(edit).toHaveCSS('font-size', '24px');
  await expect(edit).toHaveCSS('font-weight', '700');
  await expect(edit).toHaveCSS('font-style', 'italic');
  await expect(edit).toHaveCSS('color', 'rgb(20, 80, 160)');
  await expect(edit).toHaveCSS('background-color', 'rgb(232, 240, 255)');
  const appearance = await edit.evaluate((e) => ({
    font: getComputedStyle(e).font,
    color: getComputedStyle(e).color,
    background: getComputedStyle(e).backgroundColor,
  }));
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const ini = run.outputs.find((f) => f.path === 'metapad.ini');
  assert.ok(ini);
  const iniText = Buffer.from(Object.values(ini.bytes)).toString();
  assert.match(iniText, /nPrimaryFont=1/);
  assert.deepEqual(
    [...Buffer.from(/FontColour=([^\r\n]+)/.exec(iniText)[1], 'base64').slice(0, 3)],
    [20, 80, 160],
  );
  assert.deepEqual(
    [...Buffer.from(/BackColour=([^\r\n]+)/.exec(iniText)[1], 'base64').slice(0, 3)],
    [232, 240, 255],
  );
  assert.match(iniText, /bSystemColours=0/);
  await upload(Buffer.from(Object.values(ini.bytes)));
  await expect(edit).toHaveValue('alpha');
  await expect(edit).toHaveCSS('font-size', '24px');
  await expect(edit).toHaveCSS('font-weight', '700');
  await expect(edit).toHaveCSS('font-style', 'italic');
  await expect(edit).toHaveCSS('color', 'rgb(20, 80, 160)');
  await expect(edit).toHaveCSS('background-color', 'rgb(232, 240, 255)');
  await openView();
  await expect(sheet.locator('[data-control-id="1020"]')).toHaveAttribute('aria-checked', 'true');
  await sheet.locator('[data-control-id="1023"]').click();
  await expect(page.locator('#font-dialog')).toBeVisible();
  await expect(page.locator('#font-face')).toHaveValue('Arial');
  await expect(page.locator('#font-points')).toHaveValue('18');
  await page.locator('#font-cancel').click();
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const second = await page.evaluate(() => window.__lastRun);
  assert.equal(second.exitCode, 0, JSON.stringify(second));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256,
    status: 'passed-font-and-color-settings',
    exitCode: run.exitCode,
    exitCodes: [run.exitCode, second.exitCode],
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    appearance,
    checks: [
      'Unchanged native Metapad ChooseFontA returns Arial 18pt bold italic; native CreateFontIndirectA sets both the preview button and real editor to the chosen font',
      'Unchanged native ChooseColorA returns foreground/background COLORREF; native View PSN_APPLY and WritePrivateProfileStringA save exact color values and disabled system-colors preference',
      'Native WM_CTLCOLOREDIT runs with a real HDC and its brush/text colors reach the actual editor; content stays intact and native closure exits zero',
      'Uploaded native INI output restores the chosen font and actual editor colors in a fresh native run; reopening/canceling the font picker and Settings preserves them',
    ],
    scope:
      'Bounded View settings font/color selection and INI persistence. Native hooks/templates, language plugins, printing and arbitrary GUI frameworks remain unproved.',
  };
  await writeFile(
    'evidence/metapad-appearance-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        notice: document.querySelector('#dialog-text')?.textContent,
        run: window.__lastRun,
        windows: [...document.querySelectorAll('.virtual-desktop-window')].map((e) => e.innerText),
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
