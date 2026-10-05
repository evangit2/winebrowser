import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, style = 0x113, wide = false) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = async (name, ...args) =>
    (await r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
  const parent = await call(
    'CreateWindowExA',
    0,
    r.allocString('winebrowser-dialog'),
    0,
    0,
    0,
    0,
    400,
    300,
    0,
    0,
    r.pe.imageBase,
    0,
  );
  const original = r.windows.send.bind(r.windows),
    events = [];
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && [0x2b, 0x2c, 0x2d, 0x39, 0x111].includes(msg)) {
      const size = { [0x2b]: 48, [0x2c]: 24, [0x2d]: 20, [0x39]: 32 }[msg];
      const fields = size
        ? Array.from({ length: size / 4 }, (_, i) => r.read32(lp + i * 4))
        : [wp, lp];
      events.push({ msg, fields });
      if (msg === 0x2c) r.write32(lp + 16, fields[2] === 0xffffffff ? 24 : 32);
      if (msg === 0x39) return fields[4] < fields[6] ? -1 : fields[4] > fields[6] ? 1 : 0;
      return 0;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = await call(
    wide ? 'CreateWindowExW' : 'CreateWindowExA',
    0,
    r.allocString('COMBOBOX', wide),
    r.allocString('Choices', wide),
    0x50010000 | style,
    20,
    30,
    180,
    150,
    parent,
    70,
    r.pe.imageBase,
    0,
  );
  assert.ok(hwnd);
  return {
    r,
    call,
    hwnd,
    w: r.windows.windows.get(hwnd),
    events,
    send: (msg, wp = 0, lp = 0) => call('SendMessageA', hwnd, msg, wp, lp),
  };
}
test('fixed raw combos measure both areas, expose real ComboLBox handles and sort native data', async (t) => {
  const { r, call, hwnd, w, events, send } = await setup(t);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x2c).map((e) => e.fields.slice(0, 4)),
    [
      [3, 70, 0xffffffff, 180],
      [3, 70, 0, 180],
    ],
  );
  assert.equal(w.height, 28);
  assert.equal(await send(0x154, -1), 26);
  assert.equal(await send(0x154, 0), 32);
  const font = r.apiProvider.get('gdi32.dll!CreateFontW')(
    r,
    (i) => [-36, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, 0][i] >>> 0,
  ).result;
  assert.ok(font);
  await send(0x30, font, 1);
  assert.equal(await send(0x154, -1), 26, 'font changes preserve owner text measurements');
  assert.equal(await send(0x154, 0), 32, 'font changes preserve owner row measurements');
  const p = r.allocate(56);
  r.write32(p, 52);
  r.write32(p + 52, 0xfeed);
  assert.equal(await call('GetComboBoxInfo', hwnd, p), 1);
  assert.equal(r.read32(p + 40), hwnd);
  assert.equal(r.read32(p + 44), 0);
  assert.equal(r.read32(p + 48), w.comboListId);
  assert.equal(r.read32(p + 52), 0xfeed);
  r.write32(p, 51);
  assert.equal(await call('GetComboBoxInfo', hwnd, p), 0);
  assert.equal(r.lastError, 87);
  r.write32(p, 56);
  assert.equal(await call('GetComboBoxInfo', hwnd, p), 1);
  assert.equal(await call('IsWindow', w.comboListId), 1);
  const name = r.allocate(40);
  await call('GetClassNameA', w.comboListId, name, 40);
  assert.equal(r.string(name), 'ComboLBox');
  for (const data of [0xdead0003, 0xdead0001, 0xdead0002]) await send(0x143, 0, data);
  assert.deepEqual(
    w.list.items.map((i) => i.data),
    [0xdead0001, 0xdead0002, 0xdead0003],
  );
  assert.ok(
    events.filter((e) => e.msg === 0x39).every((e) => e.fields[0] === 3 && e.fields[2] === hwnd),
  );
  await send(0x14e, 1);
  const paint = events.filter((e) => e.msg === 0x2b).at(-1).fields;
  assert.equal(paint[0], 3);
  assert.equal(paint[5], hwnd);
  assert.equal(paint[4] & 0x1000, 0x1000);
  assert.equal(paint[11], 0xdead0002);
  await r.windows.destroy(hwnd);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x2d).map((e) => e.fields),
    [0, 1, 2].map((i) => [3, 70, i, hwnd, 0xdead0001 + i]),
  );
  assert.equal(await call('IsWindow', w.comboListId), 0);
});
test('popup callbacks preserve native notification ordering and keyboard/programmatic selection semantics', async (t) => {
  const { r, w, events, send, call } = await setup(t);
  for (const data of [10, 20, 30]) await send(0x143, 0, data);
  const codes = () => events.filter((e) => e.msg === 0x111).map((e) => e.fields[0] >>> 16);
  await send(0x14e, 0);
  assert.deepEqual(codes(), []);
  await call('ShowWindow', w.parentId, 5);
  await call('SetFocus', w.id);
  assert.equal(r.windows.focus, w.id);
  assert.deepEqual(codes(), [3]);
  events.length = 0;
  await send(0x14f, 1);
  const info = r.allocate(52);
  r.write32(info, 52);
  assert.equal(await call('GetComboBoxInfo', w.id, info), 1);
  assert.equal(r.read32(info + 36), 0, 'opening a dropdown does not report a held button');
  assert.equal(await send(0x157), 1);
  assert.equal(w.comboListWindow.visible, true);
  assert.deepEqual(codes(), [7]);
  await send(0x100, 0x28);
  assert.equal(await send(0x147), 1);
  assert.equal(await send(0x157), 1);
  await send(0x100, 0xd);
  assert.equal(await send(0x157), 0);
  assert.deepEqual(codes(), [7, 1, 9, 8]);
  await send(0x14f, 1);
  await send(0x100, 0x1b);
  assert.deepEqual(codes(), [7, 1, 9, 8, 7, 10, 8]);
  assert.equal(w.comboListWindow.visible, false);
  const p = r.allocate(16);
  await send(0x152, 0, p);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(p + i)),
    [21, 59, 201, 209],
  );
  assert.equal(await send(0x15f, 220), 220);
  assert.equal(w.comboListWindow.width, 218);
  assert.equal(await send(0x153, -1, 35), 35);
  assert.equal(await send(0x154, -1), 37);
  assert.equal(w.height, 39);
});
test('editable variable and simple combos use real edit/list children and separate item/text heights', async (t) => {
  for (const type of [1, 2]) {
    const { r, w, hwnd, events, send, call } = await setup(t, 0x220 | type, true);
    assert.ok(w.comboEditId && w.comboListId);
    await call('SetFocus', hwnd);
    assert.equal(r.windows.focus, w.comboEditId);
    const info = r.allocate(52);
    r.write32(info, 52);
    await call('GetComboBoxInfo', hwnd, info);
    assert.equal(r.read32(info + 36), type === 1 ? 0x8000 : 0);
    assert.equal(w.comboListWindow.visible, type === 1);
    const p = r.allocString('Wide λ', true);
    assert.equal(await call('SendMessageW', hwnd, 0x143, 0, p), 0);
    assert.equal(await send(0x154, 0), 32);
    assert.deepEqual(
      events.filter((e) => e.msg === 0x2c).map((e) => e.fields[2]),
      [0xffffffff, 0],
    );
    await send(0x14e, 0);
    const text = r.allocate(32);
    await call('SendMessageW', w.comboEditId, 0xd, 16, text);
    assert.equal(r.wideString(text), 'Wide λ');
    assert.equal(await send(0x153, 0, 43), 0);
    assert.equal(await send(0x154, 0), 43);
    assert.equal(await send(0x154, -1), 26);
    const value = r.allocString('typed', true);
    await call('SendMessageW', hwnd, 0xc, 0, value);
    assert.equal(await send(0xe), 5);
    assert.equal(await send(0x147), 0xffffffff);
    assert.equal(
      events.filter((e) => e.msg === 0x111 && [5, 6].includes(e.fields[0] >>> 16)).length,
      0,
      'native text setters do not send edit-change notifications',
    );
    await send(0x14b);
    await r.windows.destroy(hwnd);
    assert.equal(events.filter((e) => e.msg === 0x2d).length, 1);
  }
});
