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
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chromium',
    headless: process.env.HEADED !== '1',
  });
  const executable = await readFile('tests/fixtures/gdi-nearest/gdi-nearest.exe'),
    runs = [],
    errors = [];
  for (const mode of ['exe-upload', 'zip-upload']) {
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    await page.locator('#file').setInputFiles({
      name: mode === 'exe-upload' ? 'gdi-nearest.exe' : 'gdi-nearest.zip',
      mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
      buffer:
        mode === 'exe-upload'
          ? executable
          : Buffer.from(zipSync({ 'app/gdi-nearest.exe': executable })),
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
      () => window.__lastRun != null || document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    const r = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(r.run?.exitCode, 0, JSON.stringify(r));
    assert.equal(r.output, 'NATIVE NEAREST COLOR PASS\n');
    assert.ok(r.run.apiNames.includes('gdi32.dll!GetNearestColor'));
    assert.ok(r.run.totalCompiledBlocks > 0 && r.run.x86TranslationMs > 0);
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        r.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
      );
    assert.deepEqual(r.run.outputs, []);
    assert.deepEqual(r.run.deletedFiles, []);
    runs.push({ mode, ...r });
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    headedBrowser: process.env.HEADED === '1',
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Unchanged native Windows SDK PE32 client executes 352 desktop Wine nearest-color comparisons with display/memory DCs, 555/565 and indexed formats, selected logical palettes and DIB indices. x86 compiles into Wasm inside browser. Universal DLL compatibility remains unfinished.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/gdi-nearest-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
