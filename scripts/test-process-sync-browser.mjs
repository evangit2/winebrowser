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
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
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
  const exe = await readFile('tests/fixtures/process-sync/process-sync.exe');
  for (const [profile, path, args] of [
    ['native-family-ipc', 'process-sync.exe', []],
    ['renamed-nested', 'unrelated folder/renamed program.exe', []],
    ['parent-exit', 'process-sync.exe', ['--detached']],
    ['main-thread-exit', 'process-sync.exe', ['--main-exit']],
    ['stop-pending-waits', 'process-sync.exe', ['--hold']],
    ['fresh-upload-after-stop', 'process-sync.exe', []],
  ]) {
    await page.locator('#file').setInputFiles({
      name: 'process-sync.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({ [path]: exe })),
    });
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    await page.locator('#exe').selectOption(path);
    await page.locator('#args').fill(JSON.stringify(args));
    assert.ok(await page.locator('#run').isEnabled(), await page.locator('#details').textContent());
    await page.locator('#run').click();
    if (profile === 'stop-pending-waits') {
      await page.waitForFunction(
        () =>
          document.querySelector('#output').textContent.includes('IPC PARKED') ||
          ['EXITED', 'ERROR'].includes(document.querySelector('#state').textContent),
        null,
        { timeout: 120000 },
      );
      assert.equal(
        await page.locator('#state').textContent(),
        'RUNNING',
        await page.locator('#logs').textContent(),
      );
      await page.locator('#stop').click();
      assert.equal(await page.locator('#state').textContent(), 'STOPPED');
      runs.push({ profile, state: 'STOPPED' });
      continue;
    }
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      state: document.querySelector('#state').textContent,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      fault: window.__lastFaultDiagnostic,
      isolated: crossOriginIsolated,
    }));
    console.log(
      profile,
      JSON.stringify({
        state: result.state,
        output: result.output,
        processes: result.run?.processes?.map((p) => ({ exe: p.exe, exitCode: p.exitCode })),
      }),
    );
    assert.equal(result.state, 'EXITED', JSON.stringify(result));
    assert.equal(result.run.exitCode, 0, JSON.stringify(result));
    const processes = result.run.processes;
    assert.ok(
      processes.every((p) => p.exitCode === 0),
      JSON.stringify(result),
    );
    const expected = !args.length
      ? 'CHILD IPC PASS\nABANDONING CHILD PASS\nPROCESS SYNC PASS\n'
      : profile === 'parent-exit'
        ? 'PARENT IPC EXIT\nSURVIVING CHILD PASS\n'
        : 'MAIN THREAD ABANDONMENT PASS\n';
    assert.equal(result.output.replaceAll('\r\n', '\n'), expected);
    assert.equal(processes.length, !args.length ? 3 : profile === 'parent-exit' ? 2 : 1);
    const calls = new Set(processes.flatMap((p) => p.apiNames));
    assert.ok(calls.has('ntdll.dll!NtCreateMutant'), 'native Wine mutant creation');
    assert.ok(calls.has('ntdll.dll!NtReleaseMutant'), 'native Wine mutant release');
    if (!args.length) {
      for (const name of [
        'NtOpenMutant',
        'NtCreateUserProcess',
        'NtOpenSemaphore',
        'NtOpenEvent',
        'NtTerminateThread',
      ])
        assert.ok(calls.has('ntdll.dll!' + name), name);
    }
    assert.ok(processes[0].modules.some((m) => m.name === 'kernelbase.dll' && !m.host));
    runs.push({ profile, ...result });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    process.env.PROCESS_SYNC_EVIDENCE || 'evidence/process-sync-browser-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url,
        browser: browser.version(),
        exeSha256: createHash('sha256').update(exe).digest('hex'),
        runs,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await browser?.close();
  await server?.close();
}
