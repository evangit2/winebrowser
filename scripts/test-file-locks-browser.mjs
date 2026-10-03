import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

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
  const executable = await readFile('tests/fixtures/file-locks/file-locks.exe');
  for (const mode of ['exe-upload', 'zip-upload']) {
    await page.locator('#file').setInputFiles({
      name: mode === 'exe-upload' ? 'file-locks.exe' : 'file-locks.zip',
      mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
      buffer:
        mode === 'exe-upload'
          ? executable
          : Buffer.from(zipSync({ 'app/file-locks.exe': executable })),
    });
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
      downloads: [...document.querySelectorAll('#outputs a')].map((a) => a.download),
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE FILE LOCK WAIT/EVENT PASS\n');
    assert.deepEqual(result.downloads, []);
    assert.deepEqual(result.run.outputs, []);
    assert.equal(result.run.deletedFiles.length, 1);
    assert.match(result.run.deletedFiles[0], /locked\.bin$/);
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of [
      'NtCreateThreadEx',
      'NtLockFile',
      'NtUnlockFile',
      'NtReadFile',
      'NtWaitForSingleObject',
      'NtTerminateThread',
    ])
      assert.ok(result.run.apiNames.includes('ntdll.dll!' + api), api);
    assert.ok(result.run.x86TranslationMs > 0 && result.run.totalCompiledBlocks > 0);
    runs.push({ mode, ...result });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Authored native PE32 compiled to Wasm inside browser, with real Wine Kernel32/KernelBase/NTDLL. Guest thread parks on contended exclusive byte lock, wakes after unlock, receives lock and tagged positioned-read events, reads original bytes and joins. Terminated parked thread cancels pending request before immediate unlock; no orphaned lock or completion event. Loose EXE and ZIP upload; deleted output has no download. APC and background I/O remain unsupported.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/file-locks-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
