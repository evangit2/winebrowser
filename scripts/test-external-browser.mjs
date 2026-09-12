import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const port = 4183;
const origin = `http://127.0.0.1:${port}`;
const targetPath = '.cache/targets/winapiexec.exe';
const tinyGuiPath = '.cache/targets/pts-hh4t.exe';
const pcmPackageName = 'winapiexec-pcm.zip';
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { stdio: 'pipe' },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => (serverOutput += chunk.toString()));
server.stderr.on('data', (chunk) => (serverOutput += chunk.toString()));
let browser;
const browserErrors = [];
const outboundRequests = [];
const report = {
  date: new Date().toISOString(),
  target: { id: 'winapiexec-1.2-x86', path: targetPath },
  binaries: {},
  cases: [],
  optionalCases: [],
  errors: [],
};

function makePcmWave() {
  const sampleRate = 8000;
  const sampleCount = 80;
  const dataBytes = sampleCount * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const writeTag = (offset, value) => {
    for (let index = 0; index < value.length; index++)
      wav[offset + index] = value.charCodeAt(index);
  };
  writeTag(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  writeTag(8, 'WAVE');
  writeTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, 'data');
  view.setUint32(40, dataBytes, true);
  const samples = [];
  for (let index = 0; index < sampleCount; index++) {
    const sample = index % 2 === 0 ? 8192 : -8192;
    view.setInt16(44 + index * 2, sample, true);
    samples.push(sample / 32768);
  }
  return { bytes: wav, sampleRate, sampleCount, samples };
}

function expectedGdiCanvas() {
  const width = 640;
  const height = 480;
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 3; offset < pixels.length; offset += 4) pixels[offset] = 255;
  for (let y = 20; y < 60; y++) {
    for (let x = 10; x < 40; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 0x11;
      pixels[offset + 1] = 0x22;
      pixels[offset + 2] = 0x33;
    }
  }
  const pixelOffset = (22 * width + 12) * 4;
  pixels[pixelOffset] = 0xab;
  pixels[pixelOffset + 1] = 0xcd;
  pixels[pixelOffset + 2] = 0xef;
  return { width, height, pixels };
}

try {
  const targets = JSON.parse(await readFile('tests/targets.json', 'utf8'));
  const target = targets.targets.find((item) => item.path === targetPath);
  if (!target) throw Error(`Verified target hash is missing for ${targetPath}`);
  const exeBytes = await readFile(targetPath);
  const exeSha256 = createHash('sha256').update(exeBytes).digest('hex');
  report.target.bytes = exeBytes.length;
  report.target.expectedSha256 = target.sha256;
  report.target.actualSha256 = exeSha256;
  if (exeSha256 !== target.sha256)
    throw Error('Raw executable SHA-256 differs from tests/targets.json');
  report.binaries.winapiexec = report.target;

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw Error(`Vite preview did not start on port ${port}: ${serverOutput}`);

  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(`${origin}/`) && !request.url().startsWith('blob:'))
      outboundRequests.push(request.url());
  });
  await page.goto(origin);
  if (!(await page.evaluate(() => crossOriginIsolated)))
    throw Error('Missing cross-origin isolation');
  await page.evaluate(() => {
    window.__toneTrace = [];
    window.__bufferSourceTrace = [];
    let activeTrace;
    const originalCreateOscillator = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const oscillator = originalCreateOscillator.call(this);
      const trace = { frequency: null, gain: null, start: null, stop: null };
      activeTrace = trace;
      const originalStart = oscillator.start.bind(oscillator);
      const originalStop = oscillator.stop.bind(oscillator);
      oscillator.start = (when) => {
        trace.start = when ?? this.currentTime;
        return originalStart(when);
      };
      oscillator.stop = (when) => {
        trace.stop = when ?? this.currentTime;
        trace.frequency = oscillator.frequency.value;
        trace.gain = trace.gainNode?.gain.value ?? 0;
        trace.durationMs = Math.round((trace.stop - trace.start) * 1000);
        window.__toneTrace.push({
          frequency: trace.frequency,
          gain: trace.gain,
          start: trace.start,
          stop: trace.stop,
          durationMs: trace.durationMs,
        });
        return originalStop(when);
      };
      return oscillator;
    };
    const originalCreateGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      const gain = originalCreateGain.call(this);
      if (activeTrace) activeTrace.gainNode = gain;
      return gain;
    };
    const originalCreateBufferSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = originalCreateBufferSource.call(this);
      const trace = { created: true, started: false, ended: false };
      window.__bufferSourceTrace.push(trace);
      source.addEventListener(
        'ended',
        () => {
          trace.ended = true;
          trace.endedAt = performance.now();
        },
        { once: true },
      );
      const originalStart = source.start.bind(source);
      source.start = (...args) => {
        trace.started = true;
        trace.startedAt = performance.now();
        if (source.buffer) {
          trace.numberOfChannels = source.buffer.numberOfChannels;
          trace.sampleRate = source.buffer.sampleRate;
          trace.length = source.buffer.length;
          trace.samples = Array.from(source.buffer.getChannelData(0));
        }
        return originalStart(...args);
      };
      return source;
    };
  });

  await page.locator('#file').setInputFiles(targetPath);
  await page.waitForFunction(
    () => !document.getElementById('run').disabled,
    {},
    { timeout: 20000 },
  );
  const selectedExecutable = await page.locator('#exe').inputValue();
  const common = await page.evaluate(() => ({
    selectedExecutable: document.getElementById('exe').value,
    platform: document.getElementById('platform').textContent,
  }));
  report.selectedExecutable = selectedExecutable;
  report.crossOriginIsolated = await page.evaluate(() => crossOriginIsolated);
  report.browser = await browser.version();
  report.externalRequests = outboundRequests;
  report.cases.push({
    id: 'upload',
    binary: report.target.id,
    ...common,
    passed: true,
  });

  async function runCase(id, args, options = {}) {
    await page.locator('#args').fill(JSON.stringify(args));
    await page.locator('#run').click();
    let dialog = null;
    if (options.dialog) {
      await page.waitForSelector('#messagebox[open]', { timeout: 15000 });
      dialog = await page.evaluate(() => ({
        title: document.getElementById('dialog-title').textContent,
        text: document.getElementById('dialog-text').textContent,
      }));
      if (dialog.title !== options.dialog.title || dialog.text !== options.dialog.text)
        throw Error(`${id}: unexpected dialog ${JSON.stringify(dialog)}`);
      await page.locator('#dialog-ok').click();
    }
    await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
    const actual = await page.evaluate(() => {
      const result = window.__lastRun;
      return {
        exitCode: result.exitCode,
        stdout: document.getElementById('output').textContent,
        outputs: result.outputs.map((output) => ({
          path: output.path,
          bytes: Array.from(output.bytes),
          text: new TextDecoder().decode(output.bytes),
        })),
        modules: result.modules ?? [],
        metrics: document.getElementById('metrics').textContent,
        logs: document.getElementById('logs').textContent,
      };
    });
    const checks = [];
    checks.push({ name: 'exit code 1', passed: actual.exitCode === 1 });
    if (options.stdout !== undefined)
      checks.push({ name: 'exact stdout', passed: actual.stdout === options.stdout });
    if (options.output) {
      const file = actual.outputs.find((output) => output.path.endsWith(options.output.path));
      checks.push({ name: 'generated file bytes', passed: file?.text === options.output.text });
    }
    if (options.dialog)
      checks.push({
        name: 'dialog title and text',
        passed: dialog.title === options.dialog.title && dialog.text === options.dialog.text,
      });
    if (options.tone) {
      const tones = await page.evaluate(() => window.__toneTrace);
      const tone = tones.at(-1);
      checks.push({
        name: 'real WebAudio frequency, duration and gain',
        passed:
          tone?.frequency === options.tone.frequency &&
          Math.abs(tone.durationMs - options.tone.durationMs) <= 1 &&
          tone.gain > 0,
      });
      actual.tone = tone;
    }
    const failed = checks.filter((check) => !check.passed);
    report.cases.push({
      id,
      binary: report.target.id,
      args,
      ...actual,
      dialog,
      checks,
      passed: failed.length === 0,
    });
    if (failed.length) throw Error(`${id}: ${failed.map((check) => check.name).join(', ')} failed`);
    return actual;
  }

  await runCase(
    'console-write',
    ['GetStdHandle', '-11', ',', 'WriteFile', '$$:1', '$s:winebrowser stdout', '18', '$b:4', '0'],
    { stdout: 'winebrowser stdout' },
  );
  await runCase(
    'filesystem-create-write-close',
    [
      'CreateFileW',
      'winebrowser-target.txt',
      '0x40000000',
      '0',
      '0',
      '2',
      '0x80',
      '0',
      ',',
      'WriteFile',
      '$$:1',
      '$s:hello',
      '5',
      '$b:4',
      '0',
      ',',
      'CloseHandle',
      '$$:1',
    ],
    { output: { path: 'winebrowser-target.txt', text: 'hello' } },
  );
  await runCase(
    'user32-messagebox',
    ['user32@MessageBoxW', '0', 'Wine guest parser: "quoted" text', 'External target', '0'],
    { dialog: { title: 'External target', text: 'Wine guest parser: "quoted" text' } },
  );
  await runCase('kernel32-beep', ['kernel32@Beep', '440', '20'], {
    tone: { frequency: 440, durationMs: 20 },
  });

  const moduleAssertion = await page.evaluate(() => {
    const module = window.__lastRun.modules.find((item) => item.name === 'shell32.dll');
    return module
      ? {
          name: module.name,
          host: module.host,
          base: module.base,
          preferredBase: module.preferredBase,
        }
      : null;
  });
  report.shell32 = moduleAssertion;
  if (
    !moduleAssertion ||
    moduleAssertion.host ||
    moduleAssertion.base === moduleAssertion.preferredBase
  )
    throw Error(
      `shell32.dll was not loaded as a relocated guest module: ${JSON.stringify(moduleAssertion)}`,
    );

  const tinyGuiTarget = targets.targets.find((item) => item.path === tinyGuiPath);
  if (!tinyGuiTarget) throw Error(`Verified target hash is missing for ${tinyGuiPath}`);
  const tinyGuiBytes = await readFile(tinyGuiPath);
  const tinyGuiSha256 = createHash('sha256').update(tinyGuiBytes).digest('hex');
  report.binaries.ptsTinyGui = {
    id: tinyGuiTarget.id,
    path: tinyGuiPath,
    bytes: tinyGuiBytes.length,
    expectedSha256: tinyGuiTarget.sha256,
    actualSha256: tinyGuiSha256,
  };
  if (tinyGuiSha256 !== tinyGuiTarget.sha256)
    throw Error('Raw tiny GUI executable SHA-256 differs from tests/targets.json');

  await page.locator('#file').setInputFiles(tinyGuiPath);
  await page.waitForFunction(
    () => !document.getElementById('run').disabled,
    {},
    { timeout: 20000 },
  );
  const tinySelected = await page.locator('#exe').inputValue();
  if (tinySelected !== 'pts-hh4t.exe')
    throw Error(`Unexpected tiny GUI executable selection: ${tinySelected}`);
  await page.locator('#args').fill('[]');
  await page.locator('#run').click();
  await page.waitForSelector('#messagebox[open]', { timeout: 15000 });
  const tinyDialog = await page.evaluate(() => ({
    title: document.getElementById('dialog-title').textContent,
    text: document.getElementById('dialog-text').textContent,
  }));
  if (tinyDialog.title !== 'World!' || tinyDialog.text !== 'Hello,\nWorld!')
    throw Error(`Unexpected tiny GUI dialog: ${JSON.stringify(tinyDialog)}`);
  await page.locator('#dialog-ok').click();
  await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
  const tinyResult = await page.evaluate(() => ({
    exitCode: window.__lastRun.exitCode,
    apiTrace: window.__lastRun.apiTrace,
    modules: window.__lastRun.modules,
    stdout: document.getElementById('output').textContent,
    metrics: document.getElementById('metrics').textContent,
  }));
  const expectedTinyTrace = ['LoadLibraryA', 'GetProcAddress', 'MessageBoxA', 'ExitProcess'];
  let traceIndex = 0;
  const traceOrder = expectedTinyTrace.every((api) => {
    const found = tinyResult.apiTrace.findIndex(
      (entry, index) => index >= traceIndex && entry.endsWith(`!${api}`),
    );
    if (found < 0) return false;
    traceIndex = found + 1;
    return true;
  });
  const tinyChecks = [
    { name: 'exit code 0', passed: tinyResult.exitCode === 0 },
    {
      name: 'dialog title and text',
      passed: tinyDialog.title === 'World!' && tinyDialog.text === 'Hello,\nWorld!',
    },
    { name: 'LoadLibraryA/GetProcAddress/MessageBoxA/ExitProcess trace', passed: traceOrder },
  ];
  report.cases.push({
    id: 'pts-tinype-hh4t-gui',
    binary: tinyGuiTarget.id,
    selectedExecutable: tinySelected,
    dialog: tinyDialog,
    ...tinyResult,
    expectedTrace: expectedTinyTrace,
    checks: tinyChecks,
    passed: tinyChecks.every((check) => check.passed),
  });
  if (tinyChecks.some((check) => !check.passed))
    throw Error(
      `pts-hh4t.exe failed: ${tinyChecks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(', ')}`,
    );

  const pcm = makePcmWave();
  const pcmZip = zipSync(
    {
      'winapiexec.exe': new Uint8Array(exeBytes),
      'tone.wav': pcm.bytes,
    },
    { level: 0 },
  );
  const pcmZipSha256 = createHash('sha256').update(pcmZip).digest('hex');
  const pcmBinaryLabel = 'winapiexec-1.2-x86+generated-pcm-test-data';
  report.binaries.winapiexecPcmPackage = {
    id: pcmBinaryLabel,
    archive: pcmPackageName,
    archiveSha256: pcmZipSha256,
    executableId: target.id,
    executablePath: targetPath,
    executableSha256: exeSha256,
    audio: {
      path: 'tone.wav',
      format: 'PCM WAV',
      channels: 1,
      sampleRate: pcm.sampleRate,
      bitsPerSample: 16,
      frames: pcm.sampleCount,
      sourceSamples: pcm.samples,
    },
  };
  await page.locator('#file').setInputFiles({
    name: pcmPackageName,
    mimeType: 'application/zip',
    buffer: Buffer.from(pcmZip),
  });
  await page.waitForFunction(
    () => !document.getElementById('run').disabled,
    {},
    { timeout: 20000 },
  );
  const pcmExecutable = await page.locator('#exe').inputValue();
  if (pcmExecutable !== 'winapiexec.exe')
    throw Error(`Unexpected PCM package executable selection: ${pcmExecutable}`);
  const pcmArgs = ['winmm.dll@PlaySoundW', 'tone.wav', '0', '0x20002'];
  await page.locator('#args').fill(JSON.stringify(pcmArgs));
  await page.locator('#run').click();
  await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
  const pcmResult = await page.evaluate(() => ({
    exitCode: window.__lastRun.exitCode,
    apiTrace: window.__lastRun.apiTrace,
    modules: window.__lastRun.modules,
    stdout: document.getElementById('output').textContent,
    metrics: document.getElementById('metrics').textContent,
    completedAt: performance.now(),
    bufferSources: window.__bufferSourceTrace,
  }));
  const playSoundTrace = pcmResult.apiTrace.includes('winmm.dll!PlaySoundW');
  const audioSource = pcmResult.bufferSources.at(-1);
  const samplesMatch =
    audioSource?.samples?.length === pcm.samples.length &&
    audioSource.samples.every((sample, index) => sample === pcm.samples[index]);
  const pcmChecks = [
    { name: 'exit code 1', passed: pcmResult.exitCode === 1 },
    { name: 'winmm.dll!PlaySoundW API trace', passed: playSoundTrace },
    {
      name: 'one real AudioBufferSource started and ended before exit',
      passed:
        pcmResult.bufferSources.length === 1 &&
        audioSource.created &&
        audioSource.started &&
        audioSource.ended &&
        audioSource.endedAt <= pcmResult.completedAt,
    },
    {
      name: 'decoded mono PCM shape',
      passed:
        audioSource?.numberOfChannels === 1 &&
        audioSource.sampleRate === pcm.sampleRate &&
        audioSource.length === pcm.sampleCount,
    },
    { name: 'exact decoded PCM samples', passed: samplesMatch },
  ];
  report.cases.push({
    id: 'winmm-playsoundw-pcm',
    binary: pcmBinaryLabel,
    args: pcmArgs,
    executableSha256: exeSha256,
    generatedArchiveSha256: pcmZipSha256,
    audioFixture: report.binaries.winapiexecPcmPackage.audio,
    decodedAudioSource: audioSource,
    ...pcmResult,
    checks: pcmChecks,
    passed: pcmChecks.every((check) => check.passed),
  });
  if (pcmChecks.some((check) => !check.passed))
    throw Error(
      `WinMM PCM playback failed: ${pcmChecks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(', ')}`,
    );

  if ((await page.locator('#exe').inputValue()) !== 'winapiexec.exe')
    throw Error('GDI case must run with the already loaded winapiexec.exe');
  const gdiArgs = [
    'user32@GetDC',
    '0',
    ',',
    'gdi32@CreateSolidBrush',
    '0x00332211',
    ',',
    'gdi32@SelectObject',
    '$$:1',
    '$$:4',
    ',',
    'gdi32@PatBlt',
    '$$:1',
    '10',
    '20',
    '30',
    '40',
    '0xf00021',
    ',',
    'gdi32@SetPixel',
    '$$:1',
    '12',
    '22',
    '0x00efcdab',
    ',',
    'user32@ReleaseDC',
    '0',
    '$$:1',
  ];
  const expectedCanvas = expectedGdiCanvas();
  const expectedCanvasSha256 = createHash('sha256').update(expectedCanvas.pixels).digest('hex');
  await page.locator('#args').fill(JSON.stringify(gdiArgs));
  await page.locator('#run').click();
  await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
  const gdiActual = await page.evaluate(async () => {
    const canvas = document.getElementById('display');
    const context = canvas.getContext('2d');
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let mismatchingPixels = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const offset = (y * canvas.width + x) * 4;
        let red = 0,
          green = 0,
          blue = 0,
          alpha = 255;
        if (x >= 10 && x < 40 && y >= 20 && y < 60) {
          red = 0x11;
          green = 0x22;
          blue = 0x33;
        }
        if (x === 12 && y === 22) {
          red = 0xab;
          green = 0xcd;
          blue = 0xef;
        }
        if (
          actual[offset] !== red ||
          actual[offset + 1] !== green ||
          actual[offset + 2] !== blue ||
          actual[offset + 3] !== alpha
        )
          mismatchingPixels++;
      }
    }
    const actualSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', actual.buffer))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const sampleAt = (x, y) =>
      Array.from(actual.slice((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 4));
    return {
      exitCode: window.__lastRun.exitCode,
      apiTrace: window.__lastRun.apiTrace,
      modules: window.__lastRun.modules,
      width: canvas.width,
      height: canvas.height,
      hidden: canvas.hidden,
      mismatchingPixels,
      actualSha256,
      samples: {
        outside: sampleAt(0, 0),
        beforeRect: sampleAt(9, 20),
        insideRect: sampleAt(15, 25),
        pixel: sampleAt(12, 22),
        afterRect: sampleAt(40, 20),
      },
      completedAt: performance.now(),
      metrics: document.getElementById('metrics').textContent,
    };
  });
  const expectedGdiTrace = [
    'GetDC',
    'CreateSolidBrush',
    'SelectObject',
    'PatBlt',
    'SetPixel',
    'ReleaseDC',
  ];
  let gdiTraceIndex = 0;
  const gdiTraceMatches = expectedGdiTrace.every((api) => {
    const found = gdiActual.apiTrace.findIndex(
      (entry, index) => index >= gdiTraceIndex && entry.endsWith(`!${api}`),
    );
    if (found < 0) return false;
    gdiTraceIndex = found + 1;
    return true;
  });
  const gdiChecks = [
    { name: 'exit code 1', passed: gdiActual.exitCode === 1 },
    {
      name: '640x480 visible display canvas',
      passed:
        gdiActual.width === expectedCanvas.width &&
        gdiActual.height === expectedCanvas.height &&
        !gdiActual.hidden,
    },
    { name: 'entire RGBA canvas exact', passed: gdiActual.mismatchingPixels === 0 },
    {
      name: 'full canvas SHA-256',
      passed: gdiActual.actualSha256 === expectedCanvasSha256,
    },
    {
      name: 'GetDC/CreateSolidBrush/SelectObject/PatBlt/SetPixel/ReleaseDC trace',
      passed: gdiTraceMatches,
    },
  ];
  report.cases.push({
    id: 'winapiexec-gdi-realcanvas',
    binary: pcmBinaryLabel,
    args: gdiArgs,
    exitCode: gdiActual.exitCode,
    apiTrace: gdiActual.apiTrace,
    modules: gdiActual.modules,
    canvas: {
      width: gdiActual.width,
      height: gdiActual.height,
      mismatchingPixels: gdiActual.mismatchingPixels,
      samples: gdiActual.samples,
      actualSha256: gdiActual.actualSha256,
      expectedSha256: expectedCanvasSha256,
    },
    expectedTrace: expectedGdiTrace,
    metrics: gdiActual.metrics,
    checks: gdiChecks,
    passed: gdiChecks.every((check) => check.passed),
  });
  if (gdiChecks.some((check) => !check.passed))
    throw Error(
      `GDI canvas case failed: ${gdiChecks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(', ')}`,
    );

  const wineNtdllPath = process.env.WINEBROWSER_NTDLL;
  if (!wineNtdllPath) {
    report.optionalCases.push({
      id: 'wine-ntdll-rtlcomputecrc32',
      status: 'skipped',
      reason: 'WINEBROWSER_NTDLL is unset; the installed Wine DLL test is optional.',
    });
  } else {
    const expectedNtdllSha256 = 'bac6f2d9434860d09a696dcdcd5f85631e19fd4f9409b3a39828841b7a40c089';
    const ntdllBytes = await readFile(wineNtdllPath);
    const ntdllSha256 = createHash('sha256').update(ntdllBytes).digest('hex');
    if (ntdllSha256 !== expectedNtdllSha256)
      throw Error(`Installed Wine ntdll.dll SHA-256 mismatch: ${ntdllSha256}`);
    const ntdllPeOffset = ntdllBytes.readUInt32LE(0x3c);
    const ntdllEntryPointRva = ntdllBytes.readUInt32LE(ntdllPeOffset + 24 + 16);
    const ntdllZip = zipSync(
      {
        'winapiexec.exe': new Uint8Array(exeBytes),
        'ntdll.dll': new Uint8Array(ntdllBytes),
      },
      { level: 0 },
    );
    const ntdllZipSha256 = createHash('sha256').update(ntdllZip).digest('hex');
    const ntdllBinaryLabel = 'winapiexec-1.2-x86+verified-wine-ntdll';
    report.binaries.wineNtdllPackage = {
      id: ntdllBinaryLabel,
      archive: 'winapiexec-wine-ntdll.zip',
      archiveSha256: ntdllZipSha256,
      entries: ['winapiexec.exe', 'ntdll.dll'],
      executableId: target.id,
      executablePath: targetPath,
      executableSha256: exeSha256,
      dllPath: wineNtdllPath,
      dllBytes: ntdllBytes.length,
      dllExpectedSha256: expectedNtdllSha256,
      dllActualSha256: ntdllSha256,
      dllEntryPointRva: `0x${ntdllEntryPointRva.toString(16)}`,
      scope:
        'Executes the whole guest ntdll with native initialization, one pure export, native heaps, and limited clock/virtual-memory NT services. This is not general NT syscall or object support.',
    };
    await page.locator('#file').setInputFiles({
      name: 'winapiexec-wine-ntdll.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(ntdllZip),
    });
    await page.waitForFunction(
      () => !document.getElementById('run').disabled,
      {},
      { timeout: 20000 },
    );
    const ntdllExecutable = await page.locator('#exe').inputValue();
    if (ntdllExecutable !== 'winapiexec.exe')
      throw Error(`Unexpected ntdll package executable selection: ${ntdllExecutable}`);
    const ntdllArgs = ['ntdll@RtlComputeCrc32', '0', '$s:123456789', '9'];
    await page.locator('#args').fill(JSON.stringify(ntdllArgs));
    await page.locator('#run').click();
    await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
    const ntdllActual = await page.evaluate(() => {
      const result = window.__lastRun;
      return {
        exitCode: result.exitCode,
        apiTrace: result.apiTrace,
        modules: result.modules,
        metrics: document.getElementById('metrics').textContent,
        logs: document.getElementById('logs').textContent,
      };
    });
    const ntdllModule = ntdllActual.modules.find((module) => module.name === 'ntdll.dll');
    const ntdllChecks = [
      {
        name: 'RtlComputeCrc32 returns 0xcbf43926',
        passed: ntdllActual.exitCode >>> 0 === 0xcbf43926,
      },
      {
        name: 'guest ntdll loaded, initialized and relocated',
        passed:
          !!ntdllModule &&
          !ntdllModule.host &&
          ntdllModule.initialized &&
          ntdllModule.preferredBase === 0x7bc00000 &&
          ntdllModule.base !== ntdllModule.preferredBase &&
          ntdllEntryPointRva !== 0,
      },
    ];
    report.optionalCases.push({
      id: 'wine-ntdll-rtlcomputecrc32',
      status: ntdllChecks.every((check) => check.passed) ? 'passed' : 'failed',
      optional: true,
      binary: ntdllBinaryLabel,
      args: ntdllArgs,
      expectedExitCode: '0xcbf43926',
      ...ntdllActual,
      ntdllModule,
      nativeDllMain: {
        entryPointRva: `0x${ntdllEntryPointRva.toString(16)}`,
        initializedByNormalRuntime: !!ntdllModule?.initialized && ntdllEntryPointRva !== 0,
      },
      checks: ntdllChecks,
      scope:
        'This CRC32 case executes pure guest code; the same package also exercises limited clock and virtual-memory NT service dispatch in later cases.',
    });
    if (ntdllChecks.some((check) => !check.passed))
      throw Error(
        `Wine ntdll CRC case failed: ${ntdllChecks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(', ')}`,
      );

    async function runWineNtCase(id, args) {
      await page.locator('#args').fill(JSON.stringify(args));
      await page.locator('#run').click();
      await page.waitForFunction(() => window.__lastRun !== null, {}, { timeout: 30000 });
      return page.evaluate(() => ({
        exitCode: window.__lastRun.exitCode,
        apiTrace: window.__lastRun.apiTrace,
        modules: window.__lastRun.modules,
        outputs: window.__lastRun.outputs.map((output) => ({
          path: output.path,
          bytes: Array.from(output.bytes),
        })),
        metrics: document.getElementById('metrics').textContent,
        logs: document.getElementById('logs').textContent,
      }));
    }

    const clockArgs = [
      'ntdll@NtQuerySystemTime',
      '$b:8',
      ',',
      'CreateFileW',
      'winebrowser-filetime.bin',
      '0x40000000',
      '0',
      '0',
      '2',
      '0x80',
      '0',
      ',',
      'WriteFile',
      '$$:4',
      '$$:2',
      '8',
      '$b:4',
      '0',
      ',',
      'CloseHandle',
      '$$:4',
    ];
    const clockBefore = Date.now();
    const clockActual = await runWineNtCase('wine-ntdll-systemtime-file', clockArgs);
    const clockAfter = Date.now();
    const clockFile = clockActual.outputs.find((output) =>
      output.path.endsWith('winebrowser-filetime.bin'),
    );
    const fileTime =
      clockFile?.bytes.length === 8
        ? clockFile.bytes.reduce(
            (value, byte, index) => value | (BigInt(byte) << BigInt(index * 8)),
            0n,
          )
        : null;
    const fileTimeUnixMs =
      fileTime === null ? null : Number(fileTime - 116444736000000000n) / 10000;
    const clockModule = clockActual.modules.find((module) => module.name === 'ntdll.dll');
    const clockChecks = [
      { name: 'CloseHandle exit code 1', passed: clockActual.exitCode === 1 },
      {
        name: 'ntdll.dll!NtQuerySystemTime trace',
        passed: clockActual.apiTrace.includes('ntdll.dll!NtQuerySystemTime'),
      },
      {
        name: 'exact 8-byte FILETIME output in generated file',
        passed: clockFile?.bytes.length === 8,
      },
      {
        name: 'FILETIME matches current wall clock',
        passed:
          fileTimeUnixMs !== null && fileTimeUnixMs >= clockBefore && fileTimeUnixMs <= clockAfter,
      },
      {
        name: 'guest ntdll loaded, initialized and relocated',
        passed:
          !!clockModule &&
          !clockModule.host &&
          clockModule.initialized &&
          clockModule.preferredBase === 0x7bc00000 &&
          clockModule.base !== clockModule.preferredBase,
      },
    ];
    report.optionalCases.push({
      id: 'wine-ntdll-systemtime-file',
      status: clockChecks.every((check) => check.passed) ? 'passed' : 'failed',
      optional: true,
      binary: ntdllBinaryLabel,
      args: clockArgs,
      expectedFileBytes: '8-byte little-endian Windows FILETIME for current wall clock',
      ...clockActual,
      fileTime: fileTime === null ? null : `0x${fileTime.toString(16).padStart(16, '0')}`,
      unixMilliseconds: fileTimeUnixMs,
      wallClockWindow: { before: clockBefore, after: clockAfter },
      ntdllModule: clockModule,
      checks: clockChecks,
      scope: 'Exercises the real Wine NtQuerySystemTime export through the NT dispatcher.',
    });
    if (clockChecks.some((check) => !check.passed))
      throw Error(
        `Wine NtQuerySystemTime browser case failed: ${clockChecks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(', ')}`,
      );

    const memoryArgs = [
      'ntdll@NtAllocateVirtualMemory',
      '-1',
      '$b:4',
      '0',
      '$a:8192',
      '0x3000',
      '4',
      ',',
      'ntdll@NtFreeVirtualMemory',
      '-1',
      '$$:3',
      '$a:0',
      '0x8000',
    ];
    const memoryActual = await runWineNtCase('wine-ntdll-allocate-free', memoryArgs);
    const memoryModule = memoryActual.modules.find((module) => module.name === 'ntdll.dll');
    const memoryChecks = [
      { name: 'NtFreeVirtualMemory returns STATUS_SUCCESS', passed: memoryActual.exitCode === 0 },
      {
        name: 'ntdll allocate and free syscall traces',
        passed:
          memoryActual.apiTrace.includes('ntdll.dll!NtAllocateVirtualMemory') &&
          memoryActual.apiTrace.includes('ntdll.dll!NtFreeVirtualMemory'),
      },
      {
        name: 'guest ntdll remains initialized and relocated',
        passed:
          !!memoryModule &&
          !memoryModule.host &&
          memoryModule.initialized &&
          memoryModule.preferredBase === 0x7bc00000 &&
          memoryModule.base !== memoryModule.preferredBase,
      },
    ];
    report.optionalCases.push({
      id: 'wine-ntdll-allocate-free',
      status: memoryChecks.every((check) => check.passed) ? 'passed' : 'failed',
      optional: true,
      binary: ntdllBinaryLabel,
      args: memoryArgs,
      expectedExitCode: 0,
      ...memoryActual,
      ntdllModule: memoryModule,
      checks: memoryChecks,
      scope:
        'Exercises the real Wine NtAllocateVirtualMemory and NtFreeVirtualMemory exports through the NT dispatcher.',
    });
    if (memoryChecks.some((check) => !check.passed))
      throw Error(
        `Wine virtual-memory browser case failed: ${memoryChecks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(', ')}`,
      );

    const heapPrefixArgs = [
      'ntdll@RtlCreateHeap',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      ',',
      'ntdll@RtlAllocateHeap',
      '$$:1',
      '8',
      '32',
      ',',
    ];
    const heapFileArgs = [
      'CreateFileW',
      'winebrowser-heap-zero.bin',
      '0x40000000',
      '0',
      '0',
      '2',
      '0x80',
      '0',
      ',',
      'WriteFile',
      '$$:14',
      '$$:9',
      '32',
      '$b:4',
      '0',
      ',',
      'CloseHandle',
      '$$:14',
      ',',
      'ntdll@RtlFreeHeap',
      '$$:1',
      '0',
      '$$:9',
    ];
    const heapFreeArgs = [...heapPrefixArgs, ...heapFileArgs];
    const heapFreeActual = await runWineNtCase('wine-ntdll-rtlheap-zero-free', heapFreeArgs);
    const heapFile = heapFreeActual.outputs.find((output) =>
      output.path.endsWith('winebrowser-heap-zero.bin'),
    );
    const heapModule = heapFreeActual.modules.find((module) => module.name === 'ntdll.dll');
    const heapZeroChecks = [
      { name: 'RtlFreeHeap returns 1', passed: heapFreeActual.exitCode === 1 },
      {
        name: 'RtlAllocateHeap zeroes all 32 requested bytes',
        passed: heapFile?.bytes.length === 32 && heapFile.bytes.every((byte) => byte === 0),
      },
      {
        name: 'guest ntdll loaded, initialized and relocated',
        passed:
          !!heapModule &&
          !heapModule.host &&
          heapModule.initialized &&
          heapModule.preferredBase === 0x7bc00000 &&
          heapModule.base !== heapModule.preferredBase,
      },
    ];
    report.optionalCases.push({
      id: 'wine-ntdll-rtlheap-zero-free',
      status: heapZeroChecks.every((check) => check.passed) ? 'passed' : 'failed',
      optional: true,
      binary: ntdllBinaryLabel,
      args: heapFreeArgs,
      expectedExitCode: 1,
      ...heapFreeActual,
      zeroedHeapOutput: heapFile,
      ntdllModule: heapModule,
      checks: heapZeroChecks,
      scope:
        'Creates a private guest Wine heap, allocates 32 zeroed bytes, writes them to a generated file, and frees the allocation.',
    });
    if (heapZeroChecks.some((check) => !check.passed))
      throw Error(
        `Wine Rtl heap zero/free browser case failed: ${heapZeroChecks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(', ')}`,
      );

    const heapDestroyArgs = [
      ...heapPrefixArgs,
      'ntdll@RtlFreeHeap',
      '$$:1',
      '0',
      '$$:9',
      ',',
      'ntdll@RtlDestroyHeap',
      '$$:1',
    ];
    const heapDestroyActual = await runWineNtCase('wine-ntdll-rtlheap-destroy', heapDestroyArgs);
    const destroyModule = heapDestroyActual.modules.find((module) => module.name === 'ntdll.dll');
    const destroyChecks = [
      { name: 'RtlDestroyHeap returns 0', passed: heapDestroyActual.exitCode === 0 },
      {
        name: 'private heap allocation and destruction use NT memory services',
        passed:
          heapDestroyActual.apiTrace.includes('ntdll.dll!NtAllocateVirtualMemory') &&
          heapDestroyActual.apiTrace.includes('ntdll.dll!NtFreeVirtualMemory'),
      },
      {
        name: 'guest ntdll remains initialized and relocated',
        passed:
          !!destroyModule &&
          !destroyModule.host &&
          destroyModule.initialized &&
          destroyModule.preferredBase === 0x7bc00000 &&
          destroyModule.base !== destroyModule.preferredBase,
      },
    ];
    report.optionalCases.push({
      id: 'wine-ntdll-rtlheap-destroy',
      status: destroyChecks.every((check) => check.passed) ? 'passed' : 'failed',
      optional: true,
      binary: ntdllBinaryLabel,
      args: heapDestroyArgs,
      expectedExitCode: 0,
      ...heapDestroyActual,
      ntdllModule: destroyModule,
      checks: destroyChecks,
      scope:
        'Creates a private guest Wine heap, allocates and frees a block, and destroys the heap.',
    });
    if (destroyChecks.some((check) => !check.passed))
      throw Error(
        `Wine Rtl heap destroy browser case failed: ${destroyChecks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(', ')}`,
      );
  }

  if (browserErrors.length) throw Error(`Browser page errors: ${browserErrors.join('; ')}`);
  if (outboundRequests.length)
    throw Error(`Unexpected external requests: ${outboundRequests.join(', ')}`);
  report.pageErrors = browserErrors;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.errors.push(error.stack || error.message);
  report.pageErrors = browserErrors;
  report.externalRequests = outboundRequests;
  report.serverOutput = serverOutput;
  if (browser) {
    try {
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages[0]) {
        report.diagnostics = await pages[0].evaluate(() => ({
          status: document.getElementById('status')?.textContent,
          state: document.getElementById('state')?.textContent,
          stdout: document.getElementById('output')?.textContent,
          logs: document.getElementById('logs')?.textContent,
          suite: document.getElementById('suite-status')?.textContent,
        }));
      }
    } catch (diagnosticError) {
      report.diagnosticError = diagnosticError.message;
    }
  }
} finally {
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/external-browser-results.json', JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  server.kill();
}

if (report.status !== 'passed') throw Error(report.errors[0] || 'External browser test failed');
console.log(JSON.stringify(report, null, 2));
