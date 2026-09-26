import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
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
  const executable = await readFile('tests/fixtures/file-sections/sections.exe');
  const archive = zipSync({
    'app/sections.exe': executable,
    'app/payload.bin': Uint8Array.from({ length: 65573 }, (_, i) => (i * 7 + 31) & 255),
  });
  const sidecar = {
    name: 'payload.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(Uint8Array.from({ length: 65573 }, (_, i) => (i * 7 + 31) & 255)),
  };
  const results = [];
  for (const [name, mimeType, buffer] of [
    ['sections.exe', 'application/octet-stream', executable],
    ['sections.zip', 'application/zip', Buffer.from(archive)],
    ['sections-files', 'application/octet-stream', executable],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page
      .locator('#file')
      .setInputFiles(
        name === 'sections-files'
          ? [{ name: 'sections.exe', mimeType, buffer }, sidecar]
          : { name, mimeType, buffer },
      );
    await page.locator('#run').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.deepEqual(errors, []);
    const output = await page.locator('#output').textContent();
    assert.match(output, /sections-ok/);
    if (name !== 'sections.exe') assert.match(output, /sidecar-ok/);
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
      'PE32 EXE, EXE plus sidecar, and nested ZIP upload: A/W file sections, all 65573 generated/mapped bytes, 64K-offset views, closed-handle lifetimes, whole-page tails, alignment and collision errors, interior unmap, and ZIP sidecar mapping.',
    results,
  };
  await writeFile('evidence/sections-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
