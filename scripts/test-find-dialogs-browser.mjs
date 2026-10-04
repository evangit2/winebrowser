import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
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
  page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
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
    .setInputFiles([
      'tests/fixtures/find-dialogs/find-dialogs.exe',
      'tests/fixtures/find-dialogs/find-resources.dll',
    ]);
  await page.locator('#run').click();
  const owner = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: 'Native Find/Replace owner' }),
  });
  const status = owner.locator('[data-control-id="10"]');
  const find = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Find$/ }) });
  await find.getByRole('button', { name: 'Find Next', exact: true }).waitFor();
  await expect(find.getByRole('button', { name: 'Find Next', exact: true })).toBeDisabled();
  const input = find.locator('[data-control-id="1152"]');
  assert.equal(await input.getAttribute('maxlength'), '7');
  await owner.locator('[data-control-id="11"]').fill('alpha alpha'); // owner stays interactive
  await input.fill('123456789');
  await expect(input).toHaveValue('1234567');
  await input.fill('alpha');
  await find.getByRole('checkbox', { name: 'Match case', exact: true }).click();
  await expect(find.getByRole('checkbox', { name: 'Match case', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await find.getByRole('button', { name: 'Find Next', exact: true }).click();
  await status.getByText('Hook A: Find Next vetoed', { exact: true }).waitFor();
  await find.getByRole('button', { name: 'Find Next', exact: true }).click();
  await status.getByText('Find A: native notification', { exact: true }).waitFor();
  await find.getByRole('button', { name: 'Help', exact: true }).click();
  await status.getByText('Help A: native callback', { exact: true }).waitFor();
  await input.focus();
  await page.keyboard.press('Escape');
  await find.waitFor({ state: 'detached' });
  const unicode = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: 'Find in native DLL' }) });
  const unicodeInput = unicode.locator('[data-control-id="1152"]');
  await unicodeInput.waitFor();
  await expect(unicodeInput).toHaveValue('Ω');
  await unicode.getByRole('button', { name: 'Native callback', exact: true }).click();
  await status.getByText('Subclass W: native template button', { exact: true }).waitFor();
  await unicodeInput.fill('Ω€');
  await unicode.getByRole('checkbox', { name: 'Match whole word', exact: true }).click();
  await expect(
    unicode.getByRole('checkbox', { name: 'Match whole word', exact: true }),
  ).toHaveAttribute('aria-checked', 'true');
  await unicode.getByRole('button', { name: 'Find Next', exact: true }).click();
  await status.getByText('Find W: Unicode native notification', { exact: true }).waitFor();
  await unicode.getByRole('button', { name: 'Cancel', exact: true }).click();
  await unicode.waitFor({ state: 'detached' });
  const replace = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^Replace$/ }) });
  await replace.getByRole('button', { name: 'Replace', exact: true }).waitFor();
  await expect(replace.locator('[data-control-id="1152"]')).toHaveValue('alpha');
  await expect(replace.locator('[data-control-id="1153"]')).toHaveValue('beta');
  await replace.getByRole('button', { name: 'Replace', exact: true }).click();
  await status.getByText('Replace A: native edit changed', { exact: true }).waitFor();
  await expect(owner.locator('[data-control-id="11"]')).toHaveValue('beta alpha');
  await replace.getByRole('button', { name: 'Replace All', exact: true }).click();
  await status.getByText('Replace All A: native edit changed', { exact: true }).waitFor();
  await expect(owner.locator('[data-control-id="11"]')).toHaveValue('beta beta');
  await page.screenshot({ path: 'evidence/find-dialogs-browser.png' });
  await replace.locator('.virtual-desktop-close').click();
  await replace.waitFor({ state: 'detached' });
  await status.getByText('All native Find/Replace checks passed', { exact: true }).waitFor();
  await owner.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0, JSON.stringify(run));
  assert.deepEqual(errors, []);
  const hash = async (path) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exitCode: run.exitCode,
    exeSha256: await hash('tests/fixtures/find-dialogs/find-dialogs.exe'),
    dllSha256: await hash('tests/fixtures/find-dialogs/find-resources.dll'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Unchanged native EXE/DLL runs modeless FindTextA/W and ReplaceTextA through in-browser x86 compilation; owner remains enabled and editable',
      'Native DLL hook receives the original FINDREPLACE pointer and can veto Find Next; ordinal DLL dialog template and native window subclass/CallWindowProc remain callable',
      'Standard control IDs, edit input limits, A/W strings, whole-word/case/direction flags, Help, synchronous owner notifications and buffer-tail guards are checked',
      'Native Replace and Replace All callbacks change actual owner edit text; Escape/Cancel/close deliver FR_DIALOGTERM with stale action bits cleared',
      'Invalid structures, zero buffers and absent hook errors are checked; native cleanup and close exit zero',
      'Native CreateDialog/DialogBox W APIs preserve Unicode frames and edits from both DLL resources and guest memory; EndDialog returns the native result',
      'FindTextW accepts a caller-owned GlobalAlloc template; native Unicode-named DLL resource sizing/loading uses the HRSRC argument and FreeResource leaves the data valid',
    ],
    scope:
      'Shared modeless standard/resource/allocated-template Find/Replace dialogs, Unicode modal/modeless resource dialogs, native hooks and subclass forwarding. Complete custom controls, exact Windows dialog/font layout, resource language fallback and arbitrary editor execution remain incomplete.',
  };
  await writeFile(
    'evidence/find-dialogs-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun && {
          exitCode: window.__lastRun.exitCode,
          error: window.__lastRun.error,
          apiTrace: window.__lastRun.apiTrace?.slice(-30),
        },
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
