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
  const executable = await readFile('tests/fixtures/window-query/window-query.exe');
  for (const mode of ['exe-upload', 'zip-upload']) {
    await page.locator('#file').setInputFiles({
      name: mode === 'exe-upload' ? 'window-query.exe' : 'window-query.zip',
      mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
      buffer:
        mode === 'exe-upload'
          ? executable
          : Buffer.from(zipSync({ 'app/window-query.exe': executable })),
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
    assert.equal(result.output, 'NATIVE WINDOW QUERY SDK PASS\n');
    assert.deepEqual(result.downloads, []);
    assert.deepEqual(result.run.outputs, []);
    assert.deepEqual(result.run.deletedFiles, []);
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of [
      'ChildWindowFromPoint',
      'ChildWindowFromPointEx',
      'GetTopWindow',
      'IsChild',
      'CopyRect',
      'IntersectRect',
      'UnionRect',
      'SubtractRect',
      'IsRectEmpty',
      'SetRectEmpty',
      'PeekMessageW',
      'BeginPaint',
      'EndPaint',
    ])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
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
      'Unchanged Windows SDK PE32 EXE translated in browser with real Wine base libraries. Window hierarchy, immediate-child hit testing with POINT-by-value, skip flags, top-window z-order, nested versus owned windows, aliased RECT geometry and output guards. Native transparent custom children paint after underlying siblings through actual guest callbacks; window state changes and cleanup; loose EXE and ZIP upload. No claim of full USER32 conformance.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/window-query-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
