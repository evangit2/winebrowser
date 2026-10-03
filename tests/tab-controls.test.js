import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeTabs } from '../src/win32-tabs.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, kind = 'SysTabControl32', style = 0x400) {
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

test('native tab items retain text/data and selection identity across insertion, updates and deletion', async (t) => {
  const { r, w, send } = await setup(t),
    item = r.allocate(28),
    output = r.allocate(16);
  const insert = async (at, text, param, wide = false) => {
    r.data.fill(0, item, item + 28);
    r.write32(item, 9);
    r.write32(item + 12, r.allocString(text, wide));
    r.write32(item + 24, param);
    return send(wide ? 0x133e : 0x1307, at, item, wide);
  };
  assert.equal(await send(0x130b), 0xffffffff);
  assert.equal(await insert(0, 'Display', 22), 0);
  assert.equal(await insert(0, 'General', 11), 0);
  assert.equal(await insert(10, 'Unicode λ', 33, true), 2);
  assert.equal(await send(0x130b), 1);
  assert.equal(await send(0x132f), 1);
  r.data.fill(0, item, item + 28);
  r.write32(item, 9);
  r.write32(item + 12, output);
  r.write32(item + 16, 4);
  assert.equal(await send(0x133c, 2, item, true), 1);
  assert.equal(r.wideString(output), 'Uni');
  assert.equal(r.read32(item + 24), 33);
  assert.equal(await send(0x130c, 2), 1);
  assert.equal(await send(0x130c, 99), 0xffffffff);
  assert.equal(await send(0x130b), 2);
  assert.equal(await send(0x1308, 0), 1);
  assert.equal(await send(0x130b), 1);
  assert.equal(await send(0x1308, 1), 1);
  assert.equal(await send(0x130b), 0xffffffff);
  assert.equal(await send(0x1309), 1);
  assert.equal(await send(0x1304), 0);
  assert.equal(describeTabs(w).items.length, 0);
});

test('tab notifications honor vetoes, callback mutations and packed keyboard ABI', async (t) => {
  const { r, w, send, parent, hwnd } = await setup(t),
    p = r.allocate(28);
  const insert = async (text) => {
    r.data.fill(0, p, p + 28);
    r.write32(p, 1);
    r.write32(p + 12, r.allocString(text));
    await send(0x1307, 100, p);
  };
  await insert('First');
  await insert('Second');
  const original = r.windows.send.bind(r.windows),
    seen = [];
  let veto = true,
    update = false;
  r.windows.send = async (id, msg, wp, lp, ...rest) => {
    if (id === parent && msg === 0x4e) {
      assert.equal(wp, 80);
      assert.equal(r.read32(lp), hwnd);
      assert.equal(r.read32(lp + 4), 80);
      const code = r.read32(lp + 8) | 0;
      seen.push(code);
      if (code === -550) {
        assert.equal(r.view.getUint16(lp + 12, true), 39);
        assert.equal(r.read32(lp + 14), 0x12345678);
      }
      if (code === -552 && update) {
        r.write32(p, 1);
        r.write32(p + 12, r.allocString('Renamed'));
        await send(0x1306, 1, p);
      }
      return code === -552 && veto ? 1 : 0;
    }
    return original(id, msg, wp, lp, ...rest);
  };
  await send(0x7fd0, 0, w.tabs.items[1].id);
  assert.equal(await send(0x130b), 0);
  assert.deepEqual(seen, [-552]);
  veto = false;
  update = true;
  await send(0x100, 39, 0x12345678);
  assert.equal(await send(0x130b), 1);
  assert.deepEqual(seen, [-552, -550, -552, -551]);
  assert.equal(describeTabs(w).items[1].text, 'Renamed');
  const before = seen.length;
  await send(0x130c, 0);
  assert.equal(seen.length, before);
  const invalid = r.allocate(28);
  r.data.fill(0, invalid, invalid + 28);
  r.write32(invalid, 2);
  r.write32(invalid + 20, 3);
  await assert.rejects(send(0x1306, 0, invalid), /images are not implemented/);
  assert.equal(describeTabs(w).items[0].text, 'First');
});
