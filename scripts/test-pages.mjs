import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseURL = new URL(process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/');
if (!baseURL.pathname.endsWith('/')) baseURL.pathname += '/';
const failures = [];
let ignoreBootstrapAbort = true;
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  headless: true,
});

try {
  let serverReady = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(baseURL.href)).ok) {
        serverReady = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(serverReady, `Pages test server did not start at ${baseURL.href}`);

  async function bootFreshContext() {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console: ${message.text()}`);
    });
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText;
      if (reason === 'net::ERR_ABORTED' && ignoreBootstrapAbort) return;
      failures.push(`request failed: ${request.method()} ${request.url()} (${reason})`);
    });
    let response;
    try {
      response = await page.goto(baseURL.href, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (!/ERR_ABORTED|aborted/i.test(error.message)) throw error;
      // The first service-worker install can abort the initial document load.
    }
    if (response) assert.ok(response.ok(), `Harness page returned ${response.status()}`);
    await page.waitForFunction(
      () => document.getElementById('platform')?.textContent === 'ISOLATED / WASM READY',
      undefined,
      { timeout: 30000 },
    );
    const capabilities = await page.evaluate(() => ({
      controlled: navigator.serviceWorker?.controller !== null,
      isolated: crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    }));
    assert.deepEqual(capabilities, {
      controlled: true,
      isolated: true,
      sharedArrayBuffer: true,
    });
    return { context, page, capabilities };
  }

  const { context, page } = await bootFreshContext();
  assert.match(await page.title(), /WineBrowser/i);

  // Reload under service-worker control and verify the runtime isolation primitives again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('platform')?.textContent === 'ISOLATED / WASM READY',
    undefined,
    { timeout: 30000 },
  );
  const capabilities = await page.evaluate(() => ({
    controlled: navigator.serviceWorker?.controller !== null,
    isolated: crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
  }));
  assert.deepEqual(capabilities, {
    controlled: true,
    isolated: true,
    sharedArrayBuffer: true,
  });
  for (let index = 1; index < 3; index++) {
    const extra = await bootFreshContext();
    await extra.context.close();
  }
  ignoreBootstrapAbort = false;

  const manifestResponse = await page.request.get(new URL('demos/manifest.json', baseURL).href);
  assert.ok(
    manifestResponse.ok(),
    'Public fixture manifest is available under the configured base path',
  );
  const manifest = await manifestResponse.json();
  assert.ok(Array.isArray(manifest.fixtures) && manifest.fixtures.length > 0);

  await page.locator('#run-suite').click();
  await page.waitForFunction(
    (count) => {
      const status = document.getElementById('suite-status').textContent;
      const match = status.match(/^(\d+)\/(\d+) passed$/);
      return match !== null && Number(match[2]) === count;
    },
    manifest.fixtures.length,
    { timeout: 180000 },
  );
  const suiteRows = await page.locator('#suite-results tr').evaluateAll((rows) =>
    rows.map((row) => ({
      name: row.cells[0]?.textContent?.trim(),
      result: row.cells[1]?.textContent?.trim(),
      checks: row.cells[2]?.textContent?.trim(),
    })),
  );
  assert.equal(suiteRows.length, manifest.fixtures.length, 'Suite ran every public fixture');
  for (const fixture of manifest.fixtures) {
    const row = suiteRows.find(({ name }) => name === fixture.name);
    assert.ok(row, `Suite row missing for ${fixture.name}`);
    assert.equal(row.result, 'PASS', `${fixture.name}: ${row.checks}`);
  }

  // Upload a generated-file package and verify the downloadable result bytes.
  const zipFixture = manifest.fixtures.find((fixture) => fixture.expected?.createdFiles);
  assert.ok(zipFixture, 'Manifest needs at least one package that generates a file');
  const zipURL = new URL(`demos/${zipFixture.zip}`, baseURL);
  const zipResponse = await page.request.get(zipURL.href);
  assert.ok(zipResponse.ok(), `ZIP fixture is available: ${zipURL.pathname}`);
  const zipBytesBase64 = (await zipResponse.body()).toString('base64');
  await page.locator('#drop').evaluate(
    (target, { filename, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], filename, { type: 'application/zip' }));
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }),
      );
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
      );
    },
    { filename: zipFixture.zip.split('/').at(-1), base64: zipBytesBase64 },
  );
  await page.waitForFunction(() => !document.getElementById('run').disabled, undefined, {
    timeout: 30000,
  });
  await page.locator('#run').click();
  await page.waitForFunction(() => window.__lastRun !== null, undefined, { timeout: 30000 });
  assert.equal((await page.locator('#state').textContent()).trim(), 'EXITED');
  assert.equal(await page.evaluate(() => window.__lastRun.exitCode), zipFixture.expected.exitCode);
  const fileNames = Object.keys(zipFixture.expected.createdFiles);
  const links = page.locator('#outputs a');
  assert.equal(await links.count(), fileNames.length, 'Generated files are exposed as downloads');
  for (const name of fileNames) {
    const link = page.locator(`#outputs a[download=${JSON.stringify(name)}]`);
    assert.equal(await link.count(), 1, `Download link exists for ${name}`);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const tempPath = join(tmpdir(), `winebrowser-pages-${process.pid}-${name}`);
    try {
      await download.saveAs(tempPath);
      assert.deepEqual(
        await readFile(tempPath),
        Buffer.from(zipFixture.expected.createdFiles[name]),
      );
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  // Raw PE upload remains a separate supported entry path from ZIP packages.
  const exeFixture = manifest.fixtures.find(
    (fixture) =>
      typeof fixture.expected?.stdout === 'string' &&
      !fixture.expected?.createdFiles &&
      !fixture.expected?.messageBoxA,
  );
  assert.ok(exeFixture, 'Manifest needs a raw-EXE fixture with expected stdout');
  const exeURL = new URL(`demos/${exeFixture.exe}`, baseURL);
  const exeResponse = await page.request.get(exeURL.href);
  assert.ok(exeResponse.ok(), `Raw EXE fixture is available: ${exeURL.pathname}`);
  await page.locator('#file').setInputFiles({
    name: exeFixture.exe.split('/').at(-1),
    mimeType: 'application/vnd.microsoft.portable-executable',
    buffer: await exeResponse.body(),
  });
  await page.waitForFunction(() => !document.getElementById('run').disabled, undefined, {
    timeout: 30000,
  });
  await page.locator('#run').click();
  await page.waitForFunction(() => window.__lastRun !== null, undefined, { timeout: 30000 });
  assert.equal((await page.locator('#state').textContent()).trim(), 'EXITED');
  assert.equal(await page.locator('#output').textContent(), exeFixture.expected.stdout);
  assert.equal(await page.evaluate(() => window.__lastRun.exitCode), exeFixture.expected.exitCode);

  assert.deepEqual(failures, [], `Browser reported errors while testing ${baseURL.href}`);
  const report = {
    date: new Date().toISOString(),
    url: baseURL.href,
    browser: await browser.version(),
    capabilities,
    freshVisits: 3,
    serviceWorkerReload: true,
    fixtures: suiteRows,
    zipUpload: { fixture: zipFixture.name, downloadedFiles: fileNames, passed: true },
    exeUpload: {
      fixture: exeFixture.name,
      stdout: exeFixture.expected.stdout,
      exitCode: exeFixture.expected.exitCode,
      passed: true,
    },
    errors: failures,
  };
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/pages-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  await context.close();
} finally {
  await browser.close();
}
