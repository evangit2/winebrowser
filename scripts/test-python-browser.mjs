// Optional unchanged upstream Windows CPython acceptance; binaries stay private.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';
const upstream = 'https://www.python.org/ftp/python/3.8.10/python-3.8.10-embed-win32.zip';
const zipSha256 = '760dc79bcb434ee80b1001a30bb6f798287881851bac6d8137867894d40ef1fc';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filename = process.env.WINEBROWSER_PYTHON_ZIP || '.cache/python-3.8.10-embed-win32.zip';
let zip;
try {
  zip = await readFile(filename);
} catch (error) {
  if (error.code !== 'ENOENT' || process.env.WINEBROWSER_PYTHON_ZIP) throw error;
  const response = await fetch(upstream);
  assert.ok(response.ok, 'official CPython download');
  zip = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(zip), zipSha256);
  await mkdir('.cache', { recursive: true });
  await writeFile(filename, zip);
}
assert.equal(hash(zip), zipSha256, 'unchanged official Win32 embeddable distribution');
const packaged = unzipSync(zip);
const workload = await readFile('tests/fixtures/python/workload.py', 'utf8');
const oracle = JSON.parse(await readFile('tests/fixtures/python/wine-oracle.json', 'utf8'));
const databaseSha256 = (
  await readFile('tests/fixtures/python/wine-database-sha256.txt', 'utf8')
).trim();
let browser, server;
const errors = [];
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
  browser = await chromium.launch(process.argv.includes('--chrome') ? { channel: 'chrome' } : {});
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles({
    name: 'python-3.8.10-embed-win32.zip',
    mimeType: 'application/zip',
    buffer: zip,
  });
  await page.waitForFunction(
    () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
    null,
    { timeout: 120000 },
  );
  await page.locator('#exe').selectOption('python.exe');
  assert.equal(
    await page.locator('#run').isEnabled(),
    true,
    await page.locator('#details').textContent(),
  );
  await page.locator('#args').fill(JSON.stringify(['-c', workload]));
  await page.locator('#run').click();
  await page.waitForFunction(
    () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
    null,
    { timeout: 300000 },
  );
  const observed = await page.evaluate(() => ({
    state: document.querySelector('#state').textContent,
    stdout: document.querySelector('#output').textContent,
    logs: document.querySelector('#logs').textContent,
    fault: window.__lastFaultDiagnostic,
    run: window.__lastRun && {
      ...window.__lastRun,
      outputs: window.__lastRun.outputs.map((e) => ({ path: e.path, bytes: Array.from(e.bytes) })),
    },
  }));
  assert.equal(observed.state, 'EXITED', JSON.stringify(observed));
  assert.equal(observed.run.exitCode, 0, observed.stdout);
  const outputs = observed.run.outputs.map((e) => ({ ...e, bytes: Buffer.from(e.bytes) }));
  const resultFile = outputs.find((e) => e.path === 'workload-results.json');
  assert.ok(resultFile, 'guest persisted the completed workload');
  assert.deepEqual(
    JSON.parse(resultFile.bytes.toString('utf8')),
    oracle,
    'identical results from original CPython on native Wine',
  );
  assert.equal(
    observed.stdout,
    'PYTHON NATIVE EXTENSION WORKLOAD ' + resultFile.bytes.toString('utf8'),
    'console and file results agree byte for byte',
  );
  const names = [
    'python38.dll',
    'vcruntime140.dll',
    'ucrtbase.dll',
    'kernel32.dll',
    'kernelbase.dll',
    'ntdll.dll',
    '_decimal.pyd',
    '_sqlite3.pyd',
    'sqlite3.dll',
    '_bz2.pyd',
    '_lzma.pyd',
    'unicodedata.pyd',
    '_elementtree.pyd',
    'pyexpat.pyd',
  ];
  for (const name of names)
    assert.ok(
      observed.run.loadedModules.some((m) => m.name === name && !m.host),
      'native x86 module executed: ' + name,
    );
  const database = outputs.find((e) => e.path === 'compatibility.db');
  assert.ok(database, 'on-disk SQLite database');
  assert.equal(hash(database.bytes), databaseSha256, 'database bytes match native Wine');
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    browser: browser.version(),
    url,
    scope:
      'Ordinary ZIP upload of unchanged official Windows CPython 3.8.10 and its native extension DLLs; x86-to-Wasm translation in the browser. Console output, seven native extension modules, compression round trips, decimal arithmetic, Unicode normalization, XML callbacks and on-disk SQLite transactions/rollback/reopen/integrity_check match native Wine. No ctypes, OpenSSL, TLS, sockets, arbitrary Python packages or universal Windows compatibility claim.',
    upstream,
    zipSha256,
    workloadSha256: hash(workload),
    oracle,
    modules: names.map((name) => ({
      name,
      sha256: packaged[name] ? hash(packaged[name]) : undefined,
    })),
    run: {
      exitCode: observed.run.exitCode,
      elapsedMs: observed.run.elapsedMs,
      x86TranslationMs: observed.run.x86TranslationMs,
      instructions: observed.run.instructions,
      compiledBlocks: observed.run.totalCompiledBlocks,
      loadedModules: observed.run.loadedModules,
      apiNames: observed.run.apiNames,
    },
    stdout: observed.stdout,
    outputs: outputs.map((e) => ({ path: e.path, bytes: e.bytes.length, sha256: hash(e.bytes) })),
    errors,
  };
  await mkdir('evidence', { recursive: true });
  await writeFile(
    process.env.WINEBROWSER_PYTHON_REPORT || 'evidence/python-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        browser: report.browser,
        elapsedMs: report.run.elapsedMs,
        x86TranslationMs: report.run.x86TranslationMs,
        nativeModules: names.length,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server?.close();
}
