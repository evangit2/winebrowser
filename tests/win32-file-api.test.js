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
