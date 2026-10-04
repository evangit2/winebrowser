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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/statusbar/statusbar.exe');
  await page.locator('#run').click();
  const window = page.locator('.virtual-desktop-window'),
    bar = window.locator('[data-control-id="50"]'),
    fixed = window.locator('[data-control-id="51"]');
  await expect(bar.locator('[data-status-part="0"]')).toHaveText('café €', { timeout: 60000 });
  const ready = bar.locator('[data-status-part="1"]');
  await expect(ready).toHaveText('Ready Ω');
  assert.equal(await ready.getAttribute('title'), 'Native tip');
  assert.equal(await ready.evaluate((el) => getComputedStyle(el).borderLeftStyle), 'outset');
  assert.equal(
    await bar.evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(220, 230, 240)',
  );
  assert.deepEqual(await bar.evaluate((el) => [el.offsetWidth, el.offsetHeight]), [360, 26]);
  await expect(fixed.locator('[data-status-part="0"]')).toHaveText('LeftMiddleRight');
  assert.deepEqual(await fixed.locator('[data-status-part="0"] span').allTextContents(), [
    'Left',
    'Middle',
    'Right',
  ]);
  await ready.click();
  await expect(window.locator('.virtual-desktop-title')).toHaveText('Native status click');
  await window.getByRole('button', { name: 'Toggle simple', exact: true }).click();
  await expect(window.locator('.virtual-desktop-title')).toHaveText('Simple status');
  await expect(bar).toHaveAttribute('data-simple', 'true');
  await expect(bar.locator('[data-status-part="255"]')).toHaveText('Simple progress');
  await bar.locator('[data-status-part="255"]').click();
  await expect(window.locator('.virtual-desktop-title')).toHaveText('Native status click');
  await window.getByRole('button', { name: 'Toggle simple', exact: true }).click();
  await expect(bar).toHaveAttribute('data-simple', 'false');
  await expect(ready).toHaveText('Ready Ω');
  await expect(bar.locator('[data-status-part="0"]')).toHaveText('café €');
  await window.getByRole('button', { name: 'Resize owner', exact: true }).click();
  await expect(window.locator('.virtual-desktop-title')).toHaveText('Resized status');
  await expect
    .poll(() => bar.evaluate((el) => [el.offsetWidth, el.offsetHeight]))
    .toEqual([460, 26]);
  assert.deepEqual(await fixed.evaluate((el) => [el.offsetWidth, el.offsetHeight]), [330, 26]);
  assert.equal(await bar.evaluate((el) => el.parentElement.style.top), '194px');
  await mkdir('.scratch', { recursive: true });
  await window.screenshot({ path: '.scratch/statusbar-gui.png' });
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
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
      .update(await readFile('tests/fixtures/statusbar/statusbar.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native named A/W and ordinal 6 status creation use real handles and shared control procedures',
      'PE32 parts and rectangle queries preserve sentinels; rejected layouts retain previous state',
      'ANSI/Unicode text, packed length/style results, tab alignment, bounded tooltip output and background color',
      'Simple mode notifies only on changes and retains multipart text; native NMMOUSE callbacks report the selected part',
      'Parent resize docks the bar while CCS_NORESIZE preserves a fixed Unicode bar; native close exits zero',
    ],
    scope:
      'Bounded horizontal textual COMCTL32 status bars in ordinary Chromium. Icons, owner-drawn parts, native resize grip, tooltip HWNDs, exact native font/theme metrics and complete common-control coverage remain incomplete.',
  };
  await writeFile(
    'evidence/statusbar-browser-results.json',
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
