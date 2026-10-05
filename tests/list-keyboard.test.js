import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWindowFromHost } from '../src/win32-windows.js';
import { encodeAnsi } from '../src/encoding.js';
import { describeList } from '../src/win32-lists.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, style = 0x401, wide = true, combo = false) {
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
  let handler = () => -1;
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && [0x2e, 0x2f, 0x111, 0x2b, 0x2c].includes(msg)) {
      events.push({ msg, wp, lp });
      if (msg === 0x2c) r.write32(lp + 16, 20);
      if (msg === 0x2e || msg === 0x2f) return handler(msg, wp, lp);
      return 0;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = (
    await createWindowFromHost(r, {
      className: combo ? 'COMBOBOX' : 'LISTBOX',
      style: 0x50010000 | style,
      parent,
      width: 160,
      height: 60,
      controlId: 70,
      wide,
    })
  ).id;
  const w = r.windows.windows.get(hwnd);
  const call = async (name, ...args) =>
    (await r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
  const send = (msg, wp = 0, lp = 0) =>
    call(wide ? 'SendMessageW' : 'SendMessageA', hwnd, msg, wp, lp);
  for (const [i, text] of ['Apple', 'Apricot', 'Banana', 'Éclair', '€uro', 'Ωmega'].entries()) {
    const bytes = encodeAnsi(text).bytes,
      pointer = wide ? r.allocString(text, true) : r.allocate(bytes.length + 1);
    if (!wide) r.data.set(bytes, pointer);
    await send(combo ? 0x143 : 0x180, 0, w.ownerDraw && !w.hasStrings ? 0xf0000000 + i : pointer);
  }
  return {
    r,
    w,
    hwnd,
    events,
    call,
    send,
    handler: (h) => {
      handler = h;
    },
    selected: () => w.list.items.flatMap((item, i) => (item.selected ? [i] : [])),
  };
}
test('list keyboard parent callbacks accept signed defaults, handled keys, explicit targets and actual HWND/caret', async (t) => {
  const { w, hwnd, events, send, handler } = await setup(t);
  assert.equal(describeList(w).nativeKeyboard, true);
  await send(0x186, 1);
  await send(0x100, 0x28);
  assert.equal(w.list.selected, 2);
  assert.deepEqual(
    events.find((e) => e.msg === 0x2e),
    { msg: 0x2e, wp: 0x10028, lp: hwnd },
  );
  handler(() => 0xfffffffe);
  await send(0x100, 0x24);
  await send(0x102, 97);
  assert.equal(w.list.selected, 2);
  handler(() => 0);
  await send(0x100, 0x71);
  assert.equal(w.list.selected, 0, 'a custom key can explicitly select index zero');
  handler(() => 4);
  await send(0x102, 35);
  assert.equal(w.list.selected, 4);
  handler(() => 99);
  await send(0x100, 0x23);
  await send(0x102, 97);
  assert.equal(w.list.selected, 4);
  handler(() => 0xffffffff);
  await send(0x102, 97);
  assert.equal(w.list.selected, 0, 'default search wraps to the next prefix match');
  await send(0x102, 65);
  assert.equal(w.list.selected, 1, 'repeated characters cycle matching rows');
  await send(0x102, 0x3a9);
  assert.equal(w.list.selected, 5);
  await send(0x102, 13);
  assert.equal(w.list.selected, 5);
});
test('ANSI character messages and translated browser keys match Windows-1252 strings', async (t) => {
  const { r, w, hwnd, call, send, events } = await setup(t, 0x401, false);
  await send(0x102, 0x80);
  assert.equal(w.list.selected, 4);
  assert.equal(events.find((e) => e.msg === 0x2f).wp & 0xffff, 0x20ac);
  const p = r.allocate(28);
  r.windows.input({ type: 'keydown', windowId: hwnd, key: 'é', keyCode: 69 });
  await call('PeekMessageA', p, hwnd, 0x100, 0x100, 1);
  await call('TranslateMessage', p);
  await call('PeekMessageA', p, hwnd, 0x102, 0x102, 1);
  assert.equal(r.read32(p + 8), 0xe9);
  await call('DispatchMessageA', p);
  assert.equal(w.list.selected, 3);
});
test('raw-data owner lists use character callbacks without interpreting item data as strings', async (t) => {
  const { w, events, send, handler } = await setup(t, 0x411);
  await send(0x186, 0);
  await send(0x102, 97);
  assert.equal(w.list.selected, 0);
  handler((msg, wp) => (msg === 0x2f && (wp & 0xffff) === 35 ? 2 : -1));
  await send(0x102, 35);
  assert.equal(w.list.selected, 2);
  assert.equal(w.list.items[2].data, 0xf0000002);
  assert.ok(events.some((e) => e.msg === 0x111 && e.wp >>> 16 === 1));
});
test('character selection preserves independent multiple flags and extends an existing native anchor', async (t) => {
  const multiple = await setup(t, 0x9);
  await multiple.send(0x185, 1, 0);
  await multiple.send(0x185, 1, 2);
  await multiple.send(0x102, 0x3a9);
  assert.equal(multiple.w.list.caret, 5);
  assert.deepEqual(multiple.selected(), [0, 2]);
  const extended = await setup(t, 0x801);
  await extended.send(0x185, 1, 1);
  await extended.send(0x19c, 1);
  await extended.send(0x102, 0x20ac);
  assert.equal(extended.w.list.caret, 4);
  assert.equal(extended.w.list.anchor, 1);
  assert.deepEqual(extended.selected(), [1, 2, 3, 4]);
});
test('owner-drawn dropdown character forwarding updates real ComboLBox without dismissing its popup', async (t) => {
  const { w, events, send } = await setup(t, 0x213, true, true);
  await send(0x14e, 0);
  await send(0x102, 0x3a9);
  assert.equal(w.list.selected, 5);
  assert.equal(w.title, 'Ωmega');
  await send(0x14f, 1);
  await send(0x102, 97);
  assert.equal(w.list.selected, 0);
  assert.equal(w.comboDropped, true);
  assert.ok(events.some((e) => e.msg === 0x111 && e.wp >>> 16 === 1));
});
test('parent keyboard callbacks may destroy a control without stale drawing or selection notifications', async (t) => {
  const { r, hwnd, send, handler, events } = await setup(t);
  handler(async () => {
    await r.windows.destroy(hwnd);
    return 1;
  });
  await send(0x102, 97);
  assert.equal(r.windows.windows.has(hwnd), false);
  assert.equal(events.filter((e) => e.msg === 0x111 && e.wp >>> 16 === 1).length, 0);
});
