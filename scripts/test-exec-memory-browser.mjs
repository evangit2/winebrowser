import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// End-to-end gate for private executable memory. The fixture asks for
// PAGE_EXECUTE_READWRITE, emits a real machine-code routine into the block,
// drops write access, calls it, then rewrites the bytes and calls the new
// version. The printed values prove the emitted code actually executed and that
// the rewritten code — not a stale translation — ran the second time.
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const fixture = await readFile('tests/fixtures/exec-memory/exec-memory.exe');
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
  );
  const runs = [];
  for (const mode of ['exe-upload', 'zip-upload']) {
    if (mode === 'exe-upload')
      await page.locator('#file').setInputFiles({
        name: 'exec-memory.exe',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(fixture),
      });
    else
      await page.locator('#file').setInputFiles({
        name: 'exec-memory.zip',
        mimeType: 'application/zip',
        buffer: await zipOf(),
      });
    await page.waitForFunction(() => !document.getElementById('run').disabled, null, {
      timeout: 30000,
    });
    await page.locator('#run').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state').textContent),
      null,
      { timeout: 60000 },
    );
    const state = await page.locator('#state').textContent();
    const output = await page.locator('#output').textContent();
    assert.equal(state, 'EXITED', `the fixture did not exit cleanly: ${output}`);
    const lines = new Map(
      output
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    // PAGE_EXECUTE_READWRITE -> PAGE_EXECUTE_READ reports the old protection.
    assert.equal(lines.get('old'), '0x00000040', 'the writable-executable protection was previous');
    // add_value returns x + 100, then x + 200 after the rewrite.
    assert.equal(lines.get('first'), '0x00000065');
    assert.equal(lines.get('second'), '0x000000c9');
    assert.equal(lines.get('freed'), '1');
    assert.deepEqual(errors, []);
    runs.push({
      mode,
      exeSha256: createHash('sha256').update(fixture).digest('hex'),
      output,
      exitCode: await page.evaluate(() => window.__lastRun?.exitCode),
      instructions: await page.evaluate(() => window.__lastRun?.instructions),
      compiledBlocks: await page.evaluate(() => window.__lastRun?.compiledBlocks),
    });
  }
  await mkdir('evidence', { recursive: true });
  const report = {
    fixture: 'exec-memory',
    scope:
      'A native PE32 program maps private PAGE_EXECUTE_READWRITE memory, emits x86, drops to PAGE_EXECUTE_READ, calls the emitted bytes, rewrites them and calls again. This is the loader-stub/packer/JIT shape; it is not a general executable-memory or W^X claim.',
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    browserCompilation: true,
    runs,
    errors,
  };
  await writeFile(
    'evidence/exec-memory-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

async function zipOf() {
  const { zipSync } = await import('fflate');
  return Buffer.from(zipSync({ 'exec-memory/exec-memory.exe': fixture }));
}
