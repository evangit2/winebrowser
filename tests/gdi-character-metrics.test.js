import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('tests/fixtures/resource-bitmaps/resource-bitmaps.exe'));
function setup() {
  const r = new Runtime(iced, { files: new Map([['fixture.exe', exe]]), exe: 'fixture.exe' });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  const dc = call('gdi32.dll!CreateCompatibleDC', 0).result;
  const seen = [];
  r.gdiTextRasterizer = {
    rasterize(text, font) {
      seen.push({ text, font });
      const advance = { I: 3.25, W: 12.75, '€': 8.5, Ω: 9.125 }[text] ?? 4.25;
      return {
        width: Math.ceil(advance),
        height: 2,
        advance,
        left: -0.5,
        inkWidth: 2.5,
        alpha: new Uint8Array(Math.ceil(advance) * 2),
      };
    },
  };
  return { r, call, dc, seen };
}
test('character widths use each selected-font glyph, CP1252/UTF-16 decoding and four-argument ABI', () => {
  const { r, call, dc, seen } = setup(),
    p = r.allocate(256);
  for (const [name, wide, floats] of [
    ['GetCharWidthA', false, false],
    ['GetCharWidthW', true, false],
    ['GetCharWidth32A', false, false],
    ['GetCharWidth32W', true, false],
    ['GetCharWidthFloatA', false, true],
    ['GetCharWidthFloatW', true, true],
  ]) {
    r.data.fill(0xcc, p, p + 256);
    assert.deepEqual(call(`gdi32.dll!${name}`, dc, 73, 87, p), { result: 1, argc: 4 });
    const value = (i) => (floats ? r.view.getFloat32(p + i * 4, true) : r.read32(p + i * 4));
    assert.equal(value(0), floats ? 3.25 : 3);
    assert.equal(value(14), floats ? 12.75 : 13);
    assert.ok(r.data.slice(p + 60, p + 256).every((b) => b === 0xcc));
    assert.equal(
      call(`gdi32.dll!${name}`, dc, wide ? 0x20ac : 0x80, wide ? 0x20ac : 0x80, p).result,
      1,
    );
    assert.equal(value(0), floats ? 8.5 : 9);
    assert.equal(seen.at(-1).text, '€');
  }
  call('gdi32.dll!GetCharWidthFloatW', dc, 0x03a9, 0x03a9, p);
  assert.equal(r.view.getFloat32(p, true), 9.125);
  assert.equal(seen.at(-1).text, 'Ω');
});
test('ABC queries write three fields with signed bearings and preserve tails', () => {
  const { r, call, dc } = setup(),
    p = r.allocate(32);
  for (const wide of [false, true])
    for (const floats of [false, true]) {
      r.data.fill(0xcc, p, p + 32);
      assert.deepEqual(
        call(
          `gdi32.dll!GetCharABCWidths${floats ? 'Float' : ''}${wide ? 'W' : 'A'}`,
          dc,
          73,
          74,
          p,
        ),
        { result: 1, argc: 4 },
      );
      const value = (i) => (floats ? r.view.getFloat32(p + i * 4, true) : r.read32(p + i * 4) | 0);
      assert.deepEqual([value(0), value(1), value(2)], floats ? [-0.5, 2.5, 1.25] : [0, 3, 0]);
      assert.equal(value(3) + value(4) + value(5), floats ? 4.25 : 4);
      assert.ok(r.data.slice(p + 24, p + 32).every((b) => b === 0xcc));
    }
});
test('invalid ranges and backend failures preserve the entire output buffer and ABI', () => {
  const { r, call, dc } = setup(),
    p = r.allocate(32);
  r.data.fill(0xcc, p, p + 32);
  for (const [hdc, first, last, output] of [
    [dc, 4, 3, p],
    [dc, 256, 256, p],
    [dc, 0, 1, 0],
    [0xdeadbeef, 0, 1, p],
  ]) {
    assert.deepEqual(call('gdi32.dll!GetCharWidthFloatA', hdc, first, last, output), {
      result: 0,
      argc: 4,
    });
  }
  r.gdiTextRasterizer = null;
  assert.deepEqual(call('gdi32.dll!GetCharWidth32W', dc, 1, 2, p), { result: 0, argc: 4 });
  assert.equal(r.lastError, 120);
  let calls = 0;
  r.gdiTextRasterizer = {
    rasterize() {
      if (calls++) throw Error('backend fault');
      return { width: 1, height: 1, alpha: new Uint8Array(1) };
    },
  };
  assert.deepEqual(call('gdi32.dll!GetCharWidthA', dc, 1, 2, p), { result: 0, argc: 4 });
  assert.ok(r.data.slice(p, p + 32).every((b) => b === 0xcc));
});
test('TEXTMETRIC A/W use real byte offsets for selected font style and charset', () => {
  const { r, call, dc } = setup(),
    fontInput = r.allocate(92),
    p = r.allocate(68);
  r.data.fill(0, fontInput, fontInput + 92);
  r.write32(fontInput, -24);
  r.write32(fontInput + 16, 600);
  r.data.set([1, 1, 1, 2, 0, 0, 0, 0x31], fontInput + 20);
  const font = call('gdi32.dll!CreateFontIndirectW', fontInput).result;
  call('gdi32.dll!SelectObject', dc, font);
  for (const wide of [false, true]) {
    r.data.fill(0xcc, p, p + 68);
    assert.deepEqual(call(`gdi32.dll!GetTextMetrics${wide ? 'W' : 'A'}`, dc, p), {
      result: 1,
      argc: 2,
    });
    assert.equal(r.read32(p + 28), 600);
    assert.deepEqual(
      [...r.data.slice(p + (wide ? 52 : 48), p + (wide ? 57 : 53))],
      [1, 1, 1, 0x31, 2],
    );
    assert.ok(r.data.slice(p + (wide ? 60 : 56), p + 68).every((b) => b === 0xcc));
  }
});
