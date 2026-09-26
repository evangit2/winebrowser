import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';
import { packageDosPath } from '../src/guest-paths.js';

const bytes = async (path) => new Uint8Array(await readFile(path));
async function setup(extra = []) {
  return new Runtime(iced, {
    exe: 'app/main.exe',
    files: new Map([
      ['app/main.exe', await bytes('public/demos/console/console.exe')],
      ['app/plugins/math.dll', await bytes('tests/fixtures/modules/math.dll')],
      ['other/math.dll', await bytes('tests/fixtures/modules/math.dll')],
      ...extra,
    ]),
  });
}
const api = (r, name, args) => r.apiProvider.get('kernel32.dll!' + name)(r, (i) => args[i]);
const moduleAt = (r, base) => [...r.graph.modules.values()].find((m) => m.base === base);
const sum = async (r, base) =>
  r.callGuest(await r.resolveExport(moduleAt(r, base), 'sum'), [17, 25], 'cdecl');

test('relative, parent, absolute and case-insensitive DLL paths share the same loaded image', async () => {
  const r = await setup();
  const base = await r.loadLibrary('PLUGINS\\MATH');
  assert.equal(await sum(r, base), 42);
  for (const name of [
    '.\\plugins\\math.dll',
    'C:\\winebrowser\\app\\plugins\\math.dll',
    '\\??\\C:\\winebrowser\\app\\plugins\\math.dll',
    'math',
  ]) {
    assert.equal(await r.loadLibrary(name), base);
  }
  assert.equal(moduleAt(r, base).refs, 5);
  const sibling = await r.loadLibrary('..\\other\\math.dll');
  assert.notEqual(sibling, base);
  assert.equal(await sum(r, sibling), 42);
  assert.equal(moduleAt(r, sibling).path, 'other/math.dll');
});

test('DLLs with identical basenames unload independently and the surviving image remains callable', async () => {
  const r = await setup();
  const first = await r.loadLibrary('plugins/math.dll');
  const second = await r.loadLibrary('C:\\winebrowser\\other\\math.dll');
  const survivor = moduleAt(r, second);
  assert.equal(await r.freeLibrary(first), true);
  assert.equal(await sum(r, second), 42);
  assert.ok(r.regions.some((region) => region.module === survivor.key));
  assert.equal(await r.loadLibrary('math.dll'), second);
  assert.equal(await r.freeLibrary(second), true);
  assert.equal(await r.freeLibrary(second), true);
  assert.equal(
    [...r.graph.modules.values()].some((m) => m.name === 'math.dll'),
    false,
  );
  assert.equal(await sum(r, await r.loadLibrary('plugins/math.dll')), 42);
});

test('a rejected same-name DLL attach leaves the already loaded DLL and regions intact', async () => {
  const bad = await bytes('tests/fixtures/modules/math.dll');
  const pe = parsePE(bad, { allowDll: true });
  const section = pe.sections.find(
    (s) => pe.entryPointRva >= s.rva && pe.entryPointRva < s.rva + s.rawSize,
  );
  bad.set([0x31, 0xc0, 0xc2, 12, 0], section.rawOffset + pe.entryPointRva - section.rva);
  const r = await setup([['broken/math.dll', bad]]);
  const original = await r.loadLibrary('plugins/math.dll');
  const before = r.regions.slice();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(r.loadLibrary('../broken/math.dll'), (e) => e.win32Error === 1114);
    assert.deepEqual(r.regions, before);
    assert.equal(await sum(r, original), 42);
    assert.equal(moduleAt(r, original).refs, 1);
  }
});

test('GetModuleHandle and GetModuleFileName distinguish full DLL paths, including Unicode and truncated buffers', async () => {
  const r = await setup([['app/é😀/math.dll', await bytes('tests/fixtures/modules/math.dll')]]);
  const first = await r.loadLibrary('plugins/math.dll');
  const other = await r.loadLibrary('../other/math.dll');
  const unicode = await r.loadLibrary('é😀/math.dll');
  for (const base of [0, first, other, unicode]) {
    const module = base ? moduleAt(r, base) : r.graph.main;
    const path = packageDosPath(module.path);
    const buffer = r.allocate(1024);
    const result = await api(r, 'GetModuleFileNameW', [base, buffer, 512]);
    assert.equal(result.result, path.length);
    assert.equal(r.wideString(buffer), path);
    assert.equal((await api(r, 'GetModuleHandleW', [buffer])).result, module.base);
    const small = await api(r, 'GetModuleFileNameW', [base, buffer, 5]);
    assert.equal(small.result, 5);
    assert.equal(r.lastError, 122);
    assert.equal(r.wideString(buffer), path.slice(0, 4));
    const ansi = await api(r, 'GetModuleFileNameA', [base, buffer, 512]);
    assert.equal(r.string(buffer), path.replace('😀', '?'));
    assert.equal(ansi.result, r.string(buffer).length);
  }
  assert.equal(
    (await api(r, 'GetModuleHandleA', [r.allocString('C:\\elsewhere\\math.dll')])).result,
    0,
  );
  assert.equal(r.lastError, 126);
  assert.equal((await api(r, 'GetModuleFileNameA', [123, 0, 0])).result, 0);
});

test('LoadLibraryEx altered search path finds a plugin forwarder dependency in the plugin directory', async () => {
  const r = await setup([
    ['app/plugins/forward.dll', await bytes('tests/fixtures/modules/forward.dll')],
  ]);
  const name = r.allocString('C:\\winebrowser\\app\\plugins\\forward.dll', true);
  const loaded = await api(r, 'LoadLibraryExW', [name, 0, 8]);
  assert.equal(loaded.argc, 3);
  assert.ok(loaded.result);
  const pointer = await r.resolveExport(moduleAt(r, loaded.result), 'ForwardSum');
  assert.equal(await r.callGuest(pointer, [19, 23], 'cdecl'), 42);
  assert.equal(r.graph.findLoaded('math.dll').path, 'app/plugins/math.dll');
  assert.equal(await r.freeLibrary(loaded.result), true);
  assert.equal(r.graph.findLoaded('math.dll'), undefined);
});

test('explicit missing paths never fall back to matching basenames or host shims', async () => {
  const r = await setup([['bad.dll', new Uint8Array([1, 2, 3])]]);
  await r.loadLibrary('plugins/math.dll');
  for (const name of [
    'C:\\missing\\math.dll',
    'C:\\winebrowser\\absent\\math.dll',
    '../../other/math.dll',
    '../plugins/kernel32.dll',
  ]) {
    const result = await api(r, 'LoadLibraryA', [r.allocString(name)]);
    assert.equal(result.result, 0);
    assert.equal(r.lastError, 126);
  }
  assert.equal((await api(r, 'LoadLibraryA', [r.allocString('../bad.dll')])).result, 0);
  assert.equal(r.lastError, 193);
  for (const [name, file, flags] of [
    ['plugins/math.dll', 0, 8],
    ['plugins/math.dll', 0, 2],
    ['plugins/math.dll', 1, 0],
  ]) {
    assert.equal((await api(r, 'LoadLibraryExA', [r.allocString(name), file, flags])).result, 0);
    assert.equal(r.lastError, 87);
  }
});

test('a trailing period suppresses DLL extension appending', async () => {
  const r = await setup([
    ['app/plugins/extensionless', await bytes('tests/fixtures/modules/math.dll')],
  ]);
  const base = await r.loadLibrary('plugins/extensionless.');
  assert.equal(moduleAt(r, base).path, 'app/plugins/extensionless');
  assert.equal(await sum(r, base), 42);
  assert.equal((await api(r, 'GetModuleHandleA', [r.allocString('extensionless.')])).result, base);
});

test('unloading a guest DLL named like a host module preserves the host import thunks', async () => {
  const r = await setup([
    ['app/plugins/kernel32.dll', await bytes('tests/fixtures/modules/math.dll')],
  ]);
  const host = r.graph.findLoaded('kernel32.dll');
  const thunk = await r.resolveExport(host, 'GetTickCount');
  const base = await r.loadLibrary('plugins/kernel32.dll');
  assert.notEqual(base, host.base);
  assert.equal(await sum(r, base), 42);
  assert.equal(await r.freeLibrary(base), true);
  assert.ok(r.graph.thunks.has(r.read32(thunk + 1)));
  assert.equal(typeof (await r.callGuest(thunk)), 'number');
});
