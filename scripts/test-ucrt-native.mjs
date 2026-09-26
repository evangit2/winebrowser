import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import iced from 'iced-x86';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';
import { probeWineTarget } from './lib/wine-target-probe.js';
import { probeWineTargetInBrowser } from './lib/wine-loader-browser.mjs';
import { parsePE } from '../src/pe.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { browser: { type: 'boolean' } },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
  wineDirectory: positionals[0] ?? process.env.WINEBROWSER_WINE_DIR,
  nlsDirectory: positionals[1] ?? process.env.WINEBROWSER_NLS_DIR,
});
const executable = new Uint8Array(
  await readFile(new URL('../tests/fixtures/ucrt/ucrt.exe', import.meta.url)),
);
const contracts = [
  ...new Set(
    parsePE(executable)
      .imports.map((i) => i.dll.toLowerCase())
      .filter((n) => n.startsWith('api-ms-win-crt')),
  ),
];
assert.equal(contracts.length, 5);
const input = {
  files: new Map([['ucrt.exe', executable]]),
  exe: 'ucrt.exe',
  builtinFiles,
  nlsFiles,
};
const result = values.browser
  ? await probeWineTargetInBrowser(root, input)
  : await probeWineTarget(iced, input);
assert.equal(result.firstFailure, null, JSON.stringify(result.firstFailure));
assert.equal(result.exitCode, 0);
assert.match(result.output.join(''), /ucrt-ok/);
const modules = result.phases.find((p) => p.name === 'map guest closure').modules;
assert.equal(modules.filter((m) => m.name === 'ucrtbase.dll' && !m.host).length, 1);
assert.equal(modules.filter((m) => m.name.startsWith('api-ms-win-crt')).length, 0);
assert.equal(result.trappedImports.filter((x) => x.startsWith('api-ms-win-crt')).length, 0);
const report = {
  date: new Date().toISOString(),
  status: 'passed',
  scope:
    'Native PE32 API-set imports execute pinned Wine UCRT exports: malloc/calloc/realloc/free, narrow/wide strings and conversion, stdio object access, native GetModuleHandle/LoadLibrary/GetProcAddress identity and retained imports after FreeLibrary. Installed Wine/NLS supplied only to diagnostic.',
  sourceRevision: inputs.sourceRevision,
  patchSha256: inputs.patchSha256,
  inputDlls: inputs.dlls.map(({ name, sha256 }) => ({ name, sha256 })),
  exeSha256: createHash('sha256').update(executable).digest('hex'),
  contracts,
  browser: result.browser,
  worker: result.worker,
  exitCode: result.exitCode,
  output: result.output,
  modules,
  firstFailure: result.firstFailure,
  outboundRequests: result.outboundRequests,
};
await writeFile(
  new URL(
    `../evidence/ucrt-native${values.browser ? '-browser' : ''}-results.json`,
    import.meta.url,
  ),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    { status: report.status, contracts, exitCode: report.exitCode, output: report.output },
    null,
    2,
  ),
);
