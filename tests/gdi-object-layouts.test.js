import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('tests/fixtures/resource-bitmaps/resource-bitmaps.exe'));
function setup() {
  const r = new Runtime(iced, { files: new Map([['fixture.exe', exe]]), exe: 'fixture.exe' });
  const call = (name, ...args) => r.apiProvider.get(`gdi32.dll!${name}`)(r, (i) => args[i] >>> 0);
  return { r, call };
}
test('LOGFONT A/W fields and indirect stdcall cleanup survive full and partial queries', () => {
  const { r, call } = setup();
  for (const wide of [false, true]) {
    const size = wide ? 92 : 60,
      suffix = wide ? 'W' : 'A';
    const input = r.allocate(size),
      output = r.allocate(size + 8);
    r.data.fill(0, input, input + size);
    r.write32(input, -24);
    r.write32(input + 16, 600);
    r.data.set([1, 1, 1, 2, 3, 4, 5, 0x31], input + 20);
    const face = wide ? 'Arial Ω €' : 'Arial €';
    if (wide)
      for (let i = 0; i < face.length; i++)
        r.view.setUint16(input + 28 + i * 2, face.charCodeAt(i), true);
    else r.data.set([65, 114, 105, 97, 108, 32, 0x80], input + 28);
    const font = call(`CreateFontIndirect${suffix}`, input);
    assert.equal(font.argc, 1);
    assert.ok(font.result);
    assert.equal(call(`GetObject${suffix}`, font.result, 0, 0).result, size);
    for (let count = 0; count <= size + 8; count++) {
      r.data.fill(0xcc, output, output + size + 8);
      assert.equal(
        call(`GetObject${suffix}`, font.result, count, output).result,
        Math.min(count, size),
      );
      assert.deepEqual(
        r.data.slice(output, output + Math.min(count, size)),
        r.data.slice(input, input + Math.min(count, size)),
      );
      assert.ok(
        r.data.slice(output + Math.min(count, size), output + size + 8).every((b) => b === 0xcc),
      );
    }
    if (wide) {
      assert.equal(call('GetObjectA', font.result, 60, output).result, 60);
      assert.deepEqual(
        [...r.data.slice(output + 28, output + 38)],
        [65, 114, 105, 97, 108, 32, 63, 32, 128, 0],
      );
    }
    assert.equal(call('DeleteObject', font.result).result, 1);
    assert.equal(call(`GetObject${suffix}`, font.result, 0, 0).result, 0);
    assert.equal(call(`CreateFontIndirect${suffix}`, 0).argc, 1);
    r.data[input + 26] = 0xff;
    assert.deepEqual(call(`CreateFontIndirect${suffix}`, input), { result: 0, argc: 1 });
  }
});
test('default logical font preserves zero height/weight and empty requested face', () => {
  const { r, call } = setup(),
    input = r.allocate(92),
    output = r.allocate(92);
  r.data.fill(0, input, input + 92);
  const font = call('CreateFontIndirectW', input).result;
  assert.ok(font);
  assert.equal(call('GetObjectW', font, 92, output).result, 92);
  assert.deepEqual(r.data.slice(output, output + 92), r.data.slice(input, input + 92));
});
test('GetObject pen/brush probes, short copies, hatch/style/color and buffer tails match PE32', () => {
  const { r, call } = setup(),
    output = r.allocate(24);
  const pen = call('CreatePen', 0, 0, 0x00332211).result;
  assert.equal(call('GetObjectW', pen, 0, 0).result, 16);
  r.data.fill(0xcc, output, output + 24);
  assert.equal(call('GetObjectA', pen, 15, output).result, 0);
  assert.ok(r.data.slice(output, output + 24).every((b) => b === 0xcc));
  assert.equal(call('GetObjectA', pen, 24, output).result, 16);
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => r.read32(output + offset)),
    [0, 0, 0, 0x00332211],
  );
  assert.ok(r.data.slice(output + 16, output + 24).every((b) => b === 0xcc));
  for (const [brush, style, color, hatch] of [
    [call('CreateSolidBrush', 0x00123456).result, 0, 0x00123456, 0],
    [call('CreateHatchBrush', 5, 0x00332211).result, 2, 0x00332211, 5],
    [call('GetStockObject', 5).result, 1, 0, 0],
  ]) {
    assert.equal(call('GetObjectA', brush, 0, 0).result, 12);
    const expected = new Uint8Array(12),
      view = new DataView(expected.buffer);
    [style, color, hatch].forEach((value, i) => view.setUint32(i * 4, value, true));
    for (let count = 0; count <= 24; count++) {
      r.data.fill(0xcc, output, output + 24);
      assert.equal(call('GetObjectW', brush, count, output).result, Math.min(count, 12));
      assert.deepEqual(
        r.data.slice(output, output + Math.min(count, 12)),
        expected.slice(0, count),
      );
      assert.ok(r.data.slice(output + Math.min(count, 12), output + 24).every((b) => b === 0xcc));
    }
  }
  assert.equal(call('GetObjectA', 0xdeadbeef, 0, 0).result, 0);
  assert.equal(r.lastError, 6);
});
