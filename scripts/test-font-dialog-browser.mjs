import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/gdi-objects/font-chooser.exe');
  await page.locator('#run').click();
  const dialog = page.locator('#font-dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#font-face').inputValue(), 'Arial');
  const first = await dialog.getAttribute('data-request-token');
  await page.keyboard.press('Escape');
  await page.waitForFunction((previous) => {
    const d = document.querySelector('#font-dialog');
    return d?.open && d.dataset.requestToken !== previous;
  }, first);
  const second = await dialog.getAttribute('data-request-token');
  await page.locator('#font-face').fill('Courier New');
  await page.locator('#font-points').fill('18');
  await page.locator('#font-weight').fill('700');
  await page.locator('#font-italic').check();
  await page.locator('#font-underline').check();
  await page.locator('#font-color').fill('#1450a0');
  await dialog.screenshot({ path: 'evidence/font-picker-browser.png' });
  await page.locator('#font-ok').click();
  await page.waitForFunction((previous) => {
    const d = document.querySelector('#font-dialog');
    return d?.open && d.dataset.requestToken !== previous;
  }, second);
  assert.equal(await page.locator('#font-points').getAttribute('min'), '8');
  assert.equal(await page.locator('#font-points').getAttribute('max'), '30');
  assert.equal(await page.locator('#font-effects').isVisible(), false);
  await page.locator('#font-points').fill('31');
  await page.locator('#font-ok').click();
  assert.equal(await dialog.isVisible(), true);
  await page.locator('#font-face').fill('Arial Ω');
  await page.locator('#font-points').fill('18');
  await page.locator('#font-ok').click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-window') || window.__lastRun !== null,
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.evaluate(() => window.__lastRun), null);
  const guest = page.locator('.virtual-desktop-window');
  await page.waitForFunction(() => {
    const c = document.querySelector('.virtual-desktop-canvas');
    if (!c) return false;
    const p = c.getContext('2d').getImageData(20, 20, 290, 24).data;
    return p.some((v, i) => i % 4 === 0 && v === 20 && p[i + 1] === 80 && p[i + 2] === 160);
  });
  await guest.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  await page.locator('#file').setInputFiles('tests/fixtures/gdi-objects/font-chooser.exe');
  await page.locator('#run').click();
  await dialog.waitFor({ state: 'visible' });
  await page.locator('#font-stop').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#state').textContent(), 'STOPPED');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/gdi-objects/font-chooser.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native ChooseFontA Escape cancellation leaves LOGFONT unchanged and CommDlgExtendedError zero',
      'Native ChooseFontA returns selected family, point size, bold/italic/underline, COLORREF and nFontType from a real browser picker with live preview',
      'Native ChooseFontW returns a Unicode face, respects CF_LIMITSIZE and hides effects; invalid sizes keep the picker open',
      'Native CreateFontIndirectW consumes the selected LOGFONT and renders actual colored glyphs; close and cleanup exit zero',
      'Stop dismisses an outstanding native font picker and terminates the waiting executable',
    ],
    scope:
      'Standard screen-font A/W picker, initial selection, effects, size limits and disabled selectors. Native hooks/templates, printer filters, font inventory filters, Apply callbacks and exact Windows font matching remain incomplete.',
  };
  await writeFile(
    'evidence/font-dialog-browser-results.json',
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
