import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(
  await readFile('tests/fixtures/message-position/wine-oracle.json', 'utf8'),
);
test('message retrieval retains native MSG.pt at posting, regenerates paint positions and isolates the getter by thread', async (t) => {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] >>> 0);
  const p = r.allocate(28);
  r.lastError = 777;
  const check = (row, found) => {
    assert.equal(found.result, row.found, row.step);
    assert.equal(r.read32(p + 4), row.message, row.step);
    assert.deepEqual([r.read32(p + 20) | 0, r.read32(p + 24) | 0], row.point, row.step);
    assert.deepEqual(api('GetMessagePos'), { result: row.position, argc: 0 });
    assert.equal(r.lastError, row.error);
  };
  // PostMessage with HWND=0 uses the existing calling-thread message path.
  // Native PostThreadMessage targeting/routing is outside this getter test.
  assert.equal(api('GetMessagePos').result, 0);
  r.windows.windows.set(100, {
    id: 100,
    parentId: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    style: 0,
    exStyle: 0,
    visible: true,
    invalid: [],
  });
  for (const method of [0, 1]) {
    const rows = oracle.cases.filter((row) => row.method === method);
    api('SetCursorPos', 80 + method * 10, 110 + method * 10);
    assert.equal(api('PostMessageA', method ? 0 : 100, 32775, 0, 0).result, 1);
    api('SetCursorPos', 200, 230);
    for (const row of rows.slice(0, 3))
      check(row, await api('PeekMessageA', p, 0, 32775, 32775, row.remove));
    api('SetCursorPos', 100, 130);
    api('PostMessageA', method ? 0 : 100, 32775, 0, 0);
    api('SetCursorPos', 250, 280);
    check(rows[3], await api('GetMessageA', p, 0, 32775, 32775));
  }
  r.windows.windows.get(100).internalPaint = true;
  for (const row of oracle.cases.filter((row) => row.method === 2)) {
    api('SetCursorPos', ...row.point);
    check(row, await api('PeekMessageW', p, 100, 15, 15, row.remove));
  }
  const main = r.threads.current;
  r.threads.save(main);
  const second = { id: 2, depth: 0, context: r.cpu.captureContext() };
  r.threads.activate(second);
  assert.equal(
    api('GetMessagePos').result,
    oracle.cases.find((row) => row.step === 'thread-initial').position,
  );
  api('SetCursorPos', 410, 440);
  api('PostMessageW', 0, 32775, 0, 0);
  api('SetCursorPos', 450, 480);
  check(
    oracle.cases.find((row) => row.step === 'thread-get'),
    await api('GetMessageW', p, 0, 32775, 32775),
  );
  r.threads.activate(main);
  assert.equal(api('GetMessagePos').result, oracle.cases.at(-1).position);
});

test('coalesced mouse moves retain latest screen coordinates and empty filtered peeks preserve position', async (t) => {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  r.windows.post(0, 0x200, 0, 0, { x: 20, y: 30 });
  r.windows.post(0, 0x200, 0, 0, { x: -40, y: -50 });
  assert.equal(r.windows.queue.length, 1);
  const message = r.windows.next(0, 0x200, 0x200, true);
  assert.deepEqual([message.x, message.y], [-40, -50]);
  assert.equal(r.threads.current.messagePosition, (((-50 & 65535) << 16) | (-40 & 65535)) >>> 0);
  assert.equal(r.windows.next(0, 0x200, 0x200, false), null);
  assert.equal(r.threads.current.messagePosition, (((-50 & 65535) << 16) | (-40 & 65535)) >>> 0);
});
