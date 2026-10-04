import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBrowserColor } from '../src/win32-color-dialog.js';
function setup() {
  const data = new Uint8Array(512),
    view = new DataView(data.buffer),
    events = [];
  const owner = { id: 1, enabled: true };
  const r = {
    data,
    view,
    lastError: 0,
    read32: (p) => view.getUint32(p, true),
    write32: (p, v) => view.setUint32(p, v >>> 0, true),
    check(p, n) {
      if (p + n > 512) throw Error('outside memory');
    },
    windows: {
      windows: new Map([[1, owner]]),
      emit() {},
      registerWindowMessage(name) {
        assert.equal(name, 'commdlg_ColorOK');
        return 0xc001;
      },
      async send(...args) {
        events.push(args);
        return 0;
      },
    },
    request: async () => null,
  };
  r.write32(32, 36);
  r.write32(36, 1);
  r.write32(44, 0x563412);
  r.write32(48, 128);
  r.write32(52, 3);
  for (let i = 0; i < 16; i++) r.write32(128 + i * 4, 0xffffffff);
  return { r, owner, events, call: () => chooseBrowserColor(r, () => 32) };
}
test('color cancellation preserves native structures and custom palette; owner restoration survives errors', async () => {
  const { r, owner, events, call } = setup(),
    before = r.data.slice();
  r.request = async (kind, detail) => {
    assert.equal(kind, 'choose-color');
    assert.equal(owner.enabled, false);
    assert.equal(detail.initial, 0x563412);
    assert.equal(detail.fullOpen, true);
    return null;
  };
  assert.deepEqual(await call(), { result: 0, argc: 1 });
  assert.deepEqual(r.data, before);
  assert.equal(r.commonDialogError, 0);
  assert.equal(owner.enabled, true);
  assert.deepEqual(events, [
    [1, 0xa, 0, 0],
    [1, 0xa, 1, 0],
  ]);
  r.request = async () => {
    throw Error('host closed');
  };
  await assert.rejects(call(), /host closed/);
  assert.equal(owner.enabled, true);
});
test('selected COLORREF, custom palette on Cancel and native ColorOK veto use caller memory', async () => {
  const { r, owner, call } = setup();
  let requests = 0,
    callbacks = 0;
  r.windows.send = async (hwnd, msg, wp, lp) => {
    if (msg === 0xc001) {
      assert.equal(owner.enabled, false);
      assert.equal(lp, 32);
      assert.equal(r.read32(lp + 12), 0xa05014);
      return ++callbacks === 1 ? 1 : 0;
    }
    return 0;
  };
  r.request = async (kind, detail) => {
    if (requests++) assert.equal(detail.initial, 0xa05014);
    return { accepted: true, color: 0xa05014, customColors: detail.customColors };
  };
  assert.equal((await call()).result, 1);
  assert.equal(requests, 2);
  assert.equal(callbacks, 2);
  assert.equal(r.read32(44), 0xa05014);
  assert.equal(r.read32(128), 0xffffffff);
  r.request = async (kind, detail) => ({
    accepted: false,
    color: 0x123456,
    customColors: detail.customColors.map((c, i) => (i === 0 ? 0x123456 : c)),
  });
  assert.equal((await call()).result, 0);
  assert.equal(r.read32(44), 0xa05014);
  assert.equal(r.read32(128), 0x123456);
  assert.equal(r.commonDialogError, 0);
});
test('color flags, bounds and bad host data report errors without fake success or partial writes', async () => {
  const { r, call } = setup();
  for (const [field, value, win32] of [
    [32, 35, 87],
    [36, 99, 1400],
    [48, 0, 87],
    [52, 0x10, 120],
  ]) {
    const original = r.read32(field);
    r.write32(field, value);
    assert.equal((await call()).result, 0);
    assert.ok(r.commonDialogError);
    assert.equal(r.lastError, win32);
    r.write32(field, original);
  }
  r.write32(52, 2 | 4 | 0x180);
  r.request = async (kind, detail) => {
    assert.equal(detail.initial, 0);
    assert.equal(detail.fullOpen, false);
    assert.equal(detail.preventFullOpen, true);
    return { accepted: true, color: 0xffffff + 1, customColors: detail.customColors };
  };
  const before = r.data.slice();
  assert.equal((await call()).result, 0);
  assert.deepEqual(r.data, before);
  assert.equal(r.commonDialogError, 2);
  r.write32(48, 480);
  await assert.rejects(call(), /outside memory/);
});
