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
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const exe = await readFile('tests/fixtures/packed-sse/packed-sse.exe'),
    oracle = await readFile('tests/fixtures/packed-sse/native-oracle.bin');
  await page
    .locator('#file')
    .setInputFiles({ name: 'packed-sse.exe', mimeType: 'application/octet-stream', buffer: exe });
  await page.waitForFunction(() => !document.querySelector('#run').disabled);
  await page.locator('#run').click();
  await page.waitForFunction(
    () => window.__lastRun !== null || document.querySelector('#state')?.textContent === 'ERROR',
    null,
    { timeout: 60000 },
  );
  const run = await page.evaluate(() => window.__lastRun);
  assert.ok(run, await page.locator('#logs').textContent());
  assert.equal(run.exitCode, 0);
  assert.match(await page.locator('#output').textContent(), /PACKED SSE NATIVE MATRIX PASS/);
  const file = run.outputs.find((f) => f.path === 'packed-sse-results.bin'),
    actual = Buffer.from(Object.values(file.bytes));
  assert.ok(
    actual.equals(oracle),
    'All result words and MXCSR flags must match the independent native oracle',
  );
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    records: 8400,
    recordBytes: 24,
    exeSha256: createHash('sha256').update(exe).digest('hex'),
    resultSha256: createHash('sha256').update(actual).digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native SSE/SSE2 register and memory forms, arithmetic, square roots, min/max, all comparison predicates and conversions',
      'Four MXCSR rounding modes, NaNs, signed zero, infinities, denormal inputs and DAZ/FTZ results/flags',
      'Raw shuffles, unpacks, integer shifts/comparisons/logical operations and saturating packs',
      'Actual generated binary output matches all 8,400 independently executed native reference records',
    ],
    scope:
      'Bounded legacy SSE/SSE2 coverage; complete SSE-family CPUID bits, MMX, AVX and guest #XM delivery remain unsupported.',
  };
  await writeFile(
    process.env.PACKED_SSE_EVIDENCE || 'evidence/packed-sse-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
