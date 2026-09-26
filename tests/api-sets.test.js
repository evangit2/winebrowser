import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { resolveApiSet } from '../src/api-sets.js';
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
test('UCRT contracts resolve exactly, with case-insensitivity and no path/version guessing', () => {
  for (const name of 'conio convert environment filesystem heap locale math multibyte private process runtime stdio string time utility'.split(
    ' ',
  ))
    assert.equal(resolveApiSet(`API-MS-WIN-CRT-${name.toUpperCase()}-L1-1-0.DLL`), 'ucrtbase.dll');
  for (const name of [
    'other.dll',
    'api-ms-win-crt-heap-l1-2-0.dll',
    'api-ms-win-crt-unknown-l1-1-0.dll',
    'plugins/' + contract,
    'C:/winebrowser/' + contract,
  ])
    assert.equal(resolveApiSet(name), name);
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
