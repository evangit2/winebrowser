import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pins = {
  'gnu-diff': 'f449ce40db50dd35c45c3dfa54bc79b6a3a4d9dc5ab0ff4d0fe91a4c9fefa310',
  optipng: '3464cd6c7fc9cb893f368111eb19b634b2acf14dcc94958d0758251071cfcbd9',
  '7zip': 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d',
};
let server, browser;
const checks = [],
  runs = [],
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
  browser = await chromium.launch(
    process.argv.includes('--ordinary')
      ? { channel: process.env.BROWSER_CHANNEL || 'chrome' }
      : webgpuBrowserOptions,
  );
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const response = await page.request.get(new URL('examples/manifest.json', url).href);
  assert.ok(response.ok());
  const manifest = await response.json();
  const packages = {};
  for (const name of Object.keys(pins)) {
    const example = manifest.interactive.find((e) => e.name === name);
    assert.ok(example, name);
    const zipResponse = await page.request.get(new URL('examples/' + example.zip, url).href);
    assert.ok(zipResponse.ok());
    const zip = await zipResponse.body();
    assert.equal(hash(zip), example.zipSha256);
    const files = unzipSync(zip);
    assert.equal(hash(files[example.entry]), pins[name]);
    assert.equal(example.exeSha256, pins[name]);
    const provenance = JSON.parse(new TextDecoder().decode(files['PROVENANCE.json']));
    assert.deepEqual(provenance.unresolvedImports, []);
    for (const entry of provenance.files) assert.equal(hash(files[entry.path]), entry.sha256);
    packages[name] = { example, zip, files };
  }
  checks.push(
    'Hosted ZIPs, unchanged upstream EXEs and every packaged DLL/input match independent SHA-256 pins',
  );
  async function load(name, mode = 'zip', extra = {}) {
    const pkg = packages[name];
    if (mode === 'hosted') await page.locator(`[data-demo="${name}"]`).click();
    else
      await page.locator('#file').setInputFiles(
        mode === 'zip'
          ? { name: name + '.zip', mimeType: 'application/zip', buffer: pkg.zip }
          : await Promise.all(
              Object.entries({ ...pkg.files, ...extra })
                .filter(
                  ([path]) => !/COPYING|LICENSE|AUTHORS|PROVENANCE|License|copying/i.test(path),
                )
                .map(async ([name, bytes]) => ({
                  name,
                  mimeType: 'application/octet-stream',
                  buffer: Buffer.from(bytes),
                })),
            ),
      );
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    assert.equal(
      await page.locator('#run').isEnabled(),
      true,
      await page.locator('#details').textContent(),
    );
    if (mode === 'hosted') {
      assert.equal(await page.locator('#exe').inputValue(), pkg.example.entry);
      assert.deepEqual(JSON.parse(await page.locator('#args').inputValue()), pkg.example.args);
    }
  }
  async function run(label, args, exitCode = 0, exe) {
    if (exe) await page.locator('#exe').selectOption(exe);
    if (args) await page.locator('#args').fill(JSON.stringify(args));
    await page.locator('#run').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 180000 },
    );
    const result = await page.evaluate(() => ({
      state: document.querySelector('#state').textContent,
      stdout: document.querySelector('#output').textContent,
      logs: document.querySelector('#logs').textContent,
      fault: window.__lastFaultDiagnostic,
      run: window.__lastRun && {
        ...window.__lastRun,
        outputs: window.__lastRun.outputs.map((e) => ({
          path: e.path,
          bytes: Array.from(e.bytes),
        })),
      },
    }));
    assert.equal(result.state, 'EXITED', JSON.stringify(result));
    assert.equal(result.run.exitCode, exitCode, result.stdout);
    const outputs = result.run.outputs.map((e) => ({ path: e.path, bytes: Buffer.from(e.bytes) }));
    runs.push({
      label,
      exitCode,
      instructions: result.run.instructions,
      compiledBlocks: result.run.totalCompiledBlocks,
      modules: result.run.modules,
      apiNames: result.run.apiNames,
      stdout: result.stdout,
      outputs: outputs.map((e) => ({ path: e.path, bytes: e.bytes.length, sha256: hash(e.bytes) })),
    });
    console.log(label, exitCode, result.run.instructions);
    return { ...result, outputs };
  }
  await load('gnu-diff', 'hosted');
  const patch = await run('GNU diff: hosted native DLL closure and unified patch', null, 1);
  assert.match(patch.stdout, /@@ -1,3 \+1,4 @@/);
  assert.match(patch.stdout, /-beta\r?\n\+BETA/);
  assert.match(patch.stdout, /\+delta/);
  for (const name of ['libintl3.dll', 'libiconv2.dll', 'msvcp60.dll', 'msvcrt.dll', 'ntdll.dll'])
    assert.ok(
      patch.run.modules.some((m) => m.name === name && !m.host),
      name,
    );
  await load('gnu-diff', 'loose');
  const different = await run(
    'GNU cmp: loose EXE plus two original companion DLLs',
    ['before.txt', 'after.txt'],
    1,
    'cmp.exe',
  );
  assert.match(different.stdout, /differ: (char|byte) 7, line 2/);
  await load('gnu-diff');
  assert.equal(
    (await run('GNU cmp: identical files', ['before.txt', 'before.txt'], 0, 'cmp.exe')).stdout,
    '',
  );
  await load('gnu-diff');
  const missing = await run(
    'GNU diff: missing file is an application error',
    ['missing.txt', 'after.txt'],
    2,
    'diff.exe',
  );
  assert.match(missing.stdout, /No such file|cannot find/i);
  checks.push(
    'GNU unified patch, identical/different byte comparisons and missing-file error; native companion DLLs and MSVCP60 execute',
  );
  async function pixelHash(bytes) {
    return page.evaluate(async (bytes) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
      );
      const c = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      bitmap.close();
      return { width: c.width, height: c.height, hash };
    }, Array.from(bytes));
  }
  await load('optipng', 'hosted');
  const optimized = await run('OptiPNG: native libpng/zlib lossless optimization');
  const image = optimized.outputs.find((e) => e.path === 'optimized.png');
  assert.ok(image);
  assert.ok(image.bytes.length < packages.optipng.files['input.png'].length / 10);
  assert.deepEqual(
    await pixelHash(image.bytes),
    await pixelHash(packages.optipng.files['input.png']),
  );
  await page.screenshot({
    path: process.env.WINEBROWSER_FOSS_SCREENSHOT || 'evidence/foss-tools-browser.png',
  });
  await load('optipng', 'loose', { 'bad.png': Buffer.from('broken PNG') });
  const invalid = await run('OptiPNG: malformed image fails cleanly', ['bad.png'], 1);
  assert.match(invalid.stdout, /Error|Unrecognized/i);
  assert.equal(invalid.outputs.length, 0);
  checks.push(
    'OptiPNG substantially reduces image size while an independent browser PNG decoder verifies every RGBA pixel; invalid images fail cleanly',
  );
  await load('7zip', 'hosted');
  const compressed = await run('7-Zip: native text and binary compression');
  assert.match(compressed.stdout, /Everything is Ok/);
  const archive = compressed.outputs.find((e) => e.path === 'out.7z');
  assert.ok(archive);
  assert.equal(archive.bytes.subarray(0, 6).toString('hex'), '377abcaf271c');
  await load('7zip', 'loose', { 'out.7z': archive.bytes });
  const integrity = await run('7-Zip: archive CRC/integrity test', ['t', 'out.7z']);
  assert.match(integrity.stdout, /Everything is Ok/);
  await load('7zip', 'loose', { 'out.7z': archive.bytes });
  const extracted = await run('7-Zip: native LZMA decompression and extraction', [
    'x',
    'out.7z',
    '-oextracted',
  ]);
  assert.match(extracted.stdout, /Everything is Ok/);
  for (const path of ['message.txt', 'binary.bin'])
    assert.deepEqual(
      extracted.outputs.find((e) => e.path === 'extracted/' + path)?.bytes,
      Buffer.from(packages['7zip'].files[path]),
    );
  const damaged = Buffer.from(archive.bytes);
  damaged[0] = 0;
  await load('7zip', 'loose', { 'bad.7z': damaged });
  const corrupt = await run('7-Zip: corrupt archive rejection', ['t', 'bad.7z'], 2);
  assert.match(corrupt.stdout, /ERROR|Can not open/i);
  checks.push(
    '7-Zip compression, CRC test and extraction preserve both files byte-for-byte; corrupted archive exits 2',
  );
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    ordinary: process.argv.includes('--ordinary'),
    scope:
      'Unchanged upstream FOSS PE32 releases through hosted example selection, ordinary ZIP upload and loose-file uploads. Functional checks cover real GNU/libintl/libiconv/MSVCP60 code, PNG losslessness, LZMA round trip, dependency closure and application-level errors.',
    checks,
    runs,
    errors,
  };
  await mkdir('evidence', { recursive: true });
  await writeFile(
    process.env.WINEBROWSER_FOSS_EVIDENCE || 'evidence/foss-tools-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({ checks, runs: runs.length, url }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
