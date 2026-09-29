import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

// End-to-end structured-exception gate: the fixture installs its own fs:[0]
// registration frame, reads an unmapped address, and its filter reports what
// the runtime delivered. The expected text proves the record, the context and
// the resume all match the i386 ABI rather than merely "something happened".
const FAULT_ADDRESS = '0x7fff0000';
// The faulting instruction in the pinned fixture is `mov eax,[0x7fff0000]`.
const FAULTING_EIP = '0x00401164';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const executable = new Uint8Array(await readFile('tests/fixtures/seh/seh.exe'));
const browser = await chromium.launch(webgpuBrowserOptions);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
  );
  await page.locator('#file').setInputFiles({
    name: 'seh.exe',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(executable),
  });
  await page.waitForFunction(() => !document.getElementById('run').disabled, {}, { timeout: 20000 });
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
  // The handler ran exactly once, saw an access violation at the fixture's
  // unmapped address with two parameters, and the context named the instruction
  // that faulted.
  assert.equal(lines.get('handler_calls'), '0x00000001');
  assert.equal(lines.get('code'), '0xc0000005');
  assert.equal(lines.get('parameters'), '0x00000002');
  assert.equal(lines.get('eip'), FAULTING_EIP);
  assert.equal(lines.get('address'), FAULT_ADDRESS);
  // Resuming past the fault means the statement after it ran.
  assert.match(output, /before\r?\nafter/);
  assert.deepEqual(errors, []);
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/seh-browser.json',
    JSON.stringify(
      {
        scope:
          'Native PE32 fixture installing a real fs:[0] frame, faulting on an unmapped read and resuming from its filter',
        url,
        browser: browser.version(),
        exeSha256: createHash('sha256').update(executable).digest('hex'),
        expected: {
          code: '0xc0000005',
          address: FAULT_ADDRESS,
          parameters: 2,
          eip: FAULTING_EIP,
        },
        observed: Object.fromEntries(lines),
        output,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ state, observed: Object.fromEntries(lines) }, null, 1));
} finally {
  await browser?.close();
}
