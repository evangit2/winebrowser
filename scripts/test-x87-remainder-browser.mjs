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
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform').textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const exe = await readFile('tests/fixtures/x87-remainder/remainder.exe');
  await page
    .locator('#file')
    .setInputFiles({ name: 'remainder.exe', mimeType: 'application/octet-stream', buffer: exe });
  await page.waitForFunction(
    () => document.querySelector('#state').textContent === 'LOADED',
    null,
    { timeout: 60000 },
  );
  assert.ok(await page.locator('#run').isEnabled(), await page.locator('#details').textContent());
  await page.locator('#run').click();
  await page.waitForFunction(
    () => {
      if (document.querySelector('#state').textContent === 'ERROR')
        throw Error(document.querySelector('#logs').textContent);
      return window.__lastRun !== null;
    },
    null,
    { timeout: 120000 },
  );
  const result = await page.evaluate(() => window.__lastRun),
    output = await page.locator('#output').textContent();
  assert.equal(result.exitCode, 0, output);
  assert.match(output, /X87 REMAINDER PASS/);
  assert.ok(result.compiledBlocks > 0 && result.instructions > 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    sha256: createHash('sha256').update(exe).digest('hex'),
    scope:
      'Unchanged authored PE32 executes FPREM/FPREM1 over 422 independent ext80 oracle cases, three precision settings and four rounding modes; byte results, exceptions and quotient bits',
    exitCode: result.exitCode,
    instructions: result.instructions,
    compiledBlocks: result.compiledBlocks,
    x86TranslationMs: result.x86TranslationMs,
    elapsedMs: result.elapsedMs,
    output,
    errors,
  };
  await writeFile(
    'evidence/x87-remainder-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
