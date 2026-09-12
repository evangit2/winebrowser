import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePE, mapPE } from '../src/pe.js';

function makeDll({ preferredBase = 0x400000 } = {}) {
  const bytes = new Uint8Array(0xa00);
  const view = new DataView(bytes.buffer);
  const w16 = (p, x) => view.setUint16(p, x, true);
  const w32 = (p, x) => view.setUint32(p, x, true);
  const ascii = (p, text) => {
    bytes.set(new TextEncoder().encode(text), p);
    bytes[p + text.length] = 0;
  };
  w16(0, 0x5a4d);
  w32(0x3c, 0x80);
  w32(0x80, 0x00004550);
  w16(0x84, 0x14c);
  w16(0x86, 1);
  w16(0x94, 224);
  w16(0x96, 0x2102); // Executable, 32-bit, DLL.
  const o = 0x98;
  w16(o, 0x10b);
  w32(o + 16, 0); // DLL may have no process entry point.
  w32(o + 28, preferredBase);
  w32(o + 32, 0x1000);
  w32(o + 36, 0x200);
  w32(o + 56, 0x3000);
  w32(o + 60, 0x200);
  w16(o + 68, 3);
  w32(o + 92, 16);
  // Export directory at RVA 0x1100, file offset 0x300.
  w32(o + 96, 0x1100);
  w32(o + 100, 0x100);
  // Relocation directory at RVA 0x1300, file offset 0x500.
  w32(o + 96 + 5 * 8, 0x1300);
  w32(o + 100 + 5 * 8, 12);
  const s = o + 224;
  bytes.set(new TextEncoder().encode('.text'), s);
  w32(s + 8, 0x800);
  w32(s + 12, 0x1000);
  w32(s + 16, 0x800);
  w32(s + 20, 0x200);
  w32(s + 36, 0x60000020);
  bytes.fill(0x90, 0x200, 0xa00);
  const rvaToFile = (rva) => 0x200 + rva - 0x1000;
  const e = rvaToFile(0x1100);
  w32(e + 16, 7); // Export ordinal base.
  w32(e + 20, 3); // Three function slots.
  w32(e + 24, 2); // Two names alias the second slot.
  w32(e + 28, 0x1140);
  w32(e + 32, 0x1150);
  w32(e + 36, 0x1158);
  w32(rvaToFile(0x1140), 0x1010); // Ordinal only.
  w32(rvaToFile(0x1144), 0x1020); // Named aliases.
  w32(rvaToFile(0x1148), 0x1180); // Forwarder within export directory.
  w32(rvaToFile(0x1150), 0x1160);
  w32(rvaToFile(0x1154), 0x1167);
  w16(rvaToFile(0x1158), 1);
  w16(rvaToFile(0x115a), 1);
  ascii(rvaToFile(0x1160), 'NamedA');
  ascii(rvaToFile(0x1167), 'AliasA');
  ascii(rvaToFile(0x1180), 'KERNEL32.Sleep');
  // A HIGHLOW relocation at RVA 0x1010, followed by an ABSOLUTE padding entry.
  w32(rvaToFile(0x1010), preferredBase + 0x1234);
  w32(rvaToFile(0x1300), 0x1000);
  w32(rvaToFile(0x1304), 12);
  w16(rvaToFile(0x1308), 0x3010);
  w16(rvaToFile(0x130a), 0);
  return bytes;
}

test('parses DLL exports, aliases, ordinal-only entries, and forwarders', () => {
  const bytes = makeDll();
  assert.throws(() => parsePE(bytes), /DLL/);
  const pe = parsePE(bytes, { allowDll: true });
  assert.equal(pe.isDll, true);
  assert.equal(pe.entryPointRva, 0);
  assert.deepEqual(pe.exports, [
    { ordinal: 7, rva: 0x1010 },
    { name: 'NamedA', ordinal: 8, rva: 0x1020 },
    { name: 'AliasA', ordinal: 8, rva: 0x1020 },
    { ordinal: 9, rva: 0x1180, forwarder: 'KERNEL32.Sleep' },
  ]);
  assert.deepEqual(pe.relocations, [
    { type: 3, rva: 0x1010 },
    { type: 0, rva: 0x1000 },
  ]);
});

test('maps DLL at an alternate base and relocates HIGHLOW without mutating parsed metadata', () => {
  const bytes = makeDll();
  const pe = parsePE(bytes, { allowDll: true });
  const memory = new WebAssembly.Memory({ initial: 1024 });
  const mapped = mapPE(pe, bytes, memory, 0x100000);
  const view = new DataView(memory.buffer);
  assert.equal(view.getUint32(0x100000 + 0x1010, true), 0x101234);
  assert.equal(mapped.imageBase, 0x100000);
  assert.equal(mapped.preferredImageBase, 0x400000);
  assert.equal(mapped.entryPoint, 0);
  assert.equal(pe.imageBase, 0x400000);
  assert.equal(view.getUint32(0x400000 + 0x1010, true), 0);
});

test('bounds export directories and rejects malformed relocation blocks and targets', () => {
  const exportOutside = makeDll();
  const v1 = new DataView(exportOutside.buffer);
  v1.setUint32(0x98 + 96, 0x2ff0, true);
  v1.setUint32(0x98 + 100, 0x100, true);
  assert.throws(() => parsePE(exportOutside, { allowDll: true }), /outside|exceeds|backed/);

  const badBlock = makeDll();
  new DataView(badBlock.buffer).setUint32(0x200 + 0x1304 - 0x1000, 7, true);
  assert.throws(() => parsePE(badBlock, { allowDll: true }), /relocation block/);

  const badTarget = makeDll();
  const v3 = new DataView(badTarget.buffer);
  v3.setUint32(0x200 + 0x1300 - 0x1000, 0x2000, true);
  v3.setUint16(0x200 + 0x1308 - 0x1000, 0x3fff, true);
  assert.throws(() => parsePE(badTarget, { allowDll: true }), /relocation target/);
});

test('rejects alternate mapping without relocation metadata and unsupported relocation types', () => {
  const noRelocs = makeDll();
  const v1 = new DataView(noRelocs.buffer);
  v1.setUint32(0x98 + 96 + 5 * 8, 0, true);
  v1.setUint32(0x98 + 100 + 5 * 8, 0, true);
  const pe = parsePE(noRelocs, { allowDll: true });
  assert.throws(
    () => mapPE(pe, noRelocs, new WebAssembly.Memory({ initial: 1024 }), 0x100000),
    /no base relocation/,
  );

  const unsupported = makeDll();
  new DataView(unsupported.buffer).setUint16(0x200 + 0x1308 - 0x1000, 0x2010, true);
  assert.throws(() => parsePE(unsupported, { allowDll: true }), /unsupported base relocation type/);
});
