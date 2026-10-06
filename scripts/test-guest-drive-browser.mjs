import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';
let server, browser, page;
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
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chromium' });
  page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
  const errors = [],
    runs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  for (const mode of ['host-sdk', 'exe-upload', 'zip-upload', 'hosted-example']) {
    const file = mode === 'host-sdk' ? 'guest-drive-host.exe' : 'guest-drive.exe';
    const executable = await readFile('tests/fixtures/guest-drive/' + file);
    const zipped = mode === 'zip-upload';
    if (mode === 'hosted-example') {
      const response = await page.request.get(new URL('examples/manifest.json', url).href);
      assert.ok(response.ok());
      const entry = (await response.json()).interactive.find((e) => e.name === 'guest-drive');
      assert.ok(entry);
      assert.equal(createHash('sha256').update(executable).digest('hex'), entry.exeSha256);
      const received = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="guest-drive"]').click();
      const archive = await received;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'guest-drive.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
      await expect(page.locator('#exe')).toHaveValue(entry.exe);
    } else
      await page.locator('#file').setInputFiles({
        name: zipped ? 'guest-drive.zip' : file,
        mimeType: zipped ? 'application/zip' : 'application/octet-stream',
        buffer: zipped ? Buffer.from(zipSync({ 'app/guest-drive.exe': executable })) : executable,
      });
    await expect(page.locator('#run')).toBeEnabled();
    await page.locator('#run').click();
    const observations = [];
    if (mode !== 'host-sdk') {
      await page.waitForFunction(
        () =>
          document.querySelector('.virtual-desktop-window') ||
          window.__lastRun != null ||
          document.querySelector('#state')?.textContent === 'ERROR',
        null,
        { timeout: 60000 },
      );
      assert.equal(
        await page.evaluate(() => window.__lastRun),
        null,
        await page.locator('#logs').textContent(),
      );
      const root = page.locator('.virtual-desktop-window'),
        title = root.locator('.virtual-desktop-title');
      await expect(title).toHaveText('Guest drive — ready');
      await expect(
        root.getByRole('button', { name: 'Resize to 4 KiB', exact: true }),
      ).toBeDisabled();
      await expect(root.getByRole('button', { name: 'Delete file', exact: true })).toBeDisabled();
      for (const [button, caption] of [
        ['Write 8 KiB', 'Guest drive — wrote 8192 bytes'],
        ['Resize to 4 KiB', 'Guest drive — resized to 4096 bytes'],
        ['Delete file', 'Guest drive — deleted file, capacity restored'],
      ]) {
        await root.getByRole('button', { name: button, exact: true }).click();
        await expect(title).toHaveText(caption);
        observations.push(caption);
      }
      await root.getByRole('button', { name: 'Open file…', exact: true }).click();
      await expect(page.locator('#file-picker')).toBeVisible();
      const canceled = await page.locator('#file-picker').getAttribute('data-request-token');
      await page.keyboard.press('Escape');
      await expect(page.locator('#file-picker')).toBeHidden();
      await root.getByRole('button', { name: 'Open file…', exact: true }).click();
      await expect(page.locator('#file-picker')).toBeVisible();
      await expect(page.locator('#file-picker')).not.toHaveAttribute(
        'data-request-token',
        canceled,
      );
      await page.locator('#file-picker-import').setInputFiles({
        name: 'picked.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Native guest drive GUI import\n'),
      });
      await expect(page.locator('#file-picker-name')).toHaveValue('picked.txt');
      await page.locator('#file-picker-ok').click();
      await expect(page.locator('#file-picker')).toBeHidden();
      await expect(title).toHaveText('Guest drive — opened selected file');
      observations.push(
        'Native picker canceled and reopened; imported file opened through native Wine',
      );
      // Repeat writes after import to exercise accounting from the changed file map.
      for (const [button, caption] of [
        ['Write 8 KiB', 'Guest drive — wrote 8192 bytes'],
        ['Resize to 4 KiB', 'Guest drive — resized to 4096 bytes'],
        ['Delete file', 'Guest drive — deleted file, capacity restored'],
      ]) {
        await root.getByRole('button', { name: button, exact: true }).click();
        await expect(title).toHaveText(caption);
      }
      await root.screenshot({ path: '.scratch/guest-drive-' + mode + '.png' });
      await root.locator('.virtual-desktop-close').click();
    }
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.isolated, true);
    assert.ok(result.run.totalCompiledBlocks > 0 && result.run.x86TranslationMs > 0);
    if (mode !== 'host-sdk') {
      for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
        assert.ok(
          result.run.modules.some(
            (m) => m.name === name && !m.host && m.path === '@runtime/' + name,
          ),
          name,
        );
      for (const name of [
        'NtQueryDirectoryObject',
        'NtQueryVolumeInformationFile',
        'NtWriteFile',
        'NtSetInformationFile',
      ])
        assert.ok(result.run.apiNames.includes('ntdll.dll!' + name), name);
      assert.equal(result.run.outputs.length, 0, 'demo file deleted before exit');
    }
    runs.push({
      mode,
      exeSha256: createHash('sha256').update(executable).digest('hex'),
      observations,
      ...result,
    });
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    url,
    browser: browser.version(),
    scope:
      'Unchanged SDK PE32 EXEs translated to Wasm inside browser. Host SDK contracts and real native Wine drive enumeration/size queries; GUI writes 8192 bytes, resizes to 4096 and deletes, asserting free-byte deltas in guest code. Picker cancel/reopen/import and native file read; repeated accounting after import. Bounded 128MiB guest content budget, 16MiB growth per file. Full Windows filesystem compatibility remains unfinished.',
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_GUEST_DRIVE_REPORT || 'evidence/guest-drive-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
        fault: window.__lastFaultDiagnostic,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
