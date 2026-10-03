import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
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
  const files = {};
  for (const name of ['custom-child.exe', 'control.dll'])
    files[name] = await readFile(`tests/fixtures/custom-child/${name}`);
  await page.locator('#file').setInputFiles({
    name: 'custom-child.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zipSync(files)),
  });
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    first = root.locator('canvas[data-control-id="70"]'),
    second = root.locator('canvas[data-control-id="71"]');
  const title = async (text) =>
    page.waitForFunction(
      (text) => document.querySelector('.virtual-desktop-title')?.textContent === text,
      text,
    );
  await first.waitFor();
  console.log('Custom children created');
  const pixel = async (canvas) =>
    canvas.evaluate((c) => Array.from(c.getContext('2d').getImageData(60, 70, 1, 1).data));
  await page.waitForFunction(
    () => document.querySelector('canvas[data-control-id="70"]')?.width === 216,
  );
  assert.deepEqual(await pixel(first), [24, 100, 200, 255]);
  assert.deepEqual(await pixel(second), [200, 80, 24, 255]);
  console.log('Independent painting verified');
  await root.getByRole('button', { name: 'Move and resize', exact: true }).click();
  await title('Resized');
  console.log('Nested button resized sibling');
  await page.waitForFunction(
    () => document.querySelector('canvas[data-control-id="71"]')?.width === 198,
  );
  assert.deepEqual(await pixel(second), [200, 80, 24, 255]);
  assert.equal(await first.locator('..').locator('button[data-control-id="90"]').count(), 1);
  const clickClient = async (options) => {
    await first.scrollIntoViewIfNeeded();
    const point = await first.evaluate((c) => {
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + 2 + 60), y: Math.round(r.top + 2 + 70) };
    });
    await page.mouse.click(point.x, point.y, options);
  };
  await clickClient();
  await title('Child clicked');
  await clickClient({ clickCount: 2 });
  await title('Double click');
  await clickClient({ button: 'right' });
  await title('Context received');
  await page.mouse.wheel(0, 120);
  await title('Wheel received');
  await first.press('a');
  await title('Key received');
  await root.getByRole('button', { name: 'Hide or show', exact: true }).click();
  await title('Hidden');
  await second.waitFor({ state: 'hidden' });
  await root.getByRole('button', { name: 'Hide or show', exact: true }).click();
  await title('Shown');
  await second.waitFor({ state: 'visible' });
  await root.getByRole('button', { name: 'Disable or enable', exact: true }).click();
  await title('Disabled');
  assert.equal(await second.locator('..').evaluate((e) => e.inert), true);
  await root.getByRole('button', { name: 'Disable or enable', exact: true }).click();
  await title('Enabled');
  assert.equal(await second.locator('..').evaluate((e) => e.inert), false);
  await mkdir('.scratch', { recursive: true });
  await root.screenshot({ path: '.scratch/custom-child-gui.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.ok(run.modules.some((m) => m.name === 'control.dll' && !m.host));
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    sha256: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        createHash('sha256').update(bytes).digest('hex'),
      ]),
    ),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'ZIP upload runs an unchanged PE32 EXE with a registered window procedure in its companion native DLL',
      'Independent child GDI pixels, client-edge coordinates, nested native button and resize repaint',
      'Per-window subclass forwards to the DLL procedure without changing its sibling',
      'Native mouse, double-click, context menu, screen-coordinate wheel and keyboard callbacks',
      'Hide/show and disable/enable, native destruction callbacks, surface and DC cleanup',
    ],
    scope:
      'Native custom-child GUI contract in ordinary Chromium. Host-control subclassing, cross ANSI/Unicode procedure handles, custom nonclient geometry, and general GUI/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/custom-child-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        output: document.querySelector('#output')?.textContent,
        title: document.querySelector('.virtual-desktop-title')?.textContent,
        canvases: [...document.querySelectorAll('canvas')].map((c) => ({
          id: c.dataset.controlId,
          width: c.width,
          height: c.height,
        })),
        run: window.__lastRun,
        fault: window.__lastFaultDiagnostic,
      })),
    );
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
