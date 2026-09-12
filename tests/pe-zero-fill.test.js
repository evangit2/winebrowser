import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPE, parsePE } from '../src/pe.js';

function makeTailTerminatedImportImage() {
  const bytes = new Uint8Array(0x262);
  const view = new DataView(bytes.buffer);
  const w16 = (offset, value) => view.setUint16(offset, value, true);
  const w32 = (offset, value) => view.setUint32(offset, value, true);
  const rvaToFile = (rva) => 0x200 + rva - 0x1000;

  w16(0, 0x5a4d);
  w32(0x3c, 0x80);
  w32(0x80, 0x00004550);
  w16(0x84, 0x14c);
  w16(0x86, 1);
  w16(0x94, 224);
  w16(0x96, 0x0102);
  const optional = 0x98;
  w16(optional, 0x10b);
  w32(optional + 16, 0x1000);
  w32(optional + 28, 0x400000);
  w32(optional + 32, 0x1000);
  w32(optional + 36, 0x200);
  w32(optional + 56, 0x2000);
  w32(optional + 60, 0x200);
  w16(optional + 68, 3);
  w32(optional + 92, 16);
  // The directory runs from backed bytes into the section's zero-fill tail.
  w32(optional + 96 + 8, 0x104e);
  w32(optional + 100 + 8, 0x28);

  const section = optional + 224;
  bytes.set(new TextEncoder().encode('.text'), section);
  w32(section + 8, 0x76); // VirtualSize
  w32(section + 12, 0x1000);
  w32(section + 16, 0x62); // SizeOfRawData
  w32(section + 20, 0x200);
  w32(section + 36, 0x60000020);
  bytes.fill(0x90, 0x200, 0x262);

  const dllName = new TextEncoder().encode('KERNEL32.dll\0');
  bytes.set(dllName, rvaToFile(0x1020));
  w32(rvaToFile(0x1030), 0x80000001); // Import by ordinal 1.
  w32(rvaToFile(0x1034), 0); // Lookup table terminator.
  w32(rvaToFile(0x1038), 0);
  w32(rvaToFile(0x103c), 0);

  const descriptor = rvaToFile(0x104e);
  w32(descriptor, 0x1030);
  w32(descriptor + 12, 0x1020);
  w32(descriptor + 16, 0x1038);
  // [RVA 0x1062, 0x1076) belongs to virtual zero-fill, forming the null descriptor.
  return bytes;
}

test('parses an import-directory terminator in a section zero-fill tail', () => {
  const bytes = makeTailTerminatedImportImage();
  const original = bytes.slice();
  const pe = parsePE(bytes);
  assert.deepEqual(pe.imports, [{ dll: 'KERNEL32.dll', ordinal: 1, iatRva: 0x1038 }]);
  assert.equal(pe.sections[0].virtualSize, 0x76);
  assert.equal(pe.sections[0].rawSize, 0x62);
  assert.deepEqual(bytes, original, 'parsing leaves the original file bytes unchanged');

  const memory = new WebAssembly.Memory({ initial: 1024 });
  mapPE(pe, bytes, memory);
  const mapped = new Uint8Array(memory.buffer);
  assert.ok(mapped.subarray(0x400000 + 0x1062, 0x400000 + 0x1076).every((byte) => byte === 0));
});

test('rejects directories that leave their mapped section or the image', () => {
  const outsideSection = makeTailTerminatedImportImage();
  const v1 = new DataView(outsideSection.buffer);
  v1.setUint32(0x98 + 96 + 8, 0x1070, true);
  v1.setUint32(0x98 + 100 + 8, 0x20, true);
  assert.throws(() => parsePE(outsideSection), /outside mapped image sections/);

  const outsideImage = makeTailTerminatedImportImage();
  const v2 = new DataView(outsideImage.buffer);
  v2.setUint32(0x98 + 96 + 8, 0x1ff0, true);
  v2.setUint32(0x98 + 100 + 8, 0x20, true);
  assert.throws(() => parsePE(outsideImage), /outside the image/);
});

test('keeps raw section extents bounded by the file despite RVA zero-fill support', () => {
  const bytes = makeTailTerminatedImportImage();
  new DataView(bytes.buffer).setUint32(0x98 + 224 + 20, 0x500, true);
  assert.throws(() => parsePE(bytes), /raw data is out of bounds/);
});
