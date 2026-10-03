import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createHash, createHmac, pbkdf2Sync, createCipheriv } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const password = 'BrowserTest42';
const runs = [],
  errors = [],
  checks = [];
let browser, server;

// Independent WinZip AES reader. The Windows DLL computes its own PBKDF2,
// encryption, authentication and deflate; Node validates all four independently.
function verifyAesZip(archive, expected) {
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50)
    end--;
  assert.ok(end >= 0);
  const count = archive.readUInt16LE(end + 10),
    files = [],
    encrypted = [];
  let at = archive.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    assert.equal(archive.readUInt16LE(at + 10), 99);
    const nameLength = archive.readUInt16LE(at + 28),
      extraLength = archive.readUInt16LE(at + 30);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const extra = archive.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    let aes;
    for (let offset = 0; offset + 4 <= extra.length;) {
      const size = extra.readUInt16LE(offset + 2);
      if (extra.readUInt16LE(offset) === 0x9901)
        aes = extra.subarray(offset + 4, offset + 4 + size);
      offset += 4 + size;
    }
    assert.ok(aes);
    assert.equal(aes.readUInt16LE(0), 2);
    assert.equal(aes.subarray(2, 4).toString(), 'AE');
    assert.equal(aes[4], 3); // AES-256
    const method = aes.readUInt16LE(5);
    assert.ok(method === 0 || method === 8); // stored or deflate, chosen by the original codec
    const local = archive.readUInt32LE(at + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const payload = archive.subarray(start, start + archive.readUInt32LE(at + 20));
    const salt = payload.subarray(0, 16),
      verifier = payload.subarray(16, 18);
    const ciphertext = payload.subarray(18, -10),
      authentication = payload.subarray(-10);
    const keys = pbkdf2Sync(password, salt, 1000, 66, 'sha1');
    assert.deepEqual(verifier, keys.subarray(64));
    assert.deepEqual(
      authentication,
      createHmac('sha1', keys.subarray(32, 64)).update(ciphertext).digest().subarray(0, 10),
    );
    const counters = Buffer.alloc(Math.ceil(ciphertext.length / 16) * 16);
    for (let block = 0; block < counters.length / 16; block++)
      counters.writeUInt32LE(block + 1, block * 16);
    const cipher = createCipheriv('aes-256-ecb', keys.subarray(0, 32), null);
    cipher.setAutoPadding(false);
    const stream = Buffer.concat([cipher.update(counters), cipher.final()]);
    const compressed = Buffer.from(ciphertext);
    for (let n = 0; n < compressed.length; n++) compressed[n] ^= stream[n];
    assert.deepEqual(method === 8 ? inflateRawSync(compressed) : compressed, expected[name], name);
    files.push(name);
    encrypted.push({ name, method, ciphertextOffset: start + 18, salt: salt.toString('hex') });
    at += 46 + nameLength + extraLength + archive.readUInt16LE(at + 32);
  }
  assert.deepEqual(files.sort(), Object.keys(expected).sort());
  assert.equal(new Set(encrypted.map((e) => e.salt)).size, count);
  assert.ok(encrypted.some((e) => e.method === 8));
  return encrypted;
}

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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const response = await page.request.get(new URL('examples/manifest.json', url).href);
  assert.ok(response.ok());
  const example = (await response.json()).interactive.find((e) => e.name === '7zip-full');
  assert.ok(example);
  const download = await page.request.get(new URL('examples/' + example.zip, url).href);
  assert.ok(download.ok());
  const zip = await download.body();
  assert.equal(hash(zip), example.zipSha256);
  const files = unzipSync(zip);
  assert.equal(
    hash(files['7z.exe']),
    'cd74719140d12a6c837a6f78257df326f79b1a6ffcd632e9a2048e278899b733',
  );
  assert.equal(
    hash(files['7z.dll']),
    'd132e89038c802c5d5281e543a83dc407680effe0144f21b4fb431dd45fca61d',
  );
  const provenance = JSON.parse(new TextDecoder().decode(files['PROVENANCE.json']));
  assert.deepEqual(provenance.unresolvedImports, []);
  assert.deepEqual(provenance.dynamicDependencies, ['7z.dll']);
  for (const entry of provenance.files) assert.equal(hash(files[entry.path]), entry.sha256);
  const expected = Object.fromEntries(
    ['message.txt', 'binary.bin'].map((name) => [name, Buffer.from(files[name])]),
  );
  checks.push(
    'Upstream EXE, original codec DLL, package files and full dynamic dependency audit match SHA-256 pins',
  );

  async function load(mode = 'loose', extra = {}) {
    if (mode === 'hosted') await page.locator('[data-demo="7zip-full"]').click();
    else if (mode === 'zip')
      await page.locator('#file').setInputFiles({
        name: '7zip-full.zip',
        mimeType: 'application/zip',
        buffer: Object.keys(extra).length ? Buffer.from(zipSync({ ...files, ...extra })) : zip,
      });
    else
      await page.locator('#file').setInputFiles(
        Object.entries({ ...files, ...extra })
          .filter(([name]) => !/License|readme|PROVENANCE/i.test(name))
          .map(([name, bytes]) => ({
            name,
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(bytes),
          })),
      );
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 120000 },
    );
    assert.equal(
      await page.locator('#run').isEnabled(),
      true,
      (await page.locator('#details').textContent()) + (await page.locator('#logs').textContent()),
    );
    if (mode === 'hosted') {
      assert.equal(await page.locator('#exe').inputValue(), '7z.exe');
      assert.deepEqual(JSON.parse(await page.locator('#args').inputValue()), example.args);
    }
  }
  async function run(label, args, code = 0) {
    if (args) await page.locator('#args').fill(JSON.stringify(args));
    const started = performance.now();
    await page.locator('#run').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 180000 },
    );
    const result = await page.evaluate(() => ({
      state: document.querySelector('#state').textContent,
      stdout: document.querySelector('#output').textContent,
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
    assert.equal(result.run.exitCode, code, result.stdout);
    for (const name of [
      '7z.exe',
      '7z.dll',
      'msvcrt.dll',
      'kernel32.dll',
      'kernelbase.dll',
      'ntdll.dll',
    ])
      assert.ok(
        result.run.loadedModules.some((m) => m.name === name && !m.host),
        name,
      );
    assert.equal(result.run.loadedModulesTruncated, false);
    const outputs = result.run.outputs.map((e) => ({ path: e.path, bytes: Buffer.from(e.bytes) }));
    runs.push({
      label,
      exitCode: code,
      elapsedMs: performance.now() - started,
      x86TranslationMs: result.run.x86TranslationMs,
      instructions: result.run.instructions,
      compiledBlocks: result.run.totalCompiledBlocks,
      modules: result.run.modules,
      loadedModules: result.run.loadedModules,
      apiNames: result.run.apiNames,
      stdout: result.stdout,
      outputs: outputs.map((e) => ({ path: e.path, bytes: e.bytes.length, sha256: hash(e.bytes) })),
    });
    console.log(label, code, result.run.instructions);
    return { ...result, outputs };
  }
  const exact = (result, prefix) => {
    for (const [name, bytes] of Object.entries(expected))
      assert.deepEqual(result.outputs.find((e) => e.path === prefix + name)?.bytes, bytes, name);
  };
  await load('hosted');
  const plain = await run('Full 7-Zip: hosted EXE and native DLL create a deflate ZIP');
  const plainZip = plain.outputs.find((e) => e.path === 'out.zip').bytes;
  const decoded = unzipSync(plainZip);
  assert.deepEqual(Object.keys(decoded).sort(), Object.keys(expected).sort());
  for (const [name, bytes] of Object.entries(expected))
    assert.deepEqual(Buffer.from(decoded[name]), bytes);
  await load('zip', { 'out.zip': plainZip });
  exact(await run('Full 7-Zip: native ZIP extraction', ['x', 'out.zip', '-ozip-out']), 'zip-out/');
  checks.push(
    'Plain ZIP output independently decodes with fflate; native extraction preserves every byte of both files',
  );

  await load('zip');
  const lzma = await run('Full 7-Zip: native LZMA2 compression', [
    'a',
    'out.7z',
    'message.txt',
    'binary.bin',
    '-mmt=2',
  ]);
  for (const name of [
    'NtCreateThreadEx',
    'NtResumeThread',
    'NtCreateSemaphore',
    'NtReleaseSemaphore',
    'NtWaitForSingleObject',
    'NtTerminateThread',
  ])
    assert.ok(lzma.run.apiNames.includes('ntdll.dll!' + name), name);
  const archive = lzma.outputs.find((e) => e.path === 'out.7z').bytes;
  assert.equal(archive.subarray(0, 6).toString('hex'), '377abcaf271c');
  await load('loose', { 'out.7z': archive });
  await run('Full 7-Zip: native 7z CRC/integrity test', ['t', 'out.7z']);
  await load('loose', { 'out.7z': archive });
  exact(
    await run('Full 7-Zip: native LZMA2 extraction', ['x', 'out.7z', '-olzma-out']),
    'lzma-out/',
  );
  checks.push(
    'Native LZMA2 compression exercises threads, semaphores and waits; CRC/integrity test and extraction preserve both input files',
  );

  await load();
  const encrypted = await run('Full 7-Zip: native AES-256 ZIP encryption', [
    'a',
    'encrypted.zip',
    'message.txt',
    'binary.bin',
    '-tzip',
    `-p${password}`,
    '-mem=AES256',
    '-mmt=1',
  ]);
  const aesZip = encrypted.outputs.find((e) => e.path === 'encrypted.zip').bytes;
  const aesEntries = verifyAesZip(aesZip, expected);
  await page.screenshot({
    path: process.env.WINEBROWSER_7ZIP_FULL_SCREENSHOT || 'evidence/7zip-full-browser.png',
  });
  await load('zip', { 'encrypted.zip': aesZip });
  await run('Full 7-Zip: encrypted ZIP integrity', ['t', 'encrypted.zip', `-p${password}`]);
  await load('zip', { 'encrypted.zip': aesZip });
  exact(
    await run('Full 7-Zip: native AES-256 ZIP decryption', [
      'x',
      'encrypted.zip',
      `-p${password}`,
      '-oaes-out',
    ]),
    'aes-out/',
  );
  checks.push(
    'Independent Node PBKDF2, AES-256 CTR, HMAC-SHA1 and deflate validate the original DLL encryption; native decryption restores both files exactly',
  );
  await load('zip', { 'encrypted.zip': aesZip });
  const wrong = await run(
    'Full 7-Zip: wrong password fails cleanly',
    ['t', 'encrypted.zip', '-pWrongPassword'],
    2,
  );
  assert.match(wrong.stdout, /Wrong password|Data Error/i);
  const damaged = Buffer.from(aesZip);
  damaged[aesEntries[0].ciphertextOffset] ^= 1;
  await load('zip', { 'damaged.zip': damaged });
  const corrupt = await run(
    'Full 7-Zip: damaged encrypted data fails authentication',
    ['t', 'damaged.zip', `-p${password}`],
    2,
  );
  assert.match(corrupt.stdout, /Data Error|CRC Failed|ERROR/i);
  checks.push(
    'Wrong passwords and modified encrypted payloads exit with the real application error code 2',
  );
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    scope:
      'Unchanged upstream PE32 7z.exe and 7z.dll with automatic native Wine dependencies, through hosted selection, ZIP upload and loose EXE/DLL/input uploads. This covers the recorded formats and operations, not all codec DLL functions or the 7-Zip GUI.',
    checks,
    runs,
    errors,
  };
  await writeFile(
    process.env.WINEBROWSER_7ZIP_FULL_EVIDENCE || 'evidence/7zip-full-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify({ checks, runs: runs.length, url }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
