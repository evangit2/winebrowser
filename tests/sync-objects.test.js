import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { SYNC, syncObjects } from '../src/sync-objects.js';
import { systemFileTime } from '../src/shared-user-data.js';

const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => {
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  });
  const nt = (name, ...args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  const api = (name, ...args) => r.apiProvider.get(`kernel32.dll!${name}`)(r, (i) => args[i] >>> 0);
  const out = r.allocate(32),
    limit = r.allocate(8);
  r.view.setBigInt64(limit, 0n, true);
  const create = (manual = false, initial = false, attr = 0, access = SYNC.ALL) => {
    assert.equal(nt('NtCreateEvent', out, access, attr, manual ? 0 : 1, +initial), 0);
    return r.read32(out);
  };
  const wait = (handle, ticks = 0n) => {
    if (ticks === null) return nt('NtWaitForSingleObject', handle, 0, 0);
    r.view.setBigInt64(limit, ticks, true);
    return nt('NtWaitForSingleObject', handle, 0, limit);
  };
  return { r, nt, api, out, limit, create, wait, objects: syncObjects(r) };
}
function string(r, text, wide = true) {
  const p = r.allocate((text.length + 1) * (wide ? 2 : 1));
  for (let i = 0; i <= text.length; i++) {
    if (wide) r.view.setUint16(p + i * 2, text.charCodeAt(i) || 0, true);
    else r.data[p + i] = text.charCodeAt(i) || 0;
  }
  return p;
}
function attributes(r, name, flags = 0, root = 0) {
  const p = r.allocate(24),
    u = r.allocate(8),
    text = string(r, name);
  r.view.setUint16(u, name.length * 2, true);
  r.view.setUint16(u + 2, name.length * 2 + 2, true);
  r.write32(u + 4, text);
  [24, root, u, flags, 0, 0].forEach((v, i) => r.write32(p + i * 4, v));
  return p;
}

test('manual reset wakes every current waiter and stays signaled; automatic reset releases only one', async (t) => {
  const { nt, r, create, wait, out, objects } = setup(t);
  const manual = create(true),
    auto = create(false);
  const manualWaits = [wait(manual, null), wait(manual, null)];
  assert.equal(objects.waiters.size, 2);
  assert.equal(nt('NtSetEvent', manual, out), 0);
  assert.equal(r.read32(out), 0);
  assert.deepEqual(await Promise.all(manualWaits), [0, 0]);
  assert.equal(await wait(manual), 0);
  assert.equal(await wait(manual), 0);
  assert.equal(nt('NtResetEvent', manual, out), 0);
  assert.equal(r.read32(out), 1);
  assert.equal(await wait(manual), SYNC.TIMEOUT);
  const first = wait(auto, null),
    second = wait(auto, null);
  nt('NtSetEvent', auto, out);
  assert.equal(await first, 0);
  assert.equal(objects.waiters.size, 1);
  nt('NtSetEvent', auto, out);
  assert.equal(await second, 0);
  nt('NtSetEvent', auto, out);
  nt('NtSetEvent', auto, out);
  assert.equal(r.read32(out), 1, 'repeated SetEvent coalesces rather than incrementing');
  assert.equal(await wait(auto), 0);
  assert.equal(await wait(auto), SYNC.TIMEOUT);
});

test('WaitAny selects lowest index and WaitAll consumes automatic events only after all are ready', async (t) => {
  const { r, nt, out, create, wait, objects } = setup(t),
    a = create(),
    b = create();
  r.write32(out, a);
  r.write32(out + 4, b);
  nt('NtSetEvent', a, 0);
  nt('NtSetEvent', b, 0);
  assert.equal(await objects.wait([a, b], false, 0n), 0);
  assert.equal(await wait(b), 0);
  nt('NtSetEvent', a, 0);
  assert.equal(await objects.wait([a, b], true, 0n), SYNC.TIMEOUT);
  assert.equal(await wait(a), 0, 'failed WaitAll does not consume an available event');
  const pending = objects.wait([a, b], true, null);
  nt('NtSetEvent', b, 0);
  assert.equal(objects.waiters.size, 1);
  nt('NtSetEvent', a, 0);
  assert.equal(await pending, 0);
  assert.equal(await wait(a), SYNC.TIMEOUT);
  assert.equal(await wait(b), SYNC.TIMEOUT);
  nt('NtSetEvent', a, 0);
  assert.equal(await objects.wait([a, 0xdead], false, 0n), SYNC.HANDLE);
  assert.equal(await wait(a), 0, 'invalid later handles do not consume earlier signals');
  assert.equal(await objects.wait([a, a], true, 0n), SYNC.INVALID);
  assert.equal(nt('NtWaitForMultipleObjects', 65, out, 1, 0, 0), 0xc00000ef);
});

test('NT and Win32 named events share identity, preserve original state/type and enforce access rights', async (t) => {
  const { r, nt, api, out, wait, objects } = setup(t);
  const ansi = string(r, 'SharedEvent', false),
    wide = string(r, 'Local\\SharedEvent');
  const original = api('CreateEventA', 0, 0, 1, ansi).result;
  assert.ok(original);
  assert.equal(r.lastError, 0);
  const other = api('CreateEventW', 0, 1, 0, wide).result;
  assert.notEqual(other, original);
  assert.equal(r.lastError, 183);
  const attr = attributes(r, objects.local + '\\SharedEvent', 0x80);
  assert.equal(nt('NtCreateEvent', out, SYNC.ALL, attr, 0, 0), SYNC.EXISTS);
  const third = r.read32(out);
  assert.equal(
    await objects.wait([third, original], true, 0n),
    0,
    'distinct named aliases refer to one signaled object',
  );
  assert.equal(await wait(other), SYNC.TIMEOUT);
  const query = api('OpenEventW', SYNC.QUERY, 1, wide).result;
  assert.equal(r.handles.get(query).inherit, true);
  assert.equal(nt('NtQueryEvent', query, 0, out, 8, out + 8), 0);
  assert.deepEqual(
    [0, 4, 8].map((offset) => r.read32(out + offset)),
    [1, 0, 8],
  );
  assert.equal(nt('NtSetEvent', query, 0), SYNC.ACCESS);
  assert.equal(await wait(query), SYNC.ACCESS);
  assert.equal(api('SetEvent', query).result, 0);
  assert.equal(r.lastError, 5);
  assert.equal(api('OpenEventA', SYNC.ALL, 0, string(r, 'sharedevent', false)).result, 0);
  assert.equal(
    nt('NtOpenEvent', out, SYNC.WAIT, attributes(r, objects.local + '\\sharedevent', 0x40)),
    0,
  );
  const insensitive = r.read32(out);
  for (const h of [original, other, third, query, insensitive])
    assert.equal(api('CloseHandle', h).result, 1);
  assert.equal(objects.names.size, 0);
  assert.equal(nt('NtClose', third), SYNC.HANDLE);
  assert.equal(api('OpenEventW', SYNC.ALL, 0, wide).result, 0);
});

test('native directory handles resolve local/global names and validate object attributes atomically', async (t) => {
  const { r, nt, out, objects, api } = setup(t);
  assert.equal(nt('NtOpenDirectoryObject', out, 6, attributes(r, objects.local)), 0);
  const dir = r.read32(out),
    attr = attributes(r, 'Global\\NativeEvent', 0x80, dir);
  assert.equal(nt('NtCreateEvent', out, SYNC.ALL, attr, 0, 0), 0);
  const native = r.read32(out);
  const host = api('OpenEventW', SYNC.ALL, 0, string(r, 'Global\\NativeEvent')).result;
  assert.ok(host);
  assert.equal(
    objects.lookup(native, 'sync-event').object,
    objects.lookup(host, 'sync-event').object,
  );
  assert.equal(nt('NtSetEvent', dir, 0), SYNC.TYPE);
  assert.equal(
    nt('NtCreateEvent', out, SYNC.ALL, attributes(r, '\\BaseNamedObjects\\NativeEvent'), 1, 1),
    SYNC.COLLISION,
  );
  assert.equal(r.read32(out), 0);
  r.write32(attr + 16, 0xdead);
  assert.equal(nt('NtCreateEvent', out, SYNC.ALL, attr, 1, 0), SYNC.UNSUPPORTED);
  assert.equal(nt('NtCreateEvent', 0, SYNC.ALL, 0, 1, 0), SYNC.FAULT);
  assert.equal(nt('NtCreateEvent', out, SYNC.ALL, 0, 2, 0), SYNC.INVALID);
  assert.equal(nt('NtSetEvent', native, 0x4000000), SYNC.FAULT);
  assert.equal(objects.lookup(native, 'sync-event').object.signaled, false);
  assert.equal(nt('NtQueryEvent', native, 1, out, 8, 0), 0xc0000003);
  assert.equal(nt('NtQueryEvent', native, 0, out, 4, 0), 0xc0000004);
  assert.equal(nt('NtClose', dir), 0);
});

test('relative and absolute waits time out, signals cancel timers, and close/dispose cancel pending waits', async (t) => {
  const { r, nt, create, wait, objects } = setup(t),
    handle = create();
  let started = performance.now();
  assert.equal(await wait(handle, -100000n), SYNC.TIMEOUT);
  assert.ok(performance.now() - started >= 8);
  started = performance.now();
  assert.equal(await wait(handle, systemFileTime(Date.now()) + 100000n), SYNC.TIMEOUT);
  assert.ok(performance.now() - started >= 7);
  const signaled = wait(handle, -10000000n);
  setTimeout(() => nt('NtSetEvent', handle, 0), 5);
  assert.equal(await signaled, 0);
  assert.equal(objects.waiters.size, 0);
  const closing = wait(handle, null);
  nt('NtClose', handle);
  assert.equal(await closing, SYNC.HANDLE);
  const another = create(),
    pending = wait(another, null);
  objects.dispose();
  assert.equal(await pending, SYNC.CANCELLED);
  assert.equal(r.handles.has(another), false);
});

test('pulse releases current waiters without saving a signal; signal-and-wait validates both sides', async (t) => {
  const { nt, create, wait, limit, objects } = setup(t),
    manual = create(true),
    auto = create();
  const first = wait(manual, null),
    second = wait(manual, null);
  nt('NtPulseEvent', manual, 0);
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.equal(await wait(manual), SYNC.TIMEOUT);
  nt('NtPulseEvent', auto, 0);
  assert.equal(await wait(auto), SYNC.TIMEOUT);
  assert.equal(await nt('NtSignalAndWaitForSingleObject', auto, auto, 0, limit), 0);
  assert.equal(await wait(auto), SYNC.TIMEOUT);
  assert.equal(nt('NtSignalAndWaitForSingleObject', auto, 1234, 0, limit), SYNC.HANDLE);
  assert.equal(objects.lookup(auto, 'sync-event').object.signaled, false);
});

test('late host signals do not consume events for expired waits when the worker timer was delayed', async (t) => {
  const { r, nt, create, wait } = setup(t),
    handle = create();
  const initial = Number(r.performanceClock.read()) / 1e6;
  let advance = 0;
  r.performanceClock.now = () => initial + advance;
  const pending = wait(handle, -100000n);
  advance = 20;
  nt('NtSetEvent', handle, 0);
  assert.equal(await pending, SYNC.TIMEOUT);
  assert.equal(await wait(handle), 0, 'the late signal is available to the next waiter');
});
