import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4173',
    '--strictPort',
  ],
  { stdio: 'pipe' },
);
let browser;
const manifest = JSON.parse(await readFile('public/demos/manifest.json', 'utf8'));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4173')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw Error('Preview server did not start');
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const outbound = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/') && !request.url().startsWith('blob:'))
      outbound.push(request.url());
  });
  await page.goto('http://127.0.0.1:4173');
  if (!(await page.evaluate(() => crossOriginIsolated)))
    throw Error('Missing cross-origin isolation');

  await page.click('#run-suite');
  await page.waitForFunction(
    () => {
      const status = document.getElementById('suite-status').textContent;
      return /^\d+\/\d+ passed$/.test(status);
    },
    {},
    { timeout: 120000 },
  );
  const suiteRows = await page.locator('#suite-results tr').evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.cells[0].textContent,
      result: row.cells[1].textContent,
      checks: row.cells[2].textContent,
    })),
  );
  if (suiteRows.length !== manifest.fixtures.length)
    throw Error('Suite did not run all manifest fixtures');
  for (const fixture of manifest.fixtures) {
    const row = suiteRows.find((item) => item.name === fixture.name);
    if (!row || row.result !== 'PASS')
      throw Error(`Suite failed ${fixture.name}: ${row?.checks ?? 'no result'}`);
  }

  // ZIP upload must execute and persist its generated file in OPFS.
  const filesFixture = manifest.fixtures.find((fixture) => fixture.name === 'files');
  const consoleFixture = manifest.fixtures.find((fixture) => fixture.name === 'console');
  const dialogFixture = manifest.fixtures.find((fixture) => fixture.name === 'messagebox');
  if (!filesFixture || !consoleFixture || !dialogFixture)
    throw Error('Required browser coverage fixtures missing');
  await page.locator('#file').setInputFiles(`public/demos/${filesFixture.zip}`);
  await page.waitForFunction(
    () => !document.getElementById('run').disabled,
    {},
    { timeout: 15000 },
  );
  await page.click('#run');
  await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
  const persisted = await page.evaluate(async (zipUrl) => {
    const bytes = await (await fetch(zipUrl)).arrayBuffer();
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle('winebrowser-output');
    const packageDir = await base.getDirectoryHandle(id);
    const filesDir = await packageDir.getDirectoryHandle('files');
    const file = await filesDir.getFileHandle('output.txt');
    return (await file.getFile()).text();
  }, `/demos/${filesFixture.zip}`);
  if (persisted !== filesFixture.expected.createdFiles['output.txt'])
    throw Error('OPFS output content differs');
  const outputLink = page.locator('#outputs a');
  if (
    (await outputLink.count()) !== 1 ||
    (await outputLink.getAttribute('download')) !== 'output.txt'
  )
    throw Error('Generated output download link missing');

  // Raw executable uploads still work without wrapping the PE in a ZIP.
  await page.locator('#file').setInputFiles(`public/demos/${consoleFixture.exe}`);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForFunction(() => window.__lastRun !== null);
  if ((await page.locator('#output').textContent()) !== consoleFixture.expected.stdout)
    throw Error('Raw PE upload output differs');

  const importCases = [];
  const exeBytes = await readFile(`public/demos/${filesFixture.exe}`);
  const assetBytes = await readFile('public/demos/files/assets/message.txt');
  const assetZip = Buffer.from(zipSync({ 'assets/message.txt': assetBytes }));
  const checkImportedProgram = async (name, started) => {
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    const readyMs = performance.now() - started;
    await page.click('#run');
    await page.waitForFunction(() => window.__lastRun !== null);
    const result = await page.evaluate(() => window.__lastRun);
    if (
      result.exitCode !== 0 ||
      (await page.locator('#output').textContent()) !== assetBytes.toString()
    )
      throw Error(`${name}: executable could not read imported asset`);
    if ((await page.locator('#outputs a').count()) !== 1) throw Error(`${name}: output missing`);
    importCases.push({
      name,
      readyMs,
      completedMs: performance.now() - started,
      compiledBlocks: result.compiledBlocks,
      passed: true,
    });
  };
  let importStarted = performance.now();
  await page.locator('#file').setInputFiles([
    { name: 'files.exe', mimeType: 'application/octet-stream', buffer: exeBytes },
    { name: 'assets.zip', mimeType: 'application/zip', buffer: assetZip },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('loose file') },
  ]);
  await checkImportedProgram('EXE + asset ZIP + loose file', importStarted);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle('winebrowser-file-packages');
    for await (const [, dir] of base.entries()) {
      const manifest = JSON.parse(
        await (await (await dir.getFileHandle('manifest.json')).getFile()).text(),
      );
      const asset = manifest.entries.find((entry) => entry.path === 'assets/message.txt');
      if (asset) {
        const stored = await (await dir.getFileHandle(asset.file)).getFile();
        if (!stored.size) throw Error('Imported asset cache is empty');
        return;
      }
    }
    throw Error('Imported file package missing from OPFS');
  });

  importStarted = performance.now();
  await page.locator('#folder').setInputFiles('public/demos/files');
  await checkImportedProgram('Folder picker with nested assets', importStarted);
  if ((await page.locator('#exe').inputValue()) !== 'files/files.exe')
    throw Error('Folder picker did not preserve the program directory');

  importStarted = performance.now();
  await page.evaluate(
    ({ exe, assets }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(exe)], 'files.exe'));
      transfer.items.add(new File([new Uint8Array(assets)], 'assets.zip'));
      document
        .getElementById('drop')
        .dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
    },
    { exe: [...exeBytes], assets: [...assetZip] },
  );
  await checkImportedProgram('Multiple files dropped together', importStarted);

  await page.locator('#file').setInputFiles([
    { name: 'files.exe', mimeType: 'application/octet-stream', buffer: exeBytes },
    {
      name: 'collision.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(zipSync({ 'FILES.EXE': exeBytes })),
    },
  ]);
  await page.waitForFunction(() => document.getElementById('state').textContent === 'ERROR');
  if (
    !(await page.locator('#run').isDisabled()) ||
    !(await page.locator('#logs').textContent()).includes('case-colliding')
  )
    throw Error('Conflicting imports were not rejected');

  // Manual runs leave a dialog open until the user answers or stops the program.
  await page.click(`[data-demo="${dialogFixture.name}"]`);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForSelector('#messagebox[open]');
  // Replacing a suspended program must dismiss its old dialog and settle its
  // pending run without allowing a stale rejection to overwrite the new load.
  await page.locator('#file').setInputFiles(`public/demos/${consoleFixture.exe}`);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  if (await page.locator('#messagebox').evaluate((element) => element.open))
    throw Error('Replacing a package left the old program dialog open');
  await page.click('#run');
  await page.waitForFunction(() => window.__lastRun !== null);
  if ((await page.locator('#output').textContent()) !== consoleFixture.expected.stdout)
    throw Error('Replacing an active program did not run the new selection');

  await page.click(`[data-demo="${dialogFixture.name}"]`);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForSelector('#messagebox[open]');
  await page.click('#dialog-stop');
  if ((await page.locator('#state').textContent()) !== 'STOPPED') throw Error('Stop failed');

  await page.click(`[data-demo="${consoleFixture.name}"]`);
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForFunction(() => window.__lastRun !== null);
  await mkdir('evidence', { recursive: true });
  await page.screenshot({ path: 'evidence/browser.png', fullPage: true });
  const report = {
    date: new Date().toISOString(),
    browser: await browser.version(),
    crossOriginIsolated: true,
    externalRequests: outbound,
    errors,
    tests: {
      manifestSuite: suiteRows.length,
      zipUpload: true,
      rawExeUpload: true,
      opfsContent: true,
      manualDialog: true,
      stop: true,
      combinedImports: importCases,
      importCollisionsRejected: true,
      replaceActiveProgram: true,
    },
    suite: suiteRows,
  };
  await writeFile('evidence/browser-results.json', JSON.stringify(report, null, 2) + '\n');
  if (errors.length || outbound.length) throw Error(JSON.stringify({ errors, outbound }));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
