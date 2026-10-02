import test from 'node:test';
import assert from 'node:assert/strict';
import { pipelineStreamDescriptor } from '../src/d3d12-pipeline-stream.js';
import { parseCommittedResourceDescriptor } from '../src/d3d12-descriptors.js';

function memory() {
  const data = new Uint8Array(2048),
    view = new DataView(data.buffer);
  const check = (p, n) => {
    if (p < 0 || n < 1 || p + n > data.length) throw Error('memory');
  };
  const read32 = (p) => view.getUint32(p, true),
    write32 = (p, n) => view.setUint32(p, n, true);
  return { data, view, check, read32, write32, readFloat32: (p) => view.getFloat32(p, true) };
}

test('PE32 graphics streams preserve pointers, shader sizes, formats and documented defaults', () => {
  const m = memory();
  const words = [0, 200, 1, 300, 40, 2, 400, 24, 16, 40];
  words.forEach((n, i) => m.write32(128 + i * 4, n));
  const bytes = pipelineStreamDescriptor({ ...m, pointer: 128, size: words.length * 4 });
  const v = new DataView(bytes.buffer),
    word = (p) => v.getUint32(p, true);
  assert.deepEqual([word(0), word(4), word(8), word(12), word(16)], [200, 300, 40, 400, 24]);
  assert.deepEqual(
    [
      word(392),
      word(396),
      word(400),
      word(420),
      word(440),
      word(444),
      word(448),
      word(544),
      word(548),
    ],
    [0xffffffff, 3, 3, 1, 1, 1, 2, 40, 1],
  );
  assert.equal(bytes[108], 15, 'default color write mask');
  const noDepth = pipelineStreamDescriptor({ ...m, pointer: 128, size: 32 });
  assert.ok(noDepth.slice(440, 492).every((n) => n === 0));
});

test('pipeline streams reject truncation, duplicate fields, unsupported compute and missing shaders', () => {
  const m = memory(),
    parse = (size) => pipelineStreamDescriptor({ ...m, pointer: 128, size });
  m.write32(128, 1);
  assert.throws(() => parse(8), /Truncated/);
  m.write32(128, 0);
  m.write32(136, 0);
  assert.throws(() => parse(16), /Duplicate/);
  m.write32(128, 6);
  assert.throws(() => parse(12), /Unsupported/);
  m.write32(128, 0);
  assert.throws(() => parse(8), /requires/);
  assert.throws(() => parse(0), /size/);
  assert.throws(() => parse(3), /size/);
  assert.throws(() => parse(65540), /size/);
});

test('D32 depth accepts full mip chains, rejects excess mips and mismatched clears', () => {
  const m = memory(),
    { write32: w, view } = m;
  w(64, 1);
  w(76, 1);
  w(80, 1);
  w(128, 3);
  w(144, 1280);
  w(152, 720);
  view.setUint16(156, 1, true);
  w(160, 40);
  w(164, 1);
  w(176, 2);
  w(256, 40);
  view.setFloat32(260, 1, true);
  const parse = () =>
    parseCommittedResourceDescriptor({
      ...m,
      heap: 64,
      descriptor: 128,
      heapFlags: 0,
      initialState: 0x10,
      clearValue: 256,
      maxBytes: 16 * 1024 * 1024,
    });
  assert.equal(parse().mipLevelCount, 11);
  view.setUint16(158, 1, true);
  assert.equal(parse().mipLevelCount, 1);
  view.setUint16(158, 12, true);
  assert.equal(parse(), null);
  view.setUint16(158, 1, true);
  w(256, 55);
  assert.equal(parse(), null);
});
