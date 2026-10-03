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
    headless: true,
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
  const parent = await readFile('tests/fixtures/processes/parent.exe'),
    child = await readFile('tests/fixtures/processes/child.exe');
  for (const [profile, prefix, name, args] of [
    ['suspended-wait-files', 'app', 'launcher.exe', []],
    ['renamed-nested', 'different/root with spaces', 'renamed launcher.exe', []],
    ['winexec-detached', 'app', 'launcher.exe', ['--detached']],
    ['child-window', 'app', 'launcher.exe', ['--gui']],
    ['child-stop', 'app', 'launcher.exe', ['--gui']],
    ['post-stop-reupload', 'app', 'launcher.exe', []],
  ]) {
    const archive = Buffer.from(
      zipSync({
        [`${prefix}/${name}`]: parent,
        [`${prefix}/engine folder/worker renamed.exe`]: child,
      }),
    );
    await page
      .locator('#file')
      .setInputFiles({ name: 'processes.zip', mimeType: 'application/zip', buffer: archive });
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    await page.locator('#exe').selectOption(`${prefix}/${name}`);
    await page.locator('#args').fill(JSON.stringify(args));
    assert.ok(await page.locator('#run').isEnabled(), await page.locator('#details').textContent());
    await page.locator('#run').click();
    if (profile === 'child-window' || profile === 'child-stop') {
      await page.waitForFunction(
        () =>
          document.querySelector('#output').textContent.includes('GUI CHILD READY') ||
          document.querySelector('#state').textContent === 'ERROR',
        null,
        { timeout: 120000 },
      );
      const state = await page.locator('#state').textContent();
      assert.equal(state, 'RUNNING', await page.locator('#logs').textContent());
      const ids = await page
        .locator('.virtual-desktop-window')
        .evaluateAll((windows) => windows.map((w) => w.dataset.windowId));
      assert.equal(ids.length, 2);
      assert.equal(new Set(ids).size, 2);
      if (profile === 'child-stop') {
        await page.locator('#stop').click();
        assert.equal(await page.locator('#state').textContent(), 'STOPPED');
        assert.equal(await page.locator('.virtual-desktop-window').count(), 0);
        runs.push({ profile, state: 'STOPPED', windowIds: ids });
        continue;
      }
      await page
        .getByRole('button', { name: 'Close Independent parent window', exact: true })
        .click();
      await page.waitForFunction(() =>
        document.querySelector('#output').textContent.includes('GUI LAUNCHER EXIT'),
      );
      const window = page.getByText('Independent child window', { exact: true });
      await window.waitFor();
      // The desktop's own close control exercises worker input routing after
      // the parent has exited, rather than calling a Runtime helper directly.
      await page
        .getByRole('button', { name: 'Close Independent child window', exact: true })
        .click();
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
      isolated: crossOriginIsolated,
      fault: window.__lastFaultDiagnostic,
    }));
    console.log(
      profile,
      JSON.stringify({
        state: result.state,
        output: result.output,
        processes: result.run?.processes?.map((p) => ({ exe: p.exe, exitCode: p.exitCode })),
        logs: result.logs,
      }),
    );
    assert.equal(result.state, 'EXITED', JSON.stringify(result));
    assert.equal(result.run.exitCode, 0, JSON.stringify(result));
    if (!args.length) {
      assert.equal(
        result.output.replaceAll('\r\n', '\n'),
        'WIDE CHILD PASS\nANSI CHILD PASS\nPROCESS PASS\n',
      );
      assert.deepEqual(
        result.run.processes.map((p) => p.exitCode),
        [0, 73, 74, 91],
      );
      assert.ok(
        result.run.outputs.some((f) => f.path === `${prefix}/engine folder/child-output.txt`),
      );
    } else if (profile === 'winexec-detached') {
      assert.equal(result.output.replaceAll('\r\n', '\n'), 'LAUNCHER EXIT\nDETACHED CHILD PASS\n');
      assert.deepEqual(
        result.run.processes.map((p) => p.exitCode),
        [0, 75],
      );
    } else {
      assert.ok(result.output.includes('GUI CHILD CLOSED'));
      assert.deepEqual(
        result.run.processes.map((p) => p.exitCode),
        [0, 0],
      );
    }
    const root = result.run.processes[0];
    assert.ok(root.apiNames.includes('ntdll.dll!NtCreateUserProcess'));
    assert.ok(root.apiNames.includes('ntdll.dll!NtResumeThread'));
    assert.ok(root.modules.find((m) => m.name === 'kernelbase.dll' && !m.host));
    runs.push({ profile, ...result });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    process.env.PROCESS_EVIDENCE || 'evidence/processes-browser-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url,
        browser: browser.version(),
        parentSha256: createHash('sha256').update(parent).digest('hex'),
        childSha256: createHash('sha256').update(child).digest('hex'),
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
