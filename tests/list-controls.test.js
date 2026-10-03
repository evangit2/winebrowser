import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeList } from '../src/win32-lists.js';
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
