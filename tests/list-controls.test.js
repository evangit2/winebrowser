import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeList, listInput } from '../src/win32-lists.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, kind = 'LISTBOX', style = 0x43) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = async (name, ...args) =>
    r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0);
  const parent = (
    await call(
      'CreateWindowExA',
      0,
      r.allocString('winebrowser-dialog'),
      0,
      0,
      0,
      0,
      320,
      240,
      0,
      0,
      r.pe.imageBase,
      0,
    )
  ).result;
  const hwnd = (
    await call(
      'CreateWindowExA',
      0,
      r.allocString(kind),
      0,
      0x50010000 | style,
      0,
      0,
      150,
      100,
      parent,
      80,
      r.pe.imageBase,
      0,
    )
  ).result;
  assert.ok(hwnd);
  return {
    r,
    call,
    hwnd,
    parent,
    w: r.windows.windows.get(hwnd),
    send: async (msg, wp = 0, lp = 0, wide = false) =>
      (await call(wide ? 'SendMessageW' : 'SendMessageA', hwnd, msg, wp, lp)).result,
  };
}
test('tab-stop messages preserve native text and validate dialog units without mutating failed layouts', async (t) => {
  const { r, w, send } = await setup(t, 'LISTBOX', 0xc1),
    p = r.allocate(12);
  assert.equal(await send(0x192, 0, 0), 1);
  assert.deepEqual(describeList(w).tabStops, []);
  r.write32(p, 40);
  r.write32(p + 4, 80);
  assert.equal(await send(0x192, 2, p), 1);
  assert.deepEqual(describeList(w).tabStops, [40, 80]);
  r.write32(p + 4, 20);
  assert.equal(await send(0x192, 2, p), 0);
  assert.deepEqual(describeList(w).tabStops, [40, 80]);
  assert.equal(await send(0x192, 257, p), 0);
  assert.equal(await send(0x192, 1, 0), 0);
  const value = 'Name\tValue\tλ';
  assert.equal(await send(0x180, 0, r.allocString(value, true), true), 0);
  const out = r.allocate(64);
  assert.equal(await send(0x189, 0, out, true), value.length);
  assert.equal(r.wideString(out), value);
  assert.equal(await send(0x192, 1, p), 1);
  assert.deepEqual(describeList(w).tabStops, [40]);
  const plain = await setup(t);
  assert.equal(await plain.send(0x192, 0, 0), 0);
  assert.equal(plain.r.lastError, 1434);
  assert.equal(describeList(plain.w).tabStops, undefined);
});

test('drag-list exports hit-test screen points, retain geometry and throttle bounded autoscroll', async (t) => {
  const { r, w, hwnd, parent, send } = await setup(t, 'LISTBOX', 0x41);
  const api = (name, ...args) => r.apiProvider.get(`comctl32.dll!${name}`)(r, (i) => args[i] >>> 0);
  assert.deepEqual(api('MakeDragList', 0xdead), { result: 0, argc: 1 });
  assert.equal(r.lastError, 1400);
  assert.equal(api('MakeDragList', parent).result, 0);
  assert.equal(r.lastError, 87);
  for (let i = 0; i < 8; i++) await send(0x180, 0, r.allocString(String(i)));
  assert.deepEqual(api('MakeDragList', hwnd), { result: 1, argc: 1 });
  const state = w.dragList;
  assert.equal(api('MakeDragList', hwnd).result, 1);
  assert.equal(w.dragList, state);
  const [x, y] = r.windows.clientPosition(w);
  assert.deepEqual(api('LBItemFromPt', hwnd, x + 2, y + 42, 0), { result: 2, argc: 4 });
  assert.equal(api('LBItemFromPt', hwnd, x + w.width, y + 20, 1).result, 0xffffffff);
  assert.equal(w.list.top, 0);
  assert.equal(api('LBItemFromPt', hwnd, x + 2, y + w.height + 2, 1).result, 0xffffffff);
  assert.equal(w.list.top, 1);
  api('LBItemFromPt', hwnd, x + 2, y + w.height + 2, 1);
  assert.equal(w.list.top, 1);
  w.dragList.lastScroll = -Infinity;
  api('LBItemFromPt', hwnd, x + 2, y - 2, 1);
  assert.equal(w.list.top, 0);
  w.list.top = 3;
  w.dragList.lastScroll = -Infinity;
  api('LBItemFromPt', hwnd, x + 2, y + w.height + 2, 1);
  assert.equal(w.list.top, 3);
  const rect = r.allocate(16);
  assert.equal(await send(0x198, 4, rect), 0);
  assert.deepEqual(
    [0, 4, 8, 12].map((o) => r.read32(rect + o)),
    [0, 20, 150, 40],
  );
  assert.equal(await send(0x198, 8, rect), 0xffffffff);
  assert.deepEqual(api('DrawInsert', parent, hwnd, 4), { result: 0, argc: 3 });
  assert.equal(describeList(w).drag.marker, 4);
  api('DrawInsert', parent, hwnd, -1);
  assert.equal(describeList(w).drag.marker, -1);
});

test('drag-list parent callbacks receive PE32 structures, can reject, and cancellation releases capture and timers', async (t) => {
  const { r, w, hwnd, parent, send, call } = await setup(t, 'LISTBOX', 0x41);
  await send(0x180, 0, r.allocString('First'));
  r.apiProvider.get('comctl32.dll!MakeDragList')(r, () => hwnd);
  const seen = [],
    original = r.windows.send.bind(r.windows);
  let accepted = 0;
  r.windows.send = async (id, msg, wp, lp, ...extra) => {
    if (id === parent && msg === w.dragList.message) {
      assert.equal(wp, 80);
      seen.push([0, 4, 8, 12].map((o) => r.read32(lp + o)));
      return r.read32(lp) === 0x485 ? accepted : 3;
    }
    return original(id, msg, wp, lp, ...extra);
  };
  const [x, y] = r.windows.clientPosition(w);
  await send(0x201, 1, (6 << 16) | 4);
  assert.equal(w.dragList.dragging, false);
  assert.equal(r.windows.capture, 0);
  assert.equal(r.windows.timers.size, 0);
  accepted = 1;
  await send(0x201, 1, (6 << 16) | 4);
  assert.equal(w.dragList.dragging, true);
  assert.equal(r.windows.capture, hwnd);
  assert.equal(r.windows.timers.size, 1);
  assert.equal(await send(0x87), 4);
  const message = r.allocate(28);
  [hwnd, 0x100, 27, 1, 0, 0, 0].forEach((v, i) => r.write32(message + i * 4, v));
  assert.equal(
    (await call('IsDialogMessageA', parent, message)).result,
    0,
    'the control owns Escape while dragging',
  );
  await send(0x200, 1, (8 << 16) | 5);
  assert.equal(w.dragList.cursor, 3);
  await send(0x100, 27, 1);
  assert.equal(w.dragList.dragging, false);
  assert.equal(r.windows.capture, 0);
  assert.equal(r.windows.timers.size, 0);
  assert.deepEqual(seen.slice(0, 3), [
    [0x485, hwnd, x + 4, y + 6],
    [0x485, hwnd, x + 4, y + 6],
    [0x486, hwnd, x + 5, y + 8],
  ]);
  assert.equal(seen.at(-1)[0], 0x488);
  await send(0x201, 1, (6 << 16) | 4);
  await send(0x202, 0, (9 << 16) | 6);
  assert.deepEqual(seen.at(-1), [0x487, hwnd, x + 6, y + 9]);
  assert.equal(r.windows.timers.size, 0);
  await send(0x201, 1, (6 << 16) | 4);
  await call('DestroyWindow', hwnd);
  assert.equal(r.windows.capture, 0);
  assert.equal(r.windows.timers.size, 0);
});

test('sorted list strings retain selected identity and item data across insertion and deletion', async (t) => {
  const { r, w, send } = await setup(t);
  assert.equal(await send(0x180, 0, r.allocString('Beta')), 0);
  assert.equal(await send(0x19a, 0, 88), 0);
  assert.equal(await send(0x186, 0), 0);
  assert.equal(await send(0x180, 0, r.allocString('Alpha')), 0);
  assert.equal(await send(0x188), 1);
  assert.equal(await send(0x187, 1), 1);
  assert.equal(await send(0x187, 0), 0);
  assert.equal(await send(0x199, 1), 88);
  assert.equal(await send(0x1a2, 0xffffffff, r.allocString('BETA')), 1);
  assert.deepEqual(
    describeList(w).items.map((i) => i.text),
    ['Alpha', 'Beta'],
  );
  assert.equal(await send(0x182, 0), 1);
  assert.equal(await send(0x188), 0);
  assert.equal(await send(0x199, 0), 88);
  assert.equal(await send(0x182, 0), 0);
  assert.equal(await send(0x188), 0xffffffff);
  assert.equal(await send(0x189, 99, r.allocate(64)), 0xffffffff);
  await assert.rejects(() => send(0x180, 0, 0xfffffffc), /violation|range|outside/i);
});
test('ANSI-created ComboBox accepts Unicode list messages and SendDlgItemMessage uses five stack arguments', async (t) => {
  const { r, w, call, send, parent } = await setup(t, 'COMBOBOX', 0x203);
  const text = r.allocString('Unicode λ', true);
  assert.deepEqual(await call('SendDlgItemMessageW', parent, 80, 0x143, 0, text), {
    result: 0,
    argc: 5,
  });
  const out = r.allocate(32);
  assert.deepEqual(await call('SendDlgItemMessageW', parent, 80, 0x148, 0, out), {
    result: 9,
    argc: 5,
  });
  assert.equal(r.wideString(out), 'Unicode λ');
  assert.equal(await send(0x14e, 0), 0);
  assert.equal(await send(0xe, 0, 0, true), 9);
  assert.equal(await send(0xd, 32, out, true), 9);
  assert.equal(r.wideString(out), 'Unicode λ');
  assert.equal(describeList(w).selected, 0);
  assert.deepEqual(await call('SendDlgItemMessageA', parent, 999, 0x147, 0, 0), {
    result: 0,
    argc: 5,
  });
  assert.equal(r.lastError, 1400);
  await assert.rejects(() => send(0x14f, 1), /Unsupported ComboBox message/);
});

test('editable combo limits user text without clipping WM_SETTEXT and carries native A/W selection', async (t) => {
  const { r, w, send } = await setup(t, 'COMBOBOX', 2);
  const out = r.allocate(8);
  assert.equal(await send(0xc, 0, r.allocString('longer initial value')), 1);
  assert.equal(await send(0x141, 4), 0);
  assert.equal(w.title, 'longer initial value');
  assert.equal(describeList(w).textLimit, 4);
  assert.equal(await send(0x142, 0, 0xffff0000), 0);
  assert.equal(await send(0x140, out, out + 4), 20 << 16);
  assert.equal(r.read32(out), 0);
  assert.equal(r.read32(out + 4), 20);
  assert.equal(await send(0x142, 0, (2 << 16) | 6), 0);
  assert.equal(await send(0x140), (6 << 16) | 2);
  assert.equal(await send(0x142, 0, 0xffffffff), 0);
  assert.equal(await send(0x140), (6 << 16) | 6);
  assert.equal(await send(0xc, 0, r.allocString('Ω € text', true), true), 1);
  assert.equal(w.title, 'Ω € text');
  listInput(r, w, { type: 'list-text', text: 'typed long', start: 10, end: 10 });
  const event = w.list.nextEvent - 1;
  await send(0x7fe1, event);
  assert.equal(w.title, 'type');
  assert.deepEqual(describeList(w).selection, { start: 4, end: 4 });
  listInput(r, w, { type: 'list-selection', start: 1, end: 3 });
  assert.equal(await send(0x140, out, out + 4, true), (3 << 16) | 1);
  assert.equal(r.read32(out), 1);
  assert.equal(r.read32(out + 4), 3);
  assert.equal(await send(0x141, 0), 0);
  assert.equal(describeList(w).textLimit, 32767);
  const closed = await setup(t, 'COMBOBOX', 3);
  assert.equal(await closed.send(0x141, 4), 1);
  assert.equal(await closed.send(0x140), 0xffffffff);
  assert.equal(await closed.send(0x142, 0, 0xffff0000), 0xffffffff);
});
