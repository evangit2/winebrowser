import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { zipSync } from 'fflate';
import { webgpuBrowserOptions } from './webgpu-browser.mjs';

// Exercise the actual upload worker, with no intercepted routes or diagnostic
// bootstrap. Supplied DLLs must retain package search precedence even when
// the normal worker also provides the source-built base closure.
export async function verifySourceBaseUpload(root, executable, builtinFiles, nlsFiles) {
  const entries = { 'console.exe': executable };
  for (const [name, bytes] of builtinFiles) entries[name] = bytes;
  for (const [name, bytes] of nlsFiles) entries['nls/' + name] = bytes;
  const server = await createServer({
    root,
    base: '/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ ...webgpuBrowserOptions, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    await page.locator('#file').setInputFiles({
      name: 'source-base-console.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync(entries)),
    });
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
    const report = await page.evaluate(() => ({
      isolated: crossOriginIsolated,
      state: document.querySelector('#state')?.textContent,
      output: document.querySelector('#output')?.textContent,
      result: window.__lastRun,
    }));
    assert.deepEqual(errors, []);
    assert.equal(report.isolated, true);
    assert.equal(report.state, 'EXITED');
    assert.equal(report.output, 'console demo: hello from WriteFile\r\n');
    assert.equal(report.result.exitCode, 0);
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(report.result.modules.some((m) => m.name === name && !m.host));
    for (const call of [
      'ntdll.dll!NtInitializeNlsFiles',
      'ntdll.dll!NtWriteFile',
      'WineBrowserLoaderCallback',
      'ntdll.dll!NtTerminateProcess',
    ])
      assert.ok(report.result.apiNames.includes(call), call);
    assert.ok(report.result.compiledBlocks > 0);
    return report;
  } finally {
    await browser?.close();
    await server.close();
  }
}
