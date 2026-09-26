import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { comApis } from '../src/win32-com.js';
import { registryApis } from '../src/win32-registry.js';
import { probeCom } from '../scripts/lib/com-probe.js';

const files = new Map([
  ['client.exe', new Uint8Array(await readFile('tests/fixtures/com/client.exe'))],
  ['plugins/counter.dll', new Uint8Array(await readFile('tests/fixtures/com/counter.dll'))],
  ['bad.dll', new Uint8Array(await readFile('tests/fixtures/modules/math.dll'))],
]);
const setup = () => new Runtime(iced, { files, exe: 'client.exe' });
const call = (r, name, args = []) => comApis['ole32.dll!' + name](r, (i) => args[i] ?? 0);
const clsidText = '9a5bf010-1234-4321-8234-102030405060';
function guid(r, text = clsidText) {
  const p = r.allocate(16);
  r.data.set(
    Uint8Array.from(text.replaceAll('-', '').match(/../g), (b) => parseInt(b, 16)),
    p,
  );
  for (const [start, end] of [
    [0, 4],
    [4, 6],
    [6, 8],
  ])
    r.data.subarray(p + start, p + end).reverse();
  return p;
}
function register(r, path, model = 'Both', root = 0x80000000, prefix = '') {
  const api = (name, args) => registryApis['advapi32.dll!' + name](r, (i) => args[i]);
  const out = r.allocate(4);
  assert.equal(
    api('RegCreateKeyExW', [
      root,
      r.allocString(prefix + 'CLSID\\{' + clsidText + '}\\InprocServer32', true),
      0,
      0,
      0,
      2,
      0,
      out,
      0,
    ]).result,
    0,
  );
  const key = r.read32(out);
  for (const [name, value] of [
    ['', path],
    ['ThreadingModel', model],
  ]) {
    const p = r.allocString(value, true);
    assert.equal(
      api('RegSetValueExW', [key, r.allocString(name, true), 0, 1, p, (value.length + 1) * 2])
        .result,
      0,
    );
    r.free(p);
  }
  assert.equal(api('RegCloseKey', [key]).result, 0);
  r.free(out);
}
test('native COM client creates and calls real DLL objects, balances factories and unloads/reloads', async () => {
  const result = await probeCom(iced, { files });
  assert.equal(result.status, 'passed', result.failure);
});

test('COM validates arguments and apartment state before loading or calling a DLL', async () => {
  const r = setup(),
    clsid = guid(r),
    iid = guid(r),
    out = r.allocate(4);
  const args = [clsid, 0, 1, iid, out],
    before = r.graph.modules.size;
  assert.deepEqual(await call(r, 'CoCreateInstance', [...args.slice(0, 4), 0]), {
    result: 0x80004003,
    argc: 5,
  });
  assert.equal((await call(r, 'CoCreateInstance', args)).result, 0x800401f0);
  assert.equal(r.read32(out), 0);
  assert.equal(call(r, 'CoInitializeEx', [1, 2]).result, 0x80070057);
  assert.equal(call(r, 'CoInitializeEx', [0, 1]).result, 0x80070057);
  assert.equal(call(r, 'CoInitializeEx', [0, 2]).result, 0);
  assert.equal((await call(r, 'CoGetClassObject', [clsid, 1, 1, iid, out])).result, 0x80070057);
  assert.equal((await call(r, 'CoCreateInstance', [clsid, 0, 0, iid, out])).result, 0x80070057);
  assert.equal(
    (await call(r, 'CoCreateInstance', [clsid, 0, 0x40000001, iid, out])).result,
    0x80004001,
  );
  assert.equal((await call(r, 'CoCreateInstance', [clsid, 0, 4, iid, out])).result, 0x80040154);
  assert.equal(r.graph.modules.size, before);
  await assert.rejects(call(r, 'CoCreateInstance', [clsid, 0, 1, iid, 0xfffffffc]));
  assert.equal(r.graph.modules.size, before);
});

test('unavailable native COM servers fail without leaked module references; corrected registrations retry', async () => {
  const r = setup(),
    clsid = guid(r),
    iid = guid(r, '00000001-0000-0000-c000-000000000046'),
    out = r.allocate(4);
  call(r, 'CoInitialize', [0]);
  const before = r.graph.modules.size;
  for (const [path, model, expected] of [
    ['absent.dll', 'Both', 0x800401f8],
    ['bad.dll', 'Both', 0x800401f9],
    ['plugins/counter.dll', 'Free', 0x80004001],
    ['plugins/counter.dll', 'Neutral', 0x80004001],
  ]) {
    register(r, path, model);
    assert.equal((await call(r, 'CoGetClassObject', [clsid, 1, 0, iid, out])).result, expected);
    assert.equal(r.read32(out), 0);
    assert.equal(r.graph.modules.size, before);
  }
  register(r, 'plugins/counter.dll');
  assert.equal((await call(r, 'CoGetClassObject', [clsid, 1, 0, iid, out])).result, 0);
  const pointer = r.read32(out);
  assert.equal(await r.callGuest(r.read32(r.read32(pointer) + 8), [pointer]), 0);
  await call(r, 'CoFreeUnusedLibraries');
  assert.equal(r.graph.modules.size, before);
});

test('COM also sees per-user and machine Software\\Classes registrations', async () => {
  for (const root of [0x80000001, 0x80000002]) {
    const r = setup(),
      clsid = guid(r),
      iid = guid(r, '00000001-0000-0000-c000-000000000046'),
      out = r.allocate(4);
    call(r, 'CoInitialize', [0]);
    register(r, 'plugins/counter.dll', 'Apartment', root, 'Software\\Classes\\');
    assert.equal((await call(r, 'CoGetClassObject', [clsid, 1, 0, iid, out])).result, 0);
    const pointer = r.read32(out);
    await r.callGuest(r.read32(r.read32(pointer) + 8), [pointer]);
    await call(r, 'CoUninitialize');
  }
});
