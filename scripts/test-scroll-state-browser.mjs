import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { unpackPackage } from '../src/package.js';
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
  const executable = await readFile('tests/fixtures/scroll-state/scroll-state.exe'),
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
      const entry = (await response.json()).interactive.find((e) => e.name === 'scroll-state');
      assert.equal(entry.exeSha256, sha256);
      const fetched = page.waitForResponse((r) => r.url().endsWith('/examples/' + entry.zip));
      await page.locator('[data-demo="scroll-state"]').click();
      const archive = await fetched;
      assert.ok(archive.ok());
      const bytes = await archive.body();
      assert.equal(digest(bytes), entry.zipSha256);
      const pkg = await unpackPackage(new Uint8Array(bytes), 'scroll-state.zip');
      assert.deepEqual(pkg.files.get(entry.exe), new Uint8Array(executable));
    } else
      await page.locator('#file').setInputFiles({
        name: mode === 'exe-upload' ? 'scroll-state.exe' : 'scroll-state.zip',
        mimeType: mode === 'exe-upload' ? 'application/octet-stream' : 'application/zip',
        buffer:
          mode === 'exe-upload'
            ? executable
            : Buffer.from(zipSync({ 'app/scroll-state.exe': executable })),
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
        has: page.locator('.virtual-desktop-title', { hasText: /^Native scroll state/ }),
      }),
      title = root.locator('.virtual-desktop-title'),
      values = root
        .locator('.virtual-desktop-control-static')
        .filter({ hasText: /^(Minimum|Maximum|Page|Position|Track position):/ });
    const observations = [];
    const verify = async (stage, label) => {
      await expect(title).toHaveText('Native scroll state - ' + label);
      const fields = ['Minimum', 'Maximum', 'Page', 'Position', 'Track position'];
      const expected = stages[stage].values.map((v, i) => fields[i] + ': ' + v);
      const actual = [];
      for (const text of expected) {
        const field = values.filter({ hasText: new RegExp('^' + text.split(':')[0] + ':') });
        await expect(field).toHaveText(text);
        actual.push(await field.textContent());
      }
      observations.push({ label, stage, values: actual });
      console.error('Verified', label, expected.join(', '));
      if (['Page', 'Limits', 'Callback'].includes(label))
        await root.screenshot({
          path: 'evidence/scroll-state-' + label + '-' + runs.length + '.png',
        });
    };
    const stages = [
      { label: 'Normal', button: 'Normal', values: [0, 100, 0, 0, 0] },
      { label: 'Range', button: 'Range', values: [10, 40, 8, 33, 33] },
      { label: 'Move', button: 'Move', values: [10, 40, 8, 31, 31] },
      { label: 'Page', button: 'Page', values: [10, 40, 31, 10, 10] },
      { label: 'Reverse', button: 'Reverse', values: [0, 0, 1, 0, 0] },
      {
        label: 'Limits',
        button: 'Limits',
        values: [-2147483648, 2147483647, 0, 2147483647, 2147483647],
      },
      { label: 'Legacy', button: 'Legacy', values: [-20, 200, 0, 42, 42] },
      { label: 'Callback', button: 'Callback', values: [-7, 33, 4, 15, 9] },
      { label: 'Normal', button: 'Reset', values: [0, 100, 0, 0, 0] },
    ];
    await verify(0, 'Normal');
    for (let stage = 1; stage < stages.length; stage++) {
      await root.getByRole('button', { name: stages[stage].button, exact: true }).click();
      await verify(stage, stages[stage].label);
    }
    await page.screenshot({ path: `evidence/scroll-state-${mode}.png`, fullPage: true });
    await root.locator('.virtual-desktop-close').click();
    await page.waitForFunction(
      () => window.__lastRun || document.querySelector('#state')?.textContent === 'ERROR',
      null,
      { timeout: 60000 },
    );
    const run = await page.evaluate(() => window.__lastRun);
    assert.equal(run?.exitCode, 0, await page.locator('#logs').textContent());
    assert.ok(run.compiledBlocks > 1500);
    for (const name of [
      'SetScrollInfo',
      'GetScrollInfo',
      'SetScrollPos',
      'GetScrollPos',
      'SetScrollRange',
      'GetScrollRange',
    ])
      assert.ok(run.apiNames.includes('user32.dll!' + name), name);
    for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        run.loadedModules.some((m) => m.name === name && !m.host),
        name,
      );
    const output = await page.locator('#output').textContent();
    assert.equal(output, 'NATIVE SCROLL STATE GUI PASS\n');
    runs.push({
      mode,
      observations,
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
      'Unchanged MIT Windows SDK scrollbar state inspector translated into Wasm inside the browser with native Wine base DLLs. Nine GUI stages in EXE/ZIP/catalog modes verify actual getter values, clamping, signed limits, legacy sizes and compiled custom-window callbacks. API state and forwarding are covered; standard scrollbar widgets, thumb tracking and universal Windows/DLL compatibility remain unfinished.',
    oracleReference: 'Wine 11 desktop x86 macOS; native Windows SDK scrollbar API captures',
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_SCROLL_STATE_EVIDENCE || 'evidence/scroll-state-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
