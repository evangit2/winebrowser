import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWindowFromHost } from '../src/win32-windows.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const rect = (r, p) => [0, 4, 8, 12].map((o) => r.read32(p + o) | 0);
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = async (name, ...args) =>
    (await r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0)).result;
  const info = async (name, monitor, size) => {
    const p = r.allocate(128);
    r.data.fill(0xcc, p, p + 128);
    r.write32(p, size);
    assert.equal(await call(name, monitor, p), 1);
    assert.equal(r.read32(p), size);
    assert.equal(r.read32(p + 36), 1);
    assert.ok(r.data.slice(p + size, p + 128).every((v) => v === 0xcc));
    return p;
  };
  return { r, call, info };
}
test('actual runtime monitor info and extended ANSI/Unicode names share the screen metrics and preserve output guards', async (t) => {
  const { r, call, info } = setup(t);
  const monitor = await call('MonitorFromPoint', 0, 0, 0);
  assert.ok(monitor);
  const width = await call('GetSystemMetrics', 0),
    height = await call('GetSystemMetrics', 1);
  for (const [name, size, wide] of [
    ['GetMonitorInfoA', 40, false],
    ['GetMonitorInfoW', 40, true],
    ['GetMonitorInfoA', 72, false],
    ['GetMonitorInfoW', 104, true],
  ]) {
    const p = await info(name, monitor, size);
    assert.deepEqual(rect(r, p + 4), [0, 0, width, height]);
    assert.deepEqual(rect(r, p + 20), [0, 0, width, height]);
    if (size > 40) assert.equal(wide ? r.wideString(p + 40) : r.string(p + 40), '\\\\.\\DISPLAY1');
  }
});
test('invalid monitor info handles and structure sizes fail without modifying output', async (t) => {
  const { r, call } = setup(t),
    p = r.allocate(128),
    monitor = await call('MonitorFromPoint', 0, 0, 0);
  for (const [name, handle, size] of [
    ['GetMonitorInfoW', 0, 40],
    ['GetMonitorInfoA', 0x123, 72],
    ['GetMonitorInfoW', monitor, 72],
    ['GetMonitorInfoA', monitor, 104],
    ['GetMonitorInfoA', monitor, 39],
  ]) {
    r.data.fill(0xcc, p, p + 128);
    r.write32(p, size);
    const before = r.data.slice(p, p + 128);
    assert.equal(await call(name, handle, p), 0);
    assert.deepEqual(r.data.slice(p, p + 128), before);
    if (size === 40 || (size === 72 && name.endsWith('A'))) assert.equal(r.lastError, 1461);
  }
  assert.equal(await call('GetMonitorInfoW', monitor, 0), 0);
});
test('monitor and system work-area queries follow real virtual mode changes, CDS_TEST and restoration', async (t) => {
  const { r, call, info } = setup(t),
    monitor = await call('MonitorFromPoint', 0, 0, 0),
    dm = r.allocate(156),
    area = r.allocate(16);
  assert.equal(await call('EnumDisplaySettingsA', 0, 2, dm), 1);
  assert.equal(await call('ChangeDisplaySettingsA', dm, 2), 0);
  assert.deepEqual(rect(r, (await info('GetMonitorInfoW', monitor, 40)) + 4), [0, 0, 1024, 768]);
  for (const [index, width, height] of [
    [2, 800, 600],
    [4, 640, 480],
  ]) {
    assert.equal(await call('EnumDisplaySettingsA', 0, index, dm), 1);
    assert.equal(await call('ChangeDisplaySettingsA', dm, 0), 0);
    assert.deepEqual(rect(r, (await info('GetMonitorInfoA', monitor, 72)) + 20), [
      0,
      0,
      width,
      height,
    ]);
    for (const name of ['SystemParametersInfoA', 'SystemParametersInfoW']) {
      assert.equal(await call(name, 0x30, 0, area, 0), 1);
      assert.deepEqual(rect(r, area), [0, 0, width, height]);
    }
  }
  assert.equal(await call('ChangeDisplaySettingsA', 0, 0), 0);
  assert.deepEqual(rect(r, (await info('GetMonitorInfoW', monitor, 104)) + 4), [0, 0, 1024, 768]);
});
test('signed monitor point/rectangle hit testing honors bounds, empty rectangles and explicit fallback flags', async (t) => {
  const { r, call } = setup(t),
    p = r.allocate(16),
    monitor = await call('MonitorFromPoint', 0, 0, 0);
  for (const [x, y, flags, inside] of [
    [1023, 767, 0, true],
    [1024, 10, 0, false],
    [-1, 10, 0, false],
    [0, -1, 0, false],
    [10, 768, 0, false],
    [-10, -10, 1, true],
    [5000, 5000, 2, true],
  ])
    assert.equal(await call('MonitorFromPoint', x, y, flags), inside ? monitor : 0);
  for (const [rectangle, flags, inside] of [
    [[10, 10, 10, 10], 0, true],
    [[-10, 10, 1, 20], 0, true],
    [[-5, -5, -2, -2], 0, false],
    [[2000, 2000, 2001, 2001], 2, true],
  ]) {
    rectangle.forEach((value, i) => r.write32(p + i * 4, value));
    assert.equal(await call('MonitorFromRect', p, flags), inside ? monitor : 0);
  }
});
test('window monitor selection uses real nested HWND coordinates and minimized normal rectangles', async (t) => {
  const { r, call } = setup(t),
    monitor = await call('MonitorFromPoint', 0, 0, 0);
  const parent = (
    await createWindowFromHost(r, {
      className: 'winebrowser-dialog',
      style: 0x10000000,
      x: 900,
      y: 30,
      width: 200,
      height: 150,
    })
  ).id;
  const child = (
    await createWindowFromHost(r, {
      className: 'BUTTON',
      style: 0x50000000,
      parent,
      x: 200,
      y: 10,
      width: 50,
      height: 30,
    })
  ).id;
  assert.equal(await call('MonitorFromWindow', parent, 0), monitor);
  assert.equal(await call('MonitorFromWindow', child, 0), 0);
  assert.equal(await call('MonitorFromWindow', child, 2), monitor);
  assert.equal(await call('MonitorFromWindow', 0, 0), 0);
  assert.equal(await call('MonitorFromWindow', 0, 1), monitor);
  const w = r.windows.windows.get(parent);
  w.x = 1500;
  w.normalRectangle = [40, 50, 200, 150];
  w.showCmd = 2;
  assert.equal(await call('MonitorFromWindow', parent, 0), monitor);
  w.showCmd = 1;
  assert.equal(await call('MonitorFromWindow', parent, 0), 0);
});
test('native dropdown popup flips above a bottom-edge combo and oversized popups fit the active work area', async (t) => {
  const { r, call } = setup(t),
    p = r.allocate(32);
  const parent = (
    await createWindowFromHost(r, {
      className: 'winebrowser-dialog',
      style: 0x10000000,
      x: 30,
      y: 600,
      width: 500,
      height: 200,
    })
  ).id;
  for (const [height, oversized] of [
    [170, false],
    [1400, true],
  ]) {
    const combo = (
      await createWindowFromHost(r, {
        className: 'COMBOBOX',
        style: 0x50010003,
        parent,
        x: 20,
        y: 40,
        width: 180,
        height,
        wide: true,
      })
    ).id;
    await call('SendMessageW', combo, 0x143, 0, r.allocString('Apple', true));
    await call('SendMessageW', combo, 0x14f, 1, 0);
    const popup = r.windows.windows.get(combo).comboListWindow;
    await call('GetWindowRect', combo, p);
    await call('GetWindowRect', popup.id, p + 16);
    const hostRect = rect(r, p),
      popupRect = rect(r, p + 16);
    assert.ok(popupRect[1] >= 0 && popupRect[3] <= 768);
    if (oversized) assert.deepEqual([popupRect[1], popupRect[3]], [0, 768]);
    else assert.equal(popupRect[3], hostRect[1]);
    assert.equal(await call('GetCapture'), popup.id);
    await call('SendMessageW', combo, 0x14f, 0, 0);
    assert.equal(await call('GetCapture'), 0);
  }
});
async function comCall(r, pointer, slot, ...args) {
  const entry = r.thunks.get(r.read32(r.read32(pointer) + slot * 4));
  assert.equal(entry?.kind, 'com');
  return (await entry.invoke(r, (i) => [pointer, ...args][i])).result;
}
test('DXGI output description has exact SDK offsets and a USER32-resolvable monitor across mode changes', async (t) => {
  const { r, call, info } = setup(t),
    p = r.allocate(160),
    iid = r.allocate(16);
  r.graphics12 = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('Monitor enumeration must not invoke a graphics backend');
      },
    },
  );
  r.data.set(
    [
      0x78, 0xae, 0x0a, 0x77, 0x6f, 0xf2, 0xba, 0x4d, 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3,
      0x87,
    ],
    iid,
  );
  assert.equal(
    (await r.apiProvider.get('dxgi.dll!CreateDXGIFactory1')(r, (i) => [iid, p][i])).result,
    0,
  );
  const factory = r.read32(p);
  assert.equal(await comCall(r, factory, 12, 0, p), 0);
  const adapter = r.read32(p);
  assert.equal(await comCall(r, adapter, 7, 0, p), 0);
  const output = r.read32(p),
    dm = r.allocate(156);
  for (const [mode, width, height] of [
    [null, 1024, 768],
    [2, 800, 600],
  ]) {
    if (mode !== null) {
      await call('EnumDisplaySettingsA', 0, mode, dm);
      await call('ChangeDisplaySettingsA', dm, 0);
    }
    r.data.fill(0xcc, p, p + 160);
    assert.equal(await comCall(r, output, 7, p), 0);
    assert.equal(r.wideString(p), '\\\\.\\DISPLAY1');
    assert.deepEqual(rect(r, p + 64), [0, 0, width, height]);
    assert.equal(r.read32(p + 80), 1, 'AttachedToDesktop');
    assert.equal(r.read32(p + 84), 1, 'DXGI_MODE_ROTATION_IDENTITY');
    const monitor = r.read32(p + 88);
    assert.equal(monitor, await call('MonitorFromPoint', 0, 0, 0));
    const monitorInfo = await info('GetMonitorInfoW', monitor, 104);
    assert.equal(r.wideString(monitorInfo + 40), r.wideString(p));
    assert.deepEqual(rect(r, monitorInfo + 4), rect(r, p + 64));
    assert.ok(r.data.slice(p + 92, p + 160).every((value) => value === 0xcc));
  }
  await comCall(r, output, 2);
  await comCall(r, adapter, 2);
  await comCall(r, factory, 2);
});
test('D3D8/9 adapter monitor queries return the same native monitor and reject invalid adapters', async (t) => {
  const { r, call, info } = setup(t);
  const unexpected = () => {
    throw new Error('A monitor query must not create or present a graphics device');
  };
  r.graphics = { createDevice: unexpected, present: unexpected, destroyDevice: unexpected };
  for (const [dll, name, sdk, slot] of [
    ['d3d8', 'Direct3DCreate8', 220, 14],
    ['d3d9', 'Direct3DCreate9', 32, 15],
  ]) {
    const factory = (await r.apiProvider.get(`${dll}.dll!${name}`)(r, () => sdk)).result;
    assert.ok(factory);
    const monitor = await comCall(r, factory, slot, 0);
    assert.equal(monitor, await call('MonitorFromPoint', 0, 0, 0));
    await info('GetMonitorInfoW', monitor, 40);
    assert.equal(await comCall(r, factory, slot, 1), 0);
    await comCall(r, factory, 2);
  }
});
test('SDK system-parameter getters write only their actual scalar, mouse or structure buffer', async (t) => {
  const { r, call } = setup(t),
    p = r.allocate(600);
  for (const name of ['SystemParametersInfoA', 'SystemParametersInfoW']) {
    for (const [action, expected] of [
      [1, 1],
      [5, 1],
      [0xa, 31],
      [0xe, 600],
      [0x16, 1],
      [0x26, 1],
      [0x44, 0],
      [0x46, 0],
      [0x5e, 0],
      [0x64, 4],
      [0x68, 3],
      [0x6a, 400],
      [0x1002, 0],
    ]) {
      r.data.fill(0xcc, p, p + 600);
      assert.equal(await call(name, action, 0, p, 0), 1);
      assert.equal(r.read32(p), expected);
      assert.ok(r.data.slice(p + 4, p + 600).every((v) => v === 0xcc));
    }
    r.data.fill(0xcc, p, p + 600);
    assert.equal(await call(name, 3, 0, p, 0), 1);
    assert.deepEqual(
      [0, 4, 8].map((o) => r.read32(p + o)),
      [6, 10, 1],
    );
    assert.equal(r.read32(p + 12), 0xcccccccc);
    const wide = name.endsWith('W'),
      full = wide ? 504 : 344;
    for (const size of [full, full - 4]) {
      r.data.fill(0xcc, p, p + 600);
      r.write32(p, size);
      assert.equal(await call(name, 0x29, size, p, 0), 1);
      assert.equal(r.read32(p), size);
      assert.equal(r.read32(p + 4), 1);
      assert.ok(r.data.slice(p + size, p + 600).every((v) => v === 0xcc));
    }
    r.data.fill(0xcc, p, p + 600);
    assert.equal(await call(name, 0x1f, 0, p, 0), 1);
    assert.equal(r.read32(p) | 0, -12);
    assert.ok(r.data.slice(p + (wide ? 92 : 60), p + 600).every((v) => v === 0xcc));
  }
});
test('desktop preference setters round-trip, preserve state on invalid input, and queue actual native setting-change messages', async (t) => {
  const { r, call } = setup(t),
    p = r.allocate(32);
  const hwnd = (
    await createWindowFromHost(r, {
      className: 'winebrowser-dialog',
      style: 0x10000000,
      width: 300,
      height: 200,
    })
  ).id;
  const before = r.windows.queue.filter((m) => m.message === 0x1a).length;
  assert.equal(await call('SystemParametersInfoW', 0xb, 9, 0, 2), 1);
  assert.equal(await call('SystemParametersInfoA', 0xa, 0, p, 0), 1);
  assert.equal(r.read32(p), 9);
  assert.equal(await call('SystemParametersInfoW', 0xb, 32, 0, 2), 0);
  await call('SystemParametersInfoW', 0xa, 0, p, 0);
  assert.equal(r.read32(p), 9);
  const changes = r.windows.queue.filter((m) => m.message === 0x1a);
  assert.equal(changes.length, before + 1);
  assert.deepEqual(
    [changes.at(-1).hwnd, changes.at(-1).wParam, changes.at(-1).lParam],
    [hwnd, 0xb, 0],
  );
  for (const [setter, getter, value] of [
    [2, 1, 0],
    [0x17, 0x16, 2],
    [0x6b, 0x6a, 200],
    [0x69, 0x68, 5],
  ]) {
    assert.equal(await call('SystemParametersInfoA', setter, value, 0, 0), 1);
    assert.equal(await call('SystemParametersInfoW', getter, 0, p, 0), 1);
    assert.equal(r.read32(p), value);
  }
  [8, 12, 2].forEach((v, i) => r.write32(p + i * 4, v));
  assert.equal(await call('SystemParametersInfoA', 4, 0, p, 0), 1);
  await call('SystemParametersInfoW', 3, 0, p + 16, 0);
  assert.deepEqual(
    [0, 4, 8].map((o) => r.read32(p + 16 + o)),
    [8, 12, 2],
  );
  r.write32(p + 8, 3);
  assert.equal(await call('SystemParametersInfoW', 4, 0, p, 0), 0);
  await call('SystemParametersInfoA', 3, 0, p + 16, 0);
  assert.equal(r.read32(p + 24), 2);
});
