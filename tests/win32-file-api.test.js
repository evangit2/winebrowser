import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));

function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  return { r, call };
}

test('FindFirstFileW reports a failed search with INVALID_HANDLE_VALUE, not zero', (t) => {
  const { r, call } = setup(t);
  const pattern = r.allocString('missing*.txt', true);
  const data = r.allocate(592);
  // A caller tests `handle != INVALID_HANDLE_VALUE`. Returning 0 for a missing
  // file made it believe the search succeeded and the file existed.
  const handle = call('kernel32.dll!FindFirstFileW', pattern, data).result >>> 0;
  assert.equal(handle, 0xffffffff);
  assert.equal(r.lastError, 2);
  // A path outside the volume likewise fails with the invalid handle.
  const outside = r.allocString('D:\\other\\x.txt', true);
  assert.equal(call('kernel32.dll!FindFirstFileW', outside, data).result >>> 0, 0xffffffff);
});

test('CreateFileW with CREATE_NEW creates a real file that WriteFile can fill', (t) => {
  const { r, call } = setup(t);
  const name = r.allocString('new.bin', true);
  // GENERIC_WRITE, no sharing, NULL SECURITY_ATTRIBUTES, CREATE_NEW, no flags.
  const handle = call('kernel32.dll!CreateFileW', name, 0x40000000, 0, 0, 1, 0, 0).result >>> 0;
  assert.notEqual(handle, 0xffffffff, 'CREATE_NEW opens a file that does not exist');
  assert.ok(r.files.has('new.bin'), 'the created file is a filesystem entry, not just a handle');
  const source = r.allocate(4);
  r.data.set([1, 2, 3, 4], source);
  const written = r.allocate(4);
  assert.equal(call('kernel32.dll!WriteFile', handle, source, 4, written, 0).result, 1);
  assert.equal(r.read32(written), 4);
  assert.deepEqual([...r.files.get('new.bin')], [1, 2, 3, 4]);
  // A second CREATE_NEW for the same name fails with ERROR_FILE_EXISTS.
  assert.equal(
    call('kernel32.dll!CreateFileW', name, 0x40000000, 0, 0, 1, 0, 0).result >>> 0,
    0xffffffff,
  );
  assert.equal(r.lastError, 80);
});

test('OLE Automation BSTR and VARIANT entries answer instead of raising', (t) => {
  const { r, call } = setup(t);
  // The BSTR helpers lived in a copy of the automation section that called an
  // undefined helper, so every one of them raised at the first use.
  const text = r.allocString('hi', true);
  const bstr = call('oleaut32.dll!SysAllocString', text).result >>> 0;
  assert.notEqual(bstr, 0);
  assert.equal(r.wideString(bstr), 'hi');
  assert.equal(call('oleaut32.dll!SysStringLen', bstr).result, 2);
  assert.equal(call('oleaut32.dll!SysStringByteLen', bstr).result, 4);
  // The character count is stored immediately before the first character.
  assert.equal(r.read32(bstr - 4) >>> 0, 4);
  const variant = r.allocate(16);
  r.data.fill(0xcc, variant, variant + 16);
  assert.equal(call('oleaut32.dll!VariantInit', variant).result, 0);
  assert.equal(r.guestMemory.read(variant, 2), 0, 'VariantInit clears vt');
  assert.equal(call('oleaut32.dll!SysFreeString', bstr).result, 0);
});

// Widely imported process, module and path queries that an application asks for
// before it does any real work. They were previously unresolved imports.
test('module, process, path and environment queries answer from the runtime model', (t) => {
  const { r, call } = setup(t);

  // Module identity under FROM_ADDRESS and the current image when the name is
  // NULL. (Process/thread identity lives in win32-threads.js and is tested
  // with the rest of the thread surface.)
  const out = r.allocate(4);
  assert.equal(call('kernel32.dll!GetModuleHandleExA', 0x4, r.pe.imageBase, out).result, 1);
  assert.equal(r.read32(out) >>> 0, r.pe.imageBase);
  call('kernel32.dll!GetModuleHandleExA', 0, 0, out);
  assert.equal(r.read32(out) >>> 0, r.pe.imageBase);
  assert.equal(call('kernel32.dll!GetModuleHandleExA', 0x8, 0, out).result, 0);
  assert.equal(r.lastError, 87, 'an unknown flag is rejected');
  // A FROM_ADDRESS pointer outside every image fails with MODULE_NOT_FOUND.
  r.lastError = 0;
  assert.equal(call('kernel32.dll!GetModuleHandleExA', 0x4, 0x10, out).result, 0);
  assert.equal(r.lastError, 126);

  const buffer = r.allocate(64);
  assert.equal(call('kernel32.dll!GetSystemDirectoryA', buffer, 64).result, 19);
  assert.equal(r.string(buffer), 'C:\\Windows\\System32');
  // An undersized buffer reports failure with ERROR_INSUFFICIENT_BUFFER.
  r.lastError = 0;
  assert.equal(call('kernel32.dll!GetSystemDirectoryA', buffer, 4).result, 0);
  assert.equal(r.lastError, 122);

  assert.equal(call('kernel32.dll!GetDriveTypeA', r.allocString('C:\\')).result, 3);
  assert.equal(call('kernel32.dll!GetLogicalDrives').result, 4, 'only C exists');
});

test('ExpandEnvironmentStrings resolves known variables and leaves unknown ones', (t) => {
  const { r, call } = setup(t);
  const buffer = r.allocate(256);
  const expand = (text) =>
    call('kernel32.dll!ExpandEnvironmentStringsA', r.allocString(text), buffer, 256).result >>> 0;
  assert.equal(expand('%SystemRoot%\\x'), 12);
  assert.equal(r.string(buffer), 'C:\\Windows\\x');
  assert.equal(expand('%PATH%'), 3);
  assert.equal(r.string(buffer), 'C:\\');
  assert.equal(expand('%NoSuchVar%!'), 12);
  assert.equal(r.string(buffer), '%NoSuchVar%!', 'an unknown name is left in place');
  // A too-small buffer still reports the length the expansion needs, which is
  // what ExpandEnvironmentStrings documents (unlike the path getters).
  assert.equal(
    call('kernel32.dll!ExpandEnvironmentStringsA', r.allocString('%PATH%'), buffer, 1).result,
    4,
  );
});

test('SearchPath finds a packaged file and reports the required length otherwise', (t) => {
  const { r, call } = setup(t);
  const buffer = r.allocate(256);
  const length =
    call('kernel32.dll!SearchPathA', 0, r.allocString('console.exe'), 0, buffer, 256).result >>> 0;
  assert.ok(length > 0, 'a packaged executable is found');
  assert.equal(r.string(buffer), 'C:\\winebrowser\\console.exe');
  r.lastError = 0;
  assert.equal(
    call('kernel32.dll!SearchPathA', 0, r.allocString('nope.exe'), 0, buffer, 256).result,
    0,
  );
  assert.equal(r.lastError, 2, 'a missing file reports ERROR_FILE_NOT_FOUND');
});
