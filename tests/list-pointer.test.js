import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWindowFromHost } from '../src/win32-windows.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const point = (x, y) => ((y << 16) | (x & 0xffff)) >>> 0;
async function setup(t, style = 1) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const parent = (
    await createWindowFromHost(r, {
      className: 'winebrowser-dialog',
      style: 0x10000000,
      width: 400,
      height: 300,
    })
  ).id;
  const events = [],
    original = r.windows.send.bind(r.windows);
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && [0x111, 0x131, 0x2b, 0x2c].includes(msg)) {
      events.push({ msg, wp, lp, capture: r.windows.capture });
      if (msg === 0x2c)
        r.write32(lp + 16, r.read32(lp + 8) === 0xffffffff ? 20 : 12 + (r.read32(lp + 8) % 3) * 10);
      return 0;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = (
    await createWindowFromHost(r, {
      className: 'LISTBOX',
      style: 0x50010000 | style,
      parent,
      controlId: 70,
      width: 160,
      height: 60,
      wide: true,
    })
  ).id;
  const w = r.windows.windows.get(hwnd);
  const call = async (name, ...args) =>
    (await r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
  const send = (msg, wp = 0, lp = 0) => call('SendMessageW', hwnd, msg, wp, lp);
  for (let i = 0; i < 12; i++) await send(0x180, 0, r.allocString('Row ' + i, true));
  return {
    r,
    w,
    hwnd,
    events,
    call,
    send,
    selected: () => w.list.items.flatMap((item, i) => (item.selected ? [i] : [])),
  };
}
test('ordinary string lists own native mouse capture, caret, release notifications and standard double click', async (t) => {
  const { r, w, send, call, events, hwnd } = await setup(t);
  await send(0x201, 1, point(8, 24));
  assert.equal(await call('GetCapture'), hwnd);
  assert.equal(await send(0x188), 1);
  assert.ok(events.some((e) => e.msg === 0x131 && e.wp === 1 && e.lp === point(8, 24)));
  assert.equal(events.filter((e) => e.msg === 0x111 && e.wp >>> 16 === 1).length, 0);
  await send(0x200, 1, point(8, 48));
  assert.equal(await send(0x188), 2);
  await send(0x202, 0, point(8, 48));
  assert.equal(await call('GetCapture'), 0);
  const notification = events.filter((e) => e.msg === 0x111 && e.wp >>> 16 === 1);
  assert.equal(notification.length, 1);
  assert.equal(notification[0].lp, hwnd);
  assert.equal(notification[0].capture, 0);
  await send(0x203, 1, point(8, 48));
  assert.equal(events.filter((e) => e.msg === 0x111 && e.wp >>> 16 === 2).length, 1);
  await send(0x201, 1, point(8, 100));
  assert.equal(await call('GetCapture'), 0, 'outside client cannot start selection');
  assert.equal(w.list.pointer, null);
  assert.equal(r.windows.timers.size, 0);
});
test('extended pointer ranges grow/shrink around native anchors; Control clicks toggle and drag establishes the range', async (t) => {
  const { send, selected } = await setup(t, 0x801);
  await send(0x201, 1, point(8, 24));
  await send(0x200, 1, point(8, 48));
  assert.deepEqual(selected(), [1, 2]);
  await send(0x200, 1, point(8, 24));
  assert.deepEqual(selected(), [1]);
  await send(0x202, 0, point(8, 24));
  await send(0x201, 9, point(8, 48));
  assert.deepEqual(selected(), [1, 2]);
  await send(0x200, 9, point(8, 4));
  assert.deepEqual(selected(), [0, 1, 2]);
  await send(0x202, 8, point(8, 4));
  await send(0x201, 5, point(8, 24));
  assert.deepEqual(selected(), [1, 2]);
  assert.equal(await send(0x19d), 2);
  await send(0x200, 5, point(8, 4));
  assert.deepEqual(selected(), [0, 1, 2]);
  await send(0x202, 4, point(8, 4));
});
test('multiple-selection pointer motion changes caret without toggling traversed items', async (t) => {
  const { send, selected } = await setup(t, 9);
  await send(0x185, 1, 0);
  await send(0x201, 1, point(8, 24));
  assert.deepEqual(selected(), [0, 1]);
  await send(0x200, 1, point(8, 48));
  assert.equal(await send(0x19f), 2);
  assert.deepEqual(selected(), [0, 1]);
  await send(0x202, 0, point(8, 48));
});
test('measured variable rows hit-test and autoscroll through private system timers without consuming application timers', async (t) => {
  const { r, w, hwnd, send, call, selected } = await setup(t, 0x861);
  await call('SetTimer', hwnd, 2, 60000, 0);
  await send(0x201, 1, point(8, 14));
  assert.deepEqual(selected(), [1]);
  await send(0x200, 1, point(8, 80));
  assert.equal(await send(0x19f), 2);
  assert.ok(r.windows.timers.has(`${hwnd}:system:2`));
  await send(0x118, 2);
  assert.equal(await send(0x19f), 3);
  assert.ok((await send(0x18e)) > 0);
  assert.deepEqual(selected(), [1, 2, 3]);
  r.windows.post(hwnd, 0x118, 2);
  r.windows.post(hwnd, 0x118, 2);
  assert.equal(r.windows.queue.filter((m) => m.message === 0x118).length, 1);
  await send(0x202, 0, point(8, 80));
  assert.equal(r.windows.capture, 0);
  assert.equal(r.windows.timers.has(`${hwnd}:system:2`), false);
  assert.ok(r.windows.timers.has(`${hwnd}:2`));
  assert.equal(r.windows.queue.filter((m) => m.message === 0x118).length, 0);
  assert.equal(w.list.pointer, null);
});
test('capture transfer, focus loss, disable, reset, application blur and destruction terminate pointer timers', async (t) => {
  for (const end of ['capture', 'focus', 'disable', 'reset', 'blur', 'destroy']) {
    const { r, w, send, call, hwnd } = await setup(t, 0x801);
    const other = (
      await createWindowFromHost(r, {
        className: 'EDIT',
        style: 0x50000000,
        parent: w.parentId,
        width: 100,
        height: 24,
      })
    ).id;
    await send(0x201, 1, point(8, 24));
    await send(0x200, 1, point(8, 80));
    if (end === 'capture') await call('SetCapture', other);
    if (end === 'focus') await call('SetFocus', other);
    if (end === 'disable') await call('EnableWindow', hwnd, 0);
    if (end === 'reset') await send(0x184);
    if (end === 'blur') {
      r.windows.input({ type: 'app-blur' });
      const cancel = r.windows.queue.find((m) => m.hwnd === hwnd && m.message === 0x1f);
      assert.ok(cancel);
      await r.windows.send(cancel.hwnd, cancel.message);
    }
    if (end === 'destroy') await r.windows.destroy(hwnd);
    assert.equal(w.list.pointer, null, end);
    assert.equal(r.windows.timers.has(`${hwnd}:system:2`), false, end);
    assert.notEqual(await call('GetCapture'), hwnd, end);
  }
});
test('parent may destroy the native list during WM_LBTRACKPOINT without stale capture or selection', async (t) => {
  const { r, w, send, call } = await setup(t);
  const original = r.windows.send.bind(r.windows);
  r.windows.send = async (hwnd, msg, ...args) => {
    if (hwnd === w.parentId && msg === 0x131) {
      await r.windows.destroy(w.id);
      return 0;
    }
    return original(hwnd, msg, ...args);
  };
  await send(0x201, 1, point(8, 24));
  assert.equal(await call('GetCapture'), 0);
  assert.equal(await call('IsWindow', w.id), 0);
});

test('application-cleared anchors during capture preserve flags while the pointer moves the caret', async (t) => {
  const { send, selected } = await setup(t, 0x801);
  await send(0x201, 1, point(8, 24));
  await send(0x19c, -1);
  await send(0x200, 1, point(8, 48));
  assert.equal(await send(0x19f), 2);
  assert.deepEqual(selected(), [1]);
  await send(0x202, 0, point(8, 48));
});

test('ComboLBox releases commit inside the popup and restore original selection on outside cancellation', async (t) => {
  const { r, w, call, events } = await setup(t);
  const combo = (
    await createWindowFromHost(r, {
      className: 'COMBOBOX',
      style: 0x50000003,
      parent: w.parentId,
      controlId: 71,
      width: 180,
      height: 150,
      wide: true,
    })
  ).id;
  const send = (msg, wp = 0, lp = 0) => call('SendMessageW', combo, msg, wp, lp);
  for (const text of ['Apple', 'Banana', 'Cherry']) await send(0x143, 0, r.allocString(text, true));
  await send(0x14e, 0);
  const list = r.windows.windows.get(combo).comboListId;
  await send(0x14f, 1);
  await call('SendMessageW', list, 0x201, 1, point(8, 24));
  await call('SendMessageW', list, 0x200, 1, point(8, 40));
  assert.equal(await send(0x147), 2);
  assert.equal(await send(0x157), 1);
  events.length = 0;
  await call('SendMessageW', list, 0x202, 0, point(8, 40));
  assert.equal(await send(0x157), 0);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x111 && e.lp === combo).map((e) => e.wp >>> 16),
    [1, 9, 8],
  );
  await send(0x14e, 0);
  await send(0x14f, 1);
  await call('SendMessageW', list, 0x201, 1, point(8, 24));
  events.length = 0;
  await call('SendMessageW', list, 0x202, 0, point(8, 300));
  assert.equal(await send(0x147), 0);
  assert.equal(await send(0x157), 0);
  assert.equal(await call('GetCapture'), 0);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x111 && e.lp === combo).map((e) => e.wp >>> 16),
    [10, 8],
  );
});

test('mouse-move coalescing preserves down/up, keyboard and window boundaries', async (t) => {
  const { r, hwnd, w } = await setup(t);
  r.windows.queue = [];
  const post = (msg, value) => r.windows.post(hwnd, msg, 1, value);
  post(0x200, 1);
  post(0x201, 2);
  post(0x200, 3);
  post(0x200, 4);
  post(0x202, 5);
  post(0x200, 6);
  post(0x100, 7);
  post(0x200, 8);
  r.windows.post(w.parentId, 0x200, 0, 9);
  post(0x200, 10);
  assert.deepEqual(
    r.windows.queue.map((m) => [m.hwnd, m.message, m.lParam]),
    [
      [hwnd, 0x200, 1],
      [hwnd, 0x201, 2],
      [hwnd, 0x200, 4],
      [hwnd, 0x202, 5],
      [hwnd, 0x200, 6],
      [hwnd, 0x100, 7],
      [hwnd, 0x200, 8],
      [w.parentId, 0x200, 9],
      [hwnd, 0x200, 10],
    ],
  );
});
