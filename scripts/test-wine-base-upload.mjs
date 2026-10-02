import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const url = process.env.WINEBROWSER_TEST_URL;
const server = url
  ? null
  : await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
let browser;
try {
  await server?.listen();
  const base = url ?? `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch({ ...webgpuBrowserOptions, headless: true });
  const fixture = 'tests/fixtures/wine-base-auto/';
  const crc = await readFile(fixture + 'native-base.exe');
  const dynamic = await readFile(fixture + 'dynamic-base.exe');
  const helper = await readFile(fixture + 'helper.dll');
  const helperCrt = await readFile(fixture + 'helper-crt.dll');
  const dynamicCrt = await readFile(fixture + 'dynamic-crt.exe');
  const cases = [
    { name: 'native-base.exe', bytes: crc, output: 'native Wine base: CRC32 verified\r\n' },
    {
      name: 'dynamic.zip',
      bytes: Buffer.from(zipSync({ 'app/dynamic-base.exe': dynamic, 'app/helper.dll': helper })),
      output: 'native Wine base: dynamic DLL verified\r\n',
    },
    {
      name: 'dynamic-crt.zip',
      bytes: Buffer.from(
        zipSync({ 'app/dynamic-crt.exe': dynamicCrt, 'app/helper.dll': helperCrt }),
      ),
      output: 'native Wine base: dynamic DLL verified\r\n',
      nativeCrt: true,
    },
  ];
  const runs = [];
  for (const item of cases) {
    const page = await browser.newPage();
    const errors = [],
      requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (request) => {
      if (/\/runtime\/wine-base\/[^/]+\.(dll|nls)$/.test(new URL(request.url()).pathname))
        requests.push(new URL(request.url()).pathname);
    });
    await page.goto(base);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    await page
      .locator('#file')
      .setInputFiles({ name: item.name, mimeType: 'application/octet-stream', buffer: item.bytes });
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    assert.equal(await page.locator('#state').textContent(), 'LOADED');
    await page.locator('#run').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    const result = await page.evaluate(() => ({
      state: document.querySelector('#state').textContent,
      output: document.querySelector('#output').textContent,
      result: window.__lastRun,
    }));
    assert.equal(result.state, 'EXITED', JSON.stringify(result));
    assert.equal(result.output, item.output);
    assert.equal(result.result.exitCode, 0);
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 13, 'six DLLs and seven NLS tables supplied automatically');
    for (const name of ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'])
      assert.ok(
        result.result.modules.some(
          (m) => m.name === name && m.path === '@runtime/' + name && !m.host,
        ),
      );
    assert.ok(result.result.apiNames.includes('ntdll.dll!NtWriteFile'));
    assert.ok(result.result.apiNames.includes('WineBrowserLoaderCallback'));
    if (item.nativeCrt)
      assert.ok(
        result.result.modules.some(
          (m) => m.name === 'msvcrt.dll' && m.path === '@runtime/msvcrt.dll' && !m.host,
        ),
      );
    assert.ok(result.result.compiledBlocks > 0);
    runs.push({
      name: item.name,
      sha256: createHash('sha256').update(item.bytes).digest('hex'),
      requests,
      ...result,
    });
    await page.close();
  }
  let corruptAssetError = null;
  // Page routes cannot alter fetches owned by the isolation service worker.
  // The dev gate verifies corrupt-byte rejection; the Pages gate verifies
  // real uploads and component URLs under the project's service worker.
  if (!url) {
    const page = await browser.newPage();
    await page.route('**/runtime/wine-base/ntdll.dll', async (route) => {
      const response = await route.fetch();
      const bytes = await response.body();
      bytes[bytes.length - 1] ^= 1;
      await route.fulfill({ response, body: bytes });
    });
    await page.goto(base);
    await page.locator('#file').setInputFiles({
      name: 'native-base.exe',
      mimeType: 'application/octet-stream',
      buffer: crc,
    });
    await page.waitForFunction(
      () => document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    corruptAssetError = await page.locator('#output').textContent();
    assert.match(corruptAssetError, /Wine base component hash mismatch: ntdll.dll/);
  }
  await writeFile(
    url ? 'evidence/wine-base-pages-upload-results.json' : 'evidence/wine-base-upload-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        browser: browser.version(),
        scope:
          'Ordinary EXE and nested ZIP uploads automatically fetch verified source-built Wine DLLs/NLS, execute native CRC code and dynamically load a supplied PE32 DLL, then print and exit zero. Corrupt-byte rejection is checked in the dev gate. No broad compatibility claim.',
        runs,
        corruptAssetError,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Native Wine base supplied to ordinary EXE and dynamic DLL uploads; hash rejection verified.',
  );
} finally {
  await browser?.close();
  await server?.close();
}
