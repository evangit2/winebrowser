import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// End-to-end gate for the pinned 7-Zip console archiver: a real third-party
// program with a CRT startup, a console, an automation dependency and a
// compressed archive to build. It is uploaded together with the asset it
// compresses, asked to add that asset to a new archive, and judged on the bytes
// the guest produced rather than on the absence of an error.
const PACKAGE = '7zr.exe';
const ARCHIVE = 'out.7z';
const ASSET = 'message.txt';
const EXE_SHA256 = 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';

const executable = new Uint8Array(await readFile('.cache/targets/7zr.exe'));
assert.equal(
  createHash('sha256').update(executable).digest('hex'),
  EXE_SHA256,
  'the pinned 7zr.exe is unchanged',
);
const asset = new Uint8Array(await readFile('public/demos/files/assets/message.txt'));

const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.getElementById('platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  // The archiver and its input are dropped in as loose files, exactly like a
  // user selecting several files at once.
  await page.locator('#file').setInputFiles([
    { name: PACKAGE, mimeType: 'application/octet-stream', buffer: Buffer.from(executable) },
    { name: ASSET, mimeType: 'text/plain', buffer: Buffer.from(asset) },
  ]);
  await page.waitForFunction(() => !document.getElementById('run').disabled, null, {
    timeout: 120000,
  });
  await page.locator('#args').fill(JSON.stringify(['a', ARCHIVE, ASSET]));
  await page.locator('#run').click();
  await page.waitForFunction(
    () => ['EXITED', 'ERROR'].includes(document.getElementById('state').textContent),
    null,
    { timeout: 300000 },
  );
  const state = await page.locator('#state').textContent();
  const output = await page.locator('#output').textContent();
  assert.equal(state, 'EXITED', `7zr did not exit cleanly: ${output}`);
  const run = await page.evaluate(() => ({
    exitCode: window.__lastRun.exitCode,
    instructions: window.__lastRun.instructions,
    compiledBlocks: window.__lastRun.compiledBlocks,
    outputs: window.__lastRun.outputs.map((entry) => ({
      path: entry.path,
      bytes: Array.from(entry.bytes),
    })),
  }));
  assert.equal(run.exitCode, 0);
  // The program's own report of success, not merely a clean exit.
  assert.match(output, /Creating archive: out\.7z/);
  assert.match(output, /Everything is Ok/);
  const archive = run.outputs.find((entry) => entry.path.endsWith(ARCHIVE));
  assert.ok(archive, 'the guest produced an archive');
  // The 7z signature is 37 7a bc af 27 1c, then the format version and CRC.
  assert.deepEqual(archive.bytes.slice(0, 6), [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  assert.ok(
    archive.bytes.length > 32,
    `the archive has real content (${archive.bytes.length} bytes)`,
  );
  assert.ok(run.instructions > 100000, 'the guest executed a real workload');
  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  const report = {
    binary: PACKAGE,
    scope:
      'The unchanged upstream 7-Zip console archiver, uploaded with its input and asked to build an archive. Its CRT startup, console output, automation dependency, file creation and compression all run through the ordinary harness; the produced bytes are a real 7z stream.',
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: EXE_SHA256,
    exitCode: run.exitCode,
    instructions: run.instructions,
    compiledBlocks: run.compiledBlocks,
    archiveBytes: archive.bytes.length,
    stdout: output,
    errors,
  };
  await writeFile('evidence/7zr-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, stdout: output.slice(0, 400) }, null, 2));
} finally {
  await browser.close();
}
