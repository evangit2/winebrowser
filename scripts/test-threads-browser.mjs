import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const executable = await readFile('tests/fixtures/threads/threads.exe');
  const archive = zipSync({
    'app/threads.exe': executable,
    'app/data/readme.txt': strToU8('Native EXE with companion files'),
  });
  const results = [];
  for (const [name, mimeType, buffer, expected] of [
    ['threads.exe', 'application/octet-stream', executable, 0],
    ['threads.zip', 'application/zip', Buffer.from(archive), 0],
    ...(await Promise.all(
      [
        ['duplicate', 0],
        ['duplicate-main-exit', 0],
        ['worker-exit', 77],
        ['main-exit', 77],
        ['thread-fault', null],
      ].map(async ([name, expected]) => [
        name + '.exe',
        'application/octet-stream',
        await readFile('tests/fixtures/threads/' + name + '.exe'),
        expected,
      ]),
    )),
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await page.locator('#run').click();
    await page.waitForFunction(
      () => window.__lastRun !== null || document.querySelector('#state').textContent === 'ERROR',
    );
    const result = await page.evaluate(() => window.__lastRun);
    if (expected === null)
      assert.match(await page.locator('#output').textContent(), /Unsupported instruction ud2/);
    else assert.equal(result?.exitCode, expected, JSON.stringify(result));
    assert.deepEqual(errors, []);
    results.push({
      name,
      expectedExit: expected,
      exitCode: result?.exitCode,
      instructions: result?.instructions,
      compiledBlocks: result?.compiledBlocks,
      errors,
    });
    await page.close();
  }
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Native EXE/ZIP with two suspended workers, distinct TEBs/stacks/last-error values, event synchronization, CPU-loop preemption, thread joins, return/ExitThread codes, close-before-exit and process cancellation.',
    results,
  };
  await writeFile('evidence/threads-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
