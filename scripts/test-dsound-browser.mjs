import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
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
  const executable = await readFile('tests/fixtures/dsound/dsound.exe');
  const archive = zipSync({
    'app/dsound.exe': executable,
    'app/data/readme.txt': strToU8('DirectSound PCM buffers'),
  });
  const results = [];
  for (const [name, mimeType, buffer, stop] of [
    ['dsound.exe', 'application/octet-stream', executable, false],
    ['dsound.zip', 'application/zip', Buffer.from(archive), false],
    ['dsound.exe', 'application/octet-stream', executable, true],
  ]) {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const stats = (window.__audioProbe = { chunks: [], active: 0, stopped: 0 });
      const create = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function (...args) {
        const source = create.apply(this, args),
          start = source.start.bind(source),
          stop = source.stop.bind(source),
          context = this;
        let active = false;
        const ended = () => {
          if (active) {
            active = false;
            stats.active--;
          }
        };
        source.addEventListener('ended', ended);
        source.start = (...params) => {
          const peaks = [],
            rms = [];
          for (let c = 0; c < source.buffer.numberOfChannels; c++) {
            let peak = 0,
              square = 0;
            for (const v of source.buffer.getChannelData(c)) {
              peak = Math.max(peak, Math.abs(v));
              square += v * v;
            }
            peaks.push(peak);
            rms.push(Math.sqrt(square / source.buffer.length));
          }
          stats.chunks.push({
            peaks,
            rms,
            frames: source.buffer.length,
            rate: source.buffer.sampleRate,
            now: context.currentTime,
            start: params[0] ?? context.currentTime,
            state: context.state,
            phase: document.getElementById('output').textContent.trim().split('\n').at(-1),
          });
          const result = start(...params);
          active = true;
          stats.active++;
          return result;
        };
        source.stop = (...params) => {
          stats.stopped++;
          ended();
          return stop(...params);
        };
        return source;
      };
    });
    await page.goto(url);
    await page.locator('#audio-enabled').check();
    await page.locator('#file').setInputFiles({ name, mimeType, buffer });
    await page.locator('#run').click();
    let result;
    if (stop) {
      await page.waitForFunction(() => window.__audioProbe.chunks.length >= 3);
      await page.locator('#stop').click();
      assert.equal(await page.locator('#state').textContent(), 'STOPPED');
    } else {
      await page.waitForFunction(() => window.__lastRun !== null, { timeout: 30000 });
      result = await page.evaluate(() => window.__lastRun);
      assert.equal(result.exitCode, 0, JSON.stringify(result));
    }
    await page.waitForFunction(() => window.__audioProbe.active === 0);
    const audio = await page.evaluate(() => window.__audioProbe);
    assert.ok(audio.chunks.length >= 3, JSON.stringify(audio));
    assert.ok(audio.stopped > 0, 'Stop/exit explicitly cancels queued audio');
    assert.ok(
      audio.chunks.every((c) => c.state === 'running' && c.frames === 1024 && c.rate === 44100),
    );
    assert.ok(audio.chunks.some((c) => c.peaks.every((p) => p > 0.49 && p <= 0.5)));
    assert.ok(
      audio.chunks.every((c) => c.start - c.now < 0.2),
      'bounded Web Audio queue',
    );
    if (!stop) {
      assert.ok(
        audio.chunks.some(
          (c) =>
            c.phase === 'quiet-right' && c.peaks[0] === 0 && Math.abs(c.peaks[1] - 0.05) < 1e-6,
        ),
        JSON.stringify(audio),
      );
      for (const phase of ['one-shot', 'duplicate-loop-exit'])
        assert.ok(audio.chunks.some((c) => c.phase === phase && c.peaks[0] > 0.49));
      assert.ok(audio.chunks.at(-1).now > audio.chunks[0].now + 0.8);
    }
    assert.deepEqual(errors, []);
    results.push({
      name,
      stoppedByUser: stop,
      exitCode: result?.exitCode,
      instructions: result?.instructions,
      compiledBlocks: result?.compiledBlocks,
      chunks: audio.chunks.length,
      stoppedSources: audio.stopped,
      maxQueueSeconds: Math.max(...audio.chunks.map((c) => c.start - c.now)),
      phases: [...new Set(audio.chunks.map((c) => c.phase))],
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
      'Ordinary native PE32 EXE/ZIP upload. Ordinal exports, enumeration callback, COM identity, primary format, wrapping locks, shared duplicates, timed cursors, looping/one-shot playback, volume/pan/frequency. Real running Web Audio sources contain the expected PCM; process exit and Stop cancel playback. No pretranslated guest module.',
    results,
  };
  await writeFile('evidence/dsound-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
