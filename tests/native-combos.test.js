import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWindowFromHost } from '../src/win32-windows.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, type, wide = true) {
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
    if (hwnd === parent && [0x111, 0x2b, 0x2c, 0x2d].includes(msg)) {
      events.push({ msg, wp, lp });
      return 0;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = (
    await createWindowFromHost(r, {
      className: 'COMBOBOX',
      title: 'Normal',
      style: 0x50010100 | type,
      parent,
      controlId: 70,
      width: 180,
      height: 150,
      wide,
    })
  ).id;
  const call = async (name, ...args) =>
    (await r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
  const send = (msg, wp = 0, lp = 0) =>
    call(wide ? 'SendMessageW' : 'SendMessageA', hwnd, msg, wp, lp);
  return { r, hwnd, w: r.windows.windows.get(hwnd), call, send, events };
}
test('ordinary simple/dropdown/dropdown-list combos expose real child handles, native classes and guarded info structures', async (t) => {
  for (const type of [1, 2, 3]) {
    const { r, w, hwnd, call, send, events } = await setup(t, type);
    assert.equal(w.ownerDraw, false);
    assert.ok(w.comboListId);
    assert.equal(w.comboListWindow.cls.originalName, 'ComboLBox');
    assert.equal(w.comboListWindow.list, w.list);
    assert.equal(w.comboListWindow.parentId, hwnd);
    assert.equal(!!w.comboEditId, type !== 3);
    assert.equal(w.comboListWindow.visible, type === 1);
    const p = r.allocate(56);
    r.write32(p, 52);
    r.write32(p + 52, 0xfeed);
    assert.equal(await call('GetComboBoxInfo', hwnd, p), 1);
    assert.equal(r.read32(p + 40), hwnd);
    assert.equal(r.read32(p + 44), w.comboEditId ?? 0);
    assert.equal(r.read32(p + 48), w.comboListId);
    assert.equal(r.read32(p + 52), 0xfeed);
    assert.equal(r.read32(p + 36), type === 1 ? 0x8000 : 0);
    assert.equal(await send(0x164, 0, p), 1);
    r.write32(p, 51);
    assert.equal(await call('GetComboBoxInfo', hwnd, p), 0);
    assert.equal(r.lastError, 87);
    assert.equal(
      events.filter((e) => [0x2b, 0x2c, 0x2d].includes(e.msg)).length,
      0,
      'ordinary controls never generate owner drawing callbacks',
    );
    const children = [w.comboListId, w.comboEditId].filter(Boolean);
    await r.windows.destroy(hwnd);
    for (const child of children) assert.equal(await call('IsWindow', child), 0);
  }
});
test('ordinary combo selection, edit limits/selection, focus, font and enabled state forward to real native children', async (t) => {
  const { r, w, hwnd, call, send, events } = await setup(t, 2);
  for (const text of ['Banana', 'Apple', 'Ωmega']) await send(0x143, 0, r.allocString(text, true));
  assert.deepEqual(
    w.list.items.map((i) => i.text),
    ['Apple', 'Banana', 'Ωmega'],
  );
  await send(0x14e, 2);
  assert.equal(w.comboEditWindow.title, 'Ωmega');
  assert.equal(events.length, 0, 'selection setters suppress user notifications');
  await call('SetFocus', hwnd);
  assert.equal(await call('GetFocus'), w.comboEditId);
  await send(0x141, 5);
  assert.equal(await call('SendMessageW', w.comboEditId, 0xd5, 0, 0), 5);
  await send(0x142, 0, (4 << 16) | 1);
  const p = r.allocate(8);
  assert.equal(await call('SendMessageW', w.comboEditId, 0xb0, p, p + 4), (4 << 16) | 1);
  assert.equal(r.read32(p), 1);
  assert.equal(r.read32(p + 4), 4);
  const font = r.apiProvider.get('gdi32.dll!GetStockObject')(r, () => 17).result;
  await send(0x30, font, 1);
  assert.equal(await call('SendMessageW', w.comboEditId, 0x31, 0, 0), font);
  assert.equal(await call('SendMessageW', w.comboListId, 0x31, 0, 0), font);
  await call('EnableWindow', hwnd, 0);
  assert.equal(await call('IsWindowEnabled', w.comboEditId), 0);
  assert.equal(await call('IsWindowEnabled', w.comboListId), 0);
  await call('EnableWindow', hwnd, 1);
  events.length = 0;
  await send(0x14b);
  assert.equal(w.comboEditWindow.title, '');
  assert.equal(w.list.items.length, 0);
  assert.equal(events.filter((e) => e.msg === 0x111 && [1, 5, 6].includes(e.wp >>> 16)).length, 0);
});
test('ordinary dropdown list character navigation and popup commitment preserve native notification order', async (t) => {
  const { r, w, send, events } = await setup(t, 3);
  for (const text of ['Apple', 'Banana', 'Ωmega']) await send(0x143, 0, r.allocString(text, true));
  await send(0x14e, 0);
  events.length = 0;
  await send(0x14f, 1);
  await send(0x102, 0x3a9);
  assert.equal(w.list.selected, 2);
  assert.equal(w.comboDropped, true);
  await send(0x100, 13);
  assert.equal(w.comboListWindow.visible, false);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x111).map((e) => e.wp >>> 16),
    [7, 1, 9, 8],
  );
});

test('queued focus loss cannot dismiss a combo after native dialog code restores its focus', async (t) => {
  const { r, w, hwnd, call, send, events } = await setup(t, 3);
  const other = (
    await createWindowFromHost(r, {
      className: 'EDIT',
      style: 0x50000000,
      parent: w.parentId,
      width: 120,
      height: 24,
    })
  ).id;
  await call('SetFocus', hwnd);
  await send(0x14f, 1);
  r.windows.input({ type: 'focus', windowId: other });
  await call('SetFocus', hwnd);
  const message = r.allocate(28);
  assert.equal(await call('PeekMessageW', message, hwnd, 8, 8, 1), 1);
  events.length = 0;
  await call('DispatchMessageW', message);
  assert.equal(w.comboDropped, true);
  assert.equal(w.comboListWindow.visible, true);
  assert.equal(events.filter((e) => e.msg === 0x111 && [4, 8, 10].includes(e.wp >>> 16)).length, 0);
  await call('SetFocus', other);
  assert.equal(w.comboDropped, false, 'actual native focus loss still dismisses the popup');
});

test('combo font changes resize actual children and popup rows while preserving text, selection and handles', async (t) => {
  for (const type of [1, 2, 3]) {
    const { r, w, call, send, events } = await setup(t, type);
    const gdi = async (name, ...args) =>
      (await r.apiProvider.get(`gdi32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
    const font = await gdi('CreateFontW', -28, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, 0);
    assert.ok(font);
    const text = r.allocString('Selected text', true);
    await send(0x143, 0, text);
    await send(0x14e, 0);
    const info = r.allocate(52),
      metrics = r.allocate(60),
      rect = r.allocate(16),
      dc = await call('GetDC', w.id);
    const previous = await gdi('SelectObject', dc, font);
    await gdi('GetTextMetricsW', dc, metrics);
    const height = r.read32(metrics);
    await gdi('SelectObject', dc, previous);
    await call('ReleaseDC', w.id, dc);
    const children = [w.comboEditId, w.comboListId],
      simpleHeight = w.height;
    events.length = 0;
    await send(0x30, font, 1);
    assert.equal(await send(0x154, -1), height + 4);
    assert.equal(await send(0x154, 0), height);
    assert.equal(await send(0x147), 0);
    assert.equal(w.title, 'Selected text');
    assert.deepEqual([w.comboEditId, w.comboListId], children);
    assert.equal(await call('SendMessageW', w.comboListId, 0x31), font);
    r.write32(info, 52);
    assert.equal(await call('GetComboBoxInfo', w.id, info), 1);
    assert.equal(r.read32(info + 16), height + 6);
    if (w.comboEditId) {
      assert.equal(await call('SendMessageW', w.comboEditId, 0x31), font);
      await call('GetClientRect', w.comboEditId, rect);
      assert.equal(r.read32(rect + 12), height + 4);
    }
    assert.equal(w.height, type === 1 ? simpleHeight : height + 6);
    assert.equal(
      events.length,
      0,
      'relayout cannot notify the parent of user selection or owner drawing',
    );
    assert.equal(
      await send(0x153, 0, 55),
      0xffffffff,
      'ordinary list item heights follow the font',
    );
    assert.equal(await send(0x153, -1, 50), 50);
    assert.equal(await send(0x154, -1), 52);
    assert.equal(await send(0x153, -1, 2), 2);
    assert.equal(
      await send(0x154, -1),
      type === 1 ? 4 : height + 4,
      'collapsed dropdown text cannot clip its font; simple controls honor explicit height',
    );
    await send(0x30, 0, 1);
    assert.equal(await send(0x154, -1), 20);
    assert.equal(await send(0x154, 0), 16);
    await r.windows.destroy(w.id);
    assert.equal(await gdi('DeleteObject', font), 1);
  }
});
