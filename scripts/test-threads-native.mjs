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
const results = [];
for (const [name, expectedExit] of [
  ['threads-native', 0],
  ['static-tls', 0],
  ['worker-exit', 77],
  ['main-exit', 77],
  ['thread-fault', null],
]) {
  const exe = name + '.exe',
    executable = new Uint8Array(
      await readFile(new URL('../tests/fixtures/threads/' + exe, import.meta.url)),
    );
  const files = new Map([[exe, executable]]);
  if (name === 'static-tls')
    files.set(
      'thread-tls.dll',
      new Uint8Array(
        await readFile(new URL('../tests/fixtures/threads/thread-tls.dll', import.meta.url)),
      ),
    );
  const input = { files, exe, builtinFiles, nlsFiles, testStaticTLS: name === 'static-tls' };
  const result = values.browser
    ? await probeWineTargetInBrowser(root, input)
    : await probeWineTarget(iced, input);
  const passed =
    expectedExit === null
      ? result.firstFailure?.message.includes('Unsupported instruction ud2') &&
        result.exitCode == null
      : result.status === 'entry-returned' &&
        result.exitCode === expectedExit &&
        !result.firstFailure;
  results.push({
    name,
    passed: !!passed && (name !== 'static-tls' || result.output.join('').includes('static-tls-ok')),
    output: result.output,
    staticTLSValidation: result.phases.filter((p) => p.name.startsWith('static TLS rejects')),
    expectedExit,
    exeSha256: createHash('sha256').update(executable).digest('hex'),
    exitCode: result.exitCode,
    browser: result.browser,
    worker: result.worker,
    crossOriginIsolated: result.crossOriginIsolated,
    outboundRequests: result.outboundRequests,
    firstFailure: result.firstFailure,
    recentNativeCalls: result.apiCalls?.slice(-12),
  });
}
const report = {
  date: new Date().toISOString(),
  status: results.every((r) => r.passed) ? 'passed' : 'failed',
  sourceRevision: inputs.sourceRevision,
  patchSha256: inputs.patchSha256,
  inputDlls: inputs.dlls.map(({ name, sha256 }) => ({ name, sha256 })),
  scope:
    'Native PE32 through actual Wine KernelBase/NTDLL: suspended creation/resume, priority, separate TEBs/stacks/last-error values, events, preempted loops, joins, return/ExitThread status, handle lifetime, main/worker process exit and deliberate worker-fault propagation. General APC, SEH and arbitrary thread compatibility remain unfinished.',
  results,
};
await writeFile(
  new URL(
    `../evidence/threads-native${values.browser ? '-browser' : ''}-results.json`,
    import.meta.url,
  ),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      status: report.status,
      results: results.map((r) => ({
        name: r.name,
        passed: r.passed,
        exitCode: r.exitCode,
        failure: r.firstFailure?.message,
      })),
    },
    null,
    2,
  ),
);
assert.ok(
  results.every((r) => r.passed),
  'Native thread lifecycle fixture failed; see evidence report',
);
