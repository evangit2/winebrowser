import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { apiSetContract, resolveApiSet } from '../src/api-sets.js';
import { API_NAMES, createWin32ApiProvider } from '../src/win32.js';
import { WINE_KERNELBASE_EXPORTS } from '../src/wine-kernelbase-exports.js';
const bytes = async (p) => new Uint8Array(await readFile(p));
const contract = 'api-ms-win-crt-heap-l1-1-0.dll';
async function runtime(include = true) {
  return new Runtime(iced, {
    exe: 'console.exe',
    files: new Map([['console.exe', await bytes('public/demos/console/console.exe')]]),
    // The math fixture serves as a native DLL with known executable exports;
    // actual UCRT execution is checked separately against pinned Wine binaries.
    builtinFiles: include
      ? new Map([['ucrtbase.dll', await bytes('tests/fixtures/modules/math.dll')]])
      : new Map(),
  });
}
test('UCRT contracts preserve major/minor versions, paths and case-insensitive Wine revision matching', () => {
  for (const name of 'conio convert environment filesystem heap locale math multibyte private process runtime stdio string time utility'.split(
    ' ',
  ))
    assert.equal(resolveApiSet(`API-MS-WIN-CRT-${name.toUpperCase()}-L1-1-0.DLL`), 'ucrtbase.dll');
  assert.equal(resolveApiSet('api-ms-win-crt-heap-l1-1-99'), 'ucrtbase.dll');
  for (const name of [
    'other.dll',
    'api-ms-win-crt-heap-l1-2-0.dll',
    'api-ms-win-crt-unknown-l1-1-0.dll',
    'plugins/' + contract,
    'C:/winebrowser/' + contract,
  ])
    assert.equal(resolveApiSet(name), name);
});
test('Wine contracts cover desktop, security, COM, graphics and file services without inventing destinations', () => {
  for (const [contract, target] of [
    ['api-ms-win-core-file-l1-2-0', 'kernelbase.dll'],
    ['api-ms-win-core-synch-l1-2-0', 'kernelbase.dll'],
    ['api-ms-win-core-processthreads-l1-1-0', 'kernel32.dll'],
    ['api-ms-win-core-com-l1-1-1', 'combase.dll'],
    ['ext-ms-win-ntuser-chartranslation-l1-1-0', 'user32.dll'],
    ['api-ms-win-security-base-l1-1-0', 'kernelbase.dll'],
    ['api-ms-win-base-util-l1-1-0', 'advapi32.dll'],
  ])
    assert.equal(resolveApiSet(contract), target);
  const unassigned = 'ext-ms-win-xaudio-platform-l1-1-0';
  assert.equal(apiSetContract(unassigned)?.target, null);
  assert.equal(resolveApiSet(unassigned), unassigned);
  for (const unknown of [
    'api-ms-win-core-file-l9-1-0',
    'ext-ms-win-made-up-l1-1-0',
    'C:\\Windows\\System32\\api-ms-win-core-file-l1-1-0.dll',
  ])
    assert.equal(apiSetContract(unknown), undefined);
});
test('KernelBase exports share implemented services only within the pinned export boundary', async () => {
  const provider = createWin32ApiProvider();
  assert.ok(API_NAMES['kernelbase.dll'].length > 250);
  for (const symbol of API_NAMES['kernelbase.dll']) {
    assert.ok(WINE_KERNELBASE_EXPORTS.has(symbol), symbol);
    assert.equal(typeof provider.get(`kernelbase.dll!${symbol}`), 'function', symbol);
  }
  assert.equal(
    provider.has('kernelbase.dll!CharLowerW'),
    false,
    'native-only forwarder cannot recurse into itself',
  );
  const r = await runtime(false);
  try {
    const base = await r.loadLibrary('api-ms-win-core-heap-l1-1-0');
    const module = r.graph.findLoaded('kernelbase.dll');
    assert.equal(module.base, base);
    assert.equal(await r.loadLibrary('kernelbase.dll'), base);
    assert.equal(await r.loadLibrary('api-ms-win-core-file-l1-2-0'), base);
    const heap = await r.callGuest(await r.resolveExport(module, 'GetProcessHeap'));
    const address = await r.callGuest(await r.resolveExport(module, 'HeapAlloc'), [heap, 8, 48]);
    assert.ok(address);
    assert.deepEqual([...r.data.slice(address, address + 48)], Array(48).fill(0));
    assert.equal(
      await r.callGuest(await r.resolveExport(module, 'HeapFree'), [heap, 0, address]),
      1,
    );
    await assert.rejects(r.resolveExport(module, 'AnUnsupportedAPI'), /Unsupported import/);
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
test('contracts and implementation share native exports, image identity, references and unload', async () => {
  const r = await runtime();
  try {
    const base = await r.loadLibrary(contract);
    const module = r.graph.findLoaded('ucrtbase.dll');
    assert.equal(module.host, undefined);
    assert.equal(module.base, base);
    assert.equal(await r.loadLibrary('API-MS-WIN-CRT-STDIO-L1-1-0'), base);
    assert.equal(await r.loadLibrary('ucrtbase'), base);
    assert.equal(r.graph.findLoaded(contract), module);
    assert.equal(module.refs, 3);
    assert.equal(
      [...r.graph.modules.values()].filter((m) => m.name.startsWith('api-ms-win-crt')).length,
      0,
    );
    const address = await r.resolveExport(r.graph.findLoaded(contract), 'sum');
    assert.equal(await r.callGuest(address, [17, 25], 'cdecl'), 42);
    for (let i = 0; i < 3; i++) assert.equal(await r.freeLibrary(base), true);
    assert.equal(r.graph.findLoaded(contract), undefined);
    assert.equal(r.graph.findLoaded('ucrtbase.dll'), undefined);
    const reloaded = await r.loadLibrary(contract);
    assert.ok(reloaded);
    assert.equal(
      await r.callGuest(
        await r.resolveExport(r.graph.findLoaded(contract), 'sum'),
        [10, 30],
        'cdecl',
      ),
      40,
    );
  } finally {
    await r.shutdownProcess();
    r.windows.dispose();
    r.cpu.dispose();
  }
});
test('absent UCRT remains a missing dependency; failed resolution leaves graph unchanged', async () => {
  const r = await runtime(false);
  try {
    const before = r.graph.describe();
    await assert.rejects(r.loadLibrary(contract), /Missing DLL ucrtbase.dll/);
    assert.deepEqual(r.graph.describe(), before);
    await assert.rejects(r.loadLibrary('plugins/' + contract), /Missing DLL plugins/);
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
