import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeListview } from '../src/win32-listview.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, kind, style) {
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
      0x10000000,
      0,
      0,
      400,
      300,
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
      300,
      200,
      parent,
      100,
      r.pe.imageBase,
      0,
    )
  ).result;
  assert.ok(hwnd);
  return {
    r,
    parent,
    hwnd,
    w: r.windows.windows.get(hwnd),
    send: async (msg, wp = 0, lp = 0) => (await call('SendMessageW', hwnd, msg, wp, lp)).result,
  };
}
test('progress range, signed position, wrap, color and state match native message contracts', async (t) => {
  const { r, send } = await setup(t, 'msctls_progress32', 1),
    range = r.allocate(12);
  r.data.fill(0xa5, range, range + 12);
  assert.equal(await send(0x401, 0, 0xffff0001), 100 << 16);
  assert.equal(await send(0x407, 0, range), 65535);
  assert.equal(r.read32(range), 1);
  assert.equal(r.read32(range + 4), 65535);
  assert.equal(r.read32(range + 8), 0xa5a5a5a5);
  await send(0x406, -10, 10);
  assert.equal(await send(0x402, -5), 1);
  assert.equal(await send(0x408), 0xfffffffb);
  await send(0x404, 20);
  assert.equal(await send(0x405), 0xfffffffb);
  assert.equal(await send(0x408), 0xfffffffb);
  await send(0x402, 10);
  await send(0x404, 1);
  await send(0x405);
  assert.equal(await send(0x408), 0xfffffff7);
  await send(0x404, -22);
  await send(0x405);
  assert.equal(await send(0x408), 9);
  assert.equal(await send(0x409, 0, 0x123456), 0xff000000);
  assert.equal(await send(0x40f), 0x123456);
  assert.equal(await send(0x410, 2), 1);
  assert.equal(await send(0x410, 99), 0);
  assert.equal(await send(0x411), 2);
});
test('report ListView retains ANSI/Unicode subitems, columns, bounded output and native selection notifications', async (t) => {
  const { r, send, w, parent, hwnd } = await setup(t, 'SysListView32', 0xc009),
    p = r.allocate(40),
    out = r.allocate(20);
  const notifications = [];
  const old = r.windows.send.bind(r.windows);
  let veto = false;
  r.windows.send = async (h, msg, wp, lp) => {
    if (h === parent && msg === 0x4e) {
      const code = r.read32(lp + 8) | 0;
      notifications.push({
        code,
        at: r.read32(lp + 12) | 0,
        before: r.read32(lp + 24),
        after: r.read32(lp + 20),
        param: r.read32(lp + 40),
      });
      return veto && code === -100 ? 1 : 0;
    }
    return old(h, msg, wp, lp);
  };
  for (const [i, name] of ['Number', 'Error'].entries()) {
    r.data.fill(0, p, p + 40);
    r.write32(p, 0xe);
    r.write32(p + 8, 80);
    r.write32(p + 12, r.allocString(name, true));
    r.write32(p + 20, i);
    assert.equal(await send(0x1061, i, p), i);
  }
  for (let i = 0; i < 3; i++) {
    r.data.fill(0xa5, p, p + 40);
    r.write32(p, 5);
    r.write32(p + 4, i);
    r.write32(p + 8, 0);
    r.write32(p + 20, r.allocString(String(i + 1)));
    r.write32(p + 32, 100 + i);
    assert.equal(await send(0x1007, 0, p), i);
    r.write32(p + 8, 1);
    r.write32(p + 20, r.allocString('Error λ ' + i, true));
    assert.equal(await send(0x1074, i, p), 1);
  }
  r.data.fill(0xa5, out, out + 20);
  r.write32(p + 20, out);
  r.write32(p + 24, 4);
  assert.equal(await send(0x1073, 0, p), 3);
  assert.equal(r.wideString(out), 'Err');
  assert.equal(r.read32(out + 8), 0xa5a5a5a5);
  const select = (at, flags = 0) => {
    r.windows.input({
      windowId: hwnd,
      type: 'report-select',
      item: w.report.items[at].id,
      ctrlKey: !!(flags & 1),
      shiftKey: !!(flags & 2),
    });
    const e = r.windows.queue.pop();
    return send(e.message, e.wParam, e.lParam);
  };
  await select(0);
  assert.equal(await send(0x1032), 1);
  r.write32(p, 8);
  r.write32(p + 4, 0);
  r.write32(p + 8, 0);
  r.write32(p + 16, 3);
  assert.equal(await send(0x104b, 0, p), 1);
  assert.equal(r.read32(p + 12), 3);
  await select(2, 1);
  assert.equal(await send(0x1032), 2);
  assert.equal(await send(0x100c, -1, 2), 0);
  assert.equal(await send(0x100c, 0, 2), 2);
  await select(0, 2);
  assert.equal(await send(0x1032), 3);
  r.write32(p + 12, 0);
  r.write32(p + 16, 0xffffffff);
  await send(0x102b, -1, p);
  assert.equal(await send(0x1032), 0);
  await select(0);
  await select(2, 2);
  assert.equal(await send(0x1032), 3);
  veto = true;
  await select(1);
  assert.equal(await send(0x1032), 3);
  veto = false;
  assert.ok(notifications.some((n) => n.code === -101 && n.param === 102 && n.after === 3));
  assert.equal(describeListview(w).columns[1].text, 'Error');
  assert.equal(await send(0x1009), 1);
  assert.equal(await send(0x1004), 0);
  assert.ok(notifications.some((n) => n.code === -104));
});
