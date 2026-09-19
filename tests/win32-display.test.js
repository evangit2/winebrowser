import test from 'node:test';
import assert from 'node:assert/strict';
import { displayApis, VIRTUAL_DISPLAY_MODE } from '../src/win32-display.js';
import { windowApis } from '../src/win32-windows.js';
import { createWin32ApiProvider } from '../src/win32.js';

const ENUM_CURRENT_SETTINGS = 0xffffffff;
const ENUM_REGISTRY_SETTINGS = 0xfffffffe;
const DISP_CHANGE_SUCCESSFUL = 0;
const DISP_CHANGE_BADMODE = -2;
const DISP_CHANGE_BADFLAGS = -4;
const DISP_CHANGE_BADPARAM = -5;
const DM_PELSWIDTH = 0x00080000;

function runtime() {
  const data = new Uint8Array(4096);
  const view = new DataView(data.buffer);
  const windows = new Map([
    [0x100, { id: 0x100, x: 40, y: 50, width: 300, height: 200, parentId: 0 }],
    [
      0x101,
      {
        id: 0x101,
        x: 7,
        y: 11,
        width: 100,
        height: 40,
        parentId: 0x100,
        controlBorder: 2,
      },
    ],
  ]);
  return {
    data,
    view,
    lastError: 0,
    check(address, size) {
      address >>>= 0;
      if (!address || address + size > data.length) throw Error('display memory range violation');
      return address;
    },
    read32(address) {
      this.check(address, 4);
      return view.getUint32(address, true);
    },
    write32(address, value) {
      this.check(address, 4);
      view.setUint32(address, value >>> 0, true);
    },
    windows: {
      windows,
      screenPosition(window) {
        let x = window.x,
          y = window.y,
          current = window;
        while (current.parentId) {
          const parent = windows.get(current.parentId);
          x += parent.x + 1;
          y += parent.y + 29;
          current = parent;
        }
        return [x, y];
      },
    },
  };
}

function call(r, name, args) {
  const handler = displayApis[`user32.dll!${name}`];
  assert.ok(handler);
  return handler(r, (index) => args[index] ?? 0);
}

function initializeDevmode(r, address = 0x200) {
  r.data.fill(0xcc, address, address + 156);
  r.view.setUint16(address + 36, 156, true);
  r.view.setUint16(address + 38, 0, true);
  return address;
}

test('ClientToScreen converts top-level and child client origins and rejects missing HWNDs', () => {
  const r = runtime();
  const point = 0x100;
  r.view.setInt32(point, -3, true);
  r.view.setInt32(point + 4, 5, true);
  assert.deepEqual(call(r, 'ClientToScreen', [0x100, point]), { result: 1, argc: 2 });
  assert.equal(r.view.getInt32(point, true), 38);
  assert.equal(r.view.getInt32(point + 4, true), 84);

  r.view.setInt32(point, 1, true);
  r.view.setInt32(point + 4, 2, true);
  assert.equal(call(r, 'ClientToScreen', [0x101, point]).result, 1);
  assert.equal(r.view.getInt32(point, true), 51);
  assert.equal(r.view.getInt32(point + 4, true), 94);

  r.view.setInt32(point, 12, true);
  assert.equal(call(r, 'ClientToScreen', [0x999, point]).result, 0);
  assert.equal(r.lastError, 1400);
  assert.equal(r.view.getInt32(point, true), 12);
});

test('EnumDisplaySettingsA exposes one bounded virtual mode for index/current/default queries', () => {
  const r = runtime();
  const address = initializeDevmode(r);
  for (const mode of [0, ENUM_CURRENT_SETTINGS, ENUM_REGISTRY_SETTINGS]) {
    r.view.setUint16(address + 36, 156, true);
    assert.deepEqual(call(r, 'EnumDisplaySettingsA', [0, mode, address]), {
      result: 1,
      argc: 3,
    });
    assert.equal(r.view.getUint16(address + 36, true), 124);
    assert.equal(r.view.getUint16(address + 38, true), 0);
    assert.equal(r.view.getUint32(address + 104, true), VIRTUAL_DISPLAY_MODE.bitsPerPixel);
    assert.equal(r.view.getUint32(address + 108, true), VIRTUAL_DISPLAY_MODE.width);
    assert.equal(r.view.getUint32(address + 112, true), VIRTUAL_DISPLAY_MODE.height);
    assert.equal(r.view.getUint32(address + 116, true), 0);
    assert.equal(r.view.getUint32(address + 120, true), VIRTUAL_DISPLAY_MODE.frequency);
    assert.ok(
      new TextDecoder().decode(r.data.subarray(address, address + 32)).startsWith('WineBrowser'),
    );
    assert.ok(r.data.subarray(address + 124, address + 156).every((byte) => byte === 0xcc));
  }
  assert.equal(call(r, 'EnumDisplaySettingsA', [0, 1, address]).result, 0);
  assert.equal(call(r, 'EnumDisplaySettingsA', [0x300, 0, address]).result, 0);
  r.view.setUint16(address + 36, 40, true);
  assert.equal(call(r, 'EnumDisplaySettingsA', [0, 0, address]).result, 0);
});

test('ChangeDisplaySettingsA accepts restore/current mode tests and rejects flags or unsupported modes', () => {
  const r = runtime();
  const address = initializeDevmode(r);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [0, 0]).result, DISP_CHANGE_SUCCESSFUL);
  assert.equal(call(r, 'EnumDisplaySettingsA', [0, ENUM_CURRENT_SETTINGS, address]).result, 1);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [address, 2]).result, DISP_CHANGE_SUCCESSFUL);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [address, 4]).result, DISP_CHANGE_SUCCESSFUL);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [address, 0x10]).result, DISP_CHANGE_BADFLAGS);

  r.view.setUint32(address + 108, 800, true);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [address, 0]).result, DISP_CHANGE_BADMODE);
  r.view.setUint32(address + 108, VIRTUAL_DISPLAY_MODE.width, true);
  r.view.setUint32(address + 40, DM_PELSWIDTH | 1, true);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [address, 0]).result, DISP_CHANGE_BADMODE);
  r.view.setUint32(address + 40, DM_PELSWIDTH, true);
  r.view.setUint16(address + 36, 40, true);
  assert.equal(call(r, 'ChangeDisplaySettingsA', [address, 0]).result, DISP_CHANGE_BADPARAM);
});

test('display APIs register automatically and screen metrics use the same virtual mode', () => {
  const provider = createWin32ApiProvider();
  for (const name of ['ClientToScreen', 'EnumDisplaySettingsA', 'ChangeDisplaySettingsA'])
    assert.ok(provider.has(`user32.dll!${name}`));
  const metric = windowApis['user32.dll!GetSystemMetrics'];
  assert.equal(metric(null, () => 0).result, VIRTUAL_DISPLAY_MODE.width);
  assert.equal(metric(null, () => 1).result, VIRTUAL_DISPLAY_MODE.height);
  assert.equal(metric(null, () => 16).result, VIRTUAL_DISPLAY_MODE.width);
  assert.equal(metric(null, () => 17).result, VIRTUAL_DISPLAY_MODE.height);
});
