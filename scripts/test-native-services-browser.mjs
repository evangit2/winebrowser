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
  const exe = await readFile('tests/fixtures/native-services/native-services.exe');
  for (const profile of ['exe-upload', 'zip-upload']) {
    const buffer =
      profile === 'zip-upload' ? Buffer.from(zipSync({ 'app/native-services.exe': exe })) : exe;
    await page.locator('#file').setInputFiles({
      name: profile === 'zip-upload' ? 'services.zip' : 'native-services.exe',
      mimeType: profile === 'zip-upload' ? 'application/zip' : 'application/octet-stream',
      buffer,
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
    assert.equal(result.output.replaceAll('\r\n', '\n'), 'NATIVE SERVICES PASS\n');
    for (const name of [
      'kernel32.dll',
      'kernelbase.dll',
      'ntdll.dll',
      'version.dll',
      'ucrtbase.dll',
    ]) {
      const module = result.run.modules.find((m) => m.name === name);
      assert.ok(module && !module.host && module.path === '@runtime/' + name, name);
    }
    for (const name of [
      'shlwapi.dll!PathCanonicalizeW',
      'shlwapi.dll!PathCombineW',
      'shlwapi.dll!PathSkipRootW',
      'advapi32.dll!CryptGenRandom',
      'bcrypt.dll!BCryptGenRandom',
      'ntdll.dll!NtQueryObject',
      'ntdll.dll!NtSetInformationObject',
    ])
      assert.ok(result.run.apiNames.includes(name), name);
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
      'Original Wine version DLL and KernelBase path/character bodies execute through native PE32 imports in ordinary EXE and ZIP uploads. Resource version values, Unicode/UNC paths, secure browser entropy across Web Crypto request limits, CSP refcounts, default registry values and local connections, handle flag queries/set/protected-close/unprotect/unload all checked by the native client. Hive save/load and remote registry fail explicitly; no persistent key containers or encryption algorithms are implemented. x86 compilation occurs in the browser; universal application compatibility remains unverified.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/native-services-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  await browser?.close();
  await server?.close();
}
