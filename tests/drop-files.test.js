import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { encodeAnsi } from '../src/encoding.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, exStyle = 0) {
  const events = [],
    r = new Runtime(iced, {
      files: new Map([['console.exe', exe]]),
      exe: 'console.exe',
      emit: (e) => events.push(e),
    });
  t.after(() => r.windows.dispose());
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  r.callGuest = async (_address, args) => (await call('user32.dll!DefWindowProcA', ...args)).result;
  const name = r.allocString('DropOwner'),
    cls = r.allocate(40);
  r.data.fill(0, cls, cls + 40);
  r.write32(cls + 4, 0x12345678);
  r.write32(cls + 16, r.pe.imageBase);
  r.write32(cls + 36, name);
  call('user32.dll!RegisterClassA', cls);
  const hwnd = (
    await call(
      'user32.dll!CreateWindowExA',
      exStyle,
      name,
      name,
      0x10c80000,
      0,
      0,
      400,
      200,
      0,
      0,
      r.pe.imageBase,
      0,
    )
  ).result;
  r.windows.queue.length = 0;
  const drop = (files, x = 12, y = 34) =>
    r.windows.input({ type: 'drop-files', windowId: hwnd, x, y, files });
  return { r, call, hwnd, drop, events };
}
test('browser drops become real HGLOBAL messages and readable isolated input files', async (t) => {
  const { r, call, hwnd, drop, events } = await setup(t);
  const files = [
    { name: 'console.exe', bytes: Uint8Array.of(65, 66) },
    { name: 'console.exe', bytes: Uint8Array.of(67) },
    { name: 'café Ω.txt', bytes: Uint8Array.of(68) },
  ];
  drop(files);
  assert.equal(r.windows.queue.length, 0);
  call('shell32.dll!DragAcceptFiles', hwnd, 1);
  assert.equal(events.at(-1).window.acceptFiles, true);
  drop(files, -2, 34);
  const message = r.windows.queue.shift();
  assert.equal(message.message, 0x233);
  assert.equal(message.lParam, 0);
  const h = message.wParam,
    out = r.allocate(1024),
    point = r.allocate(8);
  assert.equal(call('kernel32.dll!GlobalLock', h).result, h);
  assert.equal(call('shell32.dll!DragQueryFileW', h, 0xffffffff, 0, 0).result, 3);
  assert.equal(call('shell32.dll!DragQueryPoint', h, point).result, 1);
  assert.equal(r.read32(point) | 0, -2);
  assert.equal(r.read32(point + 4), 34);
  for (let i = 0; i < 3; i++) {
    const length = call('shell32.dll!DragQueryFileW', h, i, 0, 0).result;
    assert.ok(length > 0);
    r.data.fill(0xa5, out, out + 1024);
    assert.equal(call('shell32.dll!DragQueryFileW', h, i, out, 512).result, length);
    const path = r.wideString(out);
    assert.ok(path.startsWith('C:\\winebrowser\\_dropped\\1\\'));
    assert.equal(r.data[out + 2 * (length + 1)], 0xa5);
    const file = call('kernel32.dll!CreateFileW', out, 0x80000000, 7, 0, 3, 0, 0).result;
    assert.notEqual(file, 0xffffffff);
    assert.equal(call('kernel32.dll!ReadFile', file, out + 512, 4, point, 0).result, 1);
    assert.deepEqual(r.data.slice(out + 512, out + 512 + r.read32(point)), files[i].bytes);
    call('kernel32.dll!CloseHandle', file);
  }
  assert.equal(r.files.get('console.exe').length, exe.length);
  assert.equal(r.dirty.size, 0);
  call('shell32.dll!DragQueryFileA', h, 2, out, 512);
  assert.match(r.string(out), /café \?\.txt$/);
  assert.equal(call('shell32.dll!DragQueryFileW', h, 3, out, 512).result, 0);
  assert.equal(call('shell32.dll!DragFinish', h).argc, 1);
  assert.equal(r.allocationSize(h), null);
  assert.equal(call('shell32.dll!DragQueryFileW', h, 0xffffffff, 0, 0).result, 0);
  drop(files);
  assert.ok(r.files.has('_dropped/2/console.exe'));
  call('shell32.dll!DragAcceptFiles', hwnd, 0);
  const count = r.files.size;
  drop(files);
  assert.equal(r.files.size, count);
});
test('ANSI/Unicode native DROPFILES queries clip copied counts and preserve guards', async (t) => {
  const { r, call } = await setup(t, 0x10);
  for (const wide of [false, true]) {
    const text = 'C:\\café.txt\0C:\\two.txt\0\0';
    const body = wide
      ? new Uint8Array(new Uint16Array([...text].map((c) => c.charCodeAt(0))).buffer)
      : encodeAnsi(text).bytes;
    const h = r.allocate(20 + body.length),
      out = r.allocate(40),
      point = r.allocate(8);
    r.data.fill(0, h, h + r.allocationSize(h));
    r.write32(h, 20);
    r.write32(h + 12, 1);
    r.write32(h + 16, wide ? 1 : 0);
    r.data.set(body, h + 20);
    for (const suffix of ['A', 'W']) {
      r.data.fill(0xa5, out, out + 40);
      assert.equal(call('shell32.dll!DragQueryFile' + suffix, h, 0, out, 4).result, 3);
      assert.equal(r.data[out + (suffix === 'W' ? 8 : 4)], 0xa5);
      assert.equal(suffix === 'W' ? r.wideString(out) : r.string(out), 'C:\\');
      assert.equal(call('shell32.dll!DragQueryFile' + suffix, h, 0xffffffff, out, 1).result, 2);
    }
    assert.equal(call('shell32.dll!DragQueryPoint', h, point).result, 0);
    r.write32(h, 0xfffffff0);
    assert.equal(call('shell32.dll!DragQueryFileW', h, 0xffffffff, out, 5).result, 0);
    call('shell32.dll!DragFinish', h);
  }
});
test('invalid drops and malformed bounded MULTI_SZ blocks never enqueue or modify files', async (t) => {
  const { r, call, drop } = await setup(t, 0x10),
    count = r.files.size;
  for (const name of ['../x', 'C:\\x', 'a/b', '', '.', 'bad\0x'])
    drop([{ name, bytes: Uint8Array.of(1) }]);
  drop([{ name: 'a', bytes: [1] }]);
  drop([{ name: 'a', bytes: Uint8Array.of(1) }], NaN, 4);
  assert.equal(r.files.size, count);
  assert.equal(r.windows.queue.length, 0);
  const h = r.allocate(32);
  r.data.fill(65, h, h + r.allocationSize(h));
  r.write32(h, 20);
  r.write32(h + 16, 0);
  assert.equal(call('shell32.dll!DragQueryFileA', h, 0xffffffff, 0, 0).result, 0);
  call('shell32.dll!DragFinish', h);
});
