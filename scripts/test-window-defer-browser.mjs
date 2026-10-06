import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';

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
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chromium' });
  const executable = await readFile('tests/fixtures/window-defer/window-defer.exe'),
    sha256 = createHash('sha256').update(executable).digest('hex'),
    runs = [],
    errors = [];
  for (const mode of ['exe-upload', 'zip-upload', 'hosted-example']) {
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'window-defer');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="window-defer"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'window-defer.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else {
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'window-defer.exe' : 'window-defer.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/window-defer.exe': executable })),
      });
    }
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
    const root = page.locator('.virtual-desktop-window'),
      title = root.locator('.virtual-desktop-title');
    await expect(title).toHaveText('Native layout - side by side');
    const geometry = () =>
      root
        .locator('canvas[data-control-id="201"], canvas[data-control-id="202"]')
        .evaluateAll((canvases) =>
          canvases
            .sort((a, b) => Number(a.dataset.controlId) - Number(b.dataset.controlId))
            .map((c) => {
              const bounds = c.getBoundingClientRect();
              const origin = c.closest('.virtual-desktop-window').getBoundingClientRect();
              return {
                x: bounds.x - origin.x,
                y: bounds.y - origin.y,
                width: bounds.width,
                height: bounds.height,
                pixels: Array.from(c.getContext('2d').getImageData(8, 50, 1, 1).data),
              };
            }),
        );
    const waitLayout = async (stacked, minimumWidth = 0) => {
      await expect(title).toHaveText(
        stacked ? 'Native layout - stacked' : 'Native layout - side by side',
      );
      await expect
        .poll(async () => {
          const panes = await geometry();
          if (panes.length !== 2) return false;
          const [a, b] = panes;
          return (
            a.width === b.width &&
            a.height === b.height &&
            (stacked ? a.x === b.x && b.y > a.y : a.y === b.y && b.x > a.x) &&
            a.width > minimumWidth &&
            a.pixels.join() === '28,85,138,255' &&
            b.pixels.join() === '150,66,30,255'
          );
        })
        .toBe(true)
        .catch(async (error) => {
          console.log(
            JSON.stringify(
              {
                mode,
                stacked,
                minimumWidth,
                panes: await geometry(),
                run: await page.evaluate(() => window.__lastRun),
                logs: await page.locator('#logs').textContent(),
              },
              null,
              2,
            ),
          );
          await root.screenshot({ path: 'evidence/window-defer-failure.png' });
          throw error;
        });
      return geometry();
    };
    const observations = [{ step: 'initial', panes: await waitLayout(false) }];
    await root.getByRole('button', { name: 'Stack panes', exact: true }).click();
    observations.push({ step: 'stacked', panes: await waitLayout(true) });
    assert.ok(observations[1].panes[0].width > observations[0].panes[0].width);
    await root.getByRole('button', { name: 'Resize window', exact: true }).click();
    observations.push({
      step: 'large-stacked',
      panes: await waitLayout(true, observations[1].panes[0].width),
    });
    assert.ok(observations[2].panes[0].width > observations[1].panes[0].width);
    await root.screenshot({ path: `evidence/window-defer-${mode}.png` });
    await root.getByRole('button', { name: 'Side by side', exact: true }).click();
    observations.push({ step: 'large-side', panes: await waitLayout(false) });
    await root.getByRole('button', { name: 'Resize window', exact: true }).click();
    await expect.poll(async () => (await geometry())[0].width).toBe(observations[0].panes[0].width);
    observations.push({ step: 'restored-side', panes: await waitLayout(false) });
    assert.deepEqual(observations[4].panes, observations[0].panes);
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(() => window.__lastRun != null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      output: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      isolated: crossOriginIsolated,
    }));
    assert.equal(result.run?.exitCode, 0, JSON.stringify(result));
    assert.equal(result.output, 'NATIVE DEFERRED GUI PASS\n');
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    for (const api of [
      'BeginDeferWindowPos',
      'DeferWindowPos',
      'EndDeferWindowPos',
      'BeginPaint',
      'EndPaint',
    ])
      assert.ok(result.run.apiNames.includes('user32.dll!' + api), api);
    assert.ok(result.run.x86TranslationMs > 0 && result.run.totalCompiledBlocks > 0);
    assert.deepEqual(result.run.outputs, []);
    assert.deepEqual(result.run.deletedFiles, []);
    runs.push({ mode, observations, ...result });
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: sha256,
    scope:
      'Unchanged native Windows SDK GUI compiled from x86 to Wasm in browser with real Wine base DLLs. Trusted button input rearranges and resizes independently painted child HWNDs; native code verifies deferred geometry, repeated-HWND merging, callback ordering and consumed handles. Actual browser geometry and GDI pixels verified in loose EXE, ZIP and hosted-example modes. Broader Wine comctl32 and universal GUI support remain incomplete.',
    runs,
    errors,
  };
  await writeFile(
    'evidence/window-defer-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
