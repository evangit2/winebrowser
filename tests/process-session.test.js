import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine, quoteArgument } from '../src/command-line.js';
import { ProcessSession } from '../src/process-session.js';
import { SYNC, SyncObjects } from '../src/sync-objects.js';
import { ntServices } from '../src/wine-nt.js';
import { Runtime } from '../src/runtime.js';
import iced from 'iced-x86';
import { readFile } from 'node:fs/promises';

test('Windows argument quoting round trips empty, Unicode, spaces, quotes and trailing slashes', () => {
  const args = [
    'app.exe',
    '',
    'two words',
    'quoted"value',
    'end\\',
    'ends with slash\\',
    'α雪',
    'one\\\\"two',
  ];
  assert.deepEqual(parseCommandLine(args.map(quoteArgument).join(' ')), args);
  assert.deepEqual(parseCommandLine('app.exe "a""b" c\\\\\\"d'), ['app.exe', 'a"b', 'c\\"d']);
});
function mockFactory(options) {
  let resolve, reject;
  const execution = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    ...options,
    run: () => execution,
    finish: (exitCode = 0) => resolve({ exitCode, blocks: 1, apiCalls: 2 }),
    fail: reject,
    emit: () => {},
    read32: () => 0,
    cpu: { dispose() {} },
    windows: { windows: new Map(), dispose() {}, input() {} },
    handles: new Map(),
    threads: { records: new Map(), fail: reject },
  };
}
test('suspended creation, shared writes, child exit signaling, and parent-independent lifetime', async () => {
  const session = new ProcessSession(
    new Map([
      ['dir/parent.exe', new Uint8Array([1])],
      ['dir/child.exe', new Uint8Array([2])],
    ]),
    mockFactory,
  );
  const parent = session.create({ exe: 'dir/parent.exe' }).record;
  const child = session.create({ exe: 'dir/child.exe', suspended: true }, parent.runtime).record;
  const handles = session.handles(parent.runtime, child, 0x1fffff, 0x1fffff);
  assert.equal(handles.status, 0);
  assert.equal(parent.runtime.files, child.runtime.files);
  assert.equal(child.started, false);
  assert.equal(parent.runtime.syncObjects.wait([handles.process], false, 0n), SYNC.TIMEOUT);
  child.runtime.files.set('child-output.txt', new Uint8Array([4]));
  child.runtime.dirty.add('child-output.txt');
  const waiting = parent.runtime.syncObjects.wait([handles.process, handles.thread], true);
  const running = session.run(parent);
  parent.runtime.finish();
  assert.deepEqual(session.resume(child), { status: 0, previous: 1 });
  child.runtime.finish(73);
  assert.equal(await waiting, 0);
  const result = await running;
  assert.deepEqual(
    result.processes.map((p) => p.exitCode),
    [0, 73],
  );
  assert.equal(result.blocks, 2);
  assert.deepEqual(result.outputs, [{ path: 'child-output.txt', bytes: new Uint8Array([4]) }]);
  assert.deepEqual(session.resolveImage('C:\\winebrowser\\DIR\\CHILD.EXE', ''), {
    status: 0,
    exe: 'dir/child.exe',
  });
  assert.equal(session.resolveImage('../../outside.exe', 'dir/').status, SYNC.PATH);
});
test('child faults cancel a running family and are not reported as successful launcher exits', async () => {
  const session = new ProcessSession(new Map(), mockFactory);
  const root = session.create({ exe: 'root.exe' }).record;
  const child = session.create({ exe: 'child.exe' }, root.runtime).record;
  const run = session.run(root);
  session.start(child);
  child.runtime.fail(Error('child fault'));
  await assert.rejects(run, /child fault/);
  assert.ok(root.done && child.done);
});
test('terminated suspended children signal both handles without executing', async () => {
  const session = new ProcessSession(new Map(), mockFactory);
  const root = session.create({ exe: 'root' }).record;
  const child = session.create({ exe: 'child', suspended: true }, root.runtime).record;
  const handles = session.handles(root.runtime, child, 0x1fffff, 0x1fffff);
  assert.equal(session.terminate(child, 91), 0);
  assert.equal(child.started, false);
  assert.equal(child.code, 91);
  assert.equal(root.runtime.syncObjects.wait([handles.process, handles.thread], true, 0n), 0);
});
const bytes = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function runtime() {
  return new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
}
test('process basic information reports real identity and validates length, address and handle', () => {
  const r = runtime(),
    p = r.allocate(24),
    ret = r.allocate(4),
    call = (args) => ntServices.NtQueryInformationProcess.call(r, (i) => args[i]);
  assert.equal(call([0xffffffff, 0, p, 24, ret]), 0);
  assert.equal(r.read32(p), 259);
  assert.equal(r.read32(p + 16), 1);
  assert.equal(r.read32(ret), 24);
  assert.equal(call([0xffffffff, 0, p, 4, ret]), 0xc0000004);
  assert.equal(call([0xffffffff, 0, 0, 24, ret]), SYNC.FAULT);
  assert.equal(call([1234, 0, p, 24, ret]), SYNC.HANDLE);
  r.cpu.dispose();
});
test('process creation validates outputs before runtime availability and unsupported calls fail honestly', () => {
  const r = runtime(),
    p = r.allocate(8),
    call = (args) => ntServices.NtCreateUserProcess.call(r, (i) => args[i] ?? 0);
  assert.equal(call([0, p + 4]), SYNC.FAULT);
  assert.equal(call([p, p + 4]), SYNC.UNSUPPORTED);
  r.processSession = {};
  assert.equal(call([p, p + 4, 0x1fffff, 0x1fffff, 0, 0, 4]), SYNC.UNSUPPORTED);
  r.cpu.dispose();
});
