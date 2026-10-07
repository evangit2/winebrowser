import { selectNativeCombo, nativeComboEdit, nativeComboText } from './lib/native-combo-input.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';
import { verifyAesZip } from './lib/verify-aes-zip.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const password = 'BrowserGui42',
  runs = [],
  checks = [],
  errors = [];
let server, browser, page;
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
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const response = await page.request.get(new URL('examples/manifest.json', url).href);
  assert.ok(response.ok());
  const example = (await response.json()).interactive.find((e) => e.name === '7zip-gui');
  assert.ok(example);
  const download = await page.request.get(new URL('examples/' + example.zip, url).href);
  assert.ok(download.ok());
  const zip = await download.body();
  assert.equal(hash(zip), example.zipSha256);
  const files = unzipSync(zip);
  assert.equal(
    hash(files['7zG.exe']),
    '4e6d8e866a10746a44602ec2e31057d8a552efc837b726033d72fd7739546e22',
  );
  assert.equal(
    hash(files['7z.dll']),
    'd132e89038c802c5d5281e543a83dc407680effe0144f21b4fb431dd45fca61d',
  );
  const provenance = JSON.parse(new TextDecoder().decode(files['PROVENANCE.json']));
  assert.deepEqual(provenance.unresolvedImports, []);
  assert.deepEqual(provenance.dynamicDependencies, ['7z.dll']);
  for (const f of provenance.files) assert.equal(hash(files[f.path]), f.sha256);
  const expected = Object.fromEntries(
    ['message.txt', 'binary.bin'].map((n) => [n, Buffer.from(files[n])]),
  );
  checks.push(
    'Unchanged upstream GUI EXE, codec DLL and packaged inputs match SHA-256 pins; full static and dynamic dependency closure resolves',
  );
  const control = (id) =>
    page.locator(`.virtual-desktop-control[data-control-id="${id}"]`).filter({ visible: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  async function load(mode = 'zip', extra = {}) {
    if (mode === 'hosted') await page.locator('[data-demo="7zip-gui"]').click();
    else if (mode === 'zip')
      await page.locator('#file').setInputFiles({
        name: '7zip-gui.zip',
        mimeType: 'application/zip',
        buffer: Object.keys(extra).length ? Buffer.from(zipSync({ ...files, ...extra })) : zip,
      });
    else
      await page.locator('#file').setInputFiles(
        Object.entries({ ...files, ...extra })
          .filter(([n]) => !/License|readme|PROVENANCE/i.test(n))
          .map(([name, b]) => ({
            name,
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(b),
          })),
      );
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    assert.ok(await page.locator('#run').isEnabled(), await page.locator('#logs').textContent());
  }
  async function start(args) {
    if (args) await page.locator('#args').fill(JSON.stringify(args));
    await page.evaluate(() => {
      window.__guiSeen = { progress: 0, report: 0, texts: [] };
      window.__guiObserver?.disconnect();
      window.__guiObserver = new MutationObserver(() => {
        for (const kind of ['progress', 'listview'])
          if (document.querySelector(`[data-control-type="${kind}"]`))
            window.__guiSeen[kind === 'progress' ? 'progress' : 'report']++;
        for (const e of document.querySelectorAll('[role="gridcell"]'))
          if (e.textContent && !window.__guiSeen.texts.includes(e.textContent))
            window.__guiSeen.texts.push(e.textContent);
      });
      window.__guiObserver.observe(document.querySelector('#desktop') ?? document.body, {
        childList: true,
        subtree: true,
      });
    });
    await page.locator('#run').click();
  }
  async function finish(label, code = 0) {
    await page.waitForFunction(
      () =>
        ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent) ||
        [...document.querySelectorAll('.virtual-desktop-control[data-control-type="button"]')].some(
          (e) => e.textContent === 'Close' && e.getClientRects().length && !e.disabled,
        ),
      null,
      { timeout: 180000 },
    );
    // The native progress dialog can retain completion messages and wait for
    // Close. Finish that user action, then retain the original exit-code and
    // byte-for-byte output assertions so application errors still fail.
    const completionMessages = [];
    if ((await page.locator('#state').textContent()) === 'RUNNING') {
      completionMessages.push(
        ...(await page.locator('[role="gridcell"]').allTextContents()).filter(Boolean),
      );
      console.log('Native completion messages:', label, completionMessages);
      try {
        await button('Close').click({ timeout: 2000 });
      } catch (error) {
        // Close is also briefly published immediately before automatic exit.
        // Only tolerate its disappearance when that exit actually happened.
        if (!['EXITED', 'ERROR'].includes(await page.locator('#state').textContent())) throw error;
      }
      await page.waitForFunction(
        () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
        null,
        { timeout: 180000 },
      );
    }
    const result = await page.evaluate(() => ({
      state: document.querySelector('#state').textContent,
      logs: document.querySelector('#logs').textContent,
      fault: window.__lastFaultDiagnostic,
      seen: window.__guiSeen,
      run: window.__lastRun && {
        ...window.__lastRun,
        outputs: window.__lastRun.outputs.map((e) => ({
          path: e.path,
          bytes: Array.from(e.bytes),
        })),
      },
    }));
    assert.equal(result.state, 'EXITED', JSON.stringify(result));
    assert.equal(result.run.exitCode, code, JSON.stringify(result));
    for (const name of [
      '7zg.exe',
      '7z.dll',
      'msvcrt.dll',
      'kernel32.dll',
      'kernelbase.dll',
      'ntdll.dll',
    ])
      assert.ok(
        result.run.loadedModules.some((m) => m.name === name && !m.host),
        name,
      );
    assert.equal(result.run.loadedModulesTruncated, false);
    assert.equal(result.fault, undefined);
    const outputs = result.run.outputs.map((e) => ({ path: e.path, bytes: Buffer.from(e.bytes) }));
    runs.push({
      label,
      exitCode: code,
      elapsedMs: result.run.elapsedMs,
      x86TranslationMs: result.run.x86TranslationMs,
      instructions: result.run.instructions,
      compiledBlocks: result.run.totalCompiledBlocks,
      loadedModules: result.run.loadedModules,
      apiNames: result.run.apiNames,
      seen: result.seen,
      completionMessages,
      outputs: outputs.map((e) => ({ path: e.path, bytes: e.bytes.length, sha256: hash(e.bytes) })),
    });
    console.log(label, code, result.run.instructions);
    return { ...result, outputs };
  }
  const exact = (result, prefix) => {
    for (const [n, b] of Object.entries(expected))
      assert.deepEqual(result.outputs.find((e) => e.path === prefix + n)?.bytes, b, n);
  };
  await load('hosted');
  await start();
  await button('OK').waitFor({ timeout: 60000 });
  assert.equal(await nativeComboText(control(104)), 'zip');
  await selectNativeCombo(control(104), { label: '7z' });
  await selectNativeCombo(control(104), { label: 'zip' });
  await selectNativeCombo(control(102), { label: '7 - Maximum' });
  await page.screenshot({
    path: process.env.WINEBROWSER_7ZIP_GUI_SCREENSHOT || 'evidence/7zip-gui-add.png',
    fullPage: true,
  });
  await button('OK').click();
  const plain = await finish(
    'Hosted original GUI: change format and compression level, then create ZIP',
  );
  const plainZip = plain.outputs.find((e) => e.path === 'out.zip').bytes,
    decoded = unzipSync(plainZip);
  assert.deepEqual(Object.keys(decoded).sort(), Object.keys(expected).sort());
  for (const [n, b] of Object.entries(expected)) assert.deepEqual(Buffer.from(decoded[n]), b);
  assert.ok(plain.seen.progress);
  checks.push(
    'Native archive-format and compression-level GUI changes produce a plain ZIP independently decoded with fflate; progress controls are observed',
  );
  await load('zip', { 'plain.zip': plainZip });
  await start(['x', '-ad', 'plain.zip']);
  await button('OK').waitFor({ timeout: 60000 });
  await nativeComboEdit(control(100)).fill('C:\\winebrowser\\gui-extracted');
  if (await control(131).isChecked()) {
    await control(131).click();
    await expect(control(131)).not.toBeChecked();
  }
  await button('OK').click();
  exact(
    await finish('ZIP upload: choose native extraction directory and extract ZIP'),
    'gui-extracted/',
  );
  checks.push('Native extraction dialog directory input creates exact text/binary outputs');
  await load('loose');
  await start(['a', '-ad', 'encrypted.zip', 'message.txt', 'binary.bin', '-tzip', '-mmt=2']);
  await button('OK').waitFor({ timeout: 60000 });
  await control(120).fill(password);
  await control(121).fill(password);
  await selectNativeCombo(control(122), { label: 'AES-256' });
  await button('OK').click();
  const aes = await finish('Loose original EXE/DLL: native password controls create AES-256 ZIP');
  const aesZip = aes.outputs.find((e) => e.path === 'encrypted.zip').bytes,
    entries = verifyAesZip(aesZip, expected, password);
  checks.push(
    'AES-256 ZIP independently derives keys, authenticates and decrypts both inputs with Node crypto',
  );
  await load('zip', { 'encrypted.zip': aesZip });
  await start(['x', '-ad', 'encrypted.zip']);
  await button('OK').waitFor({ timeout: 60000 });
  await nativeComboEdit(control(100)).fill('C:\\winebrowser\\gui-aes');
  if (await control(131).isChecked()) {
    await control(131).click();
    await expect(control(131)).not.toBeChecked();
  }
  await control(120).fill(password);
  await button('OK').click();
  exact(await finish('Native password extraction dialog decrypts AES ZIP'), 'gui-aes/');
  await load('zip');
  await start(['a', '-ad', 'cancel.zip', 'message.txt', '-tzip']);
  await button('Cancel').waitFor({ timeout: 60000 });
  await button('Cancel').click();
  const cancelled = await finish(
    'Native compression dialog Cancel uses C++ catch and exits without an archive',
    255,
  );
  assert.equal(cancelled.outputs.length, 0);
  checks.push('Native Cancel produces no output files');
  await load('zip');
  await start(['a', '-ad', 'native.7z', 'message.txt', 'binary.bin', '-mmt=2']);
  await button('OK').waitFor({ timeout: 60000 });
  await selectNativeCombo(control(110), { label: '2' });
  await button('OK').click();
  const lzma = await finish('Original GUI compresses with native multithreaded LZMA2');
  const lzmaArchive = lzma.outputs.find((e) => e.path === 'native.7z').bytes;
  assert.equal(lzmaArchive.subarray(0, 6).toString('hex'), '377abcaf271c');
  for (const name of [
    'NtCreateThreadEx',
    'NtResumeThread',
    'NtCreateSemaphore',
    'NtReleaseSemaphore',
    'NtWaitForSingleObject',
    'NtTerminateThread',
  ])
    assert.ok(lzma.run.apiNames.includes('ntdll.dll!' + name), name);
  await load('zip', { 'native.7z': lzmaArchive });
  await start(['x', 'native.7z', '-olzma-out']);
  exact(await finish('Original GUI extracts native LZMA2 output byte for byte'), 'lzma-out/');
  checks.push(
    'Native multithreaded LZMA2 compression uses real thread/semaphore services; native extraction preserves both input files',
  );
  async function errorCase(label, archive, args, pattern) {
    await load('zip', { [archive.name]: archive.bytes });
    await start(args);
    await page.waitForFunction(
      () =>
        document.querySelector('#state')?.textContent === 'ERROR' ||
        [...document.querySelectorAll('[role="gridcell"]')].some((e) =>
          /Data Error|CRC Failed|Wrong password/i.test(e.textContent),
        ),
      null,
      { timeout: 120000 },
    );
    assert.notEqual(
      await page.locator('#state').textContent(),
      'ERROR',
      await page.locator('#logs').textContent(),
    );
    const close = button('Close');
    await close.waitFor({ timeout: 30000 });
    // Native completion refreshes the report list with DeleteAll/InsertItem/
    // SetItemText. Assert its final text through the normal web retry boundary.
    await expect
      .poll(async () => (await page.getByRole('gridcell').allTextContents()).join('\n'))
      .toMatch(pattern);
    const rows = page.getByRole('row').filter({ has: page.getByRole('gridcell') });
    await rows.first().click();
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('grid').press('Control+a');
    await expect
      .poll(() =>
        rows.evaluateAll(
          (items) =>
            items.length > 0 && items.every((e) => e.getAttribute('aria-selected') === 'true'),
        ),
      )
      .toBe(true);
    await page.getByRole('grid').press('Control+c');
    await page.screenshot({
      path: process.env.WINEBROWSER_7ZIP_GUI_ERROR_SCREENSHOT || 'evidence/7zip-gui-errors.png',
      fullPage: true,
    });
    const result = await finish(label, 2);
    assert.ok(result.seen.report);
    assert.ok(result.run.apiNames.includes('user32.dll!SetClipboardData'));
    return result;
  }
  await errorCase(
    'Wrong password displays original native report-list errors and exits 2',
    { name: 'encrypted.zip', bytes: aesZip },
    ['t', 'encrypted.zip', '-pWrongPassword'],
    /Wrong password|Data Error/i,
  );
  const damaged = Buffer.from(aesZip);
  damaged[entries[0].ciphertextOffset] ^= 1;
  await errorCase(
    'Modified encrypted data displays native errors and exits 2',
    { name: 'damaged.zip', bytes: damaged },
    ['t', 'damaged.zip', `-p${password}`],
    /Data Error|CRC Failed|Wrong password/i,
  );
  checks.push(
    'Wrong password and damaged encrypted data show native report-list errors and exit with original error code 2',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    process.env.WINEBROWSER_7ZIP_GUI_EVIDENCE || 'evidence/7zip-gui-browser-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url,
        browser: browser.version(),
        scope:
          'Unchanged 7zG.exe and 7z.dll GUI compression, extraction, passwords, cancellation and report-list errors. File Manager 7zFM.exe and arbitrary Windows GUI/DLL compatibility are outside this acceptance.',
        checks,
        runs,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ url, checks, runs: runs.length }, null, 2));
} catch (error) {
  console.error(
    'GUI FAILURE',
    await page
      ?.evaluate(() => ({
        state: document.querySelector('#state').textContent,
        logs: document.querySelector('#logs').textContent,
        titles: [...document.querySelectorAll('.virtual-desktop-title')].map((e) => e.textContent),
        controls: [...document.querySelectorAll('.virtual-desktop-control')].map((e) => ({
          id: e.dataset.controlId,
          type: e.dataset.controlType,
          text: e.textContent.slice(0, 200),
        })),
      }))
      .catch(() => null),
  );
  await page?.screenshot({ path: '.cache/foss/7zg-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
