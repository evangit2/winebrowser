import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { comApis } from '../src/win32-com.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const setup = () =>
  new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
const nt = (r, name, args) => ntServices[name].call(r, (i) => args[i] ?? 0);
const api = (r, name, args = []) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);

test('native process error mode preserves values and rejects invalid buffers and handles', () => {
  const r = setup(),
    p = r.allocate(8);
  assert.equal(nt(r, 'NtQueryInformationProcess', [0xffffffff, 12, p, 4, p + 4]), 0);
  assert.equal(r.read32(p), 0);
  assert.equal(r.read32(p + 4), 4);
  r.write32(p, 0x8003);
  assert.equal(nt(r, 'NtSetInformationProcess', [0xffffffff, 12, p, 4]), 0);
  assert.equal(nt(r, 'NtQueryInformationProcess', [0xffffffff, 12, p + 4, 4, 0]), 0);
  assert.equal(r.read32(p + 4), 0x8003);
  assert.equal(nt(r, 'NtSetInformationProcess', [123, 12, p, 4]), 0xc0000008);
  assert.equal(nt(r, 'NtSetInformationProcess', [0xffffffff, 12, p, 3]), 0xc000000d);
  assert.equal(nt(r, 'NtSetInformationProcess', [0xffffffff, 12, 0, 4]), 0xc0000005);
});

test('standard output close is shared by native and host writes, while stderr remains usable', () => {
  const r = setup(),
    text = r.allocString('text'),
    out = r.allocate(8);
  assert.equal(nt(r, 'NtClose', [1]), 0);
  assert.equal(api(r, 'kernel32.dll!WriteFile', [1, text, 4, out, 0]).result, 0);
  assert.equal(r.lastError, 6);
  assert.equal(nt(r, 'NtWriteFile', [1, 0, 0, 0, out, text, 4, 0, 0]), 0xc0000008);
  assert.equal(nt(r, 'NtWriteFile', [2, 0, 0, 0, out, text, 4, 0, 0]), 0);
  assert.equal(api(r, 'kernel32.dll!CloseHandle', [2]).result, 1);
  assert.equal(nt(r, 'NtClose', [2]), 0xc0000008);
});

test('Windows guest defaults and changed variables agree across host environment calls and CRT', () => {
  const r = setup(),
    name = r.allocString('PATHEXT', true),
    out = r.allocate(256);
  assert.equal(api(r, 'kernel32.dll!GetEnvironmentVariableW', [name, out, 128]).argc, 3);
  assert.equal(r.wideString(out), '.COM;.EXE;.BAT;.CMD');
  const replacement = r.allocString('.EXE', true);
  assert.equal(api(r, 'kernel32.dll!SetEnvironmentVariableW', [name, replacement]).result, 1);
  assert.equal(api(r, 'kernel32.dll!GetEnvironmentVariableW', [name, out, 128]).result, 4);
  assert.equal(r.wideString(out), '.EXE');
  const block = api(r, 'kernel32.dll!GetEnvironmentStringsW').result;
  let strings = [],
    pointer = block;
  while (r.guestMemory.read(pointer, 2)) {
    let v = r.wideString(pointer);
    strings.push(v);
    pointer += (v.length + 1) * 2;
  }
  assert.ok(strings.includes('PATHEXT=.EXE'));
  assert.equal(api(r, 'kernel32.dll!SetEnvironmentVariableW', [name, 0]).result, 1);
  assert.equal(api(r, 'kernel32.dll!GetEnvironmentVariableW', [name, out, 128]).result, 0);
  assert.equal(r.lastError, 203);
});

test('OLE startup shares STA reference counts and rejects a conflicting MTA', async () => {
  const r = setup(),
    call = (name, args = []) => comApis['ole32.dll!' + name](r, (i) => args[i] ?? 0);
  assert.equal(call('OleInitialize', [1]).result, 0x80070057);
  assert.equal(call('OleInitialize').result, 0);
  assert.equal(call('CoInitialize').result, 1);
  assert.equal(call('CoInitializeEx', [0, 0]).result, 0x80010106);
  await call('CoUninitialize');
  await call('CoUninitialize');
  assert.equal(call('CoInitializeEx', [0, 0]).result, 0);
  assert.equal(call('OleInitialize').result, 0x80010106);
});
