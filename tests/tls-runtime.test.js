import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';

const fixtureDir = new URL('./fixtures/tls/', import.meta.url);
const TLS_VECTOR_TEB_OFFSET = 0x2e0002c;

async function bytes(name) {
  return new Uint8Array(await readFile(new URL(name, fixtureDir)));
}

async function tlsAppRuntime({ dllBytes } = {}) {
  const app = await bytes('app.exe');
  const dll = dllBytes ?? (await bytes('tls.dll'));
  return new Runtime(iced, {
    files: new Map([
      ['app.exe', app],
      ['tls.dll', dll],
    ]),
    exe: 'app.exe',
  });
}

function exportEntry(module, name) {
  const exports = module.pe?.exports ?? module.exports;
  const entry = exports.find((candidate) => candidate.name === name);
  assert.ok(entry, `missing ${module.name}!${name} export`);
  return entry;
}

function exportedDword(runtime, module, name) {
  return runtime.read32(module.base + exportEntry(module, name).rva);
}

function exportedArray(runtime, module, name, count) {
  const address = module.base + exportEntry(module, name).rva;
  return Array.from({ length: count }, (_, index) => runtime.read32(address + index * 4));
}

function tlsPointer(runtime, module) {
  const tls = module.pe.tls;
  assert.ok(tls, `${module.name} should have static TLS`);
  const index = runtime.read32(module.base + tls.indexRva);
  const vector = runtime.read32(TLS_VECTOR_TEB_OFFSET);
  assert.ok(vector, 'TEB ThreadLocalStoragePointer should be populated');
  const pointer = runtime.read32(vector + index * 4);
  assert.ok(pointer, `${module.name} TLS vector slot should be populated`);
  return { index, vector, pointer };
}

test('native PE TLS templates, callback order, FS vector access, and per-module blocks work', async () => {
  const runtime = await tlsAppRuntime();
  const app = runtime.graph.main;
  const dll = runtime.graph.modules.get('tls.dll');
  assert.ok(app && dll);
  assert.equal(dll.pe.preferredImageBase, 0x10000000);
  assert.notEqual(dll.base, dll.pe.preferredImageBase, 'TLS DLL is relocated into guest memory');
  assert.ok(app.pe.tls && dll.pe.tls);
  assert.equal(app.pe.tls.templateSize, 4);
  assert.equal(app.pe.tls.zeroFill, 8);
  assert.equal(dll.pe.tls.templateSize, 4);
  assert.equal(dll.pe.tls.zeroFill, 8);
  assert.equal(app.pe.tls.callbackRvas.length, 1);
  assert.equal(dll.pe.tls.callbackRvas.length, 2);
  assert.deepEqual(
    dll.pe.imports.map(({ dll: importedDll, name }) => [importedDll, name]).sort(),
    [
      ['KERNEL32.dll', 'GetStdHandle'],
      ['KERNEL32.dll', 'WriteFile'],
    ],
    'DLL uses only real Win32 stdout imports and no C runtime',
  );
  assert.ok(
    dll.pe.sections.some((indexSection) => {
      return (
        dll.pe.tls.indexRva >= indexSection.rva &&
        dll.pe.tls.indexRva + 4 <=
          indexSection.rva + Math.max(indexSection.rawSize, indexSection.virtualSize) &&
        (indexSection.characteristics & 0x80000000) !== 0
      );
    }),
    'DLL TLS index is writable mapped data',
  );

  const output = [];
  runtime.emit = (event) => output.push(event);
  const result = await runtime.run();
  assert.equal(result.exitCode, 0, 'EXE validated initialized TLS before normal entry exit');
  assert.equal(
    output
      .filter(({ type }) => type === 'stdout')
      .map(({ text }) => text)
      .join(''),
    'TLS events:12349678\r\n',
    'native Wine process-detach callback ordering is observable through guest stdout',
  );
  assert.equal(dll.initialized, true, 'DLL DllMain accepted TLS callback order');

  const appTls = tlsPointer(runtime, app);
  const dllTls = tlsPointer(runtime, dll);
  assert.notEqual(appTls.index, dllTls.index, 'EXE and DLL receive distinct TLS indices');
  assert.notEqual(appTls.pointer, dllTls.pointer, 'EXE and DLL receive distinct TLS buffers');
  assert.equal(appTls.vector, dllTls.vector, 'both indices share the guest thread TLS vector');
  assert.equal(runtime.read32(appTls.vector + appTls.index * 4), appTls.pointer);
  assert.equal(runtime.read32(dllTls.vector + dllTls.index * 4), dllTls.pointer);

  assert.equal(runtime.read32(appTls.pointer), 0x87654321, 'EXE entry modified its own TLS word');
  assert.equal(
    runtime.read32(dllTls.pointer),
    0x4a3b2c1d,
    'EXE changed the DLL TLS word through its export',
  );
  for (const { pointer, module } of [
    { pointer: appTls.pointer, module: app },
    { pointer: dllTls.pointer, module: dll },
  ]) {
    assert.deepEqual(
      [runtime.read32(pointer + 4), runtime.read32(pointer + 8)],
      [0, 0],
      `${module.name} zero-fill tail stayed zero`,
    );
  }

  const eventCount = exportedDword(runtime, dll, 'eventCount');
  assert.equal(eventCount, 8);
  assert.deepEqual(
    exportedArray(runtime, dll, 'events', eventCount),
    [1, 2, 3, 4, 9, 6, 7, 8],
    'DLL callbacks precede DllMain; EXE callback precedes entry; Wine omits EXE detach callback and detaches DLL callbacks before DllMain',
  );
});

test('a nested LoadLibrary failure preserves the TLS callback already in progress', async () => {
  const runtime = await tlsAppRuntime();
  const dll = runtime.graph.modules.get('tls.dll');
  const secondCallback = dll.base + dll.pe.tls.callbackRvas[1];
  const callGuest = runtime.callGuest.bind(runtime);
  let nested = false;
  runtime.callGuest = async (address, args = [], convention) => {
    if (address === secondCallback && args[1] === 1 && !nested) {
      nested = true;
      await assert.rejects(runtime.loadLibrary('missing.dll'), /Missing DLL missing.dll/);
    }
    return callGuest(address, args, convention);
  };
  assert.equal((await runtime.run()).exitCode, 0);
  assert.ok(nested);
  assert.deepEqual(
    exportedArray(runtime, dll, 'events', exportedDword(runtime, dll, 'eventCount')),
    [1, 2, 3, 4, 9, 6, 7, 8],
    'nested rollback must neither detach early nor lose later detach callbacks',
  );
});

test('dynamic TLS DLL loading installs a vector and runs its two callbacks before DllMain', async () => {
  const consoleExe = new Uint8Array(
    await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
  );
  const dllBytes = await bytes('tls.dll');
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', consoleExe]]),
    exe: 'console.exe',
    builtinFiles: new Map([['tls.dll', dllBytes]]),
  });
  const base = await runtime.loadLibrary('tls.dll');
  const module = runtime.graph.modules.get('tls.dll');
  assert.ok(module);
  assert.equal(base, module.base);
  assert.equal(module.pe.preferredImageBase, 0x10000000);
  assert.notEqual(module.base, module.pe.preferredImageBase, 'dynamic TLS DLL is relocated');
  assert.equal(module.initialized, true);
  const block = tlsPointer(runtime, module);
  assert.equal(runtime.read32(block.pointer), 0xa1b2c3d4);
  assert.deepEqual([runtime.read32(block.pointer + 4), runtime.read32(block.pointer + 8)], [0, 0]);
  assert.equal(exportedDword(runtime, module, 'eventCount'), 3);
  assert.deepEqual(exportedArray(runtime, module, 'events', 3), [1, 2, 3]);
  assert.equal(
    await runtime.loadLibrary('tls.dll'),
    base,
    'repeated load does not repeat TLS attach',
  );
  assert.equal(exportedDword(runtime, module, 'eventCount'), 3);
});

test('failed DllMain attach detaches TLS callbacks and rolls back the module and vector slot', async () => {
  const failedDll = await bytes('tls.dll');
  const pe = parsePE(failedDll, { allowDll: true });
  const reject = exportEntry({ ...pe, name: 'tls.dll' }, 'RejectAttach');
  const section = pe.sections.find(
    (candidate) =>
      reject.rva >= candidate.rva && reject.rva + 4 <= candidate.rva + candidate.rawSize,
  );
  assert.ok(section, 'reject flag has file-backed storage');
  new DataView(failedDll.buffer, failedDll.byteOffset, failedDll.byteLength).setUint32(
    section.rawOffset + reject.rva - section.rva,
    0xdeadbeef,
    true,
  );

  const consoleExe = new Uint8Array(
    await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
  );
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', consoleExe]]),
    exe: 'console.exe',
    builtinFiles: new Map([['tls.dll', failedDll]]),
  });
  const initialRegions = runtime.regions.length;
  const initialHeapAllocations = runtime.allocations.size;
  await assert.rejects(runtime.loadLibrary('tls.dll'), /DllMain rejected process attach: tls\.dll/);
  assert.equal(
    runtime.graph.modules.has('tls.dll'),
    false,
    'failed DLL was removed from the graph',
  );
  assert.equal(runtime.tls.records.size, 0, 'failed attach TLS block and index were rolled back');
  assert.equal(runtime.tls.vector, 0, 'empty TLS vector was released');
  assert.equal(runtime.read32(TLS_VECTOR_TEB_OFFSET), 0, 'TEB TLS vector pointer was restored');
  assert.equal(runtime.regions.length, initialRegions, 'failed DLL regions were removed');
  assert.equal(
    runtime.allocations.size,
    initialHeapAllocations,
    'TLS heap allocations were released',
  );
});
