import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
let browser, server, page;
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
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
  await expect(host).toHaveValue('example.invalid', { timeout: 30000 });
  await tree.getByRole('treeitem', { name: 'Data', exact: true }).click();
  await dialog.getByText('Auto-login username', { exact: true }).waitFor();
  await expect(dialog.locator('input[data-control-id="1044"]')).toHaveValue('browser-user', {
    timeout: 30000,
  });
  await variable.click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await variable.waitFor({ state: 'detached' });
  const ssh = tree.getByRole('treeitem', { name: 'SSH', exact: true });
  if ((await ssh.getAttribute('aria-expanded')) === 'false')
    await ssh.locator('.virtual-desktop-tree-toggle').click();
  const orders = [];
  const preferenceList = () => dialog.locator('[data-control-id="1044"][role="listbox"]');
  const waitOrder = async (list, expected) => {
    await expect
      .poll(() => list.getByRole('option').allTextContents(), { timeout: 30000 })
      .toEqual(expected);
  };
  const point = async (list, name, bottom = false) => {
    const row = list.getByRole('option', { name, exact: true });
    await row.scrollIntoViewIfNeeded();
    // Native LB messages rebuild rows while a drag is starting. Keep the
    // geometry from a successful observation instead of reading a detached row.
    let bounds;
    await expect
      .poll(
        async () => {
          bounds = await row.boundingBox();
          return !!bounds;
        },
        { timeout: 30000 },
      )
      .toBe(true);
    return {
      x: Math.round(bounds.x + 20),
      y: Math.round(bounds.y + (bottom ? bounds.height - 2 : bounds.height / 2)),
    };
  };
  for (const [category, heading, itemCount] of [
    ['Kex', 'Key exchange algorithm options', 13],
    ['Host keys', 'Host key algorithm preference', 6],
    ['Cipher', 'Encryption options', 8],
  ]) {
    await tree.getByRole('treeitem', { name: category, exact: true }).click();
    await dialog.getByText(heading, { exact: true }).waitFor();
    const list = preferenceList();
    // The pinned native release creates the heading before populating the list.
    // Wait for its full algorithm set before taking a baseline for reordering.
    await expect(list.getByRole('option')).toHaveCount(itemCount, { timeout: 30000 });
    const before = await list.getByRole('option').allTextContents();
    console.log(`Checking ${category}: ${before.length} native preference items`);
    assert.ok(before.length >= 3);
    let p = await point(list, before[0]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await waitOrder(list, [...before, '']);
    p = await point(list, before[2], true);
    await page.mouse.move(p.x, p.y);
    await dialog.locator('.virtual-desktop-list-insert').waitFor();
    await page.mouse.up();
    const expected = [before[1], before[2], before[0], ...before.slice(3)];
    await waitOrder(list, expected);
    // Native Escape cancels the drag and removes PuTTY's temporary item.
    p = await point(list, expected[0]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await waitOrder(list, [...expected, '']);
    await list.press('Escape');
    await waitOrder(list, expected);
    await page.mouse.up();
    // A plain click selects the moved item; native Up/Down updates its item data.
    p = await point(list, before[0]);
    await page.mouse.click(p.x, p.y);
    await dialog.getByRole('button', { name: 'Up', exact: true }).click();
    await waitOrder(list, [before[1], before[0], before[2], ...before.slice(3)]);
    await dialog.getByRole('button', { name: 'Down', exact: true }).click();
    await waitOrder(list, expected);
    orders.push({ category, heading, expected });
  }
  for (const { category, heading, expected } of orders) {
    await tree.getByRole('treeitem', { name: category, exact: true }).click();
    await dialog.getByText(heading, { exact: true }).waitFor();
    await waitOrder(preferenceList(), expected);
  }
  await dialog.screenshot({ path: '.scratch/putty-cipher-gui.png' });
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
      'Kex, Host keys and Cipher lists reorder through native drag/drop and Up/Down callbacks',
      'Escape cancels drags without closing Configuration; preference order survives category reconstruction',
      'Native Cancel ends the process with exit code zero',
    ],
    remainingBlockers: [
      'Other configuration panels are unverified; multi-select and owner-drawn lists, callback text and full common-control coverage are incomplete',
      'SSH/Telnet connections and terminal rendering are unverified',
    ],
    scope:
      'Subset acceptance of the unchanged, privately cached MIT PuTTY release in ordinary Chromium. No PuTTY executable is added to the public repository. These GUI interactions do not establish general PuTTY or Windows compatibility.',
  };
  await writeFile('evidence/putty-gui-progress.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        lists: [...document.querySelectorAll('.virtual-desktop-control')]
          .filter((e) => e.matches('select,[role="listbox"]'))
          .map((e) => ({ id: e.dataset.windowId, html: e.outerHTML })),
        run: window.__lastRun,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
