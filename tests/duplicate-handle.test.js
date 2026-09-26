import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { duplicateHandle } from '../src/duplicate-handle.js';
import { SYNC, syncObjects } from '../src/sync-objects.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  });
  const out = r.allocate(8),
    objects = syncObjects(r);
  const dup = (source, access = 0, attrs = 0, options = 2, target = 0xffffffff, pointer = out) =>
    duplicateHandle(
      r,
      (i) => [0xffffffff, source, target, pointer, access, attrs, options][i] >>> 0,
    );
  return { r, out, objects, dup };
}
test('duplicate event aliases share state, but retain independent rights and lifetimes', async (t) => {
  const { r, out, objects, dup } = setup(t);
  const { handle } = objects.event({
    manual: false,
    signaled: false,
    access: SYNC.ALL,
    inherit: true,
  });
  assert.equal(dup(handle, SYNC.WAIT, 0, 0), 0);
  const readOnly = r.read32(out);
  assert.equal(objects.change(readOnly, 'set').status, SYNC.ACCESS);
  assert.equal(dup(handle, 0, 0, 6), 0);
  const full = r.read32(out);
  assert.equal(r.handles.get(full).inherit, true);
  assert.equal(objects.close(handle), 0);
  assert.equal(objects.change(full, 'set').status, 0);
  assert.equal(await objects.wait([readOnly], false, 0n), 0);
  assert.equal(await objects.wait([full], false, 0n), SYNC.TIMEOUT);
  assert.equal(objects.close(full), 0);
  assert.equal(r.handles.get(readOnly).object.refs, 1);
  assert.equal(objects.close(readOnly), 0);
});
test('current-thread pseudo handles produce stable real handles that become signaled on exit', async (t) => {
  const { r, out, objects, dup } = setup(t);
  assert.equal(dup(0xfffffffe), 0);
  const first = r.read32(out);
  assert.equal(dup(0xfffffffe), 0);
  const second = r.read32(out);
  assert.notEqual(first, second);
  assert.equal(r.handles.get(first).object, r.handles.get(second).object);
  assert.equal(r.threads.lookup(first).thread, r.threads.main);
  assert.equal(await objects.wait([first], false, 0n), SYNC.TIMEOUT);
  r.threads.main.code = 77;
  await r.threads.waitForChildren();
  assert.equal(await objects.wait([first], false, 0n), 0);
  assert.equal(r.threads.lookup(second).thread.code, 77);
  assert.equal(objects.close(first), 0);
  assert.equal(objects.close(second), 0);
});
test('close-source applies on duplication failures and close-only ignores target outputs', (t) => {
  const { r, out, objects, dup } = setup(t);
  let handle = objects.event({ access: SYNC.WAIT }).handle;
  r.write32(out, 0x1234);
  assert.equal(dup(handle, SYNC.ALL, 0, 1), SYNC.ACCESS);
  assert.equal(r.read32(out), 0);
  assert.equal(r.handles.has(handle), false);
  handle = objects.event({}).handle;
  assert.equal(dup(handle, 0, 0, 3, 0xffffffff, r.data.length - 2), SYNC.FAULT);
  assert.equal(r.handles.has(handle), false);
  handle = objects.event({}).handle;
  r.write32(out, 0x1234);
  assert.equal(dup(handle, 0xffffffff, 0xffffffff, 1, 0, r.data.length + 8), 0);
  assert.equal(r.read32(out), 0x1234);
  assert.equal(r.handles.has(handle), false);
});
test('failed duplication preserves sources without close-source and cannot elevate granted rights', (t) => {
  const { r, out, objects, dup } = setup(t);
  const handle = objects.event({ access: SYNC.WAIT }).handle,
    count = r.handles.size;
  for (const [status, args] of [
    [SYNC.ACCESS, [handle, SYNC.ALL, 0, 0]],
    [SYNC.UNSUPPORTED, [handle, 0, 4, 2]],
    [SYNC.INVALID, [handle, 0, 0, 8]],
    [SYNC.HANDLE, [handle, 0, 0, 2, 1]],
    [SYNC.FAULT, [handle, 0, 0, 2, 0xffffffff, r.data.length - 2]],
    [SYNC.UNSUPPORTED, [handle, 0, 0, 2, 0xffffffff, 0]],
  ])
    assert.equal(dup(...args), status);
  assert.equal(r.handles.size, count);
  assert.ok(r.handles.has(handle));
  assert.equal(dup(0xdeadbeef), SYNC.HANDLE);
  assert.equal(dup(handle, 0, 0xffffffff, 6), 0);
  assert.equal(r.handles.get(r.read32(out)).inherit, false);
});

test('duplicated thread query/set rights include their limited-information equivalents', (t) => {
  const { r, out, objects, dup } = setup(t);
  const object = r.threads.objectFor(r.threads.main);
  const source = objects.openHandle(object, 0x60, false).handle;
  assert.equal(dup(source, 0x40, 0, 0), 0);
  assert.equal(r.handles.get(r.read32(out)).access, 0x840);
  assert.equal(dup(source, 0, 0, 2), 0);
  assert.equal(r.handles.get(r.read32(out)).access, 0xc60);
  assert.equal(dup(0xfffffffe, 0x80000000, 0, 0), 0);
  assert.equal(r.handles.get(r.read32(out)).access, 0x20848);
});
