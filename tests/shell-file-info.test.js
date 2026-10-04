import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { iconForHandle } from '../src/win32-icons.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, {
    files: new Map([
      ['console.exe', exe],
      ['data/café.txt', new Uint8Array([1])],
    ]),
    exe: 'console.exe',
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  return { r, call: (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0) };
}
test('COM task allocation and shell IMalloc share ownership with preserving realloc and cross-free', async (t) => {
  const { r, call } = setup(t),
    out = r.allocate(4);
  call('shell32.dll!SHGetMalloc', out);
  const object = r.read32(out),
    table = r.read32(object),
    invoke = async (slot, ...args) =>
      r.thunks.get(r.read32(table + slot * 4)).invoke(r, (i) => [object, ...args][i] >>> 0);
  const p = call('ole32.dll!CoTaskMemAlloc', 32).result;
  r.write32(p, 0xdeadbeef);
  assert.equal((await invoke(7, p)).result, 1);
  const next = call('ole32.dll!CoTaskMemRealloc', p, 1024).result;
  assert.equal(r.read32(next), 0xdeadbeef);
  await invoke(5, next);
  assert.equal(r.allocationSize(next), null);
  const shell = (await invoke(3, 64)).result;
  call('ole32.dll!CoTaskMemFree', shell);
  assert.equal((await invoke(7, shell)).result, 0);
  const zero = call('ole32.dll!CoTaskMemAlloc', 0).result;
  assert.ok(zero);
  assert.equal(call('ole32.dll!CoTaskMemRealloc', zero, 0).result, 0);
  call('ole32.dll!CoTaskMemFree', 0);
});
test('SHGetFileInfo returns bounded A/W namespace metadata and independently owned icons', (t) => {
  const { r, call } = setup(t),
    p = r.allocate(700),
    name = r.allocString('data/café.txt', true);
  r.data.fill(0xa5, p, p + 700);
  r.lastError = 123;
  assert.equal(call('shell32.dll!SHGetFileInfoW', name, 0, p, 692, 0x700).result, 1);
  assert.equal(r.wideString(p + 12), 'café.txt');
  assert.equal(r.wideString(p + 532), 'TXT File');
  assert.equal(r.read32(p + 692), 0xa5a5a5a5);
  assert.equal(r.lastError, 123);
  const icon = r.read32(p);
  assert.equal(iconForHandle(r, icon).width, 32);
  assert.equal(
    call('shell32.dll!SHGetFileInfoA', r.allocString('not-present.zip'), 0, p, 352, 0x111).result,
    1,
  );
  const small = r.read32(p);
  assert.notEqual(small, icon);
  assert.equal(iconForHandle(r, small).width, 16);
  call('user32.dll!DestroyIcon', icon);
  assert.equal(iconForHandle(r, icon), null);
  assert.ok(iconForHandle(r, small));
  r.write32(p + 8, 0x70000000);
  assert.equal(
    call('shell32.dll!SHGetFileInfoW', r.allocString('data', true), 0, p, 692, 0x20800).result,
    1,
  );
  assert.equal(r.read32(p + 8), 0x70000000);
  r.data.fill(0xa5, p, p + 700);
  assert.equal(call('shell32.dll!SHGetFileInfoW', name, 0, p, 691, 0x100).result, 0);
  assert.equal(r.lastError, 122);
  assert.equal(r.read32(p), 0xa5a5a5a5);
  assert.equal(call('shell32.dll!SHGetFileInfoW', name, 0, p, 692, 0x4000).result, 0);
  assert.equal(r.lastError, 50);
  assert.equal(
    call('shell32.dll!SHGetFileInfoW', r.allocString('missing', true), 0, p, 692, 0x200).result,
    0,
  );
  assert.equal(r.lastError, 2);
});
