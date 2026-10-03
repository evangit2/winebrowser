import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = JSON.parse(await readFile('runtime/target-builds/lua.json'));
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
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const asset = async (row) => {
    const response = await page.request.get(new URL('examples/' + row.path, url).href);
    assert.equal(response.status(), 200, row.path);
    const bytes = await response.body();
    assert.equal(sha(bytes), row.sha256, row.path);
    return bytes;
  };
  const [zip, exe, dll, script] = await Promise.all([
    asset(pin.zip),
    asset(pin.client),
    asset(pin.dll),
    asset(pin.script),
  ]);
  for (const mode of [
    'zip-upload',
    'modified-script-upload',
    'hosted-example',
    'non-string-script-error',
  ]) {
    if (mode === 'hosted-example') await page.locator('[data-demo="lua"]').click();
    else if (mode === 'zip-upload')
      await page
        .locator('#file')
        .setInputFiles({ name: 'lua.zip', mimeType: 'application/zip', buffer: zip });
    else
      await page.locator('#file').setInputFiles([
        { name: 'lua-client.exe', mimeType: 'application/octet-stream', buffer: exe },
        { name: 'lua54.dll', mimeType: 'application/octet-stream', buffer: dll },
        {
          name: 'main.lua',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            mode === 'non-string-script-error'
              ? 'error({})'
              : script.toString().replace('9007199254740993', '9007199254741017'),
          ),
        },
      ]);
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
      { timeout: 180000 },
    );
    const result = await page.evaluate(() => ({
      run: window.__lastRun
        ? {
            ...window.__lastRun,
            outputs: window.__lastRun.outputs.map((o) => ({ ...o, bytes: [...o.bytes] })),
          }
        : null,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      downloads: [...document.querySelectorAll('#outputs a')].map((a) => a.download),
      isolated: crossOriginIsolated,
    }));
    const failure = mode === 'non-string-script-error';
    assert.equal(result.run?.exitCode, failure ? 102 : 0, JSON.stringify(result));
    let verification;
    if (failure) {
      assert.equal(result.output, 'Lua error (non-string value)');
      assert.deepEqual(result.run.outputs, []);
      assert.deepEqual(result.downloads, []);
    } else {
      assert.equal(
        result.output.replaceAll('\r\n', '\n'),
        'LUA GUEST SCRIPT PASS\nLUA SCRIPT/DLL PASS\n',
      );
      assert.equal(
        result.run.modules.some((m) => m.name === 'lua54.dll'),
        false,
        'original DLL unloads',
      );
      assert.deepEqual(result.downloads, ['lua-output.bin']);
      assert.equal(result.run.outputs.length, 1);
      const bytes = Buffer.from(result.run.outputs[0].bytes);
      assert.equal(bytes.length, 24);
      verification = {
        unsigned: bytes.readBigUInt64LE(0).toString(),
        signed: bytes.readBigInt64LE(8).toString(),
        double: bytes.readDoubleLE(16),
      };
      assert.deepEqual(verification, {
        unsigned: mode === 'modified-script-upload' ? '9007199254741017' : '9007199254740993',
        signed: '-42',
        double: 0.5,
      });
    }
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll', 'msvcrt.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
    assert.deepEqual(result.run.deletedFiles, []);
    runs.push({ mode, verification, ...result });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
    dllSha256: pin.dll.sha256,
    archiveSha256: pin.upstream[0].sha256,
    scope:
      'Unchanged upstream LuaBinaries 5.4.2 Windows DLL with native Wine CRT and Kernel32/KernelBase/NTDLL. Its original scripting VM executes a supplied file, 64-bit integers above binary64 exact range, math, Unicode, table sorting, coroutines, protected errors, GC and binary file I/O. Original DLL calls an authored guest C callback with 64-bit parameters/result. Modified uploaded script changes independently decoded output while EXE/DLL stay identical. Non-string Lua exception exits 102 without a memory fault. Original ZIP, loose files and hosted catalog compile x86 to Wasm inside ordinary Chromium. No claim for all Lua modules, network/process APIs or arbitrary Windows compatibility.',
    runs,
    errors,
  };
  await writeFile('evidence/lua-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
