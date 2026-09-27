import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import iced from 'iced-x86';
import { unpackPackage } from '../src/package.js';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';
import { probeWineTarget } from './lib/wine-target-probe.js';
import { readLocalPackage } from './lib/local-package.mjs';
import { normalizePath } from '../src/package.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    browser: { type: 'boolean' },
    exe: { type: 'string' },
    report: { type: 'string' },
    'worker-timeout': { type: 'string' },
    watch: { type: 'string' },
    'watch-range': { type: 'string' },
    'watch-any': { type: 'string' },
    'max-blocks': { type: 'string' },
    'max-ms': { type: 'string' },
  },
});
const [
  targetId = 'humus-dynamic-branching-d3d9-x86',
  wineDirectory = process.env.WINEBROWSER_WINE_DIR,
  nlsDirectory = process.env.WINEBROWSER_NLS_DIR,
] = positionals;
const catalog = JSON.parse(await readFile(path.join(root, 'tests/targets.json'), 'utf8'));
const target = catalog.targets.find((entry) => entry.id === targetId);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
let files, exe, archiveSha256;
if (target) {
  assert.ok(
    target.source.archiveSha256 && target.downloadEntry,
    'Target must have a pinned archive and EXE entry',
  );
  const archive = new Uint8Array(
    await readFile(path.join(root, '.cache/targets', `${target.id}.upstream.zip`)),
  );
  archiveSha256 = sha256(archive);
  assert.equal(archiveSha256, target.source.archiveSha256, 'Target archive integrity mismatch');
  ({ files } = await unpackPackage(archive, `${target.id}.zip`));
  exe = target.downloadEntry.toLowerCase();
  assert.equal(sha256(files.get(exe)), target.sha256, 'Target EXE integrity mismatch');
} else {
  const pkg = await readLocalPackage(targetId);
  files = pkg.files;
  assert.ok(
    options.exe || pkg.executables.length === 1,
    'Use --exe to select an executable from this package',
  );
  exe = normalizePath(options.exe ?? pkg.executables[0]);
  assert.ok(files.has(exe), 'Selected EXE is missing');
}
const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
  wineDirectory,
  nlsDirectory,
});
const browser = options.browser;
const input = {
  files,
  exe,
  builtinFiles,
  nlsFiles,
  ...(options['worker-timeout'] ? { workerTimeoutMs: Number(options['worker-timeout']) } : {}),
  ...(options.watch ? { watchValue: Number.parseInt(options.watch, 16) } : {}),
  ...(options['watch-range']
    ? { watchRange: options['watch-range'].split('-').map((v) => Number.parseInt(v, 16)) }
    : {}),
  ...(options['watch-any']
    ? { watchAnyRange: options['watch-any'].split('-').map((v) => Number.parseInt(v, 16)) }
    : {}),
  ...(options['max-blocks'] || options['max-ms']
    ? {
        limits: {
          ...(options['max-blocks'] ? { maxBlocks: Number(options['max-blocks']) } : {}),
          ...(options['max-ms'] ? { maxExecutionMs: Number(options['max-ms']) } : {}),
        },
      }
    : {}),
};
const report = browser
  ? await (await import('./lib/wine-loader-browser.mjs')).probeWineTargetInBrowser(root, input)
  : await probeWineTarget(iced, input);
await writeFile(
  path.join(
    root,
    options.report ??
      (browser ? 'evidence/wine-target-startup-browser.json' : 'evidence/wine-target-startup.json'),
  ),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      targetId,
      exe,
      exeSha256: sha256(files.get(exe)),
      archiveSha256,
      packageFiles: [...files].map(([name, bytes]) => ({
        name,
        bytes: bytes.length,
        sha256: sha256(bytes),
      })),
      inputs,
      ...report,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      status: report.status,
      phases: report.phases,
      trappedImports: report.trappedImports,
      firstFailure: report.firstFailure,
      recentCalls: report.apiCalls.slice(-5),
    },
    null,
    2,
  ),
);
process.exitCode = report.status === 'entry-returned' && report.exitCode === 0 ? 0 : 1;
