import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const pin = 'd97ab2cabe8e4eb9cfd95079fb743bdd9b762592e2774382bc0d032a22b2988e';
const hash = (bytes) => createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
let server, browser;
const checks = [],
  errors = [];
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  const manifest = await (
    await page.request.get(new URL('examples/manifest.json', url).href)
  ).json();
  const entry = manifest.interactive.find((e) => e.name === 'minesweeper');
  assert.ok(entry);
  assert.equal(entry.exeSha256, pin);
  const exeResponse = await page.request.get(new URL('examples/' + entry.exe, url).href);
  assert.ok(exeResponse.ok());
  const executable = await exeResponse.body();
  assert.equal(hash(executable), pin);
  const zipResponse = await page.request.get(new URL('examples/' + entry.zip, url).href);
  assert.ok(zipResponse.ok());
  const zip = await zipResponse.body();
  assert.equal(hash(zip), entry.zipSha256);
  checks.push(
    'Unchanged upstream PE32 EXE and MIT public ZIP match pinned hashes; ordinary Chromium compiles guest x86 in the browser',
  );
  await page.locator('#file').setInputFiles({
    name: 'minesweeper.exe',
    mimeType: 'application/octet-stream',
    buffer: executable,
  });
  await page.locator('#run').click();
  const game = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Minesweeper$/ }) });
  await game.getByRole('menuitem', { name: 'Game', exact: true }).waitFor();
  const canvas = game.locator('.virtual-desktop-canvas');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-canvas')?.width === 240,
  );
  await page.evaluate(() => {
    window.__minePatch = (x, y, width, height) =>
      Array.from(
        document
          .querySelector('.virtual-desktop-canvas')
          .getContext('2d')
          .getImageData(x, y, width, height).data,
      );
  });
  const patch = (x = 12, y = 86, w = 24, h = 24) =>
    page.evaluate(([x, y, w, h]) => window.__minePatch(x, y, w, h), [x, y, w, h]);
  const originalBytes = await patch();
  const original = hash(originalBytes);
  await canvas.click({ position: { x: 24, y: 90 }, button: 'right' });
  await page.waitForFunction(() =>
    window
      .__minePatch(12, 86, 24, 24)
      .some((v, i, a) => i % 4 === 0 && v > 180 && a[i + 1] < 80 && a[i + 2] < 80),
  );
  assert.notEqual(hash(await patch()), original);
  await canvas.click({ position: { x: 24, y: 90 }, button: 'right' });
  await page.waitForFunction(
    () =>
      !window
        .__minePatch(12, 86, 24, 24)
        .some((v, i, a) => i % 4 === 0 && v > 180 && a[i + 1] < 80 && a[i + 2] < 80),
  );
  assert.notEqual(hash(await patch()), original);
  await canvas.click({ position: { x: 24, y: 90 }, button: 'right' });
  await page.waitForFunction(
    (expected) => window.__minePatch(12, 86, 24, 24).every((v, i) => v === expected[i]),
    originalBytes,
  );
  assert.equal(hash(await patch()), original);
  checks.push('Right-click cycles flag, question mark and empty cell');
  const hidden = await patch(36, 86, 24, 24);
  await canvas.click({ position: { x: 48, y: 90 } });
  await page.waitForFunction(
    (bytes) => JSON.stringify(window.__minePatch(36, 86, 24, 24)) !== JSON.stringify(bytes),
    hidden,
  );
  assert.equal(await page.locator('#state').textContent(), 'RUNNING');
  checks.push('Left-click safely reveals a cell through original guest hit testing and painting');
  await canvas.press('F2');
  await page.waitForFunction(
    (expected) => window.__minePatch(36, 86, 24, 24).every((v, i) => v === expected[i]),
    hidden,
  );
  checks.push('F2 guest accelerator restores the unopened board');
  const select = async (name) => {
    await game.getByRole('menuitem', { name: 'Game', exact: true }).click();
    await game.locator('.virtual-desktop-menu-popup').getByText(name, { exact: true }).click();
  };
  await select('Intermediate');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-canvas')?.width === 408,
  );
  assert.deepEqual(await canvas.evaluate((c) => [c.width, c.height]), [408, 458]);
  await select('Expert');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-canvas')?.width === 744,
  );
  assert.deepEqual(await canvas.evaluate((c) => [c.width, c.height]), [744, 458]);
  await select('Beginner');
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-canvas')?.width === 240,
  );
  checks.push('Menu commands resize and redraw the original 9×9, 16×16 and 30×16 boards');
  await canvas.focus();
  await page.keyboard.press('Alt+g');
  await game.getByRole('menuitem', { name: 'Custom...', exact: true }).waitFor();
  await page.keyboard.press('c');
  const custom = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Custom Field$/ }) });
  await custom.waitFor();
  assert.equal(await game.evaluate((el) => el.inert), true);
  const input = (id) => custom.locator(`input[data-control-id="${id}"]`);
  assert.equal(await input(141).inputValue(), '9');
  assert.equal(await input(142).inputValue(), '9');
  assert.equal(await input(143).inputValue(), '10');
  await input(141).fill('12');
  await input(142).fill('10');
  await input(143).fill('20');
  await input(143).press('Tab');
  await page.waitForFunction(() => document.activeElement?.dataset.controlId === '1');
  await page.keyboard.press('Enter');
  await custom.waitFor({ state: 'detached' });
  await page.waitForFunction(
    () => document.querySelector('.virtual-desktop-canvas')?.width === 264,
  );
  assert.deepEqual(await canvas.evaluate((c) => [c.width, c.height]), [264, 362]);
  assert.equal(await game.evaluate((el) => el.inert), false);
  checks.push(
    'Alt+G and C open the resource dialog; native EDIT notifications, Tab and Enter apply a 10×12 board with 20 mines and restore its owner',
  );
  await select('Custom...');
  await custom.waitFor();
  await input(141).fill('18');
  await input(141).press('Escape');
  await custom.waitFor({ state: 'detached' });
  assert.deepEqual(await canvas.evaluate((c) => [c.width, c.height]), [264, 362]);
  checks.push('Escape cancels a resource dialog without applying edited dimensions');
  await select('Best Times...');
  const scores = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: /^Fastest Mine Sweepers$/ }),
  });
  await scores.waitFor();
  assert.match(await scores.textContent(), /999 seconds/);
  await scores.getByRole('button', { name: 'Reset Scores', exact: true }).click();
  await scores.locator('.virtual-desktop-close').click();
  await scores.waitFor({ state: 'detached' });
  checks.push(
    'High-score resource dialog populates its static controls, resets scores and accepts guest-mediated close',
  );
  await game.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await game.getByRole('menuitem', { name: 'About Minesweeper...', exact: true }).click();
  await page.locator('#messagebox').waitFor();
  assert.match(await page.locator('#dialog-title').textContent(), /Mine/i);
  assert.equal(await game.evaluate((el) => el.inert), true);
  await page.locator('#dialog-ok').click();
  await page.waitForFunction(() => !document.querySelector('.virtual-desktop-window').inert);
  checks.push('ShellAbout treats HICON as a handle and presents an owned modal About box');
  await mkdir('evidence', { recursive: true });
  await game.screenshot({ path: 'evidence/minesweeper-gameplay.png' });
  await select('Exit');
  await page.waitForFunction(() => window.__lastRun !== null);
  const result = await page.evaluate(() => window.__lastRun);
  assert.equal(result.exitCode, 0);
  assert.ok(result.totalCompiledBlocks > 0);
  assert.equal(await game.count(), 0);
  checks.push(
    'Guest Exit menu command closes the game and returns zero after browser-local x86 translation',
  );
  await page.locator('[data-demo="minesweeper"]').click();
  await page.locator('#run').click();
  await game.waitFor();
  await page.locator('#stop').click();
  assert.equal(await game.count(), 0);
  checks.push('Hosted public ZIP starts through the same loader and Stop cleans up its windows');
  assert.deepEqual(errors, []);
  const evidence = {
    date: new Date().toISOString(),
    url,
    targetId: 'wesmar-minesweeper-2026-02-x86',
    sha256: pin,
    status: 'passed',
    checks,
    exitCode: result.exitCode,
    instructions: result.instructions,
    compiledBlocks: result.totalCompiledBlocks,
    x86TranslationMs: result.x86TranslationMs,
    elapsedMs: result.elapsedMs,
    scope:
      'Interactive acceptance of this unchanged MIT release. No complete game-rule proof, pixel-exact native font comparison or universal Windows GUI compatibility claim.',
  };
  await writeFile(
    'evidence/minesweeper-browser-results.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
