import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { syncObjects } from '../src/sync-objects.js';
import { registerThunk } from '../src/thunk-addresses.js';

async function runtime(name = 'threads') {
  const bytes = new Uint8Array(await readFile(`tests/fixtures/threads/${name}.exe`));
  return new Runtime(iced, {
    files: new Map([[name + '.exe', bytes]]),
    exe: name + '.exe',
    maxBlocks: 100000,
  });
}
for (const [name, expected] of [
  ['threads', 0],
  ['worker-exit', 77],
  ['main-exit', 77],
  ['thread-fault', null],
]) {
  test(
    `native ${name} execution has correct process outcome and releases all worker storage/waits`,
    { timeout: 10000 },
    async () => {
      const r = await runtime(name),
        allocations = [],
        create = r.threads.create.bind(r.threads);
      r.threads.create = (options) => {
        const result = create(options);
        if (result.thread) allocations.push(result.thread.stack, result.thread.tebAllocation);
        return result;
      };
      if (expected === null) await assert.rejects(r.run(), /Unsupported instruction ud2/);
      else assert.equal((await r.run()).exitCode, expected);
      assert.ok(allocations.length);
      for (const allocation of allocations) assert.equal(r.heap.allocations.has(allocation), false);
      assert.equal(r.threads.records.size, 1);
      assert.equal(r.threads.queue.length, 0);
      assert.equal(r.threads.timers.size, 0);
      assert.equal(r.syncObjects.waiters.size, 0);
      assert.equal(r.callDepth, 0);
    },
  );
}

test(
  'runnable priority ordering and thread joins use actual guest routines',
  { timeout: 10000 },
  async () => {
    const r = await runtime();
    try {
      await r.initializeModules();
      const entry = r.pe.exports.find((e) => e.name?.startsWith('SimpleWorker'));
      assert.ok(entry);
      const handles = [],
        started = [],
        activate = r.threads.activate.bind(r.threads);
      r.threads.activate = (thread) => {
        if (thread !== r.threads.main && !started.includes(thread.id)) started.push(thread.id);
        activate(thread);
      };
      for (const priority of [-2, 0, 2]) {
        const created = r.threads.create({
          start: r.pe.imageBase + entry.rva,
          parameter: priority + 10,
          suspended: true,
        });
        assert.equal(created.status, 0);
        assert.equal(r.threads.setPriority(created.handle, priority), 0);
        assert.equal(r.threads.resume(created.handle).status, 0);
        handles.push(created.handle);
      }
      const wait = registerThunk(r.thunks, {
        kind: 'com',
        name: 'test-join',
        invoke: async () => ({
          result: await r.threads.block(syncObjects(r).wait(handles, true)),
          argc: 0,
        }),
      });
      assert.equal(await r.callGuest(wait), 0);
      assert.deepEqual(started, [4, 3, 2]);
      assert.deepEqual(
        handles.map((h) => r.threads.lookup(h).thread.code),
        [8, 10, 12],
      );
    } finally {
      await r.threads.stopOthers();
      r.syncObjects?.dispose();
      r.windows.dispose();
      r.cpu.dispose();
    }
  },
);

test('NT creation validates attributes/access before allocation and TLS index clearing covers live threads', async () => {
  const r = await runtime();
  const nt = (name, args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  const out = r.allocate(4),
    attrs = r.allocate(36),
    ids = r.allocate(16),
    returned = r.allocate(8),
    index = r.allocate(4);
  const count = r.heap.allocations.size;
  const args = [out, 0x1fffff, 0, 0xffffffff, r.pe.entryPoint, 0, 1, 0, 0, 65536, attrs];
  try {
    r.write32(out, 0xcccccccc);
    [36, 0x10003, 8, ids, returned, 0x10004, 4, ids + 8, returned + 4].forEach((v, i) =>
      r.write32(attrs + i * 4, v),
    );
    assert.equal(
      nt(
        'NtCreateThreadEx',
        args.map((v, i) => (i === 6 ? 2 : v)),
      ),
      0xc00000bb,
    );
    r.write32(attrs + 24, 8);
    assert.equal(nt('NtCreateThreadEx', args), 0xc000000d);
    assert.equal(r.read32(out), 0xcccccccc);
    assert.equal(r.heap.allocations.size, count);
    r.write32(attrs + 24, 4);
    assert.equal(nt('NtCreateThreadEx', args), 0);
    const handle = r.read32(out),
      thread = r.threads.lookup(handle).thread;
    assert.equal(r.read32(ids), 1);
    assert.equal(r.read32(ids + 4), thread.id);
    assert.equal(r.read32(ids + 8), thread.teb);
    assert.equal(r.read32(returned), 8);
    assert.equal(r.read32(returned + 4), 4);
    for (const t of r.threads.records.values()) r.write32(t.teb + 0xe10 + 20, 0xabcdef01);
    r.write32(index, 5);
    assert.equal(nt('NtSetInformationThread', [0xfffffffe, 10, index, 4]), 0);
    for (const t of r.threads.records.values()) assert.equal(r.read32(t.teb + 0xe10 + 20), 0);
    assert.equal(r.threads.setPriority(handle, 20), 0xc000000d);
    const restricted = syncObjects(r).openHandle(thread.object, 0x100000, false);
    assert.equal(r.threads.resume(restricted.handle).status, 0xc0000022);
    assert.equal(r.threads.setPriority(restricted.handle, 1), 0xc0000022);
    assert.equal(nt('NtQueryInformationThread', [restricted.handle, 0, attrs, 28, 0]), 0xc0000022);
    assert.equal(r.threads.records.size, 2);
  } finally {
    await r.threads.stopOthers();
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  }
  assert.equal(r.heap.allocations.size, count);
});

test('native DLL static TLS templates and attach/detach callbacks remain private to each worker', async () => {
  const r = await runtime();
  r.files.set(
    'thread-tls.dll',
    new Uint8Array(await readFile('tests/fixtures/threads/thread-tls.dll')),
  );
  r.graph.files.set('thread-tls.dll', r.files.get('thread-tls.dll'));
  try {
    await r.loadLibrary('thread-tls.dll');
    const module = r.graph.findLoaded('thread-tls.dll');
    const address = (name) =>
      module.base + module.pe.exports.find((e) => e.name?.startsWith(name)).rva;
    const handles = [10, 20].map(
      (parameter) => r.threads.create({ start: address('ProbeWorker'), parameter }).handle,
    );
    assert.ok(handles.every(Boolean));
    const wait = registerThunk(r.thunks, {
      kind: 'com',
      name: 'test-tls-join',
      invoke: async () => ({
        result: await r.threads.block(syncObjects(r).wait(handles, true)),
        argc: 0,
      }),
    });
    assert.equal(await r.callGuest(wait), 0);
    assert.deepEqual(
      handles.map((h) => r.threads.lookup(h).thread.code),
      [11, 21],
    );
    assert.equal(await r.callGuest(address('Counts')), 0x202);
    assert.equal(await r.callGuest(address('Failures')), 0);
    assert.equal(await r.callGuest(address('MainValue')), 0xa1b2c3d4);
  } finally {
    await r.threads.stopOthers();
    await r.shutdownProcess();
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  }
});

test('thread alerts coalesce, consume once and report timeout or invalid identity', async () => {
  const r = await runtime(),
    p = r.allocate(8);
  const nt = (name, ...args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  try {
    r.view.setBigInt64(p, 0n, true);
    assert.equal(nt('NtAlertThreadByThreadId', 1), 0);
    assert.equal(nt('NtAlertThreadByThreadId', 1), 0);
    assert.equal(await nt('NtWaitForAlertByThreadId', 0xdeadbeef, p), 0x101);
    assert.equal(await nt('NtWaitForAlertByThreadId', 0, p), 0x102);
    const pending = nt('NtWaitForAlertByThreadId', 0, 0);
    assert.equal(nt('NtAlertThreadByThreadId', 1), 0);
    assert.equal(await pending, 0x101);
    assert.equal(nt('NtAlertThreadByThreadId', 99999), 0xc000000b);
    assert.equal(nt('NtWaitForAlertByThreadId', 0, 0x4000000), 0xc0000005);
  } finally {
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  }
});

test('process cancellation unwinds a sleeping guest and clears its host timer', async () => {
  const r = await runtime();
  try {
    await r.initializeModules();
    const signal = syncObjects(r).event();
    const work = registerThunk(r.thunks, {
      kind: 'com',
      name: 'test-sleep',
      invoke: async () => {
        syncObjects(r).change(signal.handle, 'set');
        await r.threads.delay(10000);
        return { result: 99, argc: 1 };
      },
    });
    const created = r.threads.create({ start: work, parameter: 0 });
    assert.equal(created.status, 0);
    const wait = registerThunk(r.thunks, {
      kind: 'com',
      name: 'test-ready',
      invoke: async () => ({
        result: await r.threads.block(syncObjects(r).wait([signal.handle], false)),
        argc: 0,
      }),
    });
    assert.equal(await r.callGuest(wait), 0);
    assert.equal(r.threads.timers.size, 1);
    await r.threads.stopOthers();
    assert.equal(r.threads.timers.size, 0);
    assert.equal(r.threads.lookup(created.handle).thread.done, true);
  } finally {
    await r.threads.stopOthers();
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  }
});

test('a starved ready UI thread receives a bounded priority boost and suspended threads stay parked', async () => {
  const { GuestThreads } = await import('../src/guest-threads.js');
  let now = 0;
  const scheduler = new GuestThreads({ cpu: { captureContext: () => ({}) } });
  scheduler.schedulerNow = () => now;
  const low = { id: 2, relativePriority: -2, suspend: 0, readySince: 0 };
  const high = { id: 3, relativePriority: 15, suspend: 0, readySince: 0 };
  const suspended = { id: 4, relativePriority: 15, suspend: 1, readySince: 0 };
  const resumed = [];
  scheduler.activate = (thread) => {
    scheduler.current = thread;
    if (thread.boostQuanta) thread.boostSince = now;
    resumed.push(thread.id);
  };
  for (const thread of [low, high, suspended]) thread.resume = () => {};
  scheduler.current = null;
  scheduler.queue = [low, high, suspended];
  scheduler.pump();
  assert.deepEqual(resumed, [3], 'base priority wins before starvation');
  now = 3001;
  scheduler.block = async () => {
    scheduler.current = null;
    high.resume = () => {};
    scheduler.ready(high);
  };
  await scheduler.yield();
  assert.deepEqual(
    resumed,
    [3, 2],
    'starved low-priority thread resumes despite runnable priority 15',
  );
  assert.equal(low.boostQuanta, 2);
  assert.equal(scheduler.priority(low), 6, 'boost leaves the requested base priority intact');
  assert.equal(scheduler.schedulingPriority(low), 15);
  scheduler.block = async () => {};
  now += 10;
  await scheduler.yield();
  assert.equal(low.boostQuanta, 2, 'a dispatcher checkpoint is not a full quantum');
  now += 10;
  await scheduler.yield();
  assert.equal(low.boostQuanta, 1);
  now += 20;
  await scheduler.yield();
  assert.equal(low.boostQuanta, 0);
  assert.equal(scheduler.schedulingPriority(low), 6, 'boost expires after two quanta');
  assert.ok(scheduler.queue.includes(suspended));
});

test('starvation boost accounts running time across switches and excludes blocked time', async () => {
  const { GuestThreads } = await import('../src/guest-threads.js');
  let now = 0;
  const runtime = { cpu: { captureContext: () => ({}), restoreContext: () => {} }, callDepth: 1 };
  const scheduler = new GuestThreads(runtime);
  scheduler.schedulerNow = () => now;
  const thread = { id: 2, depth: 1, context: {}, boostQuanta: 2, boostElapsed: 0 };
  scheduler.activate(thread);
  now = 10;
  scheduler.save(thread);
  assert.equal(thread.boostElapsed, 10);
  // A blocked guest waits on a host API while another guest owns the CPU.
  now = 1010;
  scheduler.activate(thread);
  now = 1020;
  scheduler.accountBoost(thread);
  assert.equal(thread.boostQuanta, 1);
  assert.equal(thread.boostElapsed, 0);
  now = 1040;
  scheduler.accountBoost(thread);
  assert.equal(thread.boostQuanta, 0);
  assert.equal(scheduler.schedulingPriority(thread), 8);
});
