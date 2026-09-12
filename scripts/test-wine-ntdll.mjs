import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

// Optional test of an entire, unmodified installed Wine DLL. It is not bundled
// or downloaded by CI. Pin this build so changing Wine is an explicit experiment.
const expectedSha256 = 'bac6f2d9434860d09a696dcdcd5f85631e19fd4f9409b3a39828841b7a40c089';
const dllPath = process.argv[2] || process.env.WINEBROWSER_NTDLL;
if (!dllPath)
  throw Error('Usage: node scripts/test-wine-ntdll.mjs /path/to/Wine-11-i386/ntdll.dll');
const bytes = new Uint8Array(await readFile(dllPath));
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, expectedSha256, 'installed Wine DLL must match the recorded build');
const exe = 'console.exe';
const report = {
  date: new Date().toISOString(),
  dll: { name: 'ntdll.dll', sha256, bytes: bytes.length },
  scope:
    'Whole unmodified Wine DLL: real process attach and selected pure exports. Not a Wine NT host or general application compatibility test.',
  cases: [],
};
const runtime = new Runtime(iced, {
  files: new Map([[exe, new Uint8Array(await readFile('public/demos/console/console.exe'))]]),
  exe,
  builtinFiles: new Map([['ntdll.dll', bytes]]),
});
try {
  await runtime.loadLibrary('ntdll.dll');
  const module = runtime.graph.modules.get('ntdll.dll');
  assert.ok(module.initialized && module.mapped);
  report.modules = runtime.graph.describe();
  const crc = await runtime.resolveExport(module, 'RtlComputeCrc32');
  for (const [value, expected] of [
    ['', 0],
    ['123456789', 0xcbf43926],
    ['hello', 0x3610a686],
  ]) {
    const address = runtime.allocString(value);
    const result = await runtime.callGuest(crc, [0, address, value.length]);
    assert.equal(result, expected);
    report.cases.push({
      export: 'RtlComputeCrc32',
      input: value,
      expected,
      actual: result,
      passed: true,
    });
  }
  for (const [name, args, convention, expected] of [
    ['strlen', [runtime.allocString('whole Wine DLL')], 'cdecl', 14],
    ['RtlNtStatusToDosError', [0xc000000f], 'stdcall', 2],
    ['RtlNtStatusToDosError', [0xc000000d], 'stdcall', 87],
    [
      'RtlCompareMemory',
      [runtime.allocString('hello'), runtime.allocString('helLO'), 5],
      'stdcall',
      3,
    ],
  ]) {
    const address = await runtime.resolveExport(module, name);
    const actual = await runtime.callGuest(address, args, convention);
    assert.equal(actual, expected);
    report.cases.push({ export: name, expected, actual, passed: true });
  }
  // Preserve the actual next boundary: the Wine Unix syscall dispatcher has
  // not been installed. A pure export pass must not conceal this limitation.
  try {
    const queryTime = await runtime.resolveExport(module, 'NtQuerySystemTime');
    await runtime.callGuest(queryTime, [runtime.allocate(8)]);
    report.ntHostProbe = { status: 'unexpectedly-returned', export: 'NtQuerySystemTime' };
    throw Error('Reassess NT host evidence: the previously blocked syscall now returns');
  } catch (error) {
    if (!error.message.includes('Execute outside code at 0x0')) throw error;
    report.ntHostProbe = {
      status: 'blocked',
      export: 'NtQuerySystemTime',
      error: error.message,
      reason:
        'The unmodified Wine syscall stub calls its not-yet-installed Unix dispatcher pointer.',
    };
  }
  report.status = 'passed-selected-exports';
} catch (error) {
  report.status = 'blocked';
  report.error = error.stack || error.message;
  process.exitCode = 1;
} finally {
  report.blocks = runtime.blocks;
  report.instructions = runtime.cpu.instructions;
  report.compiledBlocks = runtime.cpu.cache.size;
  report.apiTrace = runtime.apiTrace;
  await mkdir('evidence', { recursive: true });
  await writeFile('evidence/wine-ntdll-results.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
