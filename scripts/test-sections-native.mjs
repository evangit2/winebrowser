import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import iced from 'iced-x86';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';
import { probeWineTarget } from './lib/wine-target-probe.js';
import { probeWineTargetInBrowser } from './lib/wine-loader-browser.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { browser: { type: 'boolean' } },
});
const root = fileURLToPath(new URL('../', import.meta.url));
const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
  wineDirectory: positionals[0] ?? process.env.WINEBROWSER_WINE_DIR,
  nlsDirectory: positionals[1] ?? process.env.WINEBROWSER_NLS_DIR,
});
const exe = 'sections-native.exe',
  executable = new Uint8Array(
    await readFile(new URL('../tests/fixtures/file-sections/' + exe, import.meta.url)),
  );
const input = {
  files: new Map([
    [exe, executable],
    ['payload.bin', Uint8Array.from({ length: 65573 }, (_, i) => (i * 7 + 31) & 255)],
  ]),
  exe,
  builtinFiles,
  nlsFiles,
};
const result = values.browser
  ? await probeWineTargetInBrowser(root, input)
  : await probeWineTarget(iced, input);
const passed = result.status === 'entry-returned' && result.exitCode === 0;
const report = {
  date: new Date().toISOString(),
  status: passed ? 'passed' : 'failed',
  exitCode: result.exitCode,
  exeSha256: createHash('sha256').update(executable).digest('hex'),
  sourceRevision: inputs.sourceRevision,
  patchSha256: inputs.patchSha256,
  inputDlls: inputs.dlls.map(({ name, sha256 }) => ({ name, sha256 })),
  scope:
    'Native PE32 through Wine Kernel32/KernelBase/NTDLL: generated and supplied file bytes, A/W file mappings, NT create/map/query, exact section size and SEC_FILE, offset views, alignment/collision/protection errors, handle/view lifetimes and interior unmap.',
  browser: result.browser,
  worker: result.worker,
  crossOriginIsolated: result.crossOriginIsolated,
  outboundRequests: result.outboundRequests,
  firstFailure: result.firstFailure,
  recentNativeCalls: result.apiCalls,
};
const path = new URL(
  `../evidence/sections-native${values.browser ? '-browser' : ''}-results.json`,
  import.meta.url,
);
await writeFile(path, JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      status: report.status,
      exitCode: report.exitCode,
      browser: report.browser,
      firstFailure: report.firstFailure,
    },
    null,
    2,
  ),
);
assert.ok(
  passed,
  report.firstFailure?.message ?? `Native fixture failed at source line ${result.exitCode}`,
);
