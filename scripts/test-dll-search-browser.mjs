import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
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
  const files = new Map();
  for (const name of ['helper.dll', 'app/helper.dll', 'plugins/helper.dll', 'plugins/plugin.dll'])
    files.set(name, await readFile('tests/fixtures/dll-search/' + name));
  for (const profile of ['host', 'native']) {
    const exe = await readFile(`tests/fixtures/dll-search/app/${profile}.exe`);
    const zip = zipSync(Object.fromEntries([...files, [`app/${profile}.exe`, exe]]));
    await page.locator('#file').setInputFiles({
      name: 'dll-search.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zip),
    });
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    assert.equal(
      await page.locator('#run').isEnabled(),
      true,
      await page.locator('#details').textContent(),
    );
    await page.locator('#run').click();
    try {
      await page.waitForFunction(
        () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
        null,
        { timeout: 120000 },
      );
    } catch (error) {
      console.log(
        await page.evaluate(() => ({
          state: document.querySelector('#state').textContent,
          output: document.querySelector('#output').textContent,
          logs: document.querySelector('#logs').textContent,
          fault: window.__lastFaultDiagnostic,
        })),
      );
      throw error;
    }
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    console.log(profile, JSON.stringify(result));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(
      result.output.replaceAll('\r\n', '\n'),
      profile.toUpperCase() + ' DLL SEARCH PASS\n',
    );
    assert.equal(
      result.run.modules.some((m) => ['helper.dll', 'plugin.dll'].includes(m.name)),
      false,
      'loaded plugins and dependencies unload',
    );
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll']) {
      const module = result.run.modules.find((m) => m.name === name);
      if (profile === 'native')
        assert.ok(module && !module.host && module.path === '@runtime/' + name, name);
    }
    assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
    assert.deepEqual(result.run.outputs, []);
    assert.deepEqual(result.run.deletedFiles, []);
    runs.push({ profile, exeSha256: createHash('sha256').update(exe).digest('hex'), ...result });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
    scope:
      'Ordinary ZIP upload runs native PE32 clients and same-name DLLs with distinct outputs in package root, application and plugin directories. Host and native Wine LoadLibraryEx honor application, SYSTEM32 and DLL_LOAD_DIR selection, dependency imports, DllMain calls, invalid combinations, path queries and unload. Native Wine AddDllDirectory/RemoveDllDirectory and SetDefaultDllDirectories control real guest loads; removed/empty user searches cannot fall back to package files. x86 compilation occurs in the browser. Datafile/resource loading, signed-target enforcement and arbitrary Windows compatibility remain unsupported.',
    dllSha256: Object.fromEntries(
      [...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]),
    ),
    runs,
    errors,
  };
  await writeFile(
    'evidence/dll-search-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  await browser?.close();
  await server?.close();
}
