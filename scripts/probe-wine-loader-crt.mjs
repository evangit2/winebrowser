import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iced from 'iced-x86';
import { parsePE } from '../src/pe.js';
import { probeWineCrt } from './lib/wine-crt-probe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const browser = args.includes('--browser');
const positional = args.filter((value) => value !== '--browser');
const configuredWineDirectory = positional[0] || process.env.WINEBROWSER_WINE_DIR;
const configuredNlsDirectory = positional[1] || process.env.WINEBROWSER_NLS_DIR;
const wineDirectory = configuredWineDirectory ? path.resolve(configuredWineDirectory) : null;
const nlsDirectory = configuredNlsDirectory ? path.resolve(configuredNlsDirectory) : null;
const manifestPath = path.join(root, '.cache/wine-loader/manifest.json');
const evidencePath = path.join(
  root,
  browser
    ? 'evidence/wine-loader-crt-browser-results.json'
    : 'evidence/wine-loader-crt-results.json',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const installedHashes = {
  'msvcrt.dll': '612edff0b1d2493a6c491aa3be10f1b42a961f8516db8cffe3d59dbe4c192558',
  'kernel32.dll': 'c4b1f1f1210e85acc9f82a898664b1c79b6e83e0485cb59e2e6251885cde9418',
  'kernelbase.dll': '4fae98d80c69cf36fbfc669acbe87676f0ad06dcebb85cff7b4abee13912a6f6',
};
const report = {
  date: new Date().toISOString(),
  status: 'blocked-integrity',
  scope:
    'Optional diagnostic of a source-built Wine loader bridge with pinned installed CRT DLLs, followed by real guest CRT allocation, formatting and output calls. No EXE entry point runs. After-attach loader metadata synchronization is not implemented; no general application support is claimed.',
  operation:
    'map full msvcrt closure; process bootstrap; source loader registration; kernelbase dynamic TLS; normal DLL attach; real CRT services',
  environment: browser ? 'chromium-worker' : 'node',
  inputs: {
    manifest: path.relative(root, manifestPath),
    wineDirectory,
    nlsDirectory,
    dlls: [],
    nls: [],
  },
  phases: [],
  firstFailure: null,
};
try {
  if (!wineDirectory || !nlsDirectory)
    throw Error(
      'Pass the pinned i386 Wine DLL directory and NLS directory as arguments or WINEBROWSER_WINE_DIR/WINEBROWSER_NLS_DIR.',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceRevision, 'db11d0fe6a169c457e23d007e20404643d067aa8');
  assert.equal(
    manifest.sourceSha256,
    '18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a',
  );
  assert.equal(
    manifest.patchSha256,
    sha256(await readFile(path.join(root, 'runtime/wine/browser-loader.patch'))),
  );
  assert.equal(manifest.artifactPathBase, 'manifest-directory');
  const patchedPath = path.resolve(path.dirname(manifestPath), manifest.artifact.path);
  const patched = new Uint8Array(await readFile(patchedPath));
  assert.equal(patched.length, manifest.artifact.bytes);
  assert.equal(sha256(patched), manifest.artifact.sha256);
  assert.equal(parsePE(patched, { allowDll: true }).isDll, true);
  Object.assign(report.inputs, {
    sourceRevision: manifest.sourceRevision,
    sourceSha256: manifest.sourceSha256,
    patchSha256: manifest.patchSha256,
  });
  report.inputs.dlls.push({
    name: 'ntdll.dll',
    path: patchedPath,
    bytes: patched.length,
    sha256: sha256(patched),
  });
  const builtinFiles = new Map([['ntdll.dll', patched]]);
  for (const [name, expected] of Object.entries(installedHashes)) {
    const filename = path.join(wineDirectory, name);
    const bytes = new Uint8Array(await readFile(filename));
    assert.equal(sha256(bytes), expected, `${name} differs from the pinned installed DLL`);
    assert.equal(parsePE(bytes, { allowDll: true }).isDll, true);
    builtinFiles.set(name, bytes);
    report.inputs.dlls.push({ name, path: filename, bytes: bytes.length, sha256: expected });
  }
  const nlsManifest = JSON.parse(
    await readFile(path.join(root, 'runtime/wine/nls-probe-manifest.json'), 'utf8'),
  );
  assert.equal(nlsManifest.wineCommit, manifest.sourceRevision);
  const nlsFiles = new Map();
  for (const [name, expected] of Object.entries(nlsManifest.files)) {
    let filename = path.join(nlsDirectory, name),
      bytes;
    try {
      bytes = new Uint8Array(await readFile(filename));
    } catch (error) {
      if (name !== 'sortdefault.nls' || error.code !== 'ENOENT') throw error;
      filename = path.resolve(nlsDirectory, '../globalization/sorting/sortdefault.nls');
      bytes = new Uint8Array(await readFile(filename));
    }
    assert.equal(bytes.length, expected.bytes, `${name} length differs from the pinned NLS file`);
    assert.equal(sha256(bytes), expected.sha256, `${name} differs from the pinned NLS file`);
    nlsFiles.set(name, bytes);
    report.inputs.nls.push({ name, path: filename, bytes: bytes.length, sha256: expected.sha256 });
  }
  const executable = new Uint8Array(
    await readFile(path.join(root, 'public/demos/console/console.exe')),
  );
  report.inputs.executable = {
    name: 'console.exe',
    sha256: sha256(executable),
    bytes: executable.length,
  };
  const result = browser
    ? await (
        await import('./lib/wine-loader-browser.mjs')
      ).probeWineCrtInBrowser(root, {
        executable,
        builtinFiles,
        nlsFiles,
      })
    : await probeWineCrt(iced, { executable, builtinFiles, nlsFiles });
  const metadata = {
    date: report.date,
    scope: report.scope,
    operation: report.operation,
    inputs: report.inputs,
    environment: report.environment,
  };
  Object.assign(report, result, metadata);
} catch (error) {
  report.firstFailure ??= {
    phase: 'input integrity',
    error: { name: error.name, message: error.message },
  };
  report.status = 'blocked-integrity';
  report.processExitCode = 1;
}
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ status: report.status, environment: report.environment, phases: report.phases?.map(({ name, passed }) => ({ name, passed })), firstFailure: report.firstFailure, processExitCode: report.processExitCode }, null, 2)}\n`,
);
process.exitCode = report.processExitCode;
