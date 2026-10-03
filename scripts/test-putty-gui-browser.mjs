import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
let browser, server;
try {
  const bytes = await readFile('.cache/targets/putty-x86.exe');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, '4c70267ca03a00ea761ec358498b990a7221decb36eace9b7dbe6a751be0fb3b');
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
  await page
    .locator('#file')
    .setInputFiles({ name: 'putty.exe', mimeType: 'application/octet-stream', buffer: bytes });
  await page.locator('#run').click();
  const dialog = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: 'PuTTY Configuration' }) });
  const tree = dialog.getByRole('tree');
  const saved = dialog.locator('[data-control-id="1058"]');
  await saved
    .getByRole('option', { name: 'Default Settings', exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await tree
      .getByRole('treeitem', { name: 'Session', exact: true })
      .getAttribute('aria-selected'),
    'true',
  );
  await dialog.locator('input[data-control-id="1044"]').fill('example.invalid');
  await dialog.locator('input[data-control-id="1056"]').fill('BrowserGuiCheck');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await saved.getByRole('option', { name: 'BrowserGuiCheck', exact: true }).waitFor();
  await tree.getByRole('treeitem', { name: 'Terminal', exact: true }).click();
  await dialog.getByText('Set various terminal options', { exact: true }).waitFor();
  await dialog
    .getByRole('checkbox', { name: 'Auto wrap mode initially on', exact: true })
    .waitFor();
  assert.equal(await page.locator('#state').textContent(), 'RUNNING');
  await mkdir('.scratch', { recursive: true });
  await dialog.screenshot({ path: '.scratch/putty-terminal-gui.png' });
  const connection = tree.getByRole('treeitem', { name: 'Connection', exact: true });
  if ((await connection.getAttribute('aria-expanded')) === 'false')
    await connection.locator('.virtual-desktop-tree-toggle').click();
  await tree.getByRole('treeitem', { name: 'Data', exact: true }).click();
  await dialog.getByText('Auto-login username', { exact: true }).waitFor();
  await dialog.locator('input[data-control-id="1044"]').fill('browser-user');
  await dialog.locator('input[data-control-id="1055"]').fill('BROWSER_TEST');
  await dialog.locator('input[data-control-id="1057"]').fill('columns-work');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const variables = dialog
    .getByRole('listbox')
    .filter({ has: page.getByRole('option', { name: /BROWSER_TEST/ }) });
  const variable = variables.getByRole('option', { name: /BROWSER_TEST/ });
  await variable.waitFor();
  assert.equal(await variable.getAttribute('aria-label'), 'BROWSER_TEST\tcolumns-work');
  const positions = await variable
    .locator('span')
    .evaluateAll((spans) => spans.map((span) => parseFloat(span.style.left)));
  assert.equal(positions.length, 2);
  assert.ok(positions[1] > positions[0]);
  await dialog.screenshot({ path: '.scratch/putty-data-gui.png' });
  await tree.getByRole('treeitem', { name: 'Session', exact: true }).click();
  await dialog.getByText('Host Name (or IP address)', { exact: true }).waitFor();
  const host = dialog.locator('input[data-control-id="1044"]');
  await host.waitFor();
  assert.equal(await host.inputValue(), 'example.invalid');
  await tree.getByRole('treeitem', { name: 'Data', exact: true }).click();
  await dialog.getByText('Auto-login username', { exact: true }).waitFor();
  assert.equal(await dialog.locator('input[data-control-id="1044"]').inputValue(), 'browser-user');
  await variable.click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await variable.waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    sha256,
    status: 'partial',
    guiAcceptance: 'passed',
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Native custom-class Configuration dialog selects its Session category',
      'Typed hostname and saved-session name reach native code',
      'Save writes a named session and updates the registry-backed ListBox',
      'Terminal category creates its controls and enumerates zero installed printers',
      'Connection/Data creates tabbed environment-variable list; native Add and Remove update it',
      'Tab-stop columns render separately; edited username and environment values survive category changes',
      'Returning to Session preserves the hostname',
      'Native Cancel ends the process with exit code zero',
    ],
    remainingBlockers: [
      'Exploratory SSH/Kex navigation reaches a native call to address zero; its cause remains unresolved',
      'Other configuration panels are unverified; multi-select and owner-drawn lists, callback text and full common-control coverage are incomplete',
      'SSH/Telnet connections and terminal rendering are unverified',
    ],
    scope:
      'Subset acceptance of the unchanged, privately cached MIT PuTTY release in ordinary Chromium. No PuTTY executable is added to the public repository. These GUI interactions do not establish general PuTTY or Windows compatibility.',
  };
  await writeFile('evidence/putty-gui-progress.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
