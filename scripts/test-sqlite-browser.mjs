import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pin = JSON.parse(await readFile('runtime/target-builds/sqlite.json'));
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
  const fetchAsset = async (path, expected) => {
    const response = await page.request.get(new URL('examples/' + path, url).href);
    assert.equal(response.status(), 200, path);
    const bytes = await response.body();
    if (expected) assert.equal(sha(bytes), expected, path);
    return bytes;
  };
  const [zip, exe, dll] = await Promise.all([
    fetchAsset(pin.zip.path, pin.zip.sha256),
    fetchAsset(pin.client.path, pin.client.sha256),
    fetchAsset(pin.dll.path, pin.dll.sha256),
  ]);
  const manifest = JSON.parse((await fetchAsset('manifest.json')).toString());
  const entry = manifest.interactive.find((e) => e.name === 'sqlite');
  assert.ok(entry);
  assert.equal(entry.zipSha256, pin.zip.sha256);
  await mkdir('.scratch/sqlite-browser', { recursive: true });
  for (const mode of [
    'zip-upload',
    'zip-rerun-after-stale-journal',
    'exe-and-dll-upload',
    'hosted-example',
  ]) {
    if (mode === 'hosted-example') await page.locator('[data-demo="sqlite"]').click();
    else
      await page.locator('#file').setInputFiles(
        mode.startsWith('zip-')
          ? { name: 'sqlite.zip', mimeType: 'application/zip', buffer: zip }
          : [
              { name: 'sqlite-client.exe', mimeType: 'application/octet-stream', buffer: exe },
              { name: 'sqlite3.dll', mimeType: 'application/octet-stream', buffer: dll },
            ],
      );
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
      run: window.__lastRun
        ? {
            ...window.__lastRun,
            outputs: window.__lastRun.outputs.map((o) => ({ ...o, bytes: [...o.bytes] })),
          }
        : null,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      downloads: [...document.querySelectorAll('#outputs a')].map((a) => a.download),
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(
      result.output,
      'SQLITE MEMORY PASS\nSQLITE CONTENTION PASS\nSQLITE DISK PASS\nSQLITE NATIVE DLL PASS\n',
    );
    assert.doesNotMatch(result.logs, /Output persistence unavailable/);
    assert.deepEqual(result.downloads, ['database.db']);
    assert.equal(
      result.run.modules.some((m) => m.name === 'sqlite3.dll'),
      false,
      'original DLL unloads',
    );
    for (const dll of ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === dll && !m.host && m.path === '@runtime/' + dll),
        dll,
      );
    for (const service of [
      'NtLockFile',
      'NtUnlockFile',
      'NtReadFile',
      'NtWriteFile',
      'NtFlushBuffersFile',
    ])
      assert.ok(result.run.apiNames.includes('ntdll.dll!' + service), service);
    assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
    assert.equal(result.run.outputs.length, 1);
    assert.equal(result.run.deletedFiles.length, 1);
    assert.match(result.run.deletedFiles[0], /database\.db-journal$/);
    const db = Buffer.from(result.run.outputs[0].bytes);
    assert.equal(db.subarray(0, 16).toString(), 'SQLite format 3\0');
    const databasePath = `.scratch/sqlite-browser/${mode}.db`;
    await writeFile(databasePath, db);
    const nativeVerification = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          'import sys,sqlite3,json; d=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps({"rows":d.execute("SELECT id,label,hex(data) FROM sample ORDER BY id").fetchall(),"integrity":d.execute("PRAGMA integrity_check").fetchall()})); d.close()',
          databasePath,
        ],
        { encoding: 'utf8' },
      ),
    );
    assert.deepEqual(nativeVerification, {
      rows: [[1, 'database ✓', '0102FF']],
      integrity: [['ok']],
    });
    runs.push({
      mode,
      exitCode: 0,
      elapsedMs: result.run.elapsedMs,
      x86TranslationMs: result.run.x86TranslationMs,
      totalCompiledBlocks: result.run.totalCompiledBlocks,
      instructions: result.run.instructions,
      databaseBytes: db.length,
      databaseSha256: sha(db),
      deletedFiles: result.run.deletedFiles,
      nativeVerification,
      output: result.output,
      modules: result.run.modules,
    });
    // Seed an old persisted journal. The immediate rerun of this same ZIP must
    // remove it after real SQLite journal deletion, while retaining its DB.
    if (mode === 'zip-upload')
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(),
          outputs = await root.getDirectoryHandle('winebrowser-output');
        for await (const [, packageDir] of outputs.entries()) {
          const app = await packageDir.getDirectoryHandle('app');
          const journal = await app.getFileHandle('database.db-journal', { create: true }),
            writer = await journal.createWritable();
          await writer.write('stale journal');
          await writer.close();
        }
      });
  }
  const persisted = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(),
      outputs = await root.getDirectoryHandle('winebrowser-output');
    const files = [];
    const visit = async (dir, prefix = '') => {
      for await (const [name, entry] of dir.entries()) {
        if (entry.kind === 'directory') await visit(entry, prefix + name + '/');
        else files.push({ path: prefix + name, bytes: (await entry.getFile()).size });
      }
    };
    await visit(outputs);
    return files;
  });
  assert.ok(persisted.length >= 2);
  assert.ok(persisted.every((f) => f.path.endsWith('database.db')));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
    browser: browser.version(),
    originalDllSha256: pin.dll.sha256,
    originalArchiveSha256: pin.upstream[0].sha256,
    sourceId: pin.sourceId,
    scope:
      'Unchanged upstream SQLite Windows PE32 DLL in ordinary ZIP, loose EXE/DLL and catalog uploads. In-browser x86 compilation; native Wine NT byte locking, positioned I/O and delete-on-close; memory and disk SQL, rollback, competing writers, Unicode text/blob, reopen/integrity_check, output download and persisted journal deletion. Database independently verified by native Python SQLite. No claim for WAL/background I/O or universal DLL compatibility.',
    runs,
    persisted,
    errors,
  };
  await writeFile('evidence/sqlite-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
