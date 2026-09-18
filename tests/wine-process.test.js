import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { PROCESS_LAYOUT } from '../src/process-layout.js';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';
import { PEB_PROCESS_HEAP, initializeWineProcess } from '../src/wine-process.js';
import { PEB_FAST_LOCK, PEB_PROCESS_PARAMETERS } from '../src/wine-parameters.js';
import { PEB_NLS_POINTERS } from '../src/wine-nls-process.js';
import { processApis } from '../src/win32-process.js';

const fixture = new URL('./fixtures/wine-nt/ntdll.dll', import.meta.url);
const consoleExe = new URL('../public/demos/console/console.exe', import.meta.url);
const heapExportNames = ['RtlCreateHeap', 'RtlAllocateHeap', 'RtlFreeHeap', 'RtlDestroyHeap'];

async function makeRuntime(dllBytes) {
  const exe = new Uint8Array(await readFile(consoleExe));
  const dll = dllBytes ?? new Uint8Array(await readFile(fixture));
  return new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    builtinFiles: new Map([['ntdll.dll', dll]]),
  });
}

function addHeapExports(module) {
  // Runtime tests intercept these addresses, so their RVAs need only be unique
  // and image-bounded; the portable fixture intentionally has no heap code.
  heapExportNames.forEach((name, i) => {
    module.pe.exports.push({ name, ordinal: 0x700 + i, rva: 0x100 + i * 4 });
  });
}

function installStubHeap(
  runtime,
  { parameters = false, failParameters = false, nls = false, rejectAttach = false } = {},
) {
  const initialize = runtime.initializeModules.bind(runtime);
  const originalCall = runtime.callGuest.bind(runtime);
  const modules = new WeakSet();
  const events = [];
  runtime.initializeModules = async function () {
    const module = this.graph.modules.get('ntdll.dll');
    if (module && !modules.has(module)) {
      addHeapExports(module);
      if (parameters)
        [
          'RtlInitializeCriticalSectionEx',
          'RtlCreateProcessParametersEx',
          'RtlCreateEnvironment',
          'RtlSetCurrentEnvironment',
        ].forEach((name, i) =>
          module.pe.exports.push({ name, ordinal: 0x710 + i, rva: 0x200 + i * 4 }),
        );
      if (nls)
        ['RtlInitNlsTables', 'RtlResetRtlTranslations'].forEach((name, i) =>
          module.pe.exports.push({ name, ordinal: 0x720 + i, rva: 0x300 + i * 4 }),
        );
      modules.add(module);
    }
    return initialize();
  };
  runtime.callGuest = async function (address, args = [], convention = 'stdcall') {
    const module = this.graph.modules.get('ntdll.dll');
    if (module) {
      const exported = module.pe.exports.find((entry) => module.base + entry.rva === address);
      if (['RtlInitNlsTables', 'RtlResetRtlTranslations'].includes(exported?.name)) return 0;
      if (exported?.name === 'RtlCreateHeap') {
        events.push({ kind: 'create', args, pebHeap: this.read32(PEB_PROCESS_HEAP) });
        const result = this.virtualMemory.allocate(0, 0x1000, 0x3000, 4);
        assert.equal(result.status, 0, 'stub heap obtains a real VM reservation');
        return result.base;
      }
      if (exported?.name === 'RtlInitializeCriticalSectionEx') {
        events.push({ kind: 'initialize-lock', args });
        this.write32(args[0] + 4, 0xffffffff);
        return 0;
      }
      if (exported?.name === 'RtlCreateProcessParametersEx') {
        events.push({ kind: 'parameters', args });
        assert.ok(this.read32(PEB_FAST_LOCK));
        if (failParameters) throw Error('synthetic parameter failure');
        this.write32(args[0], this.read32(PEB_PROCESS_HEAP) + 128);
        return 0;
      }
      if (exported?.name === 'RtlCreateEnvironment') {
        this.write32(args[1], this.read32(PEB_PROCESS_HEAP) + 96);
        return 0;
      }
      if (exported?.name === 'RtlSetCurrentEnvironment') {
        this.write32(this.read32(PEB_PROCESS_PARAMETERS) + 0x48, args[0]);
        return 0;
      }
      if (exported?.name === 'RtlAllocateHeap') {
        events.push({ kind: 'allocate', args });
        return parameters ? args[0] + 64 : 0x12345678;
      }
      if (exported?.name === 'RtlFreeHeap') {
        events.push({ kind: 'free', args });
        return 1;
      }
      if (exported?.name === 'RtlDestroyHeap') {
        events.push({ kind: 'destroy', args });
        return 1;
      }
      if (address === module.pe.entryPoint && args[1] === 1) {
        events.push({ kind: 'attach', pebHeap: this.read32(PEB_PROCESS_HEAP) });
        if (rejectAttach) return 0;
      }
    }
    return originalCall(address, args, convention);
  };
  return events;
}

test('Wine process heap is created before DLL attach, published in the PEB, and backs Win32 heap APIs', async () => {
  const runtime = await makeRuntime();
  const events = installStubHeap(runtime);
  await runtime.loadLibrary('ntdll.dll');

  assert.deepEqual(
    events.map((event) => event.kind),
    ['create', 'attach'],
  );
  assert.deepEqual(events[0].args, [2, 0, 0, 0, 0, 0]);
  assert.equal(events[0].pebHeap, 0, 'PEB is not published before RtlCreateHeap runs');
  assert.equal(events[1].pebHeap, runtime.wineProcess.heap, 'DllMain sees the process heap');
  assert.equal(runtime.read32(PEB_PROCESS_HEAP), runtime.wineProcess.heap);

  const getHeap = processApis['kernel32.dll!GetProcessHeap'];
  const heap = getHeap(runtime).result;
  assert.equal(heap, runtime.wineProcess.heap, 'GetProcessHeap returns the retained guest heap');
  const args = [heap, 8, 64];
  const allocated = await processApis['kernel32.dll!HeapAlloc'](runtime, (i) => args[i]);
  assert.equal(allocated.result, 0x12345678);
  assert.deepEqual(events.at(-1), { kind: 'allocate', args });
  const freeArgs = [heap, 0, allocated.result];
  const freed = await processApis['kernel32.dll!HeapFree'](runtime, (i) => freeArgs[i]);
  assert.equal(freed.result, 1);
  assert.deepEqual(events.at(-1), { kind: 'free', args: freeArgs });
  assert.equal(runtime.wineProcess.reservations.length, 1);
  assert.ok(runtime.virtualMemory.reservations.has(runtime.wineProcess.reservations[0]));
});

test('failed RtlCreateHeap restores DLL image bytes and releases only new VM reservations', async () => {
  const base = 0x1000;
  const data = new Uint8Array(0x10000);
  data.fill(0x5a, base, base + 0x4000);
  const originalImage = data.slice(base, base + 0x4000);
  const reservations = new Map([[0x02000000, { base: 0x02000000 }]]);
  const freed = [];
  const runtime = {
    data,
    read32: () => 0,
    write32: () => {},
    virtualMemory: {
      reservations,
      free(address, size, type) {
        freed.push([address, size, type]);
        reservations.delete(address);
        return { status: 0 };
      },
    },
    async callGuest() {
      data.fill(0xa5, base, base + 0x4000);
      reservations.set(0x02010000, { base: 0x02010000 });
      throw Error('synthetic guest heap failure');
    },
  };
  const module = {
    ntBridge: { address: 1 },
    base,
    pe: {
      imageSize: 0x4000,
      exports: heapExportNames.map((name, i) => ({ name, rva: 0x100 + i * 4 })),
    },
  };

  await assert.rejects(initializeWineProcess(runtime, module), /synthetic guest heap failure/);
  assert.deepEqual(data.slice(base, base + 0x4000), originalImage);
  assert.deepEqual(freed, [[0x02010000, 0, 0x8000]]);
  assert.deepEqual([...reservations.keys()], [0x02000000], 'pre-existing VM allocation survives');
  assert.equal(runtime.wineProcess, undefined);
});

test('rejected DllMain rolls back bootstrap heap and VM state; a repeated load remains clean', async () => {
  const dll = new Uint8Array(await readFile(fixture));
  const pe = parsePE(dll, { allowDll: true });
  const entrySection = pe.sections.find(
    (section) =>
      pe.entryPointRva >= section.rva && pe.entryPointRva < section.rva + section.rawSize,
  );
  assert.ok(entrySection, 'fixture entry point has file-backed instructions');
  // Make the fixture reject process attach while retaining its NT dispatcher.
  dll.set([0x31, 0xc0, 0xc2, 12, 0], entrySection.rawOffset + pe.entryPointRva - entrySection.rva);

  const runtime = await makeRuntime(dll);
  const events = installStubHeap(runtime);
  const initialRegions = runtime.regions.length;
  const initialReservations = runtime.virtualMemory.reservations.size;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      runtime.loadLibrary('ntdll.dll'),
      /DllMain rejected process attach: ntdll\.dll/,
    );
    assert.equal(runtime.graph.modules.has('ntdll.dll'), false);
    assert.equal(runtime.wineProcess, undefined);
    assert.equal(runtime.read32(PEB_PROCESS_HEAP), 0);
    assert.equal(runtime.virtualMemory.reservations.size, initialReservations);
    assert.equal(runtime.regions.length, initialRegions);
  }
  assert.deepEqual(
    events.map((event) => event.kind),
    ['create', 'attach', 'create', 'attach'],
  );
  assert.ok(events.every((event) => event.kind !== 'attach' || event.pebHeap !== 0));
});

// Wine's native i386 debug ring starts one TEB past FS base, independently of
// where the browser runtime chooses to put its PEB.
test('Wine debug storage does not overwrite process data or the published heap', async () => {
  const runtime = await makeRuntime();
  installStubHeap(runtime);
  await runtime.loadLibrary('ntdll.dll');
  const peb = runtime.read32(runtime.cpu.fsBase + 0x30);
  const before = runtime.data.slice(peb, peb + 0x100);
  const debugStart = runtime.cpu.fsBase + PROCESS_LAYOUT.tebSize;
  for (let offset = 0; offset < PROCESS_LAYOUT.wineDebugSize; offset += 4)
    runtime.write32(debugStart + offset, 0x58494e55);
  assert.deepEqual(runtime.data.slice(peb, peb + 0x100), before);
  assert.equal(runtime.read32(peb + 8), runtime.pe.imageBase);
  assert.equal(runtime.read32(PEB_PROCESS_HEAP), runtime.wineProcess.heap);
});

test('parameter initialization failure rolls back the heap, PEB pointers and scratch allocations', async () => {
  const runtime = await makeRuntime();
  installStubHeap(runtime, { parameters: true, failParameters: true });
  const originalAllocations = [...runtime.heap.allocations];
  const originalReservations = [...runtime.virtualMemory.reservations];
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runtime.loadLibrary('ntdll.dll'), /synthetic parameter failure/);
    assert.equal(runtime.wineProcess, undefined);
    for (const pointer of [PEB_PROCESS_HEAP, PEB_FAST_LOCK, PEB_PROCESS_PARAMETERS])
      assert.equal(runtime.read32(pointer), 0);
    assert.deepEqual([...runtime.heap.allocations], originalAllocations);
    assert.deepEqual([...runtime.virtualMemory.reservations], originalReservations);
  }
});

test('rejected DLL attach rolls back successful Wine process parameters', async () => {
  const dll = new Uint8Array(await readFile(fixture));
  const pe = parsePE(dll, { allowDll: true });
  const section = pe.sections.find(
    (s) => pe.entryPointRva >= s.rva && pe.entryPointRva < s.rva + s.rawSize,
  );
  dll.set([0x31, 0xc0, 0xc2, 12, 0], section.rawOffset + pe.entryPointRva - section.rva);
  const runtime = await makeRuntime(dll);
  const events = installStubHeap(runtime, { parameters: true });
  const originalAllocations = [...runtime.heap.allocations];
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runtime.loadLibrary('ntdll.dll'), /DllMain rejected process attach/);
    assert.equal(runtime.wineProcess, undefined);
    for (const pointer of [PEB_PROCESS_HEAP, PEB_FAST_LOCK, PEB_PROCESS_PARAMETERS])
      assert.equal(runtime.read32(pointer), 0);
    assert.equal(runtime.virtualMemory.reservations.size, 0);
    assert.deepEqual([...runtime.heap.allocations], originalAllocations);
  }
  assert.equal(events.filter((event) => event.kind === 'parameters').length, 2);
});

test('rejected attach releases bootstrap NLS views without unmapping unrelated sections', async () => {
  const runtime = await makeRuntime();
  runtime.nls.files = new Map(
    ['c_1252.nls', 'c_437.nls', 'l_intl.nls'].map((name) => [name, Uint8Array.of(1, 2, 3, 4)]),
  );
  installStubHeap(runtime, { parameters: true, nls: true, rejectAttach: true });
  const unrelated = runtime.sectionViews.map(Uint8Array.of(42), { name: 'unrelated' });
  const allocations = [...runtime.heap.allocations];
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runtime.loadLibrary('ntdll.dll'), /DllMain rejected process attach/);
    assert.equal(runtime.wineProcess, undefined);
    assert.deepEqual([...runtime.sectionViews.views.keys()], [unrelated.base]);
    assert.equal(runtime.data[unrelated.base], 42);
    assert.equal(runtime.virtualMemory.reservations.size, 0);
    assert.deepEqual([...runtime.heap.allocations], allocations);
    for (const pointer of Object.values(PEB_NLS_POINTERS)) assert.equal(runtime.read32(pointer), 0);
  }
});
