import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';

const fixtureUrl = new URL('./fixtures/wine-nt/ntdll.dll', import.meta.url);
const consoleUrl = new URL('../public/demos/console/console.exe', import.meta.url);

async function runtimeWithWineNt(dllBytes) {
  const executable = new Uint8Array(await readFile(consoleUrl));
  const dll = dllBytes ?? new Uint8Array(await readFile(fixtureUrl));
  const parsedDll = parsePE(dll, { allowDll: true });
  const dispatcherExport = parsedDll.exports.find(
    (entry) => entry.name === '__wine_syscall_dispatcher',
  );
  const dispatcherSection = parsedDll.sections.find(
    (section) =>
      dispatcherExport.rva >= section.rva && dispatcherExport.rva < section.rva + section.rawSize,
  );
  assert.ok(dispatcherSection, 'dispatcher data export has file-backed storage');
  assert.equal(
    new DataView(dll.buffer, dll.byteOffset, dll.byteLength).getUint32(
      dispatcherSection.rawOffset + dispatcherExport.rva - dispatcherSection.rva,
      true,
    ),
    0,
    'fixture dispatcher data pointer starts unset',
  );
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
    builtinFiles: new Map([['ntdll.dll', dll]]),
  });
  const base = await runtime.loadLibrary('ntdll.dll');
  const module = runtime.graph.modules.get('ntdll.dll');
  assert.equal(base, module.base);
  return { runtime, module };
}

function exportAddress(runtime, module, name) {
  const target = runtime.graph.resolve(module, name);
  assert.equal(target.module, module);
  return runtime.graph.address(target);
}

test('Wine NT clock services dispatch through the guest dispatcher and preserve stdcall cleanup', async () => {
  const { runtime, module } = await runtimeWithWineNt();
  assert.deepEqual(module.pe.imports, [], 'fixture DLL has no imports or CRT dependency');
  assert.equal(module.pe.directories[9]?.rva ?? 0, 0, 'fixture DLL has no TLS directory');
  assert.equal(module.pe.directories[9]?.size ?? 0, 0, 'fixture DLL has no TLS directory');
  assert.equal(module.pe.preferredImageBase, 0x10000000);
  assert.equal(module.base, 0x01000000, 'DLL is relocated into the guest image range');
  assert.equal(module.host, undefined, 'ntdll is an executable guest DLL');
  assert.equal(module.initialized, true, 'native DLL entry point accepted process attach');
  assert.ok(module.ntBridge?.address, 'Wine NT dispatcher thunk was installed');
  assert.equal(module.ntBridge.version, 1);
  assert.equal(module.ntBridge.tebSlot, runtime.cpu.fsBase + 0xc0);
  assert.equal(
    runtime.read32(
      module.base +
        module.pe.exports.find((entry) => entry.name === '__wine_syscall_dispatcher').rva,
    ),
    module.ntBridge.address,
    'exported dispatch pointer was populated',
  );
  assert.equal(
    runtime.read32(runtime.cpu.fsBase + 0xc0),
    module.ntBridge.address,
    'Wine TEB WOW32Reserved points to the same validated host dispatcher',
  );
  assert.deepEqual(
    [...runtime.thunks.values()]
      .filter((thunk) => thunk.kind === 'wine-nt')
      .map((thunk) => [...thunk.services.values()].map((service) => service.name).sort())
      .flat()
      .sort(),
    [
      'NtAllocateVirtualMemory',
      'NtClose',
      'NtFreeVirtualMemory',
      'NtQueryInformationProcess',
      'NtQueryPerformanceCounter',
      'NtQuerySystemTime',
      'NtSetInformationProcess',
    ],
  );

  const queryTime = exportAddress(runtime, module, 'NtQuerySystemTime');
  const timeOutput = runtime.allocate(8);
  const stackBefore = runtime.cpu.r[4].value;
  const before = Date.now();
  assert.equal(await runtime.callGuest(queryTime, [timeOutput]), 0);
  const after = Date.now();
  assert.equal(runtime.cpu.r[4].value, stackBefore, 'wrapper RET 4 restored the callback stack');
  const fileTime = runtime.view.getBigInt64(timeOutput, true);
  const unixMilliseconds = Number(fileTime - 116444736000000000n) / 10000;
  assert.ok(
    unixMilliseconds >= before && unixMilliseconds <= after,
    `FILETIME converts to a time between ${before} and ${after}, got ${unixMilliseconds}`,
  );
  assert.equal(
    await runtime.callGuest(queryTime, [0x40000000]),
    0xc0000005,
    'an invalid output pointer returns STATUS_ACCESS_VIOLATION',
  );

  const queryCounter = exportAddress(runtime, module, 'NtQueryPerformanceCounter');
  const counter = runtime.allocate(8),
    frequency = runtime.allocate(8);
  assert.equal(await runtime.callGuest(queryCounter, [counter, frequency]), 0);
  const firstCounter = runtime.view.getBigInt64(counter, true);
  assert.equal(runtime.view.getBigInt64(frequency, true), 1000000000n);
  assert.equal(await runtime.callGuest(queryCounter, [counter, frequency]), 0);
  const secondCounter = runtime.view.getBigInt64(counter, true);
  assert.ok(secondCounter >= firstCounter, 'performance counter is monotonic');
  assert.equal(runtime.view.getBigInt64(frequency, true), 1000000000n);
  assert.equal(
    await runtime.callGuest(queryCounter, [0x40000000, 0]),
    0xc0000005,
    'invalid counter output returns STATUS_ACCESS_VIOLATION',
  );

  const close = exportAddress(runtime, module, 'NtClose');
  await assert.rejects(
    runtime.callGuest(close, [0]),
    /Unsupported Wine NT service NtClose/,
    'unimplemented NT services fail explicitly instead of inventing an NTSTATUS',
  );
  const queryProcess = exportAddress(runtime, module, 'NtQueryInformationProcess');
  const stackBeforeUnknown = runtime.cpu.r[4].value;
  await assert.rejects(
    runtime.callGuest(queryProcess, [0xffffffff, 0, 0, 0, 0]),
    /Unsupported Wine process information class 0/,
    'the FS:C0 entry reaches process information dispatch and rejects unsupported classes',
  );
  assert.equal(
    runtime.cpu.r[4].value,
    stackBeforeUnknown,
    'failed dispatch restores the guest stack',
  );
  assert.ok(runtime.apiTrace.includes('ntdll.dll!NtQuerySystemTime'));
  assert.ok(runtime.apiTrace.includes('ntdll.dll!NtQueryPerformanceCounter'));
});

test('FS syscall wrappers report the real PE32 process architecture and validate output buffers', async () => {
  const { runtime, module } = await runtimeWithWineNt();
  const address = exportAddress(runtime, module, 'NtQueryInformationProcess');
  const output = runtime.allocate(4),
    length = runtime.allocate(4);
  const query = (handle = 0xffffffff, size = 4, out = output, retLength = length) =>
    runtime.callGuest(address, [handle, 26, out, size, retLength]);
  runtime.write32(output, 0xdeadbeef);
  assert.equal(await query(), 0);
  assert.equal(runtime.read32(output), 0, 'there is no WOW64 companion process');
  assert.equal(runtime.read32(length), 4);
  runtime.write32(output, 0xdeadbeef);
  runtime.write32(length, 0xaabbccdd);
  assert.equal(await query(0xffffffff, 3), 0xc0000004);
  assert.equal(
    runtime.read32(length),
    0xaabbccdd,
    'wrong-sized WOW64 queries leave return length untouched',
  );
  assert.equal(await query(0), 0xc0000008);
  assert.equal(await query(0xffffffff, 4, 0), 0xc0000005);
  assert.equal(await query(0xffffffff, 4, output, 0x40000000), 0xc0000005);
  assert.equal(runtime.read32(output), 0xdeadbeef, 'invalid second output causes no partial write');
  assert.equal(await query(0xffffffff, 4, output, 0), 0);
  assert.ok(runtime.apiTrace.includes('ntdll.dll!NtQueryInformationProcess'));
});

test('process execute flags expose permanent browser DEP and reject policy changes', async () => {
  const { runtime, module } = await runtimeWithWineNt();
  const queryAddress = exportAddress(runtime, module, 'NtQueryInformationProcess');
  const setAddress = exportAddress(runtime, module, 'NtSetInformationProcess');
  const flags = runtime.allocate(4),
    length = runtime.allocate(4);
  const query = (handle = 0xffffffff, size = 4, out = flags, retLength = length) =>
    runtime.callGuest(queryAddress, [handle, 34, out, size, retLength]);
  const set = (value, handle = 0xffffffff, size = 4, pointer = flags) => {
    runtime.write32(flags, value);
    return runtime.callGuest(setAddress, [handle, 34, pointer, size]);
  };

  assert.equal(await query(), 0);
  assert.equal(runtime.read32(flags), 0x0d, 'DEP, no thunk emulation, and permanence are enforced');
  assert.equal(runtime.read32(length), 4);
  assert.equal(await set(0x0d), 0, 'an exact update matching the enforced policy succeeds');
  assert.equal(await set(0x02), 0xc0000022, 'enabling execution from guest data is denied');
  assert.equal(await set(0x01), 0xc0000022, 'removing permanent policy bits is denied');
  assert.equal(await set(0), 0xc000000d, 'an update without an execute selection is invalid');
  assert.equal(await set(3), 0xc000000d, 'conflicting execute selections are invalid');
  assert.equal(await set(0x0d, 0), 0xc0000008);
  assert.equal(await set(0x0d, 0xffffffff, 3), 0xc000000d);
  assert.equal(await set(0x0d, 0xffffffff, 4, 0x40000000), 0xc0000005);
  assert.equal(await query(), 0);
  assert.equal(runtime.read32(flags), 0x0d, 'failed updates cannot change browser DEP');
  assert.ok(runtime.apiTrace.includes('ntdll.dll!NtSetInformationProcess'));
});

test('Wine NT virtual-memory services reserve, commit, decommit, recommit, and release guest pages', async () => {
  const { runtime, module } = await runtimeWithWineNt();
  const allocateVirtualMemory = exportAddress(runtime, module, 'NtAllocateVirtualMemory');
  const freeVirtualMemory = exportAddress(runtime, module, 'NtFreeVirtualMemory');
  const process = 0xffffffff;
  const basePointer = runtime.allocate(4);
  const sizePointer = runtime.allocate(4);
  const initialReservations = runtime.virtualMemory.reservations.size;
  const initialRegions = runtime.regions.length;

  runtime.write32(basePointer, 0);
  runtime.write32(sizePointer, 0x1800);
  assert.equal(
    await runtime.callGuest(allocateVirtualMemory, [
      process,
      basePointer,
      0,
      sizePointer,
      0x2000,
      1,
    ]),
    0,
  );
  const base = runtime.read32(basePointer);
  assert.equal(base, 0x02000000);
  assert.equal(runtime.read32(sizePointer), 0x2000, 'reserve size is rounded to pages');
  assert.equal(runtime.virtualMemory.reservations.size, initialReservations + 1);
  assert.throws(
    () => runtime.read32(base),
    /Guest read violation/,
    'reserved pages remain inaccessible',
  );
  assert.throws(() => runtime.write32(base, 0x12345678), /Guest write violation/);

  runtime.write32(sizePointer, 0x2000);
  assert.equal(
    await runtime.callGuest(allocateVirtualMemory, [
      process,
      basePointer,
      0,
      sizePointer,
      0x1000,
      4,
    ]),
    0,
    'commit makes the reserved range read/write',
  );
  assert.equal(runtime.read32(base), 0, 'newly committed memory is zero-filled');
  runtime.write32(base, 0xdecafbad);
  assert.equal(runtime.read32(base), 0xdecafbad);

  runtime.write32(sizePointer, 0x2000);
  assert.equal(
    await runtime.callGuest(freeVirtualMemory, [process, basePointer, sizePointer, 0x4000]),
    0,
  );
  assert.throws(
    () => runtime.read32(base),
    /Guest read violation/,
    'decommitted pages are inaccessible',
  );

  runtime.write32(sizePointer, 0x2000);
  assert.equal(
    await runtime.callGuest(allocateVirtualMemory, [
      process,
      basePointer,
      0,
      sizePointer,
      0x1000,
      4,
    ]),
    0,
  );
  assert.equal(runtime.read32(base), 0, 'recommit clears the old contents');

  runtime.write32(sizePointer, 0);
  assert.equal(
    await runtime.callGuest(freeVirtualMemory, [process, basePointer, sizePointer, 0x8000]),
    0,
  );
  assert.throws(
    () => runtime.read32(base),
    /Guest read violation/,
    'released pages are no longer mapped',
  );
  assert.equal(runtime.virtualMemory.reservations.size, initialReservations);

  assert.equal(
    await runtime.callGuest(allocateVirtualMemory, [0, basePointer, 0, sizePointer, 0x2000, 1]),
    0xc0000008,
    'a non-current-process handle returns STATUS_INVALID_HANDLE',
  );
  assert.equal(
    runtime.virtualMemory.reservations.size,
    initialReservations,
    'invalid process handle has no allocation side effects',
  );
  assert.equal(
    runtime.regions.length,
    initialRegions,
    'invalid process handle does not add guest access regions',
  );
  assert.equal(
    await runtime.callGuest(allocateVirtualMemory, [
      process,
      0x40000000,
      0,
      sizePointer,
      0x2000,
      1,
    ]),
    0xc0000005,
    'an invalid output pointer returns STATUS_ACCESS_VIOLATION',
  );
  assert.equal(
    runtime.virtualMemory.reservations.size,
    initialReservations,
    'bad output pointers do not allocate guest pages',
  );
  assert.ok(runtime.apiTrace.includes('ntdll.dll!NtAllocateVirtualMemory'));
  assert.ok(runtime.apiTrace.includes('ntdll.dll!NtFreeVirtualMemory'));
});

test('Wine NT bridge rejects a malformed guest trampoline and rolls back the load', async () => {
  const bytes = new Uint8Array(await readFile(fixtureUrl));
  const pe = parsePE(bytes, { allowDll: true });
  const stub = pe.exports.find((entry) => entry.name === 'NtQueryPerformanceCounter');
  const stubSection = pe.sections.find(
    (section) => stub.rva >= section.rva && stub.rva < section.rva + section.rawSize,
  );
  const trampolineRva =
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      stubSection.rawOffset + stub.rva - stubSection.rva + 6,
      true,
    ) - pe.imageBase;
  const trampolineSection = pe.sections.find(
    (section) => trampolineRva >= section.rva && trampolineRva < section.rva + section.rawSize,
  );
  assert.ok(trampolineSection);
  bytes[trampolineSection.rawOffset + trampolineRva - trampolineSection.rva] = 0x90;

  const executable = new Uint8Array(await readFile(consoleUrl));
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
    builtinFiles: new Map([['ntdll.dll', bytes]]),
  });
  const regionsBefore = runtime.regions.length;
  await assert.rejects(runtime.loadLibrary('ntdll.dll'), /Unsupported Wine NT trampoline/);
  assert.equal(runtime.graph.modules.has('ntdll.dll'), false, 'failed bridge load is rolled back');
  assert.equal(runtime.regions.length, regionsBefore, 'failed mapping regions are rolled back');
});

test('Wine NT FS:C0 wrappers reject an already occupied TEB dispatcher slot', async () => {
  const executable = new Uint8Array(await readFile(consoleUrl));
  const dll = new Uint8Array(await readFile(fixtureUrl));
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
    builtinFiles: new Map([['ntdll.dll', dll]]),
  });
  runtime.write32(runtime.cpu.fsBase + 0xc0, 0x12345678);
  const regionsBefore = runtime.regions.length;
  await assert.rejects(
    runtime.loadLibrary('ntdll.dll'),
    /TEB syscall dispatcher is already installed/,
  );
  assert.equal(runtime.graph.modules.has('ntdll.dll'), false, 'rejected load is rolled back');
  assert.equal(
    runtime.regions.length,
    regionsBefore,
    'rejected TEB registration rolls back mappings',
  );
  assert.equal(runtime.read32(runtime.cpu.fsBase + 0xc0), 0x12345678, 'foreign slot is preserved');
});
