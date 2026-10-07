import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';
const oracle = JSON.parse(
  await readFile('tests/fixtures/scroll-controls/geometry-wine-oracle.json', 'utf8'),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chromium',
    headless: process.env.HEADED !== '1',
  });
  const executable = await readFile('tests/fixtures/scroll-controls/scroll-controls.exe'),
    sha256 = digest(executable),
    runs = [],
    errors = [];
  for (const mode of ['exe-upload', 'zip-upload', 'hosted-example']) {
    console.error('Starting', mode);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    if (mode === 'hosted-example') {
      const response = await page.request.get(new URL('examples/manifest.json', url).href);
      assert.ok(response.ok());
      const entry = (await response.json()).interactive.find((e) => e.name === 'scroll-controls');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="scroll-controls"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(digest(bytes), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'scroll-controls.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'scroll-controls.exe' : 'scroll-controls.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/scroll-controls.exe': executable })),
      });
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    assert.equal(
      await page.locator('#run').isEnabled(),
      true,
      await page.locator('#details').textContent(),
    );
    await page.locator('#run').click();
    await page.waitForFunction(
      () =>
        document.querySelector('.virtual-desktop-window') ||
        window.__lastRun ||
        document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    assert.equal(
      await page.evaluate(() => window.__lastRun),
      null,
      await page.locator('#logs').textContent(),
    );
    const root = page.locator('.virtual-desktop-window').filter({
        has: page.locator('.virtual-desktop-title', { hasText: /^Native scrollbars/ }),
      }),
      title = root.locator('.virtual-desktop-title'),
      horizontal = root.locator('[data-control-id="201"]'),
      vertical = root.locator('[data-control-id="204"]');
    const observations = [];
    const verify = async (stage) => {
      const labels = [
        'Normal',
        'Large page',
        'Left off',
        'Right off',
        'All off',
        'Limits',
        'Normal',
        'Disabled window',
        'Enabled window',
      ];
      await expect(title).toHaveText('Native scrollbars - ' + labels[stage]);
      const mapping = [1, 5, 8, 9, 10, 11, 1, 10, 1];
      for (const [id, v, l, t] of [
        [201, 0, 180, 17],
        [202, 0, 180, 25],
        [203, 0, 8, 17],
        [204, 1, 180, 17],
        [205, 1, 180, 25],
        [206, 0, 180, 18],
        [207, 0, 180, 18],
        [208, 1, 180, 18],
        [209, 1, 180, 18],
      ]) {
        const ref = oracle.cases.find(
          (c) =>
            c.vertical === v && c.length === l && c.thickness === t && c.stage === mapping[stage],
        );
        assert.ok(ref);
        const actual = await root.locator('[data-control-id="' + id + '"]').evaluate((canvas) => ({
          width: canvas.width,
          height: canvas.height,
          bytes: Array.from(
            canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data,
          ),
        }));
        const width = v ? t : l,
          height = v ? l : t;
        assert.deepEqual([actual.width, actual.height], [width, height]);
        for (const [x, y, n, color] of ref.runs)
          for (let i = x; i < x + n; i++) {
            const k = (y * width + i) * 4;
            assert.equal(
              actual.bytes[k] | (actual.bytes[k + 1] << 8) | (actual.bytes[k + 2] << 16),
              color,
              mode + '/' + stage + '/' + id + '/' + i + ',' + y,
            );
            assert.equal(actual.bytes[k + 3], 255);
          }
      }
      const position = stage === 1 ? 10 : stage === 5 ? 80000 : 20;
      await expect(root.locator('[data-control-id="301"]')).toHaveText(
        'Horizontal position: ' + position,
      );
      await expect(root.locator('[data-control-id="302"]')).toHaveText(
        'Vertical position: ' + position,
      );
      await expect(root.locator('[data-control-id="304"]')).toHaveText('Window DPI: 96');
      await expect(root.locator('[data-control-id="306"]')).toHaveText(
        'Horizontal thumb pixels: ' +
          (stage === 1 ? 146 : stage === 4 || stage === 7 ? 0 : stage === 5 ? 17 : 38),
      );
      observations.push({ stage, label: labels[stage], verifiedPixels: 28216 });
      for (const control of [horizontal, vertical])
        await expect(control).toHaveAttribute('aria-disabled', String(stage === 4 || stage === 7));
      if ([2, 4, 5].includes(stage))
        await root.screenshot({
          path: 'evidence/scroll-controls-stage-' + stage + '-' + runs.length + '.png',
        });
    };
    // Check actual displayed coordinates against the independently captured
    // native creation geometry, including bottom/right origin adjustment.
    for (const [id, x, y, width, height] of [
      [206, 60, 158, 180, 18],
      [207, 260, 165, 180, 18],
      [208, 600, 112, 18, 180],
      [209, 622, 112, 18, 180],
    ]) {
      const actual = await root
        .locator('[data-control-id="' + id + '"]')
        .evaluate((el) => [
          parseFloat(el.parentElement.style.left),
          parseFloat(el.parentElement.style.top),
          el.width,
          el.height,
        ]);
      assert.deepEqual(actual, [x, y, width, height]);
    }
    await verify(0);
    for (const [stage, button] of [
      [1, 'Large page'],
      [2, 'Left off'],
      [3, 'Right off'],
      [4, 'All off'],
      [5, 'Limits'],
      [6, 'Reset'],
      [7, 'Disable'],
      [8, 'Enable'],
    ]) {
      await root.getByRole('button', { name: button, exact: true }).click();
      await verify(stage);
    }
    for (const [id, vertical] of [
      [206, false],
      [207, false],
      [208, true],
      [209, true],
    ]) {
      await root.getByRole('button', { name: 'Reset', exact: true }).click();
      const control = root.locator('[data-control-id="' + id + '"]');
      await control.click({ position: vertical ? { x: 9, y: 171 } : { x: 171, y: 9 } });
      await expect(root.locator('[data-control-id="305"]')).toHaveText('Aligned position: 21');
      await control.press(vertical ? 'ArrowDown' : 'ArrowRight');
      await expect(root.locator('[data-control-id="305"]')).toHaveText('Aligned position: 22');
    }
    await root.getByRole('button', { name: 'Reset', exact: true }).click();
    const hLabel = root.locator('[data-control-id="301"]'),
      vLabel = root.locator('[data-control-id="302"]');
    await root.getByRole('button', { name: 'Disable', exact: true }).click();
    const disabledRect = await horizontal.boundingBox();
    await page.mouse.click(disabledRect.x + 171, disabledRect.y + 8);
    await expect(hLabel).toHaveText('Horizontal position: 20');
    await expect(root.locator('[data-control-id="303"]')).toHaveText('Last event: -1');
    await root.getByRole('button', { name: 'Enable', exact: true }).click();
    await horizontal.click({ position: { x: 171, y: 8 } });
    await expect(hLabel).toHaveText('Horizontal position: 21');
    await expect(root.locator('[data-control-id="303"]')).toHaveText('Last event: 8');
    await horizontal.press('ArrowRight');
    await expect(hLabel).toHaveText('Horizontal position: 22');
    await horizontal.press('PageUp');
    await expect(hLabel).toHaveText('Horizontal position: 14');
    await horizontal.press('End');
    await expect(hLabel).toHaveText('Horizontal position: 33');
    await horizontal.press('Home');
    await expect(hLabel).toHaveText('Horizontal position: 10');
    await vertical.press('ArrowDown');
    await expect(vLabel).toHaveText('Vertical position: 21');
    await vertical.press('PageDown');
    await expect(vLabel).toHaveText('Vertical position: 29');
    await root.getByRole('button', { name: 'Left off', exact: true }).click();
    await horizontal.click({ position: { x: 8, y: 8 } });
    await expect(hLabel).toHaveText('Horizontal position: 20');
    await root.getByRole('button', { name: 'Reset', exact: true }).click();
    const drag = async (control, from, to, expected, label) => {
      await control.scrollIntoViewIfNeeded();
      const rect = await control.boundingBox();
      await page.mouse.move(rect.x + from.x, rect.y + from.y);
      await page.mouse.down();
      await page.mouse.move(rect.x + to.x, rect.y + to.y, { steps: 4 });
      await page.mouse.up();
      await expect(label).toHaveText(expected);
    };
    await drag(horizontal, { x: 83, y: 8 }, { x: 123, y: 8 }, 'Horizontal position: 29', hLabel);
    await drag(vertical, { x: 8, y: 83 }, { x: 8, y: 123 }, 'Vertical position: 29', vLabel);
    await root.getByRole('button', { name: 'Limits', exact: true }).click();
    await drag(
      horizontal,
      { x: 76, y: 8 },
      { x: 106, y: 8 },
      'Horizontal position: 127084',
      hLabel,
    );
    await root.screenshot({ path: 'evidence/scroll-controls-input-' + runs.length + '.png' });
    const inputAcceptance = [
      'Native arrow/page/Home/End keyboard notifications update application state',
      'Disabled left arrow suppresses mouse notification',
      'Horizontal and vertical thumb dragging calls the compiled parent procedure',
      'Track positions above 65535 use full GetScrollInfo data',
      'EnableWindow updates WS_DISABLED, native arrow flags, and actual browser interaction',
      'All four aligned controls retain native edge positioning and mouse/keyboard callbacks',
    ];
    await page.screenshot({ path: `evidence/scroll-controls-${mode}.png`, fullPage: true });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => window.__lastRun || document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    const run = await page.evaluate(() => window.__lastRun);
    assert.equal(run?.exitCode, 0, await page.locator('#logs').textContent());
    assert.ok(run.compiledBlocks > 0 && run.x86TranslationMs > 0 && run.wasmBytes > 0);
    for (const name of [
      'SetScrollInfo',
      'GetScrollInfo',
      'EnableScrollBar',
      'EnableWindow',
      'GetDpiForWindow',
      'GetScrollBarInfo',
      'GetWindowRect',
      'GetClientRect',
      'ScreenToClient',
    ])
      assert.ok(run.apiNames.includes('user32.dll!' + name), name);
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        run.loadedModules.some((m) => m.name === name && !m.host),
        name,
      );
    const output = await page.locator('#output').textContent();
    assert.equal(output, 'NATIVE SCROLLBAR CONTROLS GUI PASS\n');
    runs.push({
      mode,
      observations,
      inputAcceptance,
      run,
      output,
      logs: await page.locator('#logs').textContent(),
      isolated: await page.evaluate(() => crossOriginIsolated),
    });
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    headedBrowser: process.env.HEADED === '1',
    exeSha256: sha256,
    scope:
      'Unchanged MIT Windows SDK GUI with standalone native SCROLLBAR controls translated into Wasm inside the browser with Wine base DLLs. Nine stages verify nine controls against classic native pixel captures in EXE/ZIP/catalog modes. Actual mouse, keyboard, native window enabling, 32-bit thumb tracking and compiled parent callbacks are exercised. Native top/bottom/left/right alignment and GetScrollBarInfo geometry/state/reserved-field queries are exercised. Nonclient bars, size-box/size-grip styles, mouse auto-repeat, complete subclass behavior and universal Windows/DLL support remain unfinished.',
    oracleReference: oracle.reference,
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_SCROLL_CONTROLS_EVIDENCE ||
      'evidence/scroll-controls-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
