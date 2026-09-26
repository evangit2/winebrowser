import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { compareWindowOrder, MAX_WINDOW_WIDTH } from '../src/window-frame.js';
import { flushGdi } from '../src/win32-gdi.js';

const api = (r, name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
const pos = (r, hwnd, after, x, y, cx, cy, flags = 16) =>
  api(r, 'user32.dll!SetWindowPos', hwnd, after, x, y, cx, cy, flags);
async function setup(t, hook = () => {}) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const events = [],
    messages = [];
  const r = new Runtime(iced, {
    files: new Map([['console.exe', bytes]]),
    exe: 'console.exe',
    emit: (e) => events.push(e),
  });
  t.after(() => r.windows.dispose());
  for (const id of [100, 101, 102])
    r.windows.windows.set(id, {
      id,
      parentId: 0,
      style: 0x80000000,
      exStyle: 0,
      x: 5,
      y: 10,
      width: 80,
      height: 60,
      visible: true,
      enabled: true,
      presented: true,
      topmost: false,
      zOrder: id,
      proc: 1,
      cls: {},
    });
  r.windows.nextZOrder = 103;
  r.callGuest = async (_address, args) => {
    messages.push({
      hwnd: args[0],
      message: args[1],
      wp: args[2],
      lp: args[3],
      position: [0x46, 0x47].includes(args[1])
        ? Array.from({ length: 7 }, (_, i) => r.read32(args[3] + i * 4))
        : undefined,
    });
    const value = await hook(r, ...args);
    if (value !== undefined) return value;
    return (await api(r, 'user32.dll!DefWindowProcA', ...args)).result;
  };
  return { r, events, messages, w: r.windows.windows.get(100) };
}
const order = (r) =>
  [...r.windows.windows.values()]
    .filter((w) => !w.parentId)
    .sort(compareWindowOrder)
    .map((w) => w.id);

test('SetWindowPos accepts callback changes, sends NCCALCSIZE and delegates MOVE/SIZE to DefWindowProc', async (t) => {
  let swallow = false;
  const { r, w, messages } = await setup(t, (r, _hwnd, message, _wp, lp) => {
    if (message === 0x46) r.write32(lp + 8, -20);
    if (message === 0x47 && swallow) return 0;
  });
  assert.deepEqual(await pos(r, 100, 0, 1, 2, 120, 90), { result: 1, argc: 7 });
  assert.deepEqual([w.x, w.y, w.width, w.height], [-20, 2, 120, 90]);
  assert.deepEqual(
    messages.map((m) => m.message),
    [0x46, 0x83, 0x47, 3, 5],
  );
  assert.equal(messages.find((m) => m.message === 3).lp, (2 << 16) | 0xffec);
  assert.equal(messages.find((m) => m.message === 5).lp, (90 << 16) | 120);
  messages.length = 0;
  swallow = true;
  assert.equal((await pos(r, 100, 0, 3, 4, 100, 70)).result, 1);
  assert.deepEqual(
    messages.map((m) => m.message),
    [0x46, 0x83, 0x47],
  );
});

test('position flags suppress changing, preserve ignored geometry and request frame recalculation', async (t) => {
  const { r, w, messages } = await setup(t);
  const allIgnored = 1 | 2 | 4 | 8 | 16 | 1024;
  assert.equal((await pos(r, 100, 0xdead, -99999, 99999, 0, 0, allIgnored)).result, 1);
  assert.deepEqual([w.x, w.y, w.width, w.height], [5, 10, 80, 60]);
  assert.deepEqual(messages, []);
  assert.equal(w.invalid, undefined);
  await pos(r, 100, 0, 0, 0, 0, 0, allIgnored | 32);
  assert.deepEqual(
    messages.map((m) => m.message),
    [0x83, 0x47],
  );
  assert.ok(messages.at(-1).position[6] & 0x1800);
  assert.equal(w.invalid, undefined);
});

test('DefWindowProc honors guest minimum and maximum tracking dimensions', async (t) => {
  const { r, w, messages } = await setup(t, (r, _hwnd, message, _wp, lp) => {
    if (message === 0x24) {
      [100, 90, 150, 120].forEach((v, i) => r.write32(lp + 24 + i * 4, v));
      return 0;
    }
  });
  w.style = 0x00cf0000;
  await pos(r, 100, 0, 0, 0, 40, 200);
  assert.deepEqual([w.width, w.height], [98, 90]);
  assert.deepEqual(
    messages.map((m) => m.message),
    [0x46, 0x24, 0x83, 0x47, 3, 5],
  );
});

test('topmost bands, explicit sibling placement and activation preserve requested stacking', async (t) => {
  const { r, w, events } = await setup(t);
  await pos(r, 100, -1, 0, 0, 0, 0, 19);
  assert.deepEqual(order(r), [100, 102, 101]);
  assert.equal(w.exStyle & 8, 8);
  await pos(r, 101, -1, 0, 0, 0, 0, 19);
  await pos(r, 102, 101, 0, 0, 0, 0, 19);
  assert.deepEqual(order(r), [101, 102, 100]);
  assert.equal(r.windows.windows.get(102).topmost, true);
  await pos(r, 102, -2, 0, 0, 0, 0, 19);
  await pos(r, 101, 1, 0, 0, 0, 0, 3);
  assert.deepEqual(order(r), [100, 102, 101]);
  assert.equal(r.windows.windows.get(101).topmost, false);
  assert.equal(r.windows.active, 0, 'HWND_BOTTOM suppresses activation');
  await pos(r, 102, 101, 0, 0, 0, 0, 3);
  assert.deepEqual(order(r), [100, 101, 102]);
  assert.equal(r.windows.active, 102);
  assert.ok(events.some((e) => e.type === 'window-focus' && e.windowId === 102 && e.preserveOrder));
  await pos(r, 101, 0, 0, 0, 0, 0, 7);
  assert.deepEqual(order(r), [100, 101, 102], 'NOZORDER also applies while activating');
  assert.equal(r.windows.active, 101);
});

test('hidden child descendants lose focus; invalid handles and callbacks fail without mutation', async (t) => {
  let action;
  const { r, w } = await setup(t, async (r, hwnd, message) => {
    if (message === 0x46 && action === 'destroy') {
      await r.windows.destroy(hwnd);
      return 0;
    }
    if (message === 0x83 && action === 'destroy-after') await r.windows.destroy(101);
  });
  const child = r.windows.windows.get(101),
    descendant = r.windows.windows.get(102);
  child.parentId = 100;
  descendant.parentId = 101;
  await r.windows.setFocus(102);
  await pos(r, 101, 0, 0, 0, 0, 0, 1 | 2 | 4 | 16 | 128);
  assert.equal(r.windows.focus, 0);
  assert.equal(child.visible, false);
  for (const args of [
    [100, 101, 1, 2, 90, 80, 16],
    [100, 0, 1, 2, 90, 80, 0x8000],
    [100, 0, 1, 2, MAX_WINDOW_WIDTH + 52, 80, 16],
    [999, 0, 1, 2, 90, 80, 16],
  ])
    assert.equal((await pos(r, ...args)).result, 0);
  assert.deepEqual([w.x, w.y, w.width, w.height], [5, 10, 80, 60]);
  child.parentId = 0;
  action = 'destroy-after';
  assert.equal((await pos(r, 100, 101, 5, 10, 90, 80)).result, 0);
  assert.equal(r.lastError, 1400);
  assert.deepEqual([w.width, w.height], [80, 60]);
  action = 'destroy';
  assert.equal((await pos(r, 100, 0, 0, 0, 90, 80)).result, 0);
  assert.equal(r.windows.windows.has(100), false);
});

test('resizing preserves client pixels and live DCs, NOCOPYBITS discards, NOREDRAW stays clean', async (t) => {
  const { r, w, events } = await setup(t);
  const dc = api(r, 'user32.dll!GetDC', 100).result;
  api(r, 'gdi32.dll!SetPixel', dc, 4, 5, 0x123456);
  flushGdi(r);
  events.length = 0;
  await pos(r, 100, 0, 5, 10, 100, 90, 4 | 8 | 16);
  assert.equal(api(r, 'gdi32.dll!GetPixel', dc, 4, 5).result, 0x123456);
  flushGdi(r);
  assert.equal(
    events.some((e) => e.type === 'frame'),
    false,
  );
  assert.equal(w.invalid, undefined);
  await pos(r, 100, 0, 5, 10, 100, 90, 4 | 16 | 256);
  assert.equal(api(r, 'gdi32.dll!GetPixel', dc, 4, 5).result, 0);
  flushGdi(r);
  assert.ok(events.some((e) => e.type === 'frame' && e.windowId === 100 && e.width === 100));
  assert.deepEqual(w.invalid, [0, 0, 100, 90]);
});

test('custom nonclient rectangles fail explicitly and free callback scratch memory', async (t) => {
  const { r } = await setup(t, (r, _hwnd, message, _wp, lp) => {
    if (message === 0x83) {
      r.write32(lp, 123);
      return 0;
    }
  });
  const allocated = [],
    freed = [],
    allocate = r.allocate.bind(r),
    free = r.free.bind(r);
  r.allocate = (...args) => {
    const p = allocate(...args);
    allocated.push(p);
    return p;
  };
  r.free = (p) => {
    freed.push(p);
    return free(p);
  };
  await assert.rejects(pos(r, 100, 0, 0, 0, 90, 80), /Custom nonclient window positioning/);
  assert.deepEqual(freed.sort(), allocated.sort());
});
