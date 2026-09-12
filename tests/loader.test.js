import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { parsePE, mapPE } from '../src/pe.js';
import { normalizePath, unpackPackage } from '../src/package.js';

function makePE() {
  const bytes = new Uint8Array(0x400);
  const v = new DataView(bytes.buffer);
  const w16 = (p, x) => v.setUint16(p, x, true);
  const w32 = (p, x) => v.setUint32(p, x, true);
  w16(0, 0x5a4d);
  w32(0x3c, 0x80);
  w32(0x80, 0x00004550);
  w16(0x84, 0x14c);
  w16(0x86, 1);
  w16(0x94, 224);
  w16(0x96, 0x0102);
  const o = 0x98;
  w16(o, 0x10b);
  w32(o + 16, 0x1000);
  w32(o + 28, 0x400000);
  w32(o + 32, 0x1000);
  w32(o + 36, 0x200);
  w32(o + 56, 0x2000);
  w32(o + 60, 0x200);
  w16(o + 68, 3);
  w32(o + 92, 16);
  const s = o + 224;
  bytes.set(new TextEncoder().encode('.text'), s);
  w32(s + 8, 0x200);
  w32(s + 12, 0x1000);
  w32(s + 16, 0x200);
  w32(s + 20, 0x200);
  w32(s + 36, 0x60000020);
  bytes.fill(0x90, 0x200, 0x400);
  return bytes;
}

const crcTable = (() => {
  const a = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    a[i] = c >>> 0;
  }
  return a;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const n = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    locals.push(local);
    const c = new Uint8Array(46 + n.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x0314, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    c.set(n, 46);
    centrals.push(c);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, x) => sum + x.length, 0));
  let p = 0;
  for (const item of all) {
    out.set(item, p);
    p += item.length;
  }
  return out;
}

test('parses and maps a bounded x86 PE32 image', () => {
  const bytes = makePE();
  const pe = parsePE(bytes);
  assert.equal(pe.machine, 0x14c);
  assert.equal(pe.entryPoint, 0x401000);
  assert.equal(pe.sections[0].name, '.text');
  const memory = new WebAssembly.Memory({ initial: 1024 });
  mapPE(pe, bytes, memory);
  const mapped = new Uint8Array(memory.buffer);
  assert.equal(mapped[0x401000], 0x90);
  assert.equal(mapped[0x401200], 0);
});

test('rejects PE32+, DLLs, out-of-range and overlapping sections', () => {
  const plus = makePE();
  new DataView(plus.buffer).setUint16(0x98, 0x20b, true);
  assert.throws(() => parsePE(plus), /PE32/);
  const dll = makePE();
  new DataView(dll.buffer).setUint16(0x96, 0x2102, true);
  assert.throws(() => parsePE(dll), /DLL/);
  const overlap = makePE();
  new DataView(overlap.buffer).setUint32(0x98 + 224 + 12, 0x100, true);
  assert.throws(() => parsePE(overlap), /section|overlapping/);
  const two = new Uint8Array(0x600);
  two.set(makePE());
  const tv = new DataView(two.buffer);
  tv.setUint16(0x86, 2, true);
  tv.setUint32(0x98 + 56, 0x3000, true);
  const second = 0x98 + 224 + 40;
  two.set(new TextEncoder().encode('.data'), second);
  tv.setUint32(second + 8, 0x200, true);
  tv.setUint32(second + 12, 0x1100, true);
  tv.setUint32(second + 16, 0x200, true);
  tv.setUint32(second + 20, 0x400, true);
  assert.throws(() => parsePE(two), /overlapping virtual/);
  tv.setUint32(second + 12, 0x2000, true);
  tv.setUint32(second + 20, 0x300, true);
  assert.throws(() => parsePE(two), /overlapping raw/);
});

test('rejects TLS and delay-import directories', () => {
  const tls = makePE();
  new DataView(tls.buffer).setUint32(0x98 + 96 + 9 * 8, 0x1000, true);
  assert.throws(() => parsePE(tls), /TLS/);
  const delay = makePE();
  new DataView(delay.buffer).setUint32(0x98 + 96 + 13 * 8 + 4, 8, true);
  assert.throws(() => parsePE(delay), /delay imports/);
});

test('normalizes safe virtual paths and rejects traversal and absolute paths', () => {
  assert.equal(normalizePath('Bin\\Demo.EXE'), 'bin/demo.exe');
  assert.throws(() => normalizePath('../secret.exe'), /traversal/);
  assert.throws(() => normalizePath('C:\\secret.exe'), /absolute/);
  assert.throws(() => normalizePath('/secret.exe'), /absolute/);
});

test('accepts a raw executable and extracts a ZIP with CRC validation', async () => {
  const pe = makePE();
  const raw = await unpackPackage(pe, 'Demo.EXE');
  assert.deepEqual(raw.executables, ['demo.exe']);
  const zip = makeZip([
    ['Bin/Demo.exe', pe],
    ['readme.txt', new TextEncoder().encode('hello')],
  ]);
  const pkg = await unpackPackage(zip);
  assert.deepEqual(pkg.executables, ['bin/demo.exe']);
  assert.equal(new TextDecoder().decode(pkg.files.get('readme.txt')), 'hello');
});

test('recognizes the generated public demo as a raw executable', async () => {
  const demo = new Uint8Array(
    await readFile(new URL('../public/demos/beep/beep.exe', import.meta.url)),
  );
  const pkg = await unpackPackage(demo, 'beep.exe');
  assert.deepEqual(pkg.executables, ['beep.exe']);
  assert.equal(pkg.files.get('beep.exe')[2], demo[2]);
  assert.equal(parsePE(pkg.files.get('beep.exe')).machine, 0x14c);
});

test('enumerates malformed executable candidates without rejecting the package', async () => {
  const valid = makePE();
  const invalidExe = new Uint8Array([0x4d, 0x5a, 0x90, 0]);
  const pkg = await unpackPackage(
    makeZip([
      ['good.exe', valid],
      ['bad.exe', invalidExe],
    ]),
  );
  assert.deepEqual(pkg.executables, ['good.exe', 'bad.exe']);
  assert.deepEqual(pkg.files.get('bad.exe'), invalidExe);
  assert.throws(() => parsePE(pkg.files.get('bad.exe')));
});

test('rejects ZIP traversal, case collisions, and CRC corruption', async () => {
  const pe = makePE();
  await assert.rejects(unpackPackage(makeZip([['../evil.exe', pe]])), /traversal/);
  await assert.rejects(
    unpackPackage(
      makeZip([
        ['App.exe', pe],
        ['app.EXE', pe],
      ]),
    ),
    /colliding/,
  );
  const corrupt = makeZip([['note.txt', new TextEncoder().encode('hello')]]);
  corrupt[38] ^= 0xff;
  await assert.rejects(unpackPackage(corrupt), /CRC|decompress/);
  const bomb = makeZip([['a.txt', new Uint8Array([1])]]);
  const bv = new DataView(bomb.buffer);
  // The first entry has a one-byte compressed payload but declares 201 output bytes.
  bv.setUint16(8, 8, true);
  bv.setUint32(22, 201, true);
  bv.setUint16(36 + 10, 8, true);
  bv.setUint32(36 + 20, 1, true);
  bv.setUint32(36 + 24, 201, true);
  await assert.rejects(unpackPackage(bomb), /compression ratio/);
});

test('stops deflate output as soon as it exceeds the declared size', async () => {
  const archive = zipSync({ 'payload.bin': new Uint8Array(64 * 1024).fill(65) });
  const v = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - 22;
  const central = v.getUint32(end + 16, true);
  v.setUint32(22, 1, true); // Local uncompressed size.
  v.setUint32(central + 24, 1, true); // Central uncompressed size.
  await assert.rejects(unpackPackage(archive), /inflated data exceeds declared size/);
});
