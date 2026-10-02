import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
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
  for (const profile of ['host', 'native']) {
    const bytes = await readFile(`tests/fixtures/api-sets/${profile}.exe`);
    await page.locator('#file').setInputFiles({
      name: `${profile}.exe`,
      mimeType: 'application/octet-stream',
      buffer: bytes,
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
    console.log('Loaded API-set profile:', profile);
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
        'evidence/api-sets-browser-failure.json',
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
      profile === 'host' ? /HOST API SET SERVICES PASS/ : /NATIVE API SET SCHEMA PASS/,
    );
    const kernelbase = result.run.modules.find((m) => m.name === 'kernelbase.dll');
    assert.equal(kernelbase?.host, profile === 'host');
    if (profile === 'native')
      assert.ok(result.run.modules.some((m) => m.name === 'ntdll.dll' && !m.host));
    assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
    runs.push({
      profile,
      exeSha256: createHash('sha256').update(bytes).digest('hex'),
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
      'Native authored EXE uploads import seven Windows API-set families, execute heap/file/registry/character services, read the real guest PEB namespace, preserve module identities and fail missing exports. Native variant automatically selects source-built Wine and queries schema presence through unchanged NTDLL.',
    runs,
    errors,
  };
  await writeFile('evidence/api-sets-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
