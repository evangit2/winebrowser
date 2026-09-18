import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { PEB_PROCESS_HEAP, PROCESS_LAYOUT } from '../src/process-layout.js';
import { PEB_FAST_LOCK, PEB_PROCESS_PARAMETERS } from '../src/wine-parameters.js';
import { PROCESS_USER_SID } from '../src/process-identity.js';
import { PEB_NLS_POINTERS } from '../src/wine-nls-process.js';
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
const nlsDirectory = process.argv[3] || process.env.WINEBROWSER_NLS_DIR;
const nlsFiles = new Map();
const nlsEvidence = [];
if (nlsDirectory) {
  const manifest = JSON.parse(await readFile('runtime/wine/nls-probe-manifest.json', 'utf8'));
  for (const name of ['c_1252.nls', 'c_437.nls', 'l_intl.nls']) {
    const data = new Uint8Array(await readFile(path.join(nlsDirectory, name)));
    const hash = createHash('sha256').update(data).digest('hex');
    assert.equal(hash, manifest.files[name].sha256, `NLS hash ${name}`);
    assert.equal(data.length, manifest.files[name].bytes, `NLS length ${name}`);
    nlsFiles.set(name, data);
    nlsEvidence.push({ name, bytes: data.length, sha256: hash });
  }
}
const exe = 'console.exe';
const report = {
  date: new Date().toISOString(),
  dll: { name: 'ntdll.dll', sha256, bytes: bytes.length },
  nls: nlsEvidence,
  scope:
    'Whole unmodified Wine DLL: real process attach and selected pure exports. Includes NT clocks, virtual memory and the native Wine heap; not general application compatibility.',
  cases: [],
};
const runtime = new Runtime(iced, {
  files: new Map([[exe, new Uint8Array(await readFile('public/demos/console/console.exe'))]]),
  exe,
  builtinFiles: new Map([['ntdll.dll', bytes]]),
  args: ['argument with spaces', ''],
  nlsFiles,
});
try {
  await runtime.loadLibrary('ntdll.dll');
  const module = runtime.graph.modules.get('ntdll.dll');
  assert.ok(module.initialized && module.mapped);
  report.modules = runtime.graph.describe();
  if (nlsFiles.size) {
    assert.equal(runtime.wineProcess.nls.initialized, true);
    for (const pointer of Object.values(PEB_NLS_POINTERS)) {
      const base = runtime.read32(pointer);
      assert.ok(runtime.sectionViews.views.has(base));
      assert.throws(() => runtime.write32(base, 0), /write violation/);
    }
    assert.equal(runtime.read32(await runtime.resolveExport(module, 'NlsAnsiCodePage')), 1252);
    const upcase = await runtime.resolveExport(module, 'RtlUpcaseUnicodeChar');
    assert.equal(await runtime.callGuest(upcase, [0x00e9]), 0x00c9);
    const input = runtime.allocate(1),
      output = runtime.allocate(2),
      length = runtime.allocate(4);
    runtime.data[input] = 0x80;
    const convert = await runtime.resolveExport(module, 'RtlMultiByteToUnicodeN');
    assert.equal(await runtime.callGuest(convert, [output, 2, length, input, 1]), 0);
    assert.equal(runtime.read32(length), 2);
    assert.equal(runtime.view.getUint16(output, true), 0x20ac);
    runtime.data[input] = 0x82;
    const convertOem = await runtime.resolveExport(module, 'RtlOemToUnicodeN');
    assert.equal(await runtime.callGuest(convertOem, [output, 2, length, input, 1]), 0);
    assert.equal(runtime.view.getUint16(output, true), 0x00e9);

    report.cases.push({
      export:
        'RtlInitNlsTables/RtlResetRtlTranslations/RtlUpcaseUnicodeChar/RtlMultiByteToUnicodeN',
      ansiCodePage: 1252,
      oemCodePage: 437,
      unicodeCaseMapping: true,
      euroByteConverted: true,
      immutableTables: true,
      passed: true,
    });
  }
  const parameters = runtime.read32(PEB_PROCESS_PARAMETERS);
  const lock = runtime.read32(PEB_FAST_LOCK);
  assert.equal(parameters, runtime.wineProcess.parameters);
  assert.equal(lock, runtime.wineProcess.lock);
  assert.equal(runtime.read32(parameters + 8), 1, 'normalized process parameters');
  assert.equal(runtime.read32(parameters + 0x1c), 1, 'stdout matches the browser console');
  assert.equal(runtime.read32(parameters + 0x20), 2, 'stderr matches the browser console');
  assert.equal(runtime.wideString(runtime.read32(parameters + 0x3c)), exe);
  assert.equal(
    runtime.wideString(runtime.read32(parameters + 0x44)),
    'console.exe "argument with spaces" ""',
  );
  const commandLine = runtime.apiProvider.get('kernel32.dll!GetCommandLineW')(runtime).result;
  assert.equal(
    runtime.wideString(commandLine),
    runtime.wideString(runtime.read32(parameters + 0x44)),
  );
  assert.equal(runtime.wideString(runtime.read32(parameters + 0x48)), '');
  const environmentSize = await runtime.callGuest(
    await runtime.resolveExport(module, 'RtlSizeHeap'),
    [runtime.wineProcess.heap, 0, runtime.read32(parameters + 0x48)],
  );
  assert.ok(
    environmentSize >= 2 && environmentSize < 64,
    'environment is its own valid Wine heap allocation',
  );
  const acquireLock = await runtime.resolveExport(module, 'RtlAcquirePebLock');
  const releaseLock = await runtime.resolveExport(module, 'RtlReleasePebLock');
  await runtime.callGuest(acquireLock, []);
  await runtime.callGuest(acquireLock, []);
  assert.equal(runtime.read32(lock + 8), 2, 'recursive acquisition is guest Wine behavior');
  assert.equal(runtime.read32(lock + 12), 1, 'TEB thread identity owns the lock');
  await runtime.callGuest(releaseLock, []);
  await runtime.callGuest(releaseLock, []);
  assert.equal(runtime.read32(lock + 4), 0xffffffff);
  assert.equal(runtime.read32(lock + 8), 0);
  const name = runtime.allocString('WINEBROWSER_ABSENT', true);
  const queryName = runtime.allocate(8);
  runtime.guestMemory.write(queryName, 17 * 2, 2);
  runtime.guestMemory.write(queryName + 2, 18 * 2, 2);
  runtime.write32(queryName + 4, name);
  const queryValue = runtime.allocate(8);
  const queryEnvironment = await runtime.resolveExport(module, 'RtlQueryEnvironmentVariable_U');
  assert.equal(await runtime.callGuest(queryEnvironment, [0, queryName, queryValue]), 0xc0000100);
  assert.equal(runtime.read32(lock + 8), 0, 'environment lookup releases the PEB lock');
  const setEnvironment = await runtime.resolveExport(module, 'RtlSetEnvironmentVariable');
  const unicode = (value) => {
    const descriptor = runtime.allocate(8);
    runtime.guestMemory.write(descriptor, value.length * 2, 2);
    runtime.guestMemory.write(descriptor + 2, (value.length + 1) * 2, 2);
    runtime.write32(descriptor + 4, runtime.allocString(value, true));
    return descriptor;
  };
  const environmentName = unicode('WineBrowser_Value');
  const environmentQueryName = unicode('winebrowser_value');
  const valueBuffer = runtime.allocate(1024);
  runtime.guestMemory.write(queryValue + 2, 1024, 2);
  runtime.write32(queryValue + 4, valueBuffer);
  for (const value of ['déjà vu ✓', 'longer environment value '.repeat(10)]) {
    assert.equal(await runtime.callGuest(setEnvironment, [0, environmentName, unicode(value)]), 0);
    assert.equal(
      await runtime.callGuest(queryEnvironment, [0, environmentQueryName, queryValue]),
      0,
    );
    assert.equal(runtime.wideString(valueBuffer), value);
  }
  assert.equal(await runtime.callGuest(setEnvironment, [0, environmentName, 0]), 0);
  assert.equal(
    await runtime.callGuest(queryEnvironment, [0, environmentQueryName, queryValue]),
    0xc0000100,
  );
  assert.equal(
    runtime.wideString(runtime.read32(parameters + 0x44)),
    'console.exe "argument with spaces" ""',
  );

  report.cases.push({
    export:
      'RtlCreateProcessParametersEx/RtlAcquirePebLock/RtlReleasePebLock/RtlQueryEnvironmentVariable_U',
    normalizedParameters: true,
    quotedCommandLine: true,
    isolatedEmptyEnvironment: true,
    independentlyOwnedEnvironment: true,
    environmentSetGrowQueryDelete: true,
    recursiveLockOwnership: true,
    missingVariableStatus: '0xc0000100',
    passed: true,
  });
  const tokenBuffer = runtime.allocate(80);
  const tokenLength = runtime.allocate(4);
  const queryToken = await runtime.resolveExport(module, 'NtQueryInformationToken');
  assert.equal(
    await runtime.callGuest(queryToken, [0xfffffffa, 1, tokenBuffer, 80, tokenLength]),
    0,
  );
  assert.equal(runtime.read32(tokenLength), 36);
  const validSid = await runtime.resolveExport(module, 'RtlValidSid');
  assert.equal((await runtime.callGuest(validSid, [runtime.read32(tokenBuffer)])) & 255, 1);
  const currentUserPath = runtime.allocate(8);
  const formatUserPath = await runtime.resolveExport(module, 'RtlFormatCurrentUserKeyPath');
  assert.equal(await runtime.callGuest(formatUserPath, [currentUserPath]), 0);
  assert.equal(
    runtime.wideString(runtime.read32(currentUserPath + 4)),
    '\\Registry\\User\\' + PROCESS_USER_SID,
  );
  await runtime.callGuest(await runtime.resolveExport(module, 'RtlFreeUnicodeString'), [
    currentUserPath,
  ]);
  const userKey = runtime.allocate(4);
  const openCurrentUser = await runtime.resolveExport(module, 'RtlOpenCurrentUser');
  assert.equal(await runtime.callGuest(openCurrentUser, [1, userKey]), 0);
  assert.equal(
    await runtime.callGuest(await runtime.resolveExport(module, 'NtClose'), [
      runtime.read32(userKey),
    ]),
    0,
  );
  report.cases.push({
    export:
      'NtQueryInformationToken/RtlValidSid/RtlFormatCurrentUserKeyPath/RtlOpenCurrentUser/NtClose',
    isolatedUserSid: PROCESS_USER_SID,
    currentUserHiveOpened: true,
    passed: true,
  });
  // Exercise the unchanged Wine helper that originally overwrote our PEB.
  const debugString = await runtime.resolveExport(module, '__wine_dbg_strdup');
  const pebBefore = runtime.data.slice(PROCESS_LAYOUT.peb, PROCESS_LAYOUT.peb + 0x100);
  const debugStart = PROCESS_LAYOUT.teb + PROCESS_LAYOUT.tebSize;
  for (const value of ['WINEUNIXCP', 'x'.repeat(900), 'y'.repeat(900)]) {
    const pointer = await runtime.callGuest(debugString, [runtime.allocString(value)], 'cdecl');
    assert.ok(pointer >= debugStart && pointer < debugStart + PROCESS_LAYOUT.wineDebugSize);
    assert.deepEqual(
      runtime.data.slice(pointer, pointer + value.length + 1),
      new TextEncoder().encode(value + '\0'),
    );
    assert.deepEqual(runtime.data.slice(PROCESS_LAYOUT.peb, PROCESS_LAYOUT.peb + 0x100), pebBefore);
    assert.equal(runtime.read32(PEB_PROCESS_HEAP), runtime.wineProcess.heap);
  }
  report.cases.push({
    export: '__wine_dbg_strdup',
    ringBufferWrap: true,
    processDataPreserved: true,
    passed: true,
  });
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
  const queryProcess = await runtime.resolveExport(module, 'NtQueryInformationProcess');
  const wow64 = runtime.allocate(4),
    returnLength = runtime.allocate(4);
  runtime.write32(wow64, 0xdeadbeef);
  assert.equal(await runtime.callGuest(queryProcess, [0xffffffff, 26, wow64, 4, returnLength]), 0);
  assert.equal(runtime.read32(wow64), 0);
  assert.equal(runtime.read32(returnLength), 4);
  report.cases.push({
    export: 'NtQueryInformationProcess',
    informationClass: 'ProcessWow64Information',
    wow64Peb: 0,
    returnLength: 4,
    dispatch: 'FS:[0xc0]',
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
  assert.equal(runtime.read32(PEB_PROCESS_HEAP), processHeap);
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
