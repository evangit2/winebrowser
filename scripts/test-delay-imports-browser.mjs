import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let server, browser;
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: process.env.WINEBROWSER_NORMAL_CHROMIUM !== '1',
  });
  const page = await browser.newPage(),
    errors = [],
    runs = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const dll = await readFile('tests/fixtures/delay-imports/delayed.dll');
  for (const exe of ['delay-imports.exe', 'delay-native.exe']) {
    const executable = await readFile('tests/fixtures/delay-imports/' + exe);
    for (const mode of ['loose-upload', 'zip-upload']) {
      await page.locator('#file').setInputFiles(
        mode === 'zip-upload'
          ? {
              name: 'delay-imports.zip',
              mimeType: 'application/zip',
              buffer: Buffer.from(zipSync({ ['app/' + exe]: executable, 'app/delayed.dll': dll })),
            }
          : [
              { name: exe, mimeType: 'application/octet-stream', buffer: executable },
              { name: 'delayed.dll', mimeType: 'application/octet-stream', buffer: dll },
            ],
      );
      await page.waitForFunction(
        () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
        null,
        { timeout: 60000 },
      );
      assert.equal(
        await page.locator('#run').isEnabled(),
        true,
        await page.locator('#details').textContent(),
      );
      await page.locator('#run').click();
      await page.waitForFunction(
        () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
        null,
        { timeout: 120000 },
      );
      const result = await page.evaluate(() => ({
        run: window.__lastRun,
        output: document.querySelector('#output').textContent,
        logs: document.querySelector('#logs').textContent,
        isolated: crossOriginIsolated,
      }));
      assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
      assert.equal(
        result.output,
        exe === 'delay-native.exe'
          ? 'NATIVE NTDLL DELAY RESOLVER PASS\n'
          : 'NATIVE DELAY IMPORT PASS\n',
      );
      for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'msvcrt.dll'])
        assert.ok(
          result.run.modules.some(
            (m) => m.name === name && !m.host && m.path === '@runtime/' + name,
          ),
          name,
        );
      assert.equal(
        result.run.modules.some((m) => ['delayed.dll', 'absent-optional.dll'].includes(m.name)),
        false,
      );
      assert.ok(result.run.apiNames.includes('WineBrowserLoaderCallback'));
      assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
      assert.deepEqual(result.run.outputs, []);
      assert.deepEqual(result.run.deletedFiles, []);
      runs.push({ exe, mode, exeSha256: sha(executable), ...result });
    }
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
    dllSha256: sha(dll),
    scope:
      'Authored PE32 EXEs with actual MinGW delay imports. Original guest helper and native Wine LdrResolveDelayLoadedAPI independently resolve named/ordinal exports and patch original lazy IATs. Delayed MSVCRT selects the native Wine base before startup. Optional absent DLL does not prevent startup; real guest failure hooks see ERROR_MOD_NOT_FOUND/ERROR_PROC_NOT_FOUND and supply a guest fallback, reused on later calls. DLL is explicitly unloaded. EXE/DLL and ZIP uploads compile x86 to Wasm inside ordinary Chromium. Legacy VA metadata is parser-checked only; bound-delay/unload-helper and universal application acceptance remain unverified.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/delay-imports-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
