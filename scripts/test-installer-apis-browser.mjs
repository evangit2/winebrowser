import assert from 'node:assert/strict';
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
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform').textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const executable = await readFile('tests/fixtures/installer-apis/installer-apis.exe');
  const archive = zipSync({
    'installer-apis.exe': executable,
    'payload.da_': Uint8Array.from([
      0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33, 0x41, 0x74, 9, 0, 0, 0, 7, 65, 66, 67, 0xf0,
      0xf3,
    ]),
    'assets/marker.txt': new TextEncoder().encode('Folder target'),
  });
  await page.locator('#file').setInputFiles({
    name: 'installer-apis.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(archive),
  });
  await page.waitForFunction(
    () => {
      if (document.querySelector('#state').textContent === 'ERROR')
        throw Error(document.querySelector('#logs').textContent);
      return document.querySelector('#state').textContent === 'LOADED';
    },
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
    () => {
      if (['ERROR', 'EXITED'].includes(document.querySelector('#state').textContent))
        throw Error(
          document.querySelector('#output').textContent +
            '\n' +
            document.querySelector('#logs').textContent,
        );
      return document.querySelector('#folder-dialog').open;
    },
    null,
    { timeout: 120000 },
  );
  assert.equal(await page.locator('#folder-dialog-selection').inputValue(), 'assets');
  assert.equal(
    await page.locator('#folder-dialog-title').textContent(),
    'Choose installation folder',
  );
  await page.locator('#folder-dialog-ok').click();
  await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__lastRun);
  assert.equal(result.exitCode, 0, await page.locator('#output').textContent());
  assert.match(await page.locator('#output').textContent(), /INSTALLER APIS PASS/);
  const names = new Set(result.apiNames);
  for (const name of [
    'user32.dll!CreateDialogIndirectParamA',
    'user32.dll!CharNextA',
    'user32.dll!GetWindow',
    'user32.dll!GetNextDlgTabItem',
    'user32.dll!SetParent',
    'gdi32.dll!CreateDIBitmap',
    'gdi32.dll!EnumFontFamiliesExA',
    'shell32.dll!SHGetMalloc',
    'shell32.dll!SHBrowseForFolderA',
    'shell32.dll!SHGetPathFromIDListA',
    'lz32.dll!LZOpenFileA',
    'lz32.dll!LZCopy',
    'lz32.dll!LZClose',
    'comctl32.dll!InitCommonControls',
  ])
    assert.ok(names.has(name), name);
  assert.ok(result.compiledBlocks > 0 && result.instructions > 0);
  assert.ok(result.x86TranslationMs > 0 && result.x86TranslationMs < result.elapsedMs);
  assert.ok(result.totalCompiledBlocks >= result.compiledBlocks);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    scope:
      'Authored unchanged PE32 installer-service client uploaded as ZIP; not acceptance of the proprietary ATI installer',
    exitCode: result.exitCode,
    compiledBlocks: result.compiledBlocks,
    totalCompiledBlocks: result.totalCompiledBlocks,
    x86TranslationMs: result.x86TranslationMs,
    elapsedMs: result.elapsedMs,
    instructions: result.instructions,
    apiNames: result.apiNames,
    output: await page.locator('#output').textContent(),
    errors,
  };
  await writeFile(
    'evidence/installer-apis-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
