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
const exe = 'events-native.exe',
  executable = new Uint8Array(
    await readFile(new URL('../tests/fixtures/events/' + exe, import.meta.url)),
  );
const input = { files: new Map([[exe, executable]]), exe, builtinFiles, nlsFiles };
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
    'Native PE32 through real Wine Kernel32/KernelBase/NTDLL. Named A/W events and directory handles, access masks, signal/reset/pulse, wait-any/all, timed waits and close; native module lookup through TEB Unicode scratch storage, and empty activation-context query. No guest-thread or APC delivery claim.',
  browser: result.browser,
  worker: result.worker,
  crossOriginIsolated: result.crossOriginIsolated,
  outboundRequests: result.outboundRequests,
  firstFailure: result.firstFailure,
  recentNativeCalls: result.apiCalls,
};
const path = new URL(
  `../evidence/events-native${values.browser ? '-browser' : ''}-results.json`,
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
