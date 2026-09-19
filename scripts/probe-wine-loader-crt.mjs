import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iced from 'iced-x86';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';
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
  const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
    wineDirectory,
    nlsDirectory,
  });
  report.inputs = inputs;
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
