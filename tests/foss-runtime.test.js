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

test('native file stat and volume information describe actual files with stable distinct identities', () => {
  const r = setup();
  r.files.set('first.txt', new Uint8Array([1, 2, 3]));
  r.files.set('second.txt', new Uint8Array([4]));
  const open = (name) =>
    api(r, 'kernel32.dll!CreateFileA', [r.allocString(name), 0x80000000, 3, 0, 3, 0, 0]).result;
  const first = open('first.txt'),
    again = open('first.txt'),
    second = open('second.txt'),
    out = r.allocate(80),
    io = r.allocate(8);
  const stat = (h) => nt(r, 'NtQueryInformationFile', [h, io, out, 72, 68]);
  assert.equal(stat(first), 0);
  const id = r.view.getBigInt64(out, true);
  assert.ok(id > 0n);
  assert.equal(r.view.getBigInt64(out + 48, true), 3n);
  assert.equal(r.read32(out + 64), 1);
  assert.equal(stat(again), 0);
  assert.equal(r.view.getBigInt64(out, true), id);
  assert.equal(stat(second), 0);
  assert.notEqual(r.view.getBigInt64(out, true), id);
  assert.equal(r.view.getBigInt64(out + 48, true), 1n);
  assert.equal(nt(r, 'NtQueryInformationFile', [first, io, out, 71, 68]), 0xc0000004);
  r.write32(out + 24, 0x12345678);
  assert.equal(nt(r, 'NtQueryVolumeInformationFile', [first, io, out, 24, 1]), 0x80000005);
  assert.equal(r.read32(out + 8), 0x57425231);
  assert.equal(r.read32(out + 12), 22);
  assert.equal(r.read32(out + 24), 0x12345678);
  assert.equal(nt(r, 'NtQueryVolumeInformationFile', [first, io, out, 40, 1]), 0);
  assert.equal(r.view.getUint16(out + 18, true), 87);
});

test('Win32 enumeration preserves each file size and timestamp across A/W first/next results', () => {
  const r = setup();
  r.files.set('one.dat', new Uint8Array([1, 2, 3]));
  r.files.set('two.dat', new Uint8Array([4, 5, 6, 7, 8]));
  for (const wide of [false, true]) {
    const suffix = wide ? 'W' : 'A',
      out = r.allocate(600),
      pattern = r.allocString('*.dat', wide);
    const handle = api(r, 'kernel32.dll!FindFirstFile' + suffix, [pattern, out]).result;
    assert.notEqual(handle >>> 0, 0xffffffff);
    assert.equal(r.read32(out + 28), 0);
    assert.equal(r.read32(out + 32), 3);
    assert.equal(r.view.getBigInt64(out + 4, true), r.packageFileTime);
    assert.equal(api(r, 'kernel32.dll!FindNextFile' + suffix, [handle, out]).result, 1);
    assert.equal(r.read32(out + 32), 5);
    assert.equal(api(r, 'kernel32.dll!FindNextFile' + suffix, [handle, out]).result, 0);
    assert.equal(r.lastError, 18);
  }
  const h = api(r, 'kernel32.dll!CreateFileA', [
      r.allocString('one.dat'),
      0x80000000,
      3,
      0,
      3,
      0,
      0,
    ]).result,
    out = r.allocate(52);
  assert.equal(api(r, 'kernel32.dll!GetFileInformationByHandle', [h, out]).result, 1);
  assert.equal(r.read32(out + 32), 0);
  assert.equal(r.read32(out + 36), 3);
  assert.equal(r.read32(out + 40), 1);
  assert.equal(r.view.getBigInt64(out + 4, true), r.packageFileTime);
  const time = r.allocate(8);
  r.view.setBigInt64(time, r.packageFileTime - 12345n, true);
  assert.equal(api(r, 'kernel32.dll!SetFileTime', [h, 0, 0, time]).result, 1);
  assert.equal(api(r, 'kernel32.dll!GetFileInformationByHandle', [h, out]).result, 1);
  assert.equal(r.view.getBigInt64(out + 20, true), r.packageFileTime - 12345n);
  assert.equal(nt(r, 'NtFsControlFile', [1, 0, 0, 0, out, 0x11400c, 0, 0, 0, 0]), 0xc0000022);
  assert.equal(nt(r, 'NtFsControlFile', [123, 0, 0, 0, out, 0x11400c, 0, 0, 0, 0]), 0xc0000008);
});
