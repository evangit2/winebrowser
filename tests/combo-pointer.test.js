import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWindowFromHost } from '../src/win32-windows.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const point = (x, y) => ((y << 16) | (x & 0xffff)) >>> 0;
async function setup(t, type = 3, extraStyle = 0) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const parent = (
    await createWindowFromHost(r, {
      className: 'winebrowser-dialog',
      style: 0x10000000,
      width: 500,
      height: 400,
    })
  ).id;
  const events = [],
    sendOriginal = r.windows.send.bind(r.windows);
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && msg === 0x111) {
      events.push({ code: wp >>> 16, hwnd: lp, capture: r.windows.capture });
      return 0;
    }
    return sendOriginal(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = (
    await createWindowFromHost(r, {
      className: 'COMBOBOX',
      style: 0x50010000 | type | extraStyle,
      parent,
      controlId: 70,
      x: 20,
      y: 30,
      width: 180,
      height: 160,
      wide: true,
    })
  ).id;
  const w = r.windows.windows.get(hwnd),
    popup = w.comboListWindow;
  const call = async (name, ...args) =>
    (await r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
  const send = (msg, wp = 0, lp = 0) => call('SendMessageW', hwnd, msg, wp, lp);
  const list = (msg, wp = 0, lp = 0) => call('SendMessageW', popup.id, msg, wp, lp);
  for (const value of ['Apple', 'Banana', 'Cherry'])
    await send(0x143, 0, r.allocString(value, true));
  await send(0x14e, 0);
  events.length = 0;
  const info = () => {
    const p = r.allocate(52);
    r.write32(p, 52);
    return p;
  };
  return { r, parent, w, popup, call, send, list, events, info };
}
const codes = (events) =>
  events.filter((e) => [1, 7, 8, 9, 10].includes(e.code)).map((e) => e.code);
test('keyboard-opened dropdown owns native list capture, follows hover and cancels an outside press', async (t) => {
  const { r, w, popup, call, send, list, events } = await setup(t);
  await send(0x100, 0x73);
  assert.equal(await send(0x157), 1);
  assert.equal(await call('GetCapture'), popup.id);
  assert.equal(popup.list.pointer, undefined);
  await list(0x200, 0, point(8, 40));
  assert.equal(await send(0x147), 2);
  assert.equal(popup.list.pointer, undefined);
  assert.deepEqual(codes(events), [7]);
  assert.equal(r.windows.timers.size, 0, 'hover starts no autoscroll timer');
  await list(0x201, 1, point(-10, -10));
  assert.equal(await send(0x147), 0);
  assert.equal(await send(0x157), 0);
  assert.equal(await call('GetCapture'), 0);
  assert.deepEqual(codes(events), [7, 10, 8]);
  assert.equal(w.comboPointer, false);
});
test('native arrow press hands HWND capture and signed client coordinates to ComboLBox before release commits', async (t) => {
  const { r, w, popup, call, send, list, events, info } = await setup(t);
  assert.equal(await send(0x201, 1, point(170, 10)), 1);
  assert.equal(await call('GetCapture'), w.id);
  assert.equal(await send(0x157), 1);
  const p = info();
  await call('GetComboBoxInfo', w.id, p);
  assert.equal(r.read32(p + 36), 8, 'native STATE_SYSTEM_PRESSED');
  const hostOrigin = r.windows.clientPosition(w),
    listOrigin = r.windows.clientPosition(popup);
  assert.equal(
    await send(
      0x200,
      1,
      point(listOrigin[0] - hostOrigin[0] + 8, listOrigin[1] - hostOrigin[1] + 24),
    ),
    1,
  );
  assert.equal(await call('GetCapture'), popup.id);
  assert.equal(await send(0x147), 1);
  assert.ok(popup.list.pointer);
  assert.equal(w.comboPointer, true, 'browser transport survives native capture handoff');
  await call('GetComboBoxInfo', w.id, p);
  assert.equal(r.read32(p + 36), 0);
  await list(0x200, 1, point(8, 40));
  await list(0x202, 0, point(8, 40));
  assert.equal(await send(0x147), 2);
  assert.equal(await send(0x157), 0);
  assert.equal(await call('GetCapture'), 0);
  assert.equal(w.comboPointer, false);
  assert.deepEqual(codes(events), [7, 1, 9, 8]);
  assert.equal(events.find((e) => e.code === 1).capture, 0);
});
test('releasing on the combo arrow leaves its popup open for hover, while cancel mode clears both capture states', async (t) => {
  const { w, popup, call, send, list } = await setup(t);
  await send(0x201, 1, point(170, 10));
  await send(0x202, 0, point(170, 10));
  assert.equal(await call('GetCapture'), popup.id);
  assert.equal(await send(0x157), 1);
  assert.equal(w.comboPointer, false);
  await list(0x200, 0, point(8, 40));
  assert.equal(await send(0x147), 2);
  await list(0x1f);
  assert.equal(await call('GetCapture'), 0);
  assert.equal(await send(0x157), 0);
  await send(0x201, 1, point(170, 10));
  assert.equal(await call('GetCapture'), w.id);
  await send(0x1f);
  assert.equal(await call('GetCapture'), 0);
  assert.equal(await send(0x157), 0);
  assert.equal(w.comboButtonDown, false);
});
test('outside hover cancellation preserves unmatched editable text and emits no edit or selection notifications', async (t) => {
  const { r, w, send, list, events } = await setup(t, 2);
  const text = r.allocString('Typed Ω', true);
  await send(0xc, 0, text);
  assert.equal(await send(0x147), -1 >>> 0);
  await send(0x14f, 1);
  events.length = 0;
  await list(0x200, 0, point(8, 24));
  assert.equal(await send(0x147), 1);
  await list(0x202, 0, -1);
  assert.equal(await send(0x147), -1 >>> 0);
  assert.equal(w.title, 'Typed Ω');
  assert.equal(w.comboEditWindow.title, 'Typed Ω');
  assert.deepEqual(
    events.map((e) => e.code),
    [10, 8],
  );
});
test('simple combo lists retain ordinary mouse selection without dropdown capture or hover tracking', async (t) => {
  const { w, popup, call, send, list } = await setup(t, 1);
  await send(0x14f, 1);
  assert.equal(await call('GetCapture'), 0);
  await list(0x200, 0, point(8, 40));
  assert.equal(await send(0x147), 0);
  await list(0x201, 1, point(8, 40));
  assert.equal(await call('GetCapture'), popup.id);
  await list(0x202, 0, point(8, 40));
  assert.equal(await send(0x147), 2);
  assert.equal(await call('GetCapture'), 0);
  assert.equal(w.comboDropped, undefined);
});
test('parent may destroy a combo during dropdown notification without stale arrow capture', async (t) => {
  const { r, parent, w, call, send } = await setup(t);
  const original = r.windows.send.bind(r.windows);
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && msg === 0x111 && wp >>> 16 === 7) {
      await r.windows.destroy(w.id);
      return 0;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  await send(0x201, 1, point(170, 10));
  assert.equal(await call('IsWindow', w.id), 0);
  assert.equal(await call('GetCapture'), 0);
});

test('owner draw callback may close its opening popup without capturing the hidden list', async (t) => {
  const { r, parent, w, popup, call, send } = await setup(t, 3, 0x210);
  const original = r.windows.send.bind(r.windows);
  let closed = false;
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && msg === 0x2b && w.comboDropped && !closed) {
      closed = true;
      await send(0x14f, 0);
      return 1;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  await send(0x14f, 1);
  assert.equal(closed, true);
  assert.equal(await send(0x157), 0);
  assert.equal(r.windows.isVisible(popup.id), false);
  assert.equal(await call('GetCapture'), 0);
});
