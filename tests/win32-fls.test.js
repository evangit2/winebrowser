import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { systemApis } from '../src/win32-system.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function setup() {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  const call = (name, ...args) => systemApis['kernel32.dll!' + name](r, (i) => args[i] ?? 0);
  return { r, call };
}
test('FLS and TLS indices with the same number retain independent CRT values', async () => {
  const { r, call } = setup();
  try {
    const tls = call('TlsAlloc').result;
    call('TlsSetValue', tls, 0x12345678);
    const fls = call('FlsAlloc', 0).result;
    assert.equal(fls, tls);
    assert.equal(call('TlsGetValue', tls).result, 0x12345678);
    call('FlsSetValue', fls, 0xabcdef);
    call('TlsSetValue', tls, 0x87654321);
    assert.equal(call('FlsGetValue', fls).result, 0xabcdef);
    call('TlsFree', tls);
    assert.equal(call('FlsGetValue', fls).result, 0xabcdef);
    await call('FlsFree', fls);
    assert.equal(call('FlsGetValue', fls).result, 0);
    assert.equal(r.lastError, 87);
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
test('FLS owns 128 process indices and private values per implicit thread fiber', async () => {
  const { r, call } = setup();
  try {
    const main = r.cpu.fsBase;
    const slots = Array.from({ length: 128 }, () => call('FlsAlloc', 0).result);
    assert.deepEqual(
      slots,
      Array.from({ length: 128 }, (_, i) => i),
    );
    assert.equal(call('FlsAlloc', 0).result, 0xffffffff);
    call('FlsSetValue', 127, 17);
    r.cpu.fsBase = r.allocate(0x2000);
    assert.equal(call('FlsGetValue', 127).result, 0);
    call('FlsSetValue', 127, 23);
    r.cpu.fsBase = main;
    assert.equal(call('FlsGetValue', 127).result, 17);
    await call('FlsFree', 127);
    assert.equal(call('FlsAlloc', 0).result, 127);
    assert.equal(call('FlsGetValue', 127).result, 0);
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
test('FlsFree invokes the real guest destructor for each non-null fiber value', async () => {
  const { r, call } = setup();
  try {
    const output = r.allocate(4),
      code = r.virtualMemory.allocate(0, 4096, 0x3000, 0x40).base;
    // stdcall callback: add the value to a guest dword, ret 4.
    r.data.set(
      [
        0x8b,
        0x44,
        0x24,
        0x04,
        0x01,
        0x05,
        ...[0, 8, 16, 24].map((n) => (output >>> n) & 255),
        0xc2,
        0x04,
        0,
      ],
      code,
    );
    r.refreshCodeRanges();
    const slot = call('FlsAlloc', code).result,
      main = r.cpu.fsBase;
    call('FlsSetValue', slot, 7);
    r.cpu.fsBase = r.allocate(0x2000);
    call('FlsSetValue', slot, 11);
    r.cpu.fsBase = main;
    assert.equal((await call('FlsFree', slot)).result, 1);
    assert.equal(r.read32(output), 18);
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
