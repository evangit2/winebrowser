import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
let server, browser;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } }),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/treeview/treeview.exe');
  await page.locator('#run').click();
  const window = page.locator('.virtual-desktop-window'),
    tree = window.getByRole('tree', { name: 'Categories' });
  await tree.waitFor();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Selected Session',
  );
  const item = (name) => tree.getByRole('treeitem', { name, exact: true });
  assert.equal(await item('Session').getAttribute('aria-selected'), 'true');
  assert.equal(await tree.getByRole('treeitem').count(), 4);
  await item('Blocked').click();
  // A second queued selection followed by a successful command provides a
  // dispatcher barrier; a delay alone could miss a cancellation regression.
  await item('Terminal').click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Selected Terminal',
  );
  assert.equal(await item('Blocked').getAttribute('aria-selected'), 'false');
  assert.equal(await item('Terminal').getAttribute('aria-expanded'), 'false');
  await tree.press('ArrowRight');
  await item('Keyboard').waitFor();
  assert.equal(await item('Keyboard').getAttribute('aria-level'), '3');
  await tree.press('ArrowDown');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Selected Keyboard',
  );
  assert.equal(await item('Keyboard').getAttribute('aria-selected'), 'true');
  await tree.press('ArrowLeft');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Selected Terminal',
  );
  await item('Terminal').locator('.virtual-desktop-tree-toggle').click();
  await item('Keyboard').waitFor({ state: 'detached' });
  await item('Session').click();
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-title')?.textContent === 'Selected Session',
  );
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/treeview/treeview.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    checks: [
      'Native nested item ordering, opaque handles, parent/child/sibling and item-count queries',
      'TVM_INSERTITEMW/GETITEMW Unicode text and LPARAM round trip in an ANSI tree',
      'WM_NOTIFY PE32 NMTREEVIEW old/new selection, item parameters and cancellation',
      'Mouse selection, keyboard right/down/left navigation and expand/collapse controls',
      'Native deletion notification and subtree lifetime; close exits zero',
    ],
    scope:
      'Native contract fixture in ordinary Chromium. Text trees are supported; image lists, label editing, drag/drop, callback text and full common-control coverage remain incomplete.',
  };
  await writeFile('evidence/treeview-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
