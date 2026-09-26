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
  const executable = await readFile('tests/fixtures/dinput8/dinput8.exe');
  const archive = zipSync({
    'app/dinput8.exe': executable,
    'app/data/readme.txt': strToU8('Native EXE with companion files'),
  });
  const results = [];
  for (const [name, mimeType, buffer] of [
    ['dinput8.exe', 'application/octet-stream', executable],
    ['dinput8.zip', 'application/zip', Buffer.from(archive)],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await page.locator('#run').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(errors, []);
    results.push({
      name,
      exitCode: result.exitCode,
      instructions: result.instructions,
      compiledBlocks: result.compiledBlocks,
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
      'Unchanged PE32 through ordinary EXE and ZIP upload; DirectInput 8 A/W identity, shared reference counts, keyboard/mouse enumeration callbacks, filters, device metadata and capability queries.',
    results,
  };
  await writeFile('evidence/dinput8-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
