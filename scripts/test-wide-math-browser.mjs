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
  const executable = await readFile('tests/fixtures/wide-math/wide-math.exe');
  const archive = zipSync({ 'app/wide-math.exe': executable }),
    results = [];
  for (const [name, mimeType, buffer] of [
    ['wide-math.exe', 'application/octet-stream', executable],
    ['wide-math.zip', 'application/zip', Buffer.from(archive)],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await page.locator('#run').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const run = await page.evaluate(() => window.__lastRun),
      output = await page.locator('#output').textContent();
    assert.equal(run.exitCode, 0, JSON.stringify({ run, output }));
    assert.deepEqual(errors, []);
    assert.match(output, /wide-math-ok/);
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
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Native PE32 EXE/ZIP: byte/word/dword MUL, IMUL, DIV and IDIV, preserved upper registers, multiplication carry/overflow, signed quotient/remainder and high-byte operand aliasing.',
    results,
  };
  await writeFile(
    'evidence/wide-math-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
