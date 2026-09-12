import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';
import { PEB_PROCESS_HEAP, initializeWineProcess } from '../src/wine-process.js';
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

function installStubHeap(runtime) {
  const initialize = runtime.initializeModules.bind(runtime);
  const originalCall = runtime.callGuest.bind(runtime);
  const modules = new WeakSet();
  const events = [];
  runtime.initializeModules = async function () {
    const module = this.graph.modules.get('ntdll.dll');
    if (module && !modules.has(module)) {
      addHeapExports(module);
      modules.add(module);
    }
    return initialize();
  };
  runtime.callGuest = async function (address, args = [], convention = 'stdcall') {
    const module = this.graph.modules.get('ntdll.dll');
    if (module) {
      const exported = module.pe.exports.find((entry) => module.base + entry.rva === address);
      if (exported?.name === 'RtlCreateHeap') {
        events.push({ kind: 'create', args, pebHeap: this.read32(PEB_PROCESS_HEAP) });
        const result = this.virtualMemory.allocate(0, 0x1000, 0x3000, 4);
        assert.equal(result.status, 0, 'stub heap obtains a real VM reservation');
        return result.base;
      }
      if (exported?.name === 'RtlAllocateHeap') {
        events.push({ kind: 'allocate', args });
        return 0x12345678;
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
