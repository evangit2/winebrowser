import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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

  // Manual runs leave a dialog open until the user answers or stops the program.
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
