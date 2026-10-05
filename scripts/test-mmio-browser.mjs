import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
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
  const exe = await readFile('tests/fixtures/mmio/mmio.exe');
  const wave = await readFile('tests/fixtures/mmio/tone.wav');
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles({
    name: 'mmio.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync({ 'contracts/mmio.exe': exe, 'contracts/tone.wav': wave })),
  });
  await page.waitForFunction(() => !document.querySelector('#run').disabled);
  assert.doesNotMatch(await page.locator('#details').textContent(), /Unsupported import/);
  await page.locator('#run').click();
  const output = page.locator('#output');
  const window = page.locator('.virtual-desktop-window').filter({ hasText: 'MMIO lifecycle' });
  for (const [marker, visible] of [
    ['WINDOW VISIBLE', true],
    ['WINDOW MINIMIZED', false],
    ['WINDOW RESTORED', true],
  ]) {
    await page.waitForFunction(
      (marker) => document.querySelector('#output').textContent.includes(marker),
      marker,
      { timeout: 60000 },
    );
    await page.waitForFunction((visible) => {
      const w = [...document.querySelectorAll('.virtual-desktop-window')].find((e) =>
        e.textContent.includes('MMIO lifecycle'),
      );
      return !!w && !w.hidden === visible;
    }, visible);
    assert.equal(await window.isVisible(), visible);
  }
  await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.match(await output.textContent(), /MMIO WINDOW CURSOR CONTRACTS PASS/);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: await browser.version(),
    passed: true,
    exeSha256: createHash('sha256').update(exe).digest('hex'),
    exitCode: run.exitCode,
    apiNames: run.apiNames ?? run.apiTrace,
    errors,
    scope:
      'Independent native PE32 fixture verifies buffered RIFF/WAV reads across buffer boundaries, chunk padding and LIST skipping, seek/EOF, MMIOINFO ABI and synchronization, ANSI/Unicode opens, virtual cursor clipping, actual browser window minimize/restore and native lifetime checks. Feeding Frenzy gameplay is not verified.',
  };
  await writeFile(
    process.env.MMIO_EVIDENCE || 'evidence/mmio-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
