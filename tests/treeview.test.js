import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { treeMessage, describeTree } from '../src/win32-treeview.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, wide = false) {
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
  const id = (
    await call(
      `CreateWindowEx${wide ? 'W' : 'A'}`,
      0,
      r.allocString('SysTreeView32', wide),
      0,
      0x50010007,
      0,
      0,
      160,
      120,
      parent,
      70,
      r.pe.imageBase,
      0,
    )
  ).result;
  assert.ok(id);
  const w = r.windows.windows.get(id);
  return { r, w, call, send: (msg, wp = 0, lp = 0) => treeMessage(r, w, msg, wp, lp, () => 0) };
}
function insertion(r, parent, text, param = 0, wide = false, after = 0xffff0002) {
  const p = r.allocate(48);
  r.data.fill(0, p, p + 48);
  r.write32(p, parent);
  r.write32(p + 4, after);
  r.write32(p + 8, 5);
  r.write32(p + 24, r.allocString(text, wide));
  r.write32(p + 44, param);
  return p;
}
test('Unicode TreeView notifications preserve native PE32 structures, state and cancellable result', async (t) => {
  const { r, w, send } = await setup(t, true);
  const messages = [];
  r.windows.send = async (parent, msg, id, p) => {
    assert.equal(parent, w.parentId);
    assert.equal(msg, 0x4e);
    assert.equal(id, 70);
    const event = {
      code: r.read32(p + 8) | 0,
      action: r.read32(p + 12),
      old: r.read32(p + 20),
      next: r.read32(p + 60),
      param: r.read32(p + 92),
      state: r.read32(p + 64),
    };
    messages.push(event);
    return event.code === -450 && event.param === 2 ? 1 : 0;
  };
  const root = await send(0x1132, 0, insertion(r, 0xffff0000, 'Root', 0, true));
  const a = await send(0x1132, 0, insertion(r, root, 'λ', 1, true));
  const b = await send(0x1132, 0, insertion(r, root, 'Blocked', 2, true));
  assert.equal(await send(0x1102, 2, root), 1);
  assert.equal(await send(0x110b, 9, a), 1);
  assert.equal(await send(0x110b, 9, b), 0);
  assert.equal(await send(0x110a, 9), a);
  assert.deepEqual(
    messages.map((m) => m.code),
    [-454, -455, -450, -451, -450],
  );
  assert.deepEqual(messages[3], { code: -451, action: 0, old: 0, next: a, param: 1, state: 2 });
  const p = r.allocate(40),
    out = r.allocate(4);
  r.data.fill(0, p, p + 40);
  r.write32(p, 5);
  r.write32(p + 4, a);
  r.write32(p + 16, out);
  r.write32(p + 20, 2);
  assert.equal(await send(0x113e, 0, p), 1);
  assert.equal(r.wideString(out), 'λ');
  assert.equal(r.read32(p + 36), 1);
  assert.deepEqual(
    describeTree(w).rows.map((row) => row.text),
    ['Root', 'λ', 'Blocked'],
  );
  assert.equal(await send(0x1101, 0, root), 1);
  assert.equal(await send(0x1105), 0);
  assert.deepEqual(
    messages.filter((m) => m.code === -458).map((m) => m.old),
    [a, b, root],
  );
});
test('TreeView rejects unknown handles, unsupported messages and unsafe guest structures', async (t) => {
  const { r, send } = await setup(t);
  const root = await send(0x1100, 0, insertion(r, 0xffff0000, 'Root'));
  assert.equal(await send(0x1100, 0, insertion(r, 999, 'Bad')), 0);
  assert.equal(await send(0x1100, 0, insertion(r, root, 'Bad', 0, false, 999)), 0);
  assert.equal(await send(0x110b, 9, 999), 0);
  assert.equal(await send(0x1101, 0, 999), 0);
  assert.equal(await send(0x1105), 1);
  await assert.rejects(() => send(0x1100, 0, 0xfffffffc), /violation|range|outside/i);
  await assert.rejects(() => send(0x110e, 0, root), /Unsupported TreeView message/);
  const callback = insertion(r, root, '');
  r.write32(callback + 24, 0xffffffff);
  await assert.rejects(() => send(0x1100, 0, callback), /callback text/);
});
