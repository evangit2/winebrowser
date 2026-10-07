import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const reference = JSON.parse(await readFile('tests/fixtures/lame/native-reference.json'));
const manifest = JSON.parse(await readFile('public/examples/manifest.json'));
const fixture = manifest.interactive.find((f) => f.name === 'lame');
let server, browser;
try {
  let url = process.env.WINEBROWSER_TEST_URL;
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage(),
    errors = [],
    runs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
    null,
    { timeout: 60000 },
  );
  const asset = async (path, expected) => {
    const response = await page.request.get(new URL('examples/' + path, url).href);
    assert.equal(response.status(), 200, path);
    const bytes = await response.body();
    assert.equal(sha(bytes), expected, path);
    return bytes;
  };
  const exe = await asset(fixture.exe, fixture.exeSha256),
    zip = await asset(fixture.zip, fixture.zipSha256);
  // Source and licence materials must ship with the deployed executable.
  await asset(fixture.sourceZip, fixture.sourceZipSha256);
  await mkdir('.scratch/lame-downloads', { recursive: true });
  for (const [i, row] of reference.cases.entries()) {
    const mode = ['hosted-example', 'zip-upload', 'loose-files-upload'][i];
    assert.equal(sha(exe), row.exeSha256);
    const input = await asset('lame/' + row.input, row.inputSha256);
    if (i === 0) await page.locator('[data-demo="lame"]').click();
    else if (i === 1)
      await page
        .locator('#file')
        .setInputFiles({ name: 'lame.zip', mimeType: 'application/zip', buffer: zip });
    else
      await page.locator('#file').setInputFiles([
        { name: 'lame.exe', mimeType: 'application/octet-stream', buffer: exe },
        { name: row.input, mimeType: 'audio/wav', buffer: input },
      ]);
    await page.waitForFunction(
      () => ['LOADED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 60000 },
    );
    assert.ok(await page.locator('#run').isEnabled(), await page.locator('#details').textContent());
    assert.doesNotMatch(
      await page.locator('#details').textContent(),
      /Missing APIs|Unsupported import/,
    );
    if (i === 0) assert.deepEqual(JSON.parse(await page.locator('#args').inputValue()), row.args);
    else await page.locator('#args').fill(JSON.stringify(row.args));
    await page.locator('#run').click();
    await page.waitForFunction(
      () => ['EXITED', 'ERROR'].includes(document.querySelector('#state')?.textContent),
      null,
      { timeout: 240000 },
    );
    const result = await page.evaluate(() => ({
      run: window.__lastRun
        ? {
            ...window.__lastRun,
            outputs: window.__lastRun.outputs.map((f) => ({ ...f, bytes: Array.from(f.bytes) })),
          }
        : null,
      logs: document.querySelector('#logs').textContent,
      output: document.querySelector('#output').textContent,
      downloads: [...document.querySelectorAll('#outputs a')].map((a) => a.download),
    }));
    assert.equal(
      result.run?.exitCode,
      0,
      JSON.stringify({ ...result, run: result.run && { ...result.run, outputs: undefined } }),
    );
    assert.deepEqual(result.downloads, ['output.mp3']);
    assert.equal(result.run.outputs.length, 1);
    const actual = Buffer.from(result.run.outputs[0].bytes),
      expected = await readFile(row.outputPath);
    assert.equal(sha(expected), row.outputSha256, 'retained native reference hash');
    assert.ok(actual.equals(expected), row.name + ' must exactly match native Wine output');
    for (const name of ['ucrtbase.dll', 'kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
      assert.ok(
        result.run.modules.some((m) => m.name === name && !m.host && m.path === '@runtime/' + name),
        name,
      );
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#outputs a').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'output.mp3');
    const downloadPath = '.scratch/lame-downloads/' + row.name + '.mp3';
    await download.saveAs(downloadPath);
    assert.ok((await readFile(downloadPath)).equals(expected), 'downloaded MP3 matches');
    const decoded = await page.evaluate(async (bytes) => {
      const context = new AudioContext();
      try {
        const buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer);
        let peak = 0;
        for (let c = 0; c < buffer.numberOfChannels; c++)
          for (const value of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(value));
        return {
          channels: buffer.numberOfChannels,
          sampleRate: buffer.sampleRate,
          duration: buffer.duration,
          frames: buffer.length,
          peak,
        };
      } finally {
        await context.close();
      }
    }, Array.from(actual));
    assert.equal(decoded.channels, row.decoded.channels);
    assert.ok(decoded.duration >= 0.09 && decoded.duration <= 0.3);
    assert.ok(decoded.peak > 0.1 && decoded.peak < 1, 'real non-silent decoded audio');
    const { outputs, ...metrics } = result.run;
    runs.push({
      name: row.name,
      mode,
      args: row.args,
      inputSha256: row.inputSha256,
      outputBytes: actual.length,
      outputSha256: sha(actual),
      byteMatchesNativeWine: true,
      downloaded: true,
      decoded,
      ...metrics,
    });
    console.log(
      `${row.name}: ${actual.length} bytes match native Wine; ${metrics.elapsedMs.toFixed(1)} ms`,
    );
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    browser: browser.version(),
    exeSha256: fixture.exeSha256,
    upstreamSourceSha256: 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e',
    status: 'passed',
    scope:
      'Original source-built LAME 3.100 Windows i386 SSE2/UCRT WAV/PCM encoder. Hosted catalog, ZIP and loose uploads produce MP3 files byte-identical to native Wine, download correctly and decode as non-silent browser audio. Optional MP3 decoder and libsndfile are not built. These cases do not establish arbitrary Windows executable compatibility.',
    runs,
    errors,
  };
  await writeFile(
    process.env.LAME_EVIDENCE || 'evidence/lame-browser-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
} finally {
  await browser?.close();
  await server?.close();
}
