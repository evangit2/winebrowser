import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { paintOwnerList } from '../src/win32-owner-lists.js';
import { activeGdiDC, gdiApis } from '../src/win32-gdi.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));

async function setup(t, style, handler = () => 0) {
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
    320,
    240,
    0,
    0,
    r.pe.imageBase,
    0,
  );
  const original = r.windows.send.bind(r.windows),
    events = [];
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && [0x2b, 0x2c, 0x2d, 0x39, 0x111, 0x134].includes(msg)) {
      const size = { [0x2b]: 48, [0x2c]: 24, [0x2d]: 20, [0x39]: 32 }[msg];
      const fields = size
        ? Array.from({ length: size / 4 }, (_, i) => r.read32(lp + i * 4))
        : [wp, lp];
      events.push({ msg, wp, fields });
      return await handler({ r, msg, wp, lp, fields });
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = await call(
    'CreateWindowExA',
    0,
    r.allocString('LISTBOX'),
    0,
    0x50010000 | style,
    0,
    0,
    100,
    60,
    parent,
    70,
    r.pe.imageBase,
    0,
  );
  assert.ok(hwnd);
  return {
    r,
    hwnd,
    parent,
    events,
    call,
    w: r.windows.windows.get(hwnd),
    send: (msg, wp = 0, lp = 0) => call('SendMessageA', hwnd, msg, wp, lp),
  };
}

test('fixed owner lists sort raw DWORDs through signed native comparisons and release every item once', async (t) => {
  const { r, hwnd, w, events, send } = await setup(t, 0x13, ({ r, msg, lp, fields: f }) => {
    if (msg === 0x2c) r.write32(lp + 16, 24);
    if (msg === 0x39) return f[4] < f[6] ? -1 : f[4] > f[6] ? 1 : 0;
    return 0;
  });
  assert.deepEqual(events[0].fields, [2, 70, 0xffffffff, 0, 20, 0]);
  for (const value of [0xffffffff, 0, 0xdeadbeef, 0xdeadbeef]) await send(0x180, 0, value);
  assert.deepEqual(
    w.list.items.map((i) => i.data),
    [0, 0xdeadbeef, 0xdeadbeef, 0xffffffff],
  );
  assert.equal(await send(0x1a1), 24);
  const out = r.allocate(8);
  r.write32(out + 4, 0xfeed);
  assert.equal(await send(0x18a, 1), 4);
  assert.equal(await send(0x189, 1, out), 4);
  assert.equal(r.read32(out), 0xdeadbeef);
  assert.equal(r.read32(out + 4), 0xfeed);
  assert.equal(await send(0x1a2, -1, 0xdeadbeef), 1);
  assert.equal(await send(0x1a2, 1, 0xdeadbeef), 2);
  assert.equal(await send(0x182, 3), 3);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x2d).map((e) => e.fields),
    [[2, 70, 3, hwnd, 0xffffffff]],
  );
  await send(0x184);
  assert.equal(events.filter((e) => e.msg === 0x2d).length, 4);
  await r.windows.destroy(hwnd);
  assert.equal(events.filter((e) => e.msg === 0x2d).length, 4, 'reset items are not deleted twice');
});

test('variable owner lists measure inserted raw data and keep height, geometry, caret and paging consistent', async (t) => {
  const { r, w, events, send } = await setup(t, 0x21, ({ r, msg, lp, fields: f }) => {
    if (msg === 0x2c) r.write32(lp + 16, f[2] === 0 ? 0 : f[5] === 0xf0000002 ? 30 : 40);
    return 0;
  });
  assert.equal(events.length, 0, 'variable rows are measured on insertion');
  for (const value of [0xf0000001, 0xf0000002, 0xf0000003, 0xf0000004]) await send(0x180, 0, value);
  assert.deepEqual(
    w.list.items.map((i) => i.height),
    [1, 30, 40, 40],
  );
  const rect = r.allocate(16);
  await send(0x198, 2, rect);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(rect + i)),
    [0, 31, 100, 71],
  );
  assert.equal(await send(0x1a0, 1, 35), 0);
  assert.equal(await send(0x1a1, 1), 35);
  assert.equal(await send(0x1a0, 9, 20), 0xffffffff);
  assert.equal(await send(0x1a1, 9), 0xffffffff);
  assert.equal(await send(0x1a0, 1, 0), 0xffffffff);
  await send(0x197, 1);
  await send(0x198, 0, rect);
  assert.equal(r.read32(rect + 4) | 0, -1);
  await send(0x186, 2);
  assert.equal(await send(0x19f), 2);
  assert.equal(await send(0x18e), 2, 'selected row scrolls into view using measured heights');
  const notifications = () => events.filter((e) => e.msg === 0x111 && e.fields[0] >>> 16 === 1);
  assert.equal(notifications().length, 0, 'programmatic selection does not notify');
  await send(0x100, 0x23);
  assert.equal(await send(0x188), 3);
  assert.equal(notifications().length, 1);
  await send(0x100, 0x21);
  assert.equal(await send(0x188), 1);
  assert.equal(notifications().length, 2);
});

test('variable HASSTRINGS callbacks receive incoming string pointers and retain string/data independence', async (t) => {
  const incoming = [];
  const { r, send, hwnd, call } = await setup(t, 0x61, ({ r, msg, lp, fields: f }) => {
    if (msg === 0x2c) {
      incoming.push(r.wideString(f[5]));
      r.write32(lp + 16, 33);
    }
    return 0;
  });
  const text = r.allocString('Wide λ', true);
  assert.equal(await call('SendMessageW', hwnd, 0x180, 0, text), 0);
  assert.deepEqual(incoming, ['Wide λ']);
  assert.equal(await send(0x199, 0), 0);
  await send(0x19a, 0, 0xfedcba98);
  const out = r.allocate(32);
  assert.equal(await call('SendMessageW', hwnd, 0x189, 0, out), 6);
  assert.equal(r.wideString(out), 'Wide λ');
  assert.equal(await send(0x199, 0), 0xfedcba98);
});

test('native owner drawing isolates row pixels and DC state while reporting focus/selection/disabled flags', async (t) => {
  const snapshots = [];
  const { r, w, hwnd, send, call, events } = await setup(t, 0x11, ({ r, msg, lp, fields: f }) => {
    if (msg === 0x2c) r.write32(lp + 16, 20);
    if (msg === 0x2b) {
      const dc = f[6];
      const api = (name, ...args) => gdiApis[name](r, (i) => args[i] >>> 0).result;
      const clip = r.allocate(16);
      assert.equal(api('gdi32.dll!GetClipBox', dc, clip), 2);
      snapshots.push({ fields: f, textColor: api('gdi32.dll!GetTextColor', dc) });
      api('gdi32.dll!SetTextColor', dc, 0x123456);
      [-100, -100, 1000, 1000].forEach((v, i) => r.write32(clip + i * 4, v));
      api('user32.dll!FillRect', dc, clip, api('gdi32.dll!GetStockObject', f[2] === 0 ? 4 : 0));
      r.free(clip);
    }
    return 0;
  });
  await send(0x180, 0, 0xabc);
  await send(0x180, 0, 0xdef);
  await paintOwnerList(r, w);
  assert.deepEqual(
    snapshots.map((i) => i.textColor),
    [0, 0],
    'callback DC mutations do not leak into the next row',
  );
  const dc = gdiApis['user32.dll!GetDC'](r, () => hwnd).result;
  const pixels = activeGdiDC(r, dc).surface.pixels;
  assert.deepEqual([...pixels.slice((10 * 100 + 5) * 4, (10 * 100 + 5) * 4 + 4)], [0, 0, 0, 255]);
  assert.deepEqual(
    [...pixels.slice((45 * 100 + 5) * 4, (45 * 100 + 5) * 4 + 4)],
    [255, 255, 255, 255],
  );
  gdiApis['user32.dll!ReleaseDC'](r, (i) => [hwnd, dc][i]);
  await call('SetFocus', hwnd);
  await send(0x186, 1);
  assert.ok(snapshots.some((i) => i.fields[3] === 2 && i.fields[4] === 17));
  await call('EnableWindow', hwnd, 0);
  await paintOwnerList(r, w);
  assert.ok(snapshots.some((i) => i.fields[4] & 4));
  assert.equal(events.filter((e) => e.msg === 0x111 && e.fields[0] >>> 16 === 1).length, 0);
});
