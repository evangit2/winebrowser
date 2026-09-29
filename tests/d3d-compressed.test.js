import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compressedFormat, decodeCompressed } from '../src/d3d-compressed.js';

const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/dxt-vectors.json', import.meta.url)),
);
const decode = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));

test('DXT decoders match an independent Pillow oracle byte for byte', () => {
  for (const v of vectors) {
    const out = new Uint8Array(v.width * v.height * 4);
    decodeCompressed(decode(v.payload), 0, v.format, v.width, v.height, out);
    assert.deepEqual([...out], v.rgba, `${v.name} (${v.width}x${v.height})`);
  }
});

test('S3TC block geometry and chunk sizes are exact', () => {
  assert.equal(compressedFormat(0x31545844).blockBytes, 8);
  assert.equal(compressedFormat(0x33545844).blockBytes, 16);
  assert.equal(compressedFormat(0x35545844).blockBytes, 16);
  assert.equal(compressedFormat(21), null);
  // A single non-multiple-of-four level still decodes: the partial edge block
  // writes only the texels that exist.
  const dxt1 = compressedFormat(0x31545844);
  const payload = Uint8Array.from([
    0xff,
    0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00, // white over black
  ]);
  const out = new Uint8Array(3 * 2 * 4);
  decodeCompressed(payload, 0, 0x31545844, 3, 2, out);
  assert.deepEqual([...out.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...out.slice(3 * 4, 3 * 4 + 4)], [255, 255, 255, 255]);
  assert.equal(dxt1.name, 'DXT1');
});

test('DXT1 one-bit alpha keeps the transparent index at zero alpha', () => {
  // color0 <= color1 selects the 3-color plus transparent mode, where index 3
  // is transparent black regardless of the color bits.
  const payload = Uint8Array.from([
    0x00,
    0x00,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff, // every texel selects index 3
  ]);
  const out = new Uint8Array(4 * 4 * 4);
  decodeCompressed(payload, 0, 0x31545844, 4, 4, out);
  for (let i = 0; i < 16; i++) assert.deepEqual([...out.slice(i * 4, i * 4 + 4)], [0, 0, 0, 0]);
});
