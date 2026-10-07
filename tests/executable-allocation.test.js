import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('kernel32.dll!' + name)(r, (i) => args[i] >>> 0);
  const nt = (name, ...args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  const code = (pointer, value) => {
    const bytes = new Uint8Array([0xb8, value, 0, 0, 0, 0xc3]);
    r.check(pointer, bytes.length, true);
    r.data.set(bytes, pointer);
  };
  return { r, api, nt, code };
}
test('VirtualAlloc executable memory runs immediately, survives DLL loads and cannot reuse cached code after release', async (t) => {
  const { r, api, code } = setup(t);
  const pointer = api('VirtualAlloc', 0, 4096, 0x1000, 0x40).result;
  assert.ok(pointer);
  code(pointer, 42);
  assert.equal(await r.callGuest(pointer), 42);
  assert.ok(r.cpu.cache.has(pointer));
  await r.loadLibrary('ole32.dll');
  assert.equal(await r.callGuest(pointer), 42);
  const oldRanges = structuredClone(r.cpu.ranges);
  assert.equal(api('VirtualAlloc', 0, 4096, 0x3000, 0xdead).result, 0);
  assert.deepEqual(r.cpu.ranges, oldRanges);
  assert.ok(r.cpu.cache.has(pointer));
  assert.equal(api('VirtualFree', pointer, 0, 0x8000).result, 1);
  assert.equal(r.cpu.cache.has(pointer), false);
  await assert.rejects(r.callGuest(pointer), /Execute outside code/);
  assert.equal(api('VirtualAlloc', pointer, 4096, 0x3000, 0x40).result, pointer);
  code(pointer, 77);
  assert.equal(await r.callGuest(pointer), 77);
});
test('native NT allocation/decommit/recommit and direct protection updates refresh executable ranges and invalidate prior translations', async (t) => {
  const { r, nt, code } = setup(t),
    base = r.allocate(4),
    size = r.allocate(4);
  r.write32(base, 0);
  r.write32(size, 4096);
  assert.equal(nt('NtAllocateVirtualMemory', 0xffffffff, base, 0, size, 0x3000, 0x40), 0);
  const pointer = r.read32(base);
  code(pointer, 81);
  assert.equal(await r.callGuest(pointer), 81);
  assert.equal(r.virtualMemory.protect(pointer, 4096, 4).status, 0);
  assert.equal(r.cpu.cache.has(pointer), false);
  await assert.rejects(r.callGuest(pointer), /Execute outside code/);
  assert.equal(r.virtualMemory.protect(pointer, 4096, 0x40).status, 0);
  assert.equal(await r.callGuest(pointer), 81);
  r.write32(base, pointer);
  r.write32(size, 4096);
  assert.equal(nt('NtFreeVirtualMemory', 0xffffffff, base, size, 0x4000), 0);
  assert.equal(r.cpu.cache.has(pointer), false);
  await assert.rejects(r.callGuest(pointer), /Execute outside code/);
  r.write32(base, pointer);
  r.write32(size, 4096);
  assert.equal(nt('NtAllocateVirtualMemory', 0xffffffff, base, 0, size, 0x1000, 0x40), 0);
  assert.equal(r.read32(pointer), 0);
  code(pointer, 99);
  assert.equal(await r.callGuest(pointer), 99);
});
