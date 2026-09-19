import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iced from 'iced-x86';
import { unpackPackage } from '../src/package.js';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';
import { probeWineTarget } from './lib/wine-target-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [
  targetId = 'humus-dynamic-branching-d3d9-x86',
  wineDirectory = process.env.WINEBROWSER_WINE_DIR,
  nlsDirectory = process.env.WINEBROWSER_NLS_DIR,
] = process.argv.slice(2).filter((value) => value !== '--browser');
const catalog = JSON.parse(await readFile(path.join(root, 'tests/targets.json'), 'utf8'));
const target = catalog.targets.find((entry) => entry.id === targetId);
assert.ok(
  target?.source.archiveSha256 && target.downloadEntry,
  'Target must have a pinned source archive and EXE entry',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = new Uint8Array(
  await readFile(path.join(root, '.cache/targets', `${target.id}.upstream.zip`)),
);
assert.equal(sha256(archive), target.source.archiveSha256, 'Target archive integrity mismatch');
const { files } = await unpackPackage(archive, `${target.id}.zip`);
const exe = target.downloadEntry.toLowerCase();
assert.equal(sha256(files.get(exe)), target.sha256, 'Target EXE integrity mismatch');
const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
  wineDirectory,
  nlsDirectory,
});
const browser = process.argv.includes('--browser');
const input = { files, exe, builtinFiles, nlsFiles };
const report = browser
  ? await (await import('./lib/wine-loader-browser.mjs')).probeWineTargetInBrowser(root, input)
  : await probeWineTarget(iced, input);
await writeFile(
  path.join(
    root,
    browser ? 'evidence/wine-target-startup-browser.json' : 'evidence/wine-target-startup.json',
  ),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      targetId,
      exeSha256: target.sha256,
      archiveSha256: target.source.archiveSha256,
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
