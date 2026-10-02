import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { zipSync } from 'fflate';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
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
  browser = await chromium.launch(
    process.env.WINEBROWSER_NORMAL_CHROMIUM === '1' ? { headless: false } : webgpuBrowserOptions,
  );
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
  for (const profile of ['cpp-runtime', 'plugin-host']) {
    const bytes = await readFile(`tests/fixtures/cpp-runtime/${profile}.exe`);
    const plugin =
      profile === 'plugin-host'
        ? await readFile('tests/fixtures/cpp-runtime/cpp-client.dll')
        : null;
    await page.locator('#file').setInputFiles(
      plugin
        ? {
            name: 'cpp-plugin.zip',
            mimeType: 'application/zip',
            buffer: Buffer.from(
              zipSync({ 'app/plugin-host.exe': bytes, 'app/plugins/cpp-client.dll': plugin }),
            ),
          }
        : {
            name: `${profile}.exe`,
            mimeType: 'application/octet-stream',
            buffer: bytes,
          },
    );
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
    console.log('Loaded C++ runtime profile:', profile);
    await page.locator('#run').click();
    try {
      await page.waitForFunction(
        () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
        null,
        { timeout: 120000 },
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        profileState: document.querySelector('#state').textContent,
        output: document.querySelector('#output').textContent,
        logs: document.querySelector('#logs').textContent,
        metrics: document.querySelector('#metrics').textContent,
        fault: window.__lastFaultDiagnostic,
      }));
      await writeFile(
        'evidence/cpp-runtime-browser-failure.json',
        JSON.stringify({ profile, diagnostic }, null, 2) + '\n',
      );
      throw error;
    }
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.match(
      result.output,
      profile === 'plugin-host' ? /CPP PLUGIN RELOAD PASS/ : /NATIVE CPP RUNTIME PASS/,
    );
    if (plugin)
      assert.equal(
        result.run.modules.some((m) => m.name === 'cpp-client.dll'),
        false,
        'the supplied native plugin unloads after both calls',
      );
    for (const dll of [
      'ntdll.dll',
      'kernel32.dll',
      'kernelbase.dll',
      ...(plugin ? [] : ['ucrtbase.dll', 'vcruntime140.dll', 'msvcp140.dll', 'msvcp140_1.dll']),
    ])
      assert.ok(
        result.run.modules.some((m) => m.name === dll && !m.host && m.path === '@runtime/' + dll),
        dll,
      );
    if (plugin) {
      assert.equal((result.output.match(/NATIVE CPP RUNTIME PASS/g) ?? []).length, 2);
      for (const name of ['msvcp140_1.dll'])
        assert.equal(
          result.run.modules.some((m) => m.name === name),
          false,
          `${name} unloads after the plugin's final release`,
        );
    } else {
      assert.ok(
        result.run.modules.some(
          (m) => m.name === 'concrt140.dll' && !m.host && m.path === '@runtime/concrt140.dll',
        ),
      );
    }
    assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
    runs.push({
      profile,
      exeSha256: createHash('sha256').update(bytes).digest('hex'),
      pluginSha256: plugin ? createHash('sha256').update(plugin).digest('hex') : null,
      exitCode: result.run.exitCode,
      x86TranslationMs: result.run.x86TranslationMs,
      elapsedMs: result.run.elapsedMs,
      totalCompiledBlocks: result.run.totalCompiledBlocks,
      instructions: result.run.instructions,
      modules: result.run.modules,
      output: result.output,
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
    browser: browser.version(),
    scope:
      'Ordinary authored native PE32 upload automatically fetches source-built Wine Visual C++ DLLs: native mutex ownership/try-lock behavior, independently owned exception-message copies, real thiscall aligned allocation/deallocation, mangled Concurrency::Alloc/Free exports, library reference balancing and clean exit; a nested uploaded plugin then runs the checks twice across plugin and MSVCP140_1 unload/reload cycles, preserving Wine-owned references to MSVCP140/ConCRT. No Microsoft redistributable binaries or success stubs are supplied.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/cpp-runtime-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
