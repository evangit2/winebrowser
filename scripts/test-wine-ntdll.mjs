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
    'Whole unmodified Wine DLL: real process attach and selected pure exports. Includes NT clocks, virtual memory and the native Wine heap; not general application compatibility.',
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
  const time = runtime.allocate(8);
  const queryTime = await runtime.resolveExport(module, 'NtQuerySystemTime');
  const before = Date.now();
  assert.equal(await runtime.callGuest(queryTime, [time]), 0);
  const after = Date.now();
  const milliseconds = Number(
    (runtime.view.getBigInt64(time, true) - 116444736000000000n) / 10000n,
  );
  assert.ok(milliseconds >= before && milliseconds <= after);
  assert.equal(await runtime.callGuest(queryTime, [0]), 0xc0000005);
  report.cases.push({
    export: 'NtQuerySystemTime',
    status: 0,
    before,
    after,
    milliseconds,
    invalidPointerStatus: 0xc0000005,
    passed: true,
  });
  const queryCounter = await runtime.resolveExport(module, 'NtQueryPerformanceCounter');
  const frequency = runtime.allocate(8);
  assert.equal(await runtime.callGuest(queryCounter, [time, frequency]), 0);
  const firstCounter = runtime.view.getBigInt64(time, true);
  assert.equal(runtime.view.getBigInt64(frequency, true), 1000000000n);
  assert.equal(await runtime.callGuest(queryCounter, [time, 0]), 0);
  assert.ok(runtime.view.getBigInt64(time, true) >= firstCounter);
  report.cases.push({
    export: 'NtQueryPerformanceCounter',
    frequency: 1000000000,
    monotonic: true,
    passed: true,
  });
  const basePointer = runtime.allocate(4),
    sizePointer = runtime.allocate(4);
  const allocateMemory = await runtime.resolveExport(module, 'NtAllocateVirtualMemory');
  const freeMemory = await runtime.resolveExport(module, 'NtFreeVirtualMemory');
  runtime.write32(sizePointer, 8192);
  assert.equal(
    await runtime.callGuest(allocateMemory, [0xffffffff, basePointer, 0, sizePointer, 0x2000, 4]),
    0,
  );
  const base = runtime.read32(basePointer);
  assert.throws(() => runtime.read32(base), /read violation/);
  assert.equal(
    await runtime.callGuest(allocateMemory, [0xffffffff, basePointer, 0, sizePointer, 0x1000, 4]),
    0,
  );
  assert.equal(runtime.read32(base), 0);
  runtime.write32(base, 0x12345678);
  assert.equal(
    await runtime.callGuest(freeMemory, [0xffffffff, basePointer, sizePointer, 0x4000]),
    0,
  );
  assert.throws(() => runtime.read32(base), /read violation/);
  assert.equal(
    await runtime.callGuest(allocateMemory, [0xffffffff, basePointer, 0, sizePointer, 0x1000, 4]),
    0,
  );
  assert.equal(runtime.read32(base), 0);
  runtime.write32(sizePointer, 0);
  assert.equal(
    await runtime.callGuest(freeMemory, [0xffffffff, basePointer, sizePointer, 0x8000]),
    0,
  );
  assert.equal(runtime.read32(sizePointer), 8192);
  assert.throws(() => runtime.read32(base), /read violation/);
  report.cases.push({
    export: 'NtAllocateVirtualMemory/NtFreeVirtualMemory',
    base,
    size: 8192,
    reserveCommitDecommitRecommitRelease: true,
    accessEnforced: true,
    recommitZeroed: true,
    passed: true,
  });
  try {
    const close = await runtime.resolveExport(module, 'NtClose');
    await runtime.callGuest(close, [0x1234]);
    throw Error('Reassess NT host evidence: previously unsupported service now returns');
  } catch (error) {
    if (!error.message.includes('Unsupported Wine NT service NtClose')) throw error;
    report.ntHostProbe = {
      status: 'blocked',
      export: 'NtClose',
      error: error.message,
      reason: 'Clock dispatch works; NT handle/object services are not yet implemented.',
    };
  }
  const call = async (name, args) =>
    runtime.callGuest(await runtime.resolveExport(module, name), args);
  const processHeap = runtime.wineProcess.heap;
  assert.equal(runtime.read32(0x2e01018), processHeap);
  assert.equal(runtime.apiProvider.get('kernel32.dll!GetProcessHeap')(runtime).result, processHeap);
  assert.equal(
    await call('RtlDestroyHeap', [processHeap]),
    processHeap,
    'Wine refuses to destroy its process heap',
  );
  const reservationsBefore = [...runtime.virtualMemory.reservations.keys()];
  const heap = await call('RtlCreateHeap', [0, 0, 0, 0, 0, 0]);
  assert.ok(heap && heap !== processHeap);
  const allocations = [];
  for (const [index, size] of [32, 64, 1000, 65536, 200000].entries()) {
    const pointer = await call('RtlAllocateHeap', [heap, 8, size]);
    assert.ok(pointer, `allocate ${size} bytes`);
    runtime.check(pointer, size, true);
    assert.ok(runtime.data.subarray(pointer, pointer + size).every((byte) => byte === 0));
    const pattern = 0x31 + index;
    runtime.data.fill(pattern, pointer, pointer + size);
    allocations.push({ pointer, size, pattern });
  }
  for (const { pointer, size, pattern } of allocations) {
    assert.ok(
      runtime.data.subarray(pointer, pointer + size).every((byte) => byte === pattern),
      'allocations retain independent contents',
    );
    assert.equal((await call('RtlFreeHeap', [heap, 0, pointer])) & 255, 1);
  }
  assert.equal(await call('RtlDestroyHeap', [heap]), 0);
  assert.deepEqual(
    [...runtime.virtualMemory.reservations.keys()],
    reservationsBefore,
    'destroying the private heap releases all its virtual reservations',
  );
  assert.throws(() => runtime.read32(heap), /read violation/);
  // Kernel32 wrappers use the same native process heap; old host allocations
  // remain valid on their original handle when Wine is loaded dynamically.
  const allocate = runtime.apiProvider.get('kernel32.dll!HeapAlloc');
  const free = runtime.apiProvider.get('kernel32.dll!HeapFree');
  for (const handle of [processHeap, 0x50000000]) {
    const { result: pointer } = await allocate(runtime, (i) => [handle, 8, 48][i]);
    assert.ok(pointer);
    assert.ok(runtime.data.subarray(pointer, pointer + 48).every((byte) => byte === 0));
    assert.equal((await free(runtime, (i) => [handle, 0, pointer][i])).result, 1);
  }
  report.cases.push({
    export: 'RtlCreateHeap/RtlAllocateHeap/RtlFreeHeap/RtlDestroyHeap',
    processHeap,
    privateHeap: heap,
    allocations,
    zeroed: true,
    independentContents: true,
    privateHeapReservationsReleased: true,
    processHeapDestroyRefused: true,
    kernel32AndLegacyHeapInterop: true,
    passed: true,
  });
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
