import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
let browser;
try {
  await server.listen();
  const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const executable = await readFile('tests/fixtures/hlsl/hlsl.exe');
  const shader = await readFile('tests/fixtures/shaders/microsoft-hello-triangle/shaders.hlsl');
  const pin = JSON.parse(
    await readFile('runtime/target-builds/microsoft-hello-triangle.json', 'utf8'),
  );
  assert.equal(createHash('sha256').update(shader).digest('hex'), pin.files['shaders.hlsl']);
  const archive = zipSync({ 'app/hlsl.exe': executable, 'app/shaders.hlsl': shader }),
    results = [];
  for (const [name, mimeType, buffer] of [
    ['hlsl.exe', 'application/octet-stream', executable],
    ['hlsl.zip', 'application/zip', Buffer.from(archive)],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#file').setInputFiles(
      name.endsWith('.zip')
        ? { name, mimeType, buffer }
        : [
            { name, mimeType, buffer },
            { name: 'shaders.hlsl', mimeType: 'text/plain', buffer: shader },
          ],
    );
    await page.locator('#run').click();
    await page.waitForFunction(() => window.__lastRun !== null);
    const run = await page.evaluate(() => window.__lastRun),
      output = await page.locator('#output').textContent();
    assert.equal(run.exitCode, 0, JSON.stringify({ run, output }));
    assert.deepEqual(errors, []);
    assert.match(output, /hlsl-ok/);
    for (const api of [
      'd3dcompiler_47.dll!D3DCompile',
      'd3dcompiler_47.dll!D3DCompileFromFile',
      'ID3DBlob.GetBufferPointer',
      'ID3DBlob.GetBufferSize',
    ])
      assert.ok(run.apiTrace.includes(api), api);
    results.push({
      name,
      exitCode: run.exitCode,
      output,
      instructions: run.instructions,
      compiledBlocks: run.compiledBlocks,
      errors,
    });
    await page.close();
  }
  const report = {
    date: new Date().toISOString(),
    status: 'passed',
    browser: browser.version(),
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    scope:
      'Native PE32 EXE plus original Microsoft HLSL / nested ZIP: browser HLSL compilation, DXBC blobs, independent lifetimes, syntax errors, missing file and unsupported profile, followed by successful recovery.',
    results,
  };
  await writeFile(
    'evidence/hlsl-native-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
