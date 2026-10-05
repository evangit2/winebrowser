import { nativeComboEdit } from './lib/native-combo-input.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.getByRole('button', { name: 'Load gui-controls', exact: true }).click();
  await page.locator('#run').click();
  const window = page.locator('.virtual-desktop-window'),
    status = window.locator('[data-control-id="22"]'),
    tree = window.getByRole('tree', { name: 'Categories' });
  const reset = 'Choose a category, list item or option.';
  await status.getByText(reset, { exact: true }).waitFor();
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status.locator('[data-status-part="0"]')).toHaveText(reset);
  assert.deepEqual(await status.evaluate((el) => [el.offsetWidth, el.offsetHeight]), [500, 34]);
  await tree.getByRole('treeitem', { name: 'List box', exact: true }).click();
  await status
    .getByText('ListBox: strings, sorted insertion and selection.', { exact: true })
    .waitFor();
  await window.locator('select[data-control-id="20"]').selectOption({ label: 'Gamma' });
  await status.getByText('Gamma', { exact: true }).waitFor();
  await nativeComboEdit(window.locator('[data-control-id="21"]')).fill('Typed in browser');
  await status.getByText('Typed in browser', { exact: true }).waitFor();
  const checkbox = window.getByRole('checkbox', { name: 'Enable option', exact: true }),
    first = window.getByRole('radio', { name: 'First radio', exact: true }),
    second = window.getByRole('radio', { name: 'Second radio', exact: true });
  await checkbox.click();
  await status.getByText('Checkbox is checked.', { exact: true }).waitFor();
  assert.equal(await checkbox.getAttribute('aria-checked'), 'true');
  await second.click();
  await status
    .getByText('Second radio selected; its group remains exclusive.', { exact: true })
    .waitFor();
  assert.equal(await first.getAttribute('aria-checked'), 'false');
  const canvas = window.locator('canvas[data-control-id="50"]');
  const swatch = () =>
    canvas.evaluate((c) => Array.from(c.getContext('2d').getImageData(12, 12, 1, 1).data));
  await page.waitForFunction(
    () => document.querySelector('canvas[data-control-id="50"]')?.width === 312,
  );
  assert.deepEqual(await swatch(), [28, 110, 210, 255]);
  await window.getByRole('button', { name: 'Change', exact: true }).click();
  await status
    .getByText('Nested button: native child window repainted with GDI.', { exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('canvas[data-control-id="50"]')
        ?.getContext('2d')
        .getImageData(12, 12, 1, 1).data[0] === 230,
  );
  assert.deepEqual(await swatch(), [230, 140, 30, 255]);
  await canvas.click({ position: { x: 30, y: 30 } });
  await status
    .getByText('Custom canvas: mouse input reached its native window procedure.', { exact: true })
    .waitFor();
  const priorities = window.getByRole('listbox', { name: 'Priorities', exact: true });
  const initial = ['Paint window', 'Handle input', 'Update controls', 'Save settings'];
  const order = async (expected) =>
    expect.poll(() => priorities.getByRole('option').allTextContents()).toEqual(expected);
  await order(initial);
  const point = async (name) => {
    let bounds;
    await expect
      .poll(async () => {
        bounds = await priorities.getByRole('option', { name, exact: true }).boundingBox();
        return bounds;
      })
      .not.toBeNull();
    return { x: Math.round(bounds.x + 20), y: Math.round(bounds.y + bounds.height / 2) };
  };
  let p = await point(initial[0]);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = await point(initial[2]);
  await page.mouse.move(p.x, p.y);
  await window.locator('.virtual-desktop-list-insert').waitFor();
  await page.mouse.up();
  await status
    .getByText('Drag list: native callback reordered the item and preserved its data.', {
      exact: true,
    })
    .waitFor();
  const reordered = [initial[1], initial[0], ...initial.slice(2)];
  await order(reordered);
  p = await point(initial[1]);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  p = await point(initial[2]);
  await page.mouse.move(p.x, p.y);
  await window.locator('.virtual-desktop-list-insert').waitFor();
  await priorities.press('Escape');
  await status.getByText('Drag cancelled; priority order is unchanged.', { exact: true }).waitFor();
  await page.mouse.up();
  await order(reordered);
  const pages = window.getByRole('tablist', { name: 'Priority pages', exact: true });
  await pages.getByRole('tab', { name: 'Notes', exact: true }).click();
  await status
    .getByText('Notes: native edit text stays when you switch tabs.', { exact: true })
    .waitFor();
  await expect(priorities).toBeHidden();
  const notes = window.locator('textarea[data-control-id="62"]');
  await notes.fill('Notes saved in native edit state.');
  await pages.getByRole('tab', { name: 'Priorities', exact: true }).click();
  await status.getByText('Drag priorities to reorder; Escape cancels.', { exact: true }).waitFor();
  await expect(notes).toBeHidden();
  await order(reordered);
  await pages.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(notes).toBeVisible();
  assert.equal(await notes.inputValue(), 'Notes saved in native edit state.');
  await window.getByRole('menuitem', { name: 'Notes (editable)', exact: true }).click();
  const editable = window.getByRole('menuitemradio', { name: 'Editable', exact: true }),
    readOnly = window.getByRole('menuitemradio', { name: 'Read-only', exact: true });
  await expect(editable).toHaveAttribute('aria-checked', 'true');
  await expect(readOnly).toHaveAttribute('aria-checked', 'false');
  assert.equal(await editable.evaluate((el) => getComputedStyle(el).fontWeight), '700');
  await readOnly.click();
  await status
    .getByText('Notes are read-only. Select Editable to unlock them.', { exact: true })
    .waitFor();
  await expect(notes).not.toBeEditable();
  assert.equal(await notes.inputValue(), 'Notes saved in native edit state.');
  await notes.press('End');
  await notes.press('X');
  assert.equal(await notes.inputValue(), 'Notes saved in native edit state.');
  await window.getByRole('menuitem', { name: 'Notes (read-only)', exact: true }).click();
  await expect(readOnly).toHaveAttribute('aria-checked', 'true');
  await expect(editable).toHaveAttribute('aria-checked', 'false');
  await mkdir('.scratch', { recursive: true });
  await window.screenshot({ path: '.scratch/gui-controls-notes-menu.png' });
  await editable.click();
  await status.getByText('Notes are editable. Your text is preserved.', { exact: true }).waitFor();
  await expect(notes).toBeEditable();
  await notes.fill('Unlocked native notes.');
  await window.getByRole('menuitem', { name: 'Notes (editable)', exact: true }).click();
  await readOnly.click();
  await window.getByRole('menuitem', { name: 'Demo', exact: true }).click();
  await window.getByRole('menuitem', { name: 'Reset', exact: true }).click();
  await status.getByText(reset, { exact: true }).waitFor();
  await order(initial);
  await expect(notes).toBeHidden();
  assert.equal(await notes.evaluate((el) => el.readOnly), false);
  await expect(
    window.getByRole('menuitem', { name: 'Notes (editable)', exact: true }),
  ).toBeVisible();
  assert.equal(await checkbox.getAttribute('aria-checked'), 'false');
  assert.equal(await first.getAttribute('aria-checked'), 'true');
  await page.waitForFunction(
    () =>
      document
        .querySelector('canvas[data-control-id="50"]')
        ?.getContext('2d')
        .getImageData(12, 12, 1, 1).data[0] === 28,
  );
  await mkdir('.scratch', { recursive: true });
  await window.screenshot({ path: '.scratch/gui-controls-showcase.png' });
  await window.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await window.getByRole('menuitem', { name: 'Font...', exact: true }).click();
  await page.locator('#font-dialog').waitFor({ state: 'visible' });
  await page.locator('#font-cancel').click();
  await status
    .getByText('Font selection cancelled; the current font is unchanged.', { exact: true })
    .waitFor();
  await window.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  await window.getByRole('menuitem', { name: 'Font...', exact: true }).click();
  await page.locator('#font-dialog').waitFor({ state: 'visible' });
  await page.locator('#font-face').fill('Courier New');
  await page.locator('#font-points').fill('12');
  await page.locator('#font-weight').fill('700');
  await page.locator('#font-color').fill('#a0141e');
  await page.locator('#font-ok').click();
  await status
    .getByText('Font selection: native controls and GDI text use your chosen font.', {
      exact: true,
    })
    .waitFor();
  const controlFont = await notes.evaluate((el) => ({
    face: el.style.fontFamily,
    size: el.style.fontSize,
    weight: el.style.fontWeight,
  }));
  assert.match(controlFont.face, /Courier New/);
  assert.equal(controlFont.size, '16px');
  assert.equal(controlFont.weight, '700');
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas[data-control-id="50"]');
    if (!c) return false;
    const p = c.getContext('2d').getImageData(8, 26, 200, 16).data;
    return p.some((v, i) => i % 4 === 0 && v === 160 && p[i + 1] === 20 && p[i + 2] === 30);
  });
  await window.screenshot({ path: '.scratch/gui-controls-chosen-font.png' });
  await window.getByRole('menuitem', { name: 'Notes (editable)', exact: true }).click();
  await window.getByRole('menuitem', { name: 'Find...', exact: true }).click();
  const find = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: /^Find$/ }),
  });
  await find.getByRole('button', { name: 'Find Next', exact: true }).waitFor();
  await notes.fill('alpha alpha');
  await find.locator('[data-control-id="1152"]').fill('alpha');
  await find.getByRole('button', { name: 'Find Next', exact: true }).click();
  await status.getByText('Find: matching notes text selected.', { exact: true }).waitFor();
  await expect
    .poll(() => notes.evaluate((el) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, 5]);
  const toolbar = window.getByRole('toolbar');
  await toolbar.getByRole('button', { name: 'Replace', exact: true }).click();
  await find.waitFor({ state: 'detached' });
  const replace = page.locator('.virtual-desktop-window').filter({
    has: page.locator('.virtual-desktop-title', { hasText: /^Replace$/ }),
  });
  await replace.locator('[data-control-id="1153"]').fill('beta');
  await replace.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(notes).toHaveValue('beta alpha');
  await replace.getByRole('button', { name: 'Replace All', exact: true }).click();
  await expect(notes).toHaveValue('beta beta');
  await toolbar.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(notes).toHaveValue('beta alpha');
  await replace.getByRole('button', { name: 'Cancel', exact: true }).click();
  await replace.waitFor({ state: 'detached' });
  await status.getByText('Find/Replace closed; notes stay editable.', { exact: true }).waitFor();
  await toolbar.getByRole('button', { name: 'Lock notes', exact: true }).click();
  await expect(notes).toHaveJSProperty('readOnly', true);
  await expect(toolbar.getByRole('button', { name: 'Lock notes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await toolbar.getByRole('button', { name: 'Lock notes', exact: true }).click();
  await expect(notes).toHaveJSProperty('readOnly', false);
  await window.getByRole('menuitem', { name: 'Demo', exact: true }).click();
  await window.getByRole('menuitem', { name: 'Settings...', exact: true }).click();
  const settings = page
    .locator('.virtual-desktop-window')
    .filter({ has: page.locator('.virtual-desktop-title', { hasText: /^GUI settings$/ }) });
  const lock = settings.getByRole('checkbox', { name: 'Lock notes for editing', exact: true });
  await lock.click();
  await expect(lock).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('tab', { name: 'Canvas', exact: true }).click();
  const reverse = settings.getByRole('checkbox', { name: 'Reverse color order', exact: true });
  await reverse.click();
  await expect(reverse).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(notes).toHaveJSProperty('readOnly', true);
  await expect.poll(swatch).toEqual([230, 140, 30, 255]);
  await expect(settings.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  await settings.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(lock).toHaveAttribute('aria-checked', 'true');
  await lock.click();
  await expect(lock).toHaveAttribute('aria-checked', 'false');
  await settings.screenshot({ path: '.scratch/gui-controls-settings.png' });
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await settings.waitFor({ state: 'detached' });
  await status
    .getByText('Settings cancelled; applied changes are preserved.', { exact: true })
    .waitFor();
  await expect(notes).toHaveJSProperty('readOnly', true);
  await expect(notes).toHaveValue('beta alpha');
  await toolbar.getByRole('button', { name: 'Lock notes', exact: true }).click();
  await expect(notes).toHaveJSProperty('readOnly', false);
  await window.screenshot({ path: '.scratch/gui-controls-search.png' });
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  const run = await page.evaluate(() => window.__lastRun);
  assert.equal(run.exitCode, 0);
  const saved = run.outputs.find(
    (f) => f.path === 'gui-settings.ini' || f.path.endsWith('/gui-settings.ini'),
  );
  assert.ok(saved);
  const settingsIni = new Uint8Array(Object.values(saved.bytes));
  const settingsText = new TextDecoder().decode(settingsIni);
  assert.match(settingsText, /LockNotes=1/);
  assert.match(settingsText, /ReverseColors=1/);
  await page.locator('#file').setInputFiles([
    {
      name: 'gui-controls.exe',
      mimeType: 'application/octet-stream',
      buffer: await readFile('public/examples/gui-controls/gui-controls.exe'),
    },
    { name: 'gui-settings.ini', mimeType: 'text/plain', buffer: Buffer.from(settingsIni) },
  ]);
  await page.locator('#run').click();
  await status.getByText(reset, { exact: true }).waitFor();
  await expect(notes).toHaveJSProperty('readOnly', true);
  await expect(toolbar.getByRole('button', { name: 'Lock notes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(swatch).toEqual([230, 140, 30, 255]);
  await window.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun !== null);
  assert.equal((await page.evaluate(() => window.__lastRun)).exitCode, 0);

  await page.locator('#file').setInputFiles('public/examples/gui-controls/gui-controls.zip');
  await page.locator('#run').click();
  await status.getByText(reset, { exact: true }).waitFor();
  await page.locator('#stop').click();
  await window.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  const manifest = JSON.parse(
    await readFile('public/examples/manifest.json', 'utf8'),
  ).interactive.find((e) => e.name === 'gui-controls');
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    status: 'passed',
    exeSha256: manifest.exeSha256,
    exitCode: run.exitCode,
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    checks: [
      'Public EXE loads from Pages examples; original x86 callbacks run in the browser',
      'Tree category, sorted list, editable combo, checkbox and radio interactions',
      'Native registered child canvas, nested button command, independent GDI repaint and mouse callback',
      'Public priorities list reorders through native COMCTL32 drag callbacks; Escape cancels and Reset restores order',
      'Native tabs switch priorities/notes visibility; edited notes and priority order survive switching pages',
      'Native COMCTL32 status bar displays callback text through SB_SETTEXTA with minimum height and bottom docking',
      'Native MENUITEMINFO radio choices lock/unlock notes through EM_SETREADONLY, preserve text, update menu captions/default state and reset correctly',
      'Native menu Reset restores control state; close exits zero',
      'Public Appearance > Font opens the native ChooseFontA browser picker; Cancel preserves the font and Accept changes DOM control fonts and actual GDI child text color',
      'Public Notes > Find/Replace remains modeless; native search selects the DOM edit range, Replace/Replace All change actual notes and native Undo restores the previous edit',
      'Native CreateToolbarEx quick actions render standard Wine icons; Replace/Undo dispatch actual EXE callbacks and the checked Lock notes action synchronizes edit/menu state',
      'Demo > Settings opens native PropertySheetA pages from EXE resources; Apply updates notes lock and actual GDI canvas pixels, switching pages preserves draft state and Cancel discards unapplied changes',
      'Settings Apply writes real gui-settings.ini output; re-uploading it alongside the unchanged EXE restores notes lock, toolbar state and actual GDI palette',
      'Public source/license ZIP package runs and Stop removes its window',
    ],
    scope:
      'Original MIT WineBrowser Win32 showcase, separate from upstream applications. This exercises the supported controls; no universal GUI/DLL compatibility claim.',
  };
  await writeFile(
    'evidence/gui-controls-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) {
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
    await page.screenshot({ path: '.scratch/gui-controls-failure.png' });
  }
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
