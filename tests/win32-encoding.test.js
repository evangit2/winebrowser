import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function setup() {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  return { r, call };
}
test('MultiByteToWideChar handles CP1252, embedded nulls, size queries and short buffers', () => {
  const { r, call } = setup(),
    input = r.allocate(4),
    output = r.allocate(12);
  r.data.set([0x80, 0, 0xe9, 0], input);
  const api = (...args) => call('kernel32.dll!MultiByteToWideChar', ...args).result;
  assert.equal(api(0, 0, input, -1, 0, 0), 2);
  assert.equal(api(1252, 0, input, 3, output, 6), 3);
  assert.deepEqual(
    [0, 2, 4].map((i) => r.guestMemory.read(output + i, 2)),
    [0x20ac, 0, 0xe9],
  );
  r.data.fill(0xcc, output, output + 12);
  assert.equal(api(1252, 0, input, 3, output, 2), 0);
  assert.equal(r.lastError, 122);
  assert.ok(r.data.subarray(output, output + 12).every((b) => b === 0xcc));
  assert.equal(call('kernel32.dll!IsDBCSLeadByte', 0x81).result, 0);
});
test('UTF-8 conversion preserves surrogate pairs/BOM and rejects invalid input with MB_ERR_INVALID_CHARS', () => {
  const { r, call } = setup(),
    input = r.allocate(8),
    output = r.allocate(16);
  r.data.set([0xef, 0xbb, 0xbf, 0xf0, 0x9f, 0x98, 0x80, 0], input);
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 65001, 8, input, -1, output, 8).result, 4);
  assert.equal(r.wideString(output), '\ufeff😀');
  r.data[input] = 0xff;
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 65001, 8, input, 1, output, 8).result, 0);
  assert.equal(r.lastError, 1113);
});

test('single-byte CRT conversion accepts MB_PRECOMPOSED plus strict decoding and expands MB_COMPOSITE', () => {
  const { r, call } = setup(),
    input = r.allocate(2),
    output = r.allocate(8);
  r.data.set([0xe9, 0], input);
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 1252, 9, input, -1, output, 4).result, 2);
  assert.equal(r.wideString(output), 'é');
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 1252, 2, input, -1, output, 4).result, 3);
  assert.equal(r.wideString(output), 'e\u0301');
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 1252, 3, input, -1, output, 4).result, 0);
  assert.equal(r.lastError, 1004);
});
test('Get/SetWindowText cross the ANSI WndProc boundary without corrupting UTF-16 buffers', async () => {
  const { r, call } = setup(),
    hwnd = 0x20000,
    output = r.allocate(20);
  r.windows.windows.set(hwnd, { id: hwnd, cls: { wide: false }, proc: 0x401000, title: '€ café' });
  r.callGuest = async (_proc, args) => (await call('user32.dll!DefWindowProcA', ...args)).result;
  assert.equal((await call('user32.dll!GetWindowTextW', hwnd, output, 10)).result, 6);
  assert.equal(r.wideString(output), '€ café');
  const title = r.allocString('New €', true);
  assert.equal((await call('user32.dll!SetWindowTextW', hwnd, title)).result, 1);
  assert.equal(r.windows.windows.get(hwnd).title, 'New €');
  assert.equal((await call('user32.dll!GetWindowTextW', hwnd, output, 4)).result, 3);
  assert.equal(r.wideString(output), 'New');
  r.windows.dispose();
});

test('the special code pages resolve to the ANSI and OEM tables GetACP/GetOEMCP report', () => {
  const { r, call } = setup(),
    input = r.allocate(4),
    output = r.allocate(16);
  // CP_OEMCP is 1, CP_ACP is 0 and CP_THREAD_ACP is 3; none of them is a
  // literal code page number, so a conversion that passes one must resolve it
  // the same way GetACP/GetOEMCP name it instead of failing.
  assert.equal(call('kernel32.dll!GetACP').result, 1252);
  assert.equal(call('kernel32.dll!GetOEMCP').result, 437);
  r.data.set([0x80, 0], input);
  // Byte 0x80 is the euro sign in CP1252 but a C-cedilla in CP437. An explicit
  // count of 1 converts just that byte, without its terminator.
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 0, 0, input, 1, output, 8).result, 1);
  assert.equal(r.guestMemory.read(output, 2), 0x20ac);
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 3, 0, input, 1, output, 8).result, 1);
  assert.equal(r.guestMemory.read(output, 2), 0x20ac);
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 1, 0, input, 1, output, 8).result, 1);
  assert.equal(r.guestMemory.read(output, 2), 0x00c7, 'CP_OEMCP maps 0x80 to U+00C7');
});

test('wide-to-multi conversion honours CP_OEMCP and the UTF-8 invalid-character flag', () => {
  const { r, call } = setup(),
    input = r.allocate(8),
    output = r.allocate(8);
  // U+00C7 -> 0x80 in CP437, but not representable as 0x80 in CP1252 (where
  // 0x80 is the euro sign), so the two code pages must differ.
  r.guestMemory.write(input, 0x00c7, 2);
  assert.equal(call('kernel32.dll!WideCharToMultiByte', 1, 0, input, 1, output, 8, 0, 0).result, 1);
  assert.equal(r.data[output], 0x80, 'CP_OEMCP emits the CP437 byte');
  assert.equal(
    call('kernel32.dll!WideCharToMultiByte', 1252, 0, input, 1, output, 8, 0, 0).result,
    1,
  );
  assert.equal(r.data[output], 0xc7, 'CP1252 emits the ANSI byte');
  // WC_ERR_INVALID_CHARS (0x80) is accepted for UTF-8 and rejects an unpaired
  // surrogate instead of silently emitting a replacement.
  r.guestMemory.write(input, 0xd800, 2);
  assert.equal(
    call('kernel32.dll!WideCharToMultiByte', 65001, 0x80, input, 1, output, 8, 0, 0).result,
    0,
  );
  assert.equal(r.lastError, 1113);
  // A code page the runtime does not model still fails with a real error
  // rather than raising, so a caller sees ERROR_INVALID_PARAMETER.
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 932, 0, input, 1, output, 8).result, 0);
  assert.equal(r.lastError, 87);
});

test('GetCurrentDirectory/GetTempPath use the (nBufferLength, lpBuffer) argument order', () => {
  const { r, call } = setup();
  // 7zr passes the length first. Reading them in the other order writes to
  // whatever small number happened to be in the buffer slot, which faults.
  const buffer = r.allocate(64);
  const getcwd = (name, wide) => call(name, 32, buffer).result;
  assert.ok(getcwd('kernel32.dll!GetCurrentDirectoryW', true) > 0);
  assert.equal(r.wideString(buffer), 'C:\\winebrowser\\');
  assert.ok(getcwd('kernel32.dll!GetCurrentDirectoryA', false) > 0);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\');
  // An undersized buffer reports the required length and ERROR_INSUFFICIENT_BUFFER.
  assert.equal(call('kernel32.dll!GetCurrentDirectoryW', 4, buffer).result, 0);
  assert.equal(r.lastError, 122);
  // GetTempPath names the temp directory of the same volume.
  assert.ok(call('kernel32.dll!GetTempPathW', 32, buffer).result > 0);
  assert.match(r.wideString(buffer), /temp\\$/i);
  assert.ok(r.virtualDirectories?.has('temp/'));
});

test('FindFirstFileW lists the package tree instead of throwing on an undefined path', () => {
  const { r, call } = setup();
  // The prefix helper used to be declared as (r, path) while every caller
  // passed the path alone, so any directory enumeration raised instead of
  // returning matches.
  r.files.set('pkg/notes.txt', new Uint8Array([1, 2, 3]));
  r.cwd = 'pkg/';
  const pattern = r.allocString('*.txt', true);
  const data = r.allocate(592);
  const handle = call('kernel32.dll!FindFirstFileW', pattern, data).result >>> 0;
  assert.notEqual(handle, 0, 'a matching entry returns a search handle');
  assert.equal(r.read32(data) & 0x10, 0, 'the match is a file, not a directory');
  assert.equal(r.wideString(data + 44), 'notes.txt');
  assert.equal(call('kernel32.dll!FindClose', handle).result, 1);
});
