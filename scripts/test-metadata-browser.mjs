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
  const executable = await readFile('tests/fixtures/file-metadata/metadata.exe');
  const archive = zipSync({
    'app/metadata.exe': executable,
    'app/data/payload.bin': strToU8('bytes!'),
  });
  const results = [];
  for (const [name, mimeType, buffer] of [
    ['metadata.exe', 'application/octet-stream', executable],
    ['metadata.zip', 'application/zip', Buffer.from(archive)],
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
    const output = await page.locator('#output').textContent();
    assert.match(output, /metadata-ok/);
    assert.match(output, name.endsWith('.zip') ? /data-ok/ : /no-data/);
    results.push({
      name,
      exitCode: result.exitCode,
      output,
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
      'PE32 through ordinary EXE and nested ZIP upload. A/W file attributes, actual parent directories, missing leaf/parent errors, generated file size and timestamps, binary readback and bounded metadata output.',
    results,
  };
  await writeFile('evidence/metadata-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
