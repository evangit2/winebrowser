import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { SYNC, syncObjects } from '../src/sync-objects.js';
import { systemFileTime } from '../src/shared-user-data.js';
import { ProcessSession } from '../src/process-session.js';

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

test('recursive mutex ownership, queries, aliases and release errors agree across Win32 and NT', async (t) => {
  const { r, nt, api, objects, out } = setup(t);
  const name = string(r, 'Local\\OwnedLock');
  const mutex = api('CreateMutexW', 0, 1, name).result;
  assert.ok(mutex);
  assert.equal(api('CreateMutexExW', 0, name, 0, SYNC.MUTEX_ALL).result > 0, true);
  assert.equal(r.lastError, 183);
  assert.equal(objects.wait([mutex], false, 0n), 0);
  assert.equal(nt('NtQueryMutant', mutex, 0, out, 8, out + 8), 0);
  assert.deepEqual([...r.data.slice(out, out + 8)], [255, 255, 255, 255, 1, 0, 0, 0]);
  assert.equal(r.read32(out + 8), 8);
  assert.equal(nt('NtQueryMutant', mutex, 1, out, 8, 0), 0);
  assert.equal(r.read32(out), 1);
  assert.equal(r.read32(out + 4), r.threads.main.id);
  const query = api('OpenMutexW', SYNC.QUERY, 0, name).result;
  assert.ok(query);
  assert.equal(objects.wait([query], false, 0n), SYNC.ACCESS);
  const owner = r.threads.current;
  r.threads.current = { id: 2 };
  assert.equal(api('ReleaseMutex', mutex).result, 0);
  assert.equal(r.lastError, 288);
  assert.equal(objects.wait([mutex], false, 0n), SYNC.TIMEOUT);
  const pending = objects.wait([mutex], false);
  r.threads.current = owner;
  assert.equal(nt('NtReleaseMutant', mutex, out), 0);
  assert.equal(r.read32(out), 0xffffffff);
  assert.equal(objects.waiters.size, 1, 'one release retains recursive ownership');
  assert.equal(nt('NtReleaseMutant', mutex, out), 0);
  assert.equal(r.read32(out), 0);
  assert.equal(await pending, 0);
  assert.equal(nt('NtReleaseMutant', mutex, 0), SYNC.NOT_OWNER, 'parked waiter owns the lock');
  assert.equal(nt('NtQueryMutant', mutex, 0, out, 4, 0), 0xc0000004);
  assert.equal(nt('NtReleaseMutant', mutex, 0x4000000), SYNC.FAULT);
  assert.equal(api('CreateEventW', 0, 0, 0, name).result, 0);
  assert.equal(r.lastError, 6, 'mutexes and events occupy the same typed namespace');
  assert.equal(nt('NtCreateMutant', out, SYNC.ALL, 0, 0), SYNC.ACCESS);
});

test('abandoned mutexes transfer ownership once and wait-all leaves state intact until every object is ready', async (t) => {
  const { r, objects } = setup(t);
  const owner = r.threads.current;
  const mutex = objects.mutex({ initialOwner: true }).handle;
  const event = objects.event().handle;
  r.threads.current = { id: 2 };
  const pending = objects.wait([event, mutex], true);
  objects.abandon(owner);
  assert.equal(objects.waiters.size, 1);
  assert.equal(objects.lookup(mutex, 'sync-mutex').object.abandoned, true);
  objects.change(event, 'set');
  assert.equal(await pending, SYNC.ABANDONED);
  assert.equal(objects.wait([mutex], false, 0n), 0, 'abandonment is consumed exactly once');
  assert.equal(objects.releaseMutex(mutex).status, 0);
  assert.equal(objects.releaseMutex(mutex).status, 0);
  objects.wait([mutex], false, 0n);
  const second = r.threads.current;
  r.threads.current = owner;
  objects.abandon(second);
  assert.equal(objects.wait([event, mutex], false, 0n), SYNC.ABANDONED + 1);
  assert.equal(objects.wait([mutex, mutex], true, 0n), SYNC.INVALID);
});

test('named objects and cross-process wakeups survive parent disposal but are isolated between uploads', async () => {
  const make = (options) => ({
    ...options,
    read32: () => 0,
    handles: new Map(),
    threads: { current: {} },
    performanceClock: { read: () => BigInt(Math.floor(performance.now() * 1e6)) },
    systemNow: Date.now,
  });
  const session = new ProcessSession(new Map(), make);
  const parent = session.create({ exe: 'parent' }).record.runtime;
  const child = session.create({ exe: 'child' }, parent).record.runtime;
  const a = syncObjects(parent),
    b = syncObjects(child);
  const name = a.local + '\\FamilyEvent';
  const event = a.event({ name }).handle;
  const alias = b.event({ name, open: true }).handle;
  const pending = b.wait([alias], false);
  a.change(event, 'set');
  assert.equal(await pending, 0);
  const sem = a.semaphore({ name: a.local + '\\Tokens', initial: 0, maximum: 2 }).handle;
  const other = b.semaphore({ name: a.local + '\\Tokens', open: true }).handle;
  const token = b.wait([other], false);
  a.release(sem, 1);
  assert.equal(await token, 0);
  const mutex = a.mutex({ name: a.local + '\\Lock', initialOwner: true }).handle;
  const remote = b.mutex({ name: a.local + '\\Lock', open: true }).handle;
  const abandoned = b.wait([remote], false);
  const third = syncObjects(make({}));
  assert.equal(third.event({ name, open: true }).status, SYNC.NOT_FOUND);
  a.dispose();
  assert.equal(await abandoned, SYNC.ABANDONED);
  assert.equal(a.handles.size, 0);
  assert.equal(b.names.size, 3, 'child aliases retain the objects after parent exit');
  assert.equal(b.releaseMutex(remote).status, 0);
  b.change(alias, 'set');
  assert.equal(b.wait([alias], false, 0n), 0);
  b.dispose();
  assert.equal(session.syncDomain.names.size, 0);
  assert.equal(session.syncDomain.objects.size, 0);
  assert.equal(session.syncDomain.members.size, 0);
  assert.equal(a.lookup(mutex, 'sync-mutex').status, SYNC.HANDLE);
  third.dispose();
});

test('stopped waiters cannot claim released mutexes and closed owned mutexes remain alive until abandonment', async (t) => {
  const { r, objects } = setup(t);
  const owner = r.threads.current;
  const name = objects.local + '\\Lifetime';
  const mutex = objects.mutex({ name, initialOwner: true }).handle;
  objects.close(mutex);
  assert.equal(objects.names.size, 1, 'ownership retains the named object');
  const alias = objects.mutex({ name, open: true }).handle;
  const blocked = { id: 2 };
  r.threads.current = blocked;
  const waiting = objects.wait([alias], false);
  objects.abandon(blocked);
  assert.equal(await waiting, SYNC.CANCELLED);
  objects.abandon(owner);
  assert.equal(objects.wait([alias], false, 0n), SYNC.ABANDONED);
  objects.close(alias);
  objects.abandon(blocked);
  assert.equal(objects.domain.objects.size, 0);
  assert.equal(objects.names.size, 0);
});

test('owned mutexes with closed handles remain within the kernel-object budget', (t) => {
  const { r, objects } = setup(t);
  objects.domain.limit = 1;
  const mutex = objects.mutex({ initialOwner: true }).handle;
  const object = objects.lookup(mutex, 'sync-mutex').object;
  objects.close(mutex);
  assert.equal(objects.event().status, SYNC.MEMORY);
  const alias = objects.openHandle(object, SYNC.MUTEX_ALL, false).handle;
  assert.ok(alias, 'opening an existing object does not allocate another object');
  objects.close(alias);
  objects.abandon(r.threads.current);
  assert.ok(objects.event().handle, 'abandonment frees unreferenced object storage');
});

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

test('semaphore counts, release limits and output faults preserve state on failure', async (t) => {
  const { r, nt, out, wait, objects } = setup(t);
  for (const [initial, max] of [
    [-1, 2],
    [0, 0],
    [3, 2],
    [0, 0x80000000],
  ]) {
    assert.equal(nt('NtCreateSemaphore', out, SYNC.ALL, 0, initial, max), SYNC.INVALID);
    assert.equal(r.read32(out), 0);
  }
  assert.equal(nt('NtCreateSemaphore', out, SYNC.ALL, 0, 1, 3), 0);
  const h = r.read32(out),
    state = objects.lookup(h, 'sync-semaphore').object;
  assert.equal(await wait(h), 0);
  assert.equal(await wait(h), SYNC.TIMEOUT);
  assert.equal(nt('NtReleaseSemaphore', h, 2, out), 0);
  assert.equal(r.read32(out), 0);
  r.write32(out, 0xdeadbeef);
  assert.equal(nt('NtReleaseSemaphore', h, 2, out), SYNC.LIMIT);
  for (const count of [0, -1, 0x80000000])
    assert.equal(nt('NtReleaseSemaphore', h, count, out), SYNC.INVALID);
  assert.equal(nt('NtReleaseSemaphore', h, 1, 0x4000000), SYNC.FAULT);
  assert.equal(r.read32(out), 0xdeadbeef);
  assert.equal(state.count, 2);
  assert.equal(nt('NtQuerySemaphore', h, 0, out, 8, 0x4000000), SYNC.FAULT);
  assert.equal(r.read32(out), 0xdeadbeef);
  assert.equal(nt('NtQuerySemaphore', h, 1, out, 8, 0), 0xc0000003);
  assert.equal(nt('NtQuerySemaphore', h, 0, out, 12, 0), 0xc0000004);
  assert.equal(nt('NtQuerySemaphore', h, 0, out, 8, out + 8), 0);
  assert.deepEqual(
    [0, 4, 8].map((i) => r.read32(out + i)),
    [2, 3, 8],
  );
  assert.equal(await wait(h), 0);
  assert.equal(await wait(h), 0);
  assert.equal(await wait(h), SYNC.TIMEOUT);
});

test('semaphore releases wake only the available count and wait-all consumes atomically', async (t) => {
  const { nt, out, r, wait, create, objects } = setup(t);
  nt('NtCreateSemaphore', out, SYNC.ALL, 0, 0, 3);
  const h = r.read32(out),
    event = create();
  const first = wait(h, null),
    second = wait(h, null),
    third = wait(h, null);
  nt('NtReleaseSemaphore', h, 2, out);
  assert.equal(r.read32(out), 0);
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.equal(objects.waiters.size, 1);
  assert.equal(await wait(h), SYNC.TIMEOUT);
  nt('NtReleaseSemaphore', h, 1, 0);
  assert.equal(await third, 0);
  nt('NtReleaseSemaphore', h, 1, 0);
  assert.equal(await objects.wait([h, event], true, 0n), SYNC.TIMEOUT);
  assert.equal(await wait(h), 0, 'failed wait-all keeps the count');
  const both = objects.wait([h, event], true, null);
  nt('NtSetEvent', event, 0);
  assert.equal(objects.waiters.size, 1);
  nt('NtReleaseSemaphore', h, 1, 0);
  assert.equal(await both, 0);
  assert.equal(await wait(event), SYNC.TIMEOUT);
  assert.equal(await wait(h), SYNC.TIMEOUT);
  nt('NtSetEvent', event, 0);
  nt('NtReleaseSemaphore', h, 1, 0);
  assert.equal(await objects.wait([event, h], false, 0n), 0);
  assert.equal(await wait(h), 0, 'wait-any consumes only the selected object');
});

test('named semaphores share counts across NT, Win32 and duplicate handles with separate rights', async (t) => {
  const { r, nt, api, out, wait, objects } = setup(t);
  const name = string(r, 'Local\\CountingGate'),
    attr = attributes(r, objects.local + '\\CountingGate', 0x80);
  const first = api('CreateSemaphoreW', 0, 1, 2, name).result;
  assert.ok(first);
  assert.equal(nt('NtCreateSemaphore', out, SYNC.ALL, attr, 0, 7), SYNC.EXISTS);
  const alias = r.read32(out);
  assert.equal(objects.lookup(alias, 'sync-semaphore').object.maximum, 2);
  const query = api('OpenSemaphoreW', SYNC.QUERY, 1, name).result;
  assert.ok(query);
  assert.equal(r.handles.get(query).inherit, true);
  assert.equal(nt('NtReleaseSemaphore', query, 1, 0), SYNC.ACCESS);
  assert.equal(await wait(query), SYNC.ACCESS);
  assert.equal(nt('NtQuerySemaphore', query, 0, out, 8, 0), 0);
  assert.equal(nt('NtDuplicateObject', 0xffffffff, first, 0xffffffff, out, SYNC.WAIT, 0, 0), 0);
  const duplicate = r.read32(out);
  assert.equal(api('ReleaseSemaphore', duplicate, 1, 0).result, 0);
  assert.equal(r.lastError, 5);
  assert.equal(await objects.wait([duplicate, alias], true, 0n), SYNC.INVALID);
  assert.equal(await wait(duplicate), 0);
  assert.equal(await wait(alias), SYNC.TIMEOUT);
  assert.equal(api('CreateEventW', 0, 0, 0, name).result, 0);
  assert.equal(r.lastError, 6);
  assert.equal(nt('NtOpenEvent', out, SYNC.ALL, attr), SYNC.TYPE);
  assert.equal(nt('NtSetEvent', first, 0), SYNC.TYPE);
  const reverse = string(r, 'EventCollision');
  const event = api('CreateEventW', 0, 0, 0, reverse).result;
  assert.equal(api('CreateSemaphoreW', 0, 0, 2, reverse).result, 0);
  assert.equal(r.lastError, 6);
  nt('NtClose', event);
  for (const h of [first, alias, query, duplicate]) nt('NtClose', h);
  assert.equal(api('OpenSemaphoreW', SYNC.ALL, 0, name).result, 0);
  assert.equal(r.lastError, 2);
  assert.equal(objects.names.size, 0);
});

test('extended semaphore APIs, signal-and-wait, timeouts and close retain count semantics', async (t) => {
  const { r, nt, api, out, wait, limit, objects } = setup(t);
  assert.equal(api('CreateSemaphoreExA', 0, 0, 1, 0, 1, SYNC.ALL).result, 0);
  const h = api('CreateSemaphoreExA', 0, 0, 1, 0, 0, SYNC.ALL).result;
  assert.ok(h);
  assert.equal(await nt('NtSignalAndWaitForSingleObject', h, h, 0, limit), 0);
  assert.equal((await api('SignalObjectAndWait', h, h, 0, 0)).result, 0);
  assert.equal(await wait(h), SYNC.TIMEOUT);
  assert.equal(api('ReleaseSemaphore', h, 1, out).result, 1);
  r.write32(out, 0xdeadbeef);
  assert.equal(api('ReleaseSemaphore', h, 1, out).result, 0);
  assert.equal(r.lastError, 298);
  assert.equal(r.read32(out), 0xdeadbeef);
  assert.equal(await wait(h), 0);
  const initial = Number(r.performanceClock.read()) / 1e6;
  let advance = 0;
  r.performanceClock.now = () => initial + advance;
  const expired = wait(h, -100000n);
  advance = 20;
  nt('NtReleaseSemaphore', h, 1, 0);
  assert.equal(await expired, SYNC.TIMEOUT);
  assert.equal(await wait(h), 0);
  const closed = wait(h, null);
  nt('NtClose', h);
  assert.equal(await closed, SYNC.HANDLE);
  assert.equal(objects.waiters.size, 0);
});
