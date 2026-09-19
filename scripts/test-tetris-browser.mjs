import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
const checks = [];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator('[data-demo="tetris"]').waitFor();
  const response = await page.request.get(new URL('examples/manifest.json', url).href);
  assert.ok(response.ok());
  const example = (await response.json()).interactive.find((entry) => entry.name === 'tetris');
  assert.ok(example);
  const exeResponse = await page.request.get(new URL(`examples/${example.exe}`, url).href);
  assert.ok(exeResponse.ok());
  const executable = await exeResponse.body();
  assert.equal(sha256(executable), example.exeSha256);
  assert.equal(
    example.exeSha256,
    '3687bc1cfe9a7657ca9da1daacec9f97a92946f0b0440acdb70d3a71a4560007',
  );
  const zipResponse = await page.request.get(new URL(`examples/${example.zip}`, url).href);
  assert.ok(zipResponse.ok());
  assert.equal(sha256(await zipResponse.body()), example.zipSha256);
  checks.push('Unchanged upstream EXE and public ZIP match pinned SHA-256');

  await page.locator('#file').setInputFiles({
    name: 'tetris.exe',
    mimeType: 'application/octet-stream',
    buffer: executable,
  });
  await page.locator('#run').click();
  const game = page.locator('.virtual-desktop-window');
  const edit = game.locator('input');
  await edit.waitFor();
  assert.equal(await game.count(), 1);
  assert.equal(await game.locator('.virtual-desktop-control').count(), 5);
  const canvas = game.locator('.virtual-desktop-canvas');
  await page.evaluate(() => {
    // Sample cell centers using the pinned upstream renderer's 25-pixel cells.
    // Colored cells identify guest tetrominoes independently of browser fonts.
    window.__tetrisCells = () => {
      const canvas = document.querySelector('.virtual-desktop-window .virtual-desktop-canvas');
      if (!canvas) return [];
      const context = canvas.getContext('2d'),
        cells = [];
      for (let row = 0; row < 20; row++)
        for (let col = 0; col < 10; col++) {
          const [r, g, b] = context.getImageData(32 + col * 25, 32 + row * 25, 1, 1).data;
          if (Math.max(r, g, b) - Math.min(r, g, b) > 40) cells.push({ row, col, rgb: [r, g, b] });
        }
      return cells;
    };
  });
  const cells = () => page.evaluate(() => window.__tetrisCells());
  const boardHash = () =>
    canvas.evaluate(async (c) => {
      // The upstream PAUSED label pulses in the side panel; compare the board only.
      const bytes = c.getContext('2d').getImageData(0, 0, 275, 520).data;
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
    });
  await canvas.click({ position: { x: 280, y: 100 } });
  await page.waitForFunction(() => window.__tetrisCells().length === 4);
  const initial = await cells();
  const initialColumn = initial.reduce((sum, c) => sum + c.col, 0);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((sum) => {
    const cells = window.__tetrisCells();
    return cells.length === 4 && cells.reduce((total, c) => total + c.col, 0) === sum + 4;
  }, initialColumn);
  checks.push('Real guest keyboard message moves all four piece cells one column');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__tetrisCells().some((c) => c.row >= 18));
  checks.push('Hard drop settles guest piece at the board bottom');

  await game.getByRole('button', { name: /Pause Game/ }).click();
  await game.getByRole('button', { name: /Resume Game/ }).waitFor();
  await page.waitForTimeout(120);
  const paused = await boardHash();
  await page.waitForTimeout(500);
  assert.equal(await boardHash(), paused);
  checks.push('Push-button WM_COMMAND pauses gameplay while the guest draws its pulsing label');
  await edit.fill('Browser player');
  await page.waitForTimeout(100);
  assert.equal(await edit.inputValue(), 'Browser player');
  await game.getByRole('button', { name: /Ghost: OFF/ }).click();
  await game.getByRole('button', { name: /Ghost: ON/ }).waitFor();
  checks.push('EDIT changes and Ghost button notifications reach the EXE');
  await game.getByRole('button', { name: /Clear Record/ }).click();
  await page.locator('#messagebox').waitFor();
  assert.match(await page.locator('#dialog-text').textContent(), /Record cleared successfully/);
  assert.equal(await game.evaluate((element) => element.inert), true);
  await page.locator('#dialog-ok').click();
  await page.waitForFunction(() => !document.querySelector('.virtual-desktop-window').inert);
  checks.push('Owned informational dialog disables and restores its owner');
  await game.getByRole('button', { name: /Resume Game/ }).click();
  await game.getByRole('button', { name: /Pause Game/ }).waitFor();
  await page.keyboard.press('F2'); // SetFocus from the button returned keyboard input to the game.
  await page.waitForFunction(() => !window.__tetrisCells().some((c) => c.row >= 18));
  await page.keyboard.press('p');
  await game.getByRole('button', { name: /Resume Game/ }).waitFor();
  checks.push('Guest SetFocus restores keyboard restart and P pause after child controls');
  await page.keyboard.press('Alt+r');
  await game.getByRole('button', { name: /Pause Game/ }).waitFor();
  await page.keyboard.press('Alt+p');
  await game.getByRole('button', { name: /Resume Game/ }).waitFor();
  checks.push('Guest accelerator table handles Alt+R resume and Alt+P pause');

  // A normal interactive session must outlive the old one-million-block test cap.
  // Pausing keeps the board stable while the EXE continues its render/message loop.
  await page.waitForFunction(
    () => Number(document.querySelector('#metrics').dataset.blocks) > 1_000_000,
    null,
    { timeout: 60000 },
  );
  assert.equal(await page.locator('#state').textContent(), 'RUNNING');
  await mkdir('evidence', { recursive: true });
  await game.screenshot({ path: 'evidence/tetris-browser.png' });
  await game.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const result = await page.evaluate(() => window.__lastRun);
  assert.equal(result.exitCode, 0);
  assert.ok(
    result.blocks > 1_000_000,
    `Guest ran ${result.blocks} blocks; expected to exceed old cap`,
  );
  assert.ok(result.modules.some((m) => m.name === 'wine-format.dll' && !m.host));
  assert.equal(await game.count(), 0);
  checks.push(
    'Session exceeds one million dispatches, then guest close exits 0 and removes children',
  );

  await page.locator('[data-demo="tetris"]').click();
  await page.locator('#run').click();
  await game.locator('input').waitFor();
  await page.locator('#stop').click();
  assert.equal(await game.count(), 0);
  assert.notEqual(await page.locator('#state').textContent(), 'RUNNING');
  checks.push('Public ZIP example loads and Stop terminates its worker');
  assert.deepEqual(errors, []);
  const evidence = {
    date: new Date().toISOString(),
    url,
    target: 'wesmar-tetris-2026-07-x86',
    sha256: example.exeSha256,
    status: 'passed',
    checks,
    exitCode: result.exitCode,
    blocks: result.blocks,
    compiledBlocks: result.compiledBlocks,
    elapsedMs: result.elapsedMs,
    scope:
      'Interactive browser smoke test of the unchanged upstream release. No pixel-exact native font comparison, complete game-rule proof, or persistent registry claim.',
  };
  await writeFile('evidence/tetris-browser.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
}
