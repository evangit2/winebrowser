import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/draglist/draglist.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    list = root.getByRole('listbox', { name: 'Preferences', exact: true });
  const title = (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.virtual-desktop-title')?.textContent === text,
      text,
    );
  await list.getByRole('option', { name: 'Beta', exact: true }).waitFor();
  const rowPoint = async (name) => {
    const box = await list.getByRole('option', { name, exact: true }).boundingBox();
    assert.ok(box);
    return { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) };
  };
  const down = async (name) => {
    const p = await rowPoint(name);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
  };
  await down('Beta');
  await title('Dragging');
  let p = await rowPoint('Delta');
  await page.mouse.move(p.x, p.y);
  await title('Target 3');
  const marker = root.locator('.virtual-desktop-list-insert');
  await marker.waitFor();
  assert.equal(await marker.count(), 1);
  assert.equal(await list.evaluate((e) => e.style.cursor), 'move');
  await page.mouse.up();
  await title('Dropped');
  await marker.waitFor({ state: 'detached' });
  assert.deepEqual((await list.getByRole('option').allTextContents()).slice(0, 4), [
    'Alpha',
    'Gamma',
    'Beta',
    'Delta',
  ]);
  await down('Alpha');
  await title('Dragging');
  p = await rowPoint('Beta');
  await page.mouse.move(p.x, p.y);
  await title('Target 2');
  await list.press('Escape');
  await title('Cancelled');
  await page.mouse.up();
  assert.equal(await root.count(), 1);
  await marker.waitFor({ state: 'detached' });
  await root.getByRole('button', { name: 'Toggle acceptance', exact: true }).click();
  await title('Reject mode');
  await down('Gamma');
  await title('Rejected');
  p = await rowPoint('Delta');
  await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await root.getByRole('button', { name: 'Toggle acceptance', exact: true }).click();
  await title('Accept mode');
  await down('Alpha');
  await title('Dragging');
  const bounds = await list.boundingBox();
  await page.mouse.move(Math.round(bounds.x + 20), Math.round(bounds.y + bounds.height + 8));
  await title('Scrolled');
  assert.ok((await list.evaluate((e) => e.scrollTop)) > 0);
  await list.press('Escape');
  await title('Cancelled');
  await page.mouse.up();
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/draglist-gui.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: createHash('sha256')
      .update(await readFile('tests/fixtures/draglist/draglist.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'COMCTL32 MakeDragList/LBItemFromPt/DrawInsert named and ordinal exports run their native four/three/one-argument contracts',
      'Registered DRAGLISTINFO parent callbacks accept a drag; native drop reorders strings and preserves item data',
      'Visible insertion marker and cursor, rejection, Escape cancellation through IsDialogMessage without closing the window',
      'Captured pointer outside the list triggers timed autoscroll; cancellation and destruction clear capture/timers',
    ],
    scope:
      'Uniform-height single-select string drag lists in ordinary Chromium. The application owns reordering. Owner-drawn/multiselect lists, full control subclassing and universal GUI/DLL compatibility remain incomplete.',
  };
  await writeFile('evidence/draglist-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        title: document.querySelector('.virtual-desktop-title')?.textContent,
        run: window.__lastRun,
      })),
    );
  throw e;
} finally {
  await browser?.close();
  await server?.close();
}
