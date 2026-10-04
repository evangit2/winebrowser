import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBrowserFont } from '../src/win32-font-dialog.js';
function setup(wide = false) {
  const data = new Uint8Array(1024),
    view = new DataView(data.buffer);
  const r = {
    data,
    memory: data,
    view,
    windows: { windows: new Map() },
    lastError: 0,
    check(p, n) {
      if (p + n > data.length) throw Error('outside memory');
    },
    read32(p) {
      return view.getUint32(p, true);
    },
    write32(p, v) {
      view.setUint32(p, v, true);
    },
    request: async () => null,
  };
  r.write32(64, 60);
  r.write32(76, 160);
  r.write32(84, 0x141);
  r.write32(160, -16);
  r.write32(176, 400);
  data[183] = 1;
  if (wide) for (let i = 0; i < 5; i++) view.setUint16(188 + i * 2, 'Arial'.charCodeAt(i), true);
  else data.set(new TextEncoder().encode('Arial'), 188);
  return { r, call: () => chooseBrowserFont(r, () => 64, wide) };
}
test('font cancellation preserves CHOOSEFONT/LOGFONT bytes and reports no common-dialog error', async () => {
  for (const wide of [false, true]) {
    const { r, call } = setup(wide),
      before = r.data.slice();
    assert.deepEqual(await call(), { result: 0, argc: 1 });
    assert.deepEqual(r.data, before);
    assert.equal(r.commonDialogError, 0);
  }
});
test('A/W font choices write native fields, colors and face encoding without changing adjacent memory', async () => {
  for (const wide of [false, true]) {
    const { r, call } = setup(wide);
    const face = wide ? 'Arial Ω' : 'Arial €';
    r.request = async (kind, detail) => {
      assert.equal(kind, 'choose-font');
      assert.equal(detail.initial.face, 'Arial');
      return {
        face,
        points: 18,
        weight: 700,
        italic: true,
        underline: true,
        strikeout: false,
        color: 0x00332211,
      };
    };
    assert.deepEqual(await call(), { result: 1, argc: 1 });
    assert.equal(r.read32(160) | 0, -24);
    assert.equal(r.read32(176), 700);
    assert.deepEqual([...r.data.slice(180, 184)], [1, 1, 0, 1]);
    assert.equal(r.read32(80), 180);
    assert.equal(r.read32(88), 0x00332211);
    assert.equal(r.view.getUint16(112, true), 0x2300);
    if (wide) assert.equal(r.view.getUint16(200, true), 0x03a9);
    else assert.equal(r.data[194], 0x80);
    assert.ok(r.data.slice(160 + (wide ? 92 : 60), 256).every((b) => b === 0));
  }
});
test('font unsupported flags, invalid selections and limits fail without mutating guest output', async () => {
  const { r, call } = setup();
  r.write32(84, 0x149); // CF_ENABLEHOOK unsupported
  let requested = false;
  r.request = async () => {
    requested = true;
    return {};
  };
  const before = r.data.slice();
  assert.equal((await call()).result, 0);
  assert.equal(requested, false);
  assert.equal(r.commonDialogError, 2);
  assert.equal(r.lastError, 120);
  assert.deepEqual(r.data, before);
  r.write32(84, 0x141);
  r.request = async () => ({
    face: 'Ω',
    points: 18,
    weight: 700,
    italic: false,
    underline: false,
    strikeout: false,
    color: 0,
  });
  const original = r.data.slice();
  assert.equal((await call()).result, 0);
  assert.deepEqual(r.data, original);
  r.write32(84, 0x2141);
  r.write32(116, 18);
  r.write32(120, 12);
  assert.equal((await call()).result, 0);
  assert.equal(r.commonDialogError, 2);
});
test('font selection restrictions retain disabled values and hidden effects', async () => {
  const { r, call } = setup();
  r.write32(84, 0x380041);
  r.request = async () => ({
    face: 'Courier New',
    points: 30,
    weight: 900,
    italic: true,
    underline: true,
    strikeout: true,
    color: 0x112233,
  });
  assert.equal((await call()).result, 1);
  assert.equal(r.read32(160) | 0, -16);
  assert.equal(r.read32(176), 400);
  assert.equal(r.read32(88), 0);
  assert.deepEqual([...r.data.slice(180, 183)], [0, 0, 0]);
  assert.equal(new TextDecoder().decode(r.data.slice(188, 193)), 'Arial');
});
