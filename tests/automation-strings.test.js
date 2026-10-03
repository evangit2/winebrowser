import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = (name, ...args) =>
    r.apiProvider.get('oleaut32.dll!' + name)(r, (i) => args[i] >>> 0);
  return { r, call };
}

test('binary BSTRs preserve odd lengths and embedded NULs through published ordinal calls', async (t) => {
  const { r, call } = setup(t);
  const source = r.allocate(5);
  const bytes = [0x41, 0, 0, 0xff, 0x7f];
  r.data.set(bytes, source);
  const base = await r.loadLibrary('oleaut32.dll');
  const module = r.graph.findLoaded('oleaut32.dll');
  const stack = r.cpu.r[4].value;
  // Wine's oleaut32.spec and Windows publish byte length at 149 and allocation at 150.
  const allocate = await r.resolveExport(module, 150);
  const length = await r.resolveExport(module, 149);
  assert.equal(allocate, await r.resolveExport(module, 'SysAllocStringByteLen'));
  assert.equal(length, await r.resolveExport(module, 'SysStringByteLen'));
  const bstr = await r.callGuest(allocate, [source, bytes.length]);
  assert.ok(base && bstr);
  assert.equal(r.cpu.r[4].value, stack);
  assert.deepEqual([...r.data.slice(bstr, bstr + bytes.length)], bytes);
  assert.equal(r.guestMemory.read(bstr + bytes.length, 2), 0);
  assert.equal(await r.callGuest(length, [bstr]), 5);
  assert.equal(r.cpu.r[4].value, stack);
  assert.equal(call('SysStringLen', bstr).result, 2);
  call('SysFreeString', bstr);
  assert.equal(r.bstrAllocations.size, 0);
});

test('VariantCopy owns an exact binary BSTR copy and preserves self-copy and scalar values', (t) => {
  const { r, call } = setup(t);
  const bytes = [0x41, 0, 0, 0xff, 0x7f];
  const raw = r.allocate(bytes.length);
  r.data.set(bytes, raw);
  const bstr = call('SysAllocStringByteLen', raw, bytes.length).result;
  const source = r.allocate(16),
    destination = r.allocate(16);
  call('VariantInit', source);
  call('VariantInit', destination);
  r.guestMemory.write(source, 8, 2);
  r.write32(source + 8, bstr);
  assert.equal(call('VariantCopy', destination, source).result, 0);
  const copy = r.read32(destination + 8);
  assert.notEqual(copy, bstr);
  assert.equal(call('SysStringByteLen', copy).result, 5);
  assert.deepEqual([...r.data.slice(copy, copy + 5)], bytes);
  assert.equal(call('VariantCopy', source, source).result, 0);
  assert.equal(r.read32(source + 8), bstr);
  call('VariantClear', source);
  assert.deepEqual([...r.data.slice(copy, copy + 5)], bytes);
  call('VariantClear', destination);
  assert.equal(r.bstrAllocations.size, 0);
  for (const vt of [11, 19, 20, 21]) {
    r.guestMemory.write(source, vt, 2);
    r.write32(source + 8, 0x87654321);
    r.write32(source + 12, 0x12345678);
    const original = r.data.slice(source, source + 16);
    assert.equal(call('VariantCopy', destination, source).result, 0);
    assert.deepEqual(r.data.slice(destination, destination + 16), original);
    assert.equal(call('VariantClear', destination).result, 0);
    assert.deepEqual([...r.data.slice(destination, destination + 16)], Array(16).fill(0));
  }
});

test('DOS archive timestamps convert leap days exactly and reject invalid fields without writes', (t) => {
  const { r } = setup(t);
  const invoke = (...args) =>
    r.apiProvider.get('kernel32.dll!DosDateTimeToFileTime')(r, (i) => args[i] >>> 0);
  const out = r.allocate(8);
  const date = ((2024 - 1980) << 9) | (2 << 5) | 29;
  const time = (23 << 11) | (59 << 5) | 29;
  assert.deepEqual(invoke(date, time, out), { result: 1, argc: 3 });
  const filetime = BigInt(r.read32(out)) | (BigInt(r.read32(out + 4)) << 32n);
  assert.equal(filetime, 133537247980000000n); // 2024-02-29 23:59:58, 100 ns since 1601
  const original = r.data.slice(out, out + 8);
  for (const [badDate, badTime] of [
    [((2023 - 1980) << 9) | (2 << 5) | 29, time],
    [date & ~31, time],
    [date, 24 << 11],
    [date, 60 << 5],
    [date, 30],
  ]) {
    assert.equal(invoke(badDate, badTime, out).result, 0);
    assert.equal(r.lastError, 87);
    assert.deepEqual(r.data.slice(out, out + 8), original);
  }
});
