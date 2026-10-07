import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
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
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chromium',
    headless: process.env.HEADED !== '1',
  });
  const executable = await readFile('tests/fixtures/sse/packed.exe');
  const results = [];
  for (const [name, mimeType, buffer] of [
    ['packed.exe', 'application/octet-stream', executable],
    ['packed.zip', 'application/zip', Buffer.from(zipSync({ 'app/packed.exe': executable }))],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    // Static Pages installs its isolation service worker and reloads once.
    // Wait for that bootstrap before selecting a file so the upload survives.
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent.endsWith('WASM READY'),
      null,
      { timeout: 60000 },
    );
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await expect(page.locator('#run')).toBeEnabled({ timeout: 60000 });
    await page.locator('#run').click();
    await page.waitForFunction(
      () => window.__lastRun != null || document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    const run = await page.evaluate(() => window.__lastRun),
      output = await page.locator('#output').textContent();
    assert.ok(run, await page.locator('#logs').textContent());
    assert.equal(run.exitCode, 0, JSON.stringify({ run, output }));
    assert.match(output, /packed-sse-ok/);
    assert.deepEqual(errors, []);
    results.push({
      name,
      exitCode: run.exitCode,
      output,
      instructions: run.instructions,
      compiledBlocks: run.compiledBlocks,
      errors,
    });
    await page.close();
  }
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    url,
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Native PE32 EXE/ZIP uploads: ADDPS/PD, SUBPS/PD, MULPS/PD, DIVPS/PD, SQRTPS/PD, four-vertex 3D normalization and transforms, all MXCSR rounding modes, DAZ/FTZ and mixed-lane sticky exceptions.',
    results,
  };
  await writeFile(
    'evidence/packed-sse-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
