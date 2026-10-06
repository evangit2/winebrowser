import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { nativeComboList, nativeComboEdit } from './lib/native-combo-input.mjs';
let browser, server, page;
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
  page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  await page.locator('#file').setInputFiles('tests/fixtures/monitor-popup/monitor-popup.exe');
  await page.locator('#run').click();
  const root = page.locator('.virtual-desktop-window'),
    desktop = page.locator('.virtual-desktop');
  const title = async (text) => {
    await page.waitForFunction(
      (text) =>
        document.querySelector('.virtual-desktop-title')?.textContent === text ||
        window.__lastRun != null ||
        document.querySelector('#state')?.textContent === 'ERROR',
      text,
    );
    await expect(root.locator('.virtual-desktop-title')).toHaveText(text);
  };
  await title('Monitor popup ready');
  const combo = root.getByRole('combobox', { name: 'Monitor dropdown', exact: true });
  const editable = root.getByRole('combobox', { name: 'Monitor edit', exact: true });
  const oversized = root.getByRole('combobox', { name: 'Monitor oversized', exact: true });
  const list = await nativeComboList(combo),
    edit = nativeComboEdit(editable);
  const verify = async (target, text) => {
    await target.press('F6');
    await title(text);
  };
  const bounds = (locator) =>
    locator.evaluate((element) => {
      const box = element.closest('.virtual-desktop-control-container').getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
    });
  const measureUpward = async (target, width, height) => {
    const popup = await nativeComboList(target);
    await expect(popup).toBeVisible();
    const host = await bounds(target),
      box = await bounds(popup),
      area = await desktop.boundingBox();
    assert.ok(area);
    assert.ok(Math.abs(box.bottom - host.y) <= 1, JSON.stringify({ host, popup: box }));
    assert.ok(
      box.y >= area.y - 1 && box.bottom <= area.y + height + 1,
      JSON.stringify({ area, popup: box, height }),
    );
    assert.ok(
      box.x >= area.x - 1 && box.x + box.width <= area.x + width + 1,
      JSON.stringify({ area, popup: box, width }),
    );
    return { mode: [width, height], host, popup: box, desktopOrigin: [area.x, area.y] };
  };
  const observations = [];
  const move = async (popup, index) => {
    let box;
    await expect
      .poll(async () => {
        box = await popup.getByRole('option').nth(index).boundingBox();
        return box;
      })
      .not.toBeNull();
    await page.mouse.move(box.x + 12, box.y + box.height / 2);
    await expect(popup.getByRole('option').nth(index)).toHaveAttribute('aria-selected', 'true');
  };
  await combo.press('F4');
  observations.push(await measureUpward(combo, 1024, 768));
  await move(list, 3);
  await verify(combo, '1024 popup verified');
  await desktop.screenshot({ path: 'evidence/monitor-popup-upward-browser.png' });
  await list.getByRole('option').nth(5).click();
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify(combo, '800x600 popup ready');
  await combo.press('F4');
  observations.push(await measureUpward(combo, 800, 600));
  await move(list, 1);
  await verify(combo, '800 popup verified');
  await combo.press('Escape');
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify(combo, '640x480 popup ready');
  const arrow = combo.getByRole('button', { name: 'Open Monitor dropdown', exact: true });
  const arrowBox = await arrow.boundingBox();
  assert.ok(arrowBox);
  await page.mouse.move(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2);
  await page.mouse.down();
  await expect(arrow).toHaveAttribute('aria-pressed', 'true');
  observations.push(await measureUpward(combo, 640, 480));
  await verify(combo, '640 arrow verified');
  await move(list, 3);
  await expect(arrow).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.up();
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await verify(combo, '640 drag verified');
  await oversized.press('F4');
  const largeList = await nativeComboList(oversized);
  await expect(largeList).toBeVisible();
  const large = await bounds(largeList),
    area = await desktop.boundingBox();
  assert.ok(area);
  assert.ok(
    Math.abs(large.y - area.y) <= 1 && Math.abs(large.height - 480) <= 1,
    JSON.stringify({ large, area }),
  );
  observations.push({ mode: [640, 480], oversized: large, desktopOrigin: [area.x, area.y] });
  await verify(oversized, 'Oversized popup verified');
  await desktop.screenshot({ path: 'evidence/monitor-popup-oversized-browser.png' });
  await oversized.press('F7');
  await expect(oversized).toHaveAttribute('aria-expanded', 'false');
  await edit.fill('Typed Ω');
  await edit.press('F4');
  observations.push(await measureUpward(editable, 640, 480));
  await move(await nativeComboList(editable), 3);
  await verify(edit, 'Editable upward popup verified');
  const outside = await desktop.boundingBox();
  assert.ok(outside);
  await page.mouse.click(outside.x + 700, outside.y + 100);
  await expect(editable).toHaveAttribute('aria-expanded', 'false');
  await expect(edit).toHaveValue('Typed Ω');
  await verify(edit, 'Monitor popup checks complete');
  await desktop.screenshot({ path: 'evidence/monitor-popup-browser.png' });
  await root.locator('.virtual-desktop-close').click();
  await page.waitForFunction(() => window.__lastRun != null);
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
      .update(await readFile('tests/fixtures/monitor-popup/monitor-popup.exe'))
      .digest('hex'),
    compiledBlocks: run.compiledBlocks,
    x86TranslationMs: run.x86TranslationMs,
    observations,
    checks: [
      'Unchanged MIT PE32 includes SDK static assertions for DXGI_OUTPUT_DESC offsets and queries actual USER32/DXGI/D3D8/D3D9 interfaces',
      'MONITORINFOEXA/W names, both rectangles, flags and output guards match system work-area/screen metrics and native DXGI output fields',
      'DXGI and D3D8/9 return the same USER32-resolvable monitor; invalid adapters and monitor handles are rejected; signed point/rectangle boundaries honor primary/nearest fallback flags',
      'Native mode changes to 800x600 and 640x480 update every monitor/work-area query and deliver actual WM_DISPLAYCHANGE messages; restoration returns 1024x768',
      'SDK SystemParametersInfoA/W identifiers return scalar/mouse settings, modern and XP NONCLIENTMETRICS and icon LOGFONT without overwriting guard bytes',
      'Process-local mouse and keyboard-speed preferences round-trip through native setters/getters and the guest receives WM_SETTINGCHANGE',
      'Dropdowns near the bottom open above the actual native combo HWND at all three modes; browser geometry agrees with native GetWindowRect',
      'Held arrow dragging upward hands native HWND capture and signed coordinates to actual ComboLBox; native selection and release notification order pass',
      'Oversized popup fills the active 640x480 work area, retains its actual list capture and closes through native WM_CANCELMODE',
      'Editable upward hover and outside dismissal restore unmatched Unicode text; native interface release and normal destruction exit zero',
    ],
    scope:
      'One process-local virtual monitor, base/extended monitor queries, common desktop preference queries and vertical dropdown placement. Multiple monitors, full DPI handling, horizontal popup placement, persistent theme changes and universal Windows/DLL compatibility remain incomplete.',
  };
  await writeFile(
    'evidence/monitor-popup-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.scratch/monitor-popup-failure.png' });
    console.error(
      await page.evaluate(() => ({
        state: document.querySelector('#state')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        run: window.__lastRun,
      })),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
