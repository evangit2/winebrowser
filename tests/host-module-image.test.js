import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { hostModuleImage } from '../src/host-module-image.js';
import { parsePE, mapPE } from '../src/pe.js';
import { canonicalHostSymbol } from '../src/host-export-ordinals.js';
import { ModuleGraph } from '../src/modules.js';

test('Windows named exports retain published ordinals and aliases share executable addresses', () => {
  const symbols = ['DirectSoundCreate8', 'DirectSoundEnumerateW', 'DirectSoundCreate', '#1'],
    calls = [];
  const { bytes, rvas } = hostModuleImage('dsound.dll', symbols, (symbol) => {
    calls.push(symbol);
    return 0x80000010;
  });
  const pe = parsePE(bytes, { allowDll: true });
  assert.deepEqual(
    pe.exports.map(({ name, ordinal }) => [name, ordinal]),
    [
      ['DirectSoundCreate', 1],
      ['DirectSoundEnumerateW', 3],
      ['DirectSoundCreate8', 11],
    ],
  );
  assert.equal(rvas.get('#1'), rvas.get('DirectSoundCreate'));
  assert.equal(calls.length, 3);
  assert.equal(calls.includes('#1'), false);
  assert.equal(canonicalHostSymbol('dsound.dll', '#1', symbols), 'DirectSoundCreate');
  assert.equal(
    canonicalHostSymbol('dsound.dll', 2, symbols),
    2,
    'metadata does not expose missing services',
  );
});

test('ordinal resolution works during inspection without mapped DLL headers', async () => {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const graph = new ModuleGraph(new Map([['console.exe', bytes]]), 'console.exe', {
    'dsound.dll': ['DirectSoundCreate'],
  });
  const dll = graph.load('dsound.dll');
  assert.equal(graph.resolve(dll, 1).symbol, 'DirectSoundCreate');
  assert.equal(graph.resolve(dll, '#1').symbol, 'DirectSoundCreate');
  assert.throws(() => graph.resolve(dll, 11), /Unsupported import/);
});

test('host DLL image contains sorted names, sparse ordinals and relocatable executable exports', () => {
  const { bytes, rvas } = hostModuleImage(
    'example.dll',
    ['Zulu', '#17', 'Alpha'],
    () => 0x80000010,
  );
  const pe = parsePE(bytes, { allowDll: true });
  assert.equal(pe.isDll, true);
  assert.equal(pe.entryPointRva, 0);
  assert.deepEqual(
    pe.exports.map((e) => e.name ?? e.ordinal),
    ['Zulu', 'Alpha', 17],
  );
  const memory = new WebAssembly.Memory({ initial: 64 });
  mapPE(pe, bytes, memory, 0x10000);
  const data = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  for (const rva of rvas.values()) {
    assert.equal(data[0x10000 + rva], 0x68);
    assert.equal(view.getUint32(0x10000 + rva + 1, true), 0x80000010);
    assert.equal(data[0x10000 + rva + 5], 0xc3);
  }
  const exports = 0x10000 + pe.directories[0].rva;
  const names = 0x10000 + view.getUint32(exports + 32, true);
  const stringAt = (p) => new TextDecoder().decode(data.subarray(p, data.indexOf(0, p)));
  assert.deepEqual(
    [0, 1].map((i) => stringAt(0x10000 + view.getUint32(names + i * 4, true))),
    ['Alpha', 'Zulu'],
  );
});

test('mapped host export addresses match the PE table and preserve stdcall stack arguments', async () => {
  const r = new Runtime(iced, {
    files: new Map([
      ['console.exe', new Uint8Array(await readFile('public/demos/console/console.exe'))],
    ]),
    exe: 'console.exe',
  });
  const kernel = r.graph.findLoaded('kernel32.dll');
  assert.equal(r.guestMemory.read(kernel.base, 2), 0x5a4d);
  for (const [name, args, expected] of [
    ['SetLastError', [12345], undefined],
    ['GetLastError', [], 12345],
    ['SetLastError', [42], undefined],
    ['GetLastError', [], 42],
  ]) {
    const address = await r.resolveExport(kernel, name);
    const entry = kernel.pe.exports.find((e) => e.name === name);
    assert.equal(address, kernel.base + entry.rva);
    assert.equal(await r.resolveExport(kernel, entry.ordinal), address);
    const result = await r.callGuest(address, args);
    if (expected !== undefined) assert.equal(result, expected);
  }
  assert.throws(() => r.write32(kernel.base + kernel.pe.exports[0].rva, 0), /write/i);
  const base = await r.loadLibrary('KERNEL32');
  assert.equal(base, kernel.base);
  assert.equal(await r.freeLibrary(base), true);
  assert.equal(await r.callGuest(await r.resolveExport(kernel, 'GetLastError')), 42);
});

test('host export image rejects malformed names and out-of-range ordinals', () => {
  for (const symbol of ['#0', '#65536', '#x', 'bad\0name', '☃'])
    assert.throws(() => hostModuleImage('example.dll', [symbol], () => 0x80000000));
});
