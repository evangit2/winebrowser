#!/usr/bin/env node
// Reproducible probe for the original, unchanged Hamsterball executable.
//
// Inputs are the recovered original EXE plus its own assets and the native
// BASS DLL; the source-built Wine loader closure and NLS tables are supplied
// the same way the other Wine target diagnostics supply them. Nothing here
// publishes or rewrites the game's bytes.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { probeWineTarget } from './lib/wine-target-probe.js';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: options } = parseArgs({
  options: {
    browser: { type: 'boolean' },
    report: { type: 'string' },
    'worker-timeout': { type: 'string' },
    'max-blocks': { type: 'string' },
    'max-ms': { type: 'string' },
    'frame-png': { type: 'string' },
    'frame-goal': { type: 'string' },
    'sample-blocks': { type: 'string' },
    'stop-on-exception': { type: 'boolean' },
    watch: { type: 'string' },
    'watch-range': { type: 'string' },
    'watch-any': { type: 'string' },
  },
});
const EXE_SHA256 = '3379e9041c7ab83abd07da1bcf974529280aeff36b3c52e7a3d3bbb93e2da94d';
const directory =
  process.env.HAMSTERBALL_DIRECTORY || path.join(root, '.cache/hamsterball-original');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const files = new Map();
async function walk(base, prefix = '') {
  for (const entry of await readdir(base)) {
    const full = path.join(base, entry);
    if ((await stat(full)).isDirectory()) await walk(full, prefix + entry + '/');
    else
      files.set(prefix.toLowerCase() + entry.toLowerCase(), new Uint8Array(await readFile(full)));
  }
}
await walk(directory);
const exe = 'hamsterball.exe';
assert.ok(files.has(exe), `Missing ${exe} under ${directory}`);
assert.equal(sha256(files.get(exe)), EXE_SHA256, 'Hamsterball EXE integrity mismatch');

const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
  wineDirectory: process.env.WINEBROWSER_WINE_DIR,
  nlsDirectory: process.env.WINEBROWSER_NLS_DIR,
});
const input = {
  files,
  exe,
  builtinFiles,
  nlsFiles,
  ...(options['frame-goal'] ? { frameGoal: Number(options['frame-goal']) } : {}),
  ...(options['worker-timeout'] ? { workerTimeoutMs: Number(options['worker-timeout']) } : {}),
  ...(options['watch-any']
    ? { watchAnyRange: options['watch-any'].split('-').map((v) => Number.parseInt(v, 16)) }
    : {}),
  ...(options['watch-range']
    ? { watchRange: options['watch-range'].split('-').map((v) => Number.parseInt(v, 16)) }
    : {}),
  ...(options.watch ? { watchValue: Number.parseInt(options.watch, 16) } : {}),
  ...(options['max-blocks'] ||
  options['max-ms'] ||
  options['sample-blocks'] ||
  options['stop-on-exception']
    ? {
        limits: {
          ...(options['stop-on-exception'] ? { stopOnException: true } : {}),
          ...(options['sample-blocks']
            ? { blockSampleStride: Number(options['sample-blocks']) }
            : {}),
          ...(options['max-blocks'] ? { maxBlocks: Number(options['max-blocks']) } : {}),
          ...(options['max-ms'] ? { maxExecutionMs: Number(options['max-ms']) } : {}),
        },
      }
    : {}),
};
const report = options.browser
  ? await (await import('./lib/wine-loader-browser.mjs')).probeWineTargetInBrowser(root, input)
  : await probeWineTarget((await import('iced-x86')).default, input);
const destination = path.join(
  root,
  options.report ??
    (options.browser
      ? 'evidence/hamsterball-startup-browser.json'
      : 'evidence/hamsterball-startup.json'),
);
// The pixel PNG is large and gitignored; keep the JSON metrics and hashes. A
// caller may still ask for the frame to be written so the render can be
// inspected directly rather than only through its digest.
const framePngBase64 = report.framePngBase64;
delete report.framePngBase64;
if (options['frame-png'] && framePngBase64)
  await writeFile(path.join(root, options['frame-png']), Buffer.from(framePngBase64, 'base64'));
await writeFile(
  destination,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      targetId: 'hamsterball-original-x86',
      exe,
      exeSha256: sha256(files.get(exe)),
      ...(framePngBase64
        ? { framePng: 'evidence/hamsterball-frame.png (gitignored; re-run to reproduce)' }
        : {}),
      inputs,
      ...report,
    },
    null,
    2,
  ) + '\n',
);
if (framePngBase64) {
  const { writeFile: write } = await import('node:fs/promises');
  await write(
    path.join(root, 'evidence/hamsterball-frame.png'),
    Buffer.from(framePngBase64, 'base64'),
  );
}
console.log(
  JSON.stringify(
    {
      status: report.status,
      frames: report.frames,
      exitCode: report.exitCode,
      firstFailure: report.firstFailure?.message,
      frameSamples: report.frameSamples?.map((sample) => ({
        width: sample.width,
        height: sample.height,
        graphicsDraws: sample.graphicsDraws,
        nonBackground: sample.nonBackground,
        hash: sample.hash,
      })),
    },
    null,
    2,
  ),
);
process.exitCode = report.status === 'entry-returned' && report.exitCode === 0 ? 0 : 1;
