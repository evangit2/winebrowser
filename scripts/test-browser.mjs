import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
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
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4173')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const outbound = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:4173/') && !r.url().startsWith('blob:'))
      outbound.push(r.url());
  });
  await page.goto('http://127.0.0.1:4173');
  if (!(await page.evaluate(() => crossOriginIsolated)))
    throw Error('Missing cross-origin isolation');
  const results = [];
  for (const name of ['console', 'files', 'messagebox', 'beep']) {
    await page.click(`[data-demo="${name}"]`);
    await page.waitForFunction(
      () => !document.getElementById('run').disabled,
      {},
      { timeout: 15000 },
    );
    await page.click('#run');
    if (name === 'messagebox') {
      await page.waitForSelector('#messagebox[open]');
      await page.click('#dialog-ok');
    }
    await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
    const result = await page.evaluate(() => window.__lastRun);
    if (result.exitCode !== 0) throw Error(name + ' exit ' + result.exitCode);
    const output = await page.locator('#output').textContent();
    if (name === 'console' && !output.includes('hello')) throw Error('Missing console output');
    if (name === 'files' && (await page.locator('#outputs a').count()) !== 1)
      throw Error('Missing output download');
    results.push({
      name,
      exeSha256: manifest.fixtures.find((f) => f.name === name).exeSha256,
      ...result,
      outputs: result.outputs.map((o) => ({ path: o.path, bytes: Object.keys(o.bytes).length })),
    });
  }
  // Real upload flow, rather than demo button only.
  await page.locator('#file').setInputFiles('public/demos/files.zip');
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForFunction(() => window.__lastRun !== null);
  const persisted = await page.evaluate(async () => {
    const bytes = await (await fetch('/demos/files.zip')).arrayBuffer();
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle('winebrowser-output');
    const packageDir = await base.getDirectoryHandle(id);
    const filesDir = await packageDir.getDirectoryHandle('files');
    const file = await filesDir.getFileHandle('output.txt');
    return (await file.getFile()).text();
  });
  if (
    persisted !==
    manifest.fixtures.find((f) => f.name === 'files').expected.createdFiles['output.txt']
  )
    throw Error('OPFS output content differs');
  await page.locator('#file').setInputFiles('public/demos/console/console.exe');
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForFunction(() => window.__lastRun !== null);
  if (
    (await page.locator('#output').textContent()) !==
    manifest.fixtures.find((f) => f.name === 'console').expected.stdout
  )
    throw Error('Raw PE upload failed');
  // A dialog blocks guest progress until answered; Stop must terminate it.
  await page.click('[data-demo="messagebox"]');
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.click('#run');
  await page.waitForSelector('#messagebox[open]');
  await page.click('#dialog-stop');
  if ((await page.locator('#state').textContent()) !== 'STOPPED') throw Error('Stop failed');
  await page.click('[data-demo="console"]');
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
    tests: { zipUpload: true, rawExeUpload: true, opfsContent: true, stop: true },
    results,
  };
  await writeFile('evidence/browser-results.json', JSON.stringify(report, null, 2) + '\n');
  if (errors.length || outbound.length) throw Error(JSON.stringify({ errors, outbound }));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  server.kill();
}
