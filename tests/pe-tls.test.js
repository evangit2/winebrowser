import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parsePE } from '../src/pe.js';

const fixture = new URL('./fixtures/wine-nt/ntdll.dll', import.meta.url);
const IMAGE_TLS_DIRECTORY32_SIZE = 24;
const ALIGN_16 = 5 << 20;

async function original() {
  return new Uint8Array(await readFile(fixture));
}

function layout(bytes) {
  const pe = parsePE(bytes, { allowDll: true });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  const optional = peOffset + 24;
  const directory = optional + 96 + 9 * 8;
  const section = (name) => pe.sections.find((item) => item.name === name);
  const writeRva = (rva, values) => {
    const owner = pe.sections.find((s) => rva >= s.rva && rva + values.length <= s.rva + s.rawSize);
    assert.ok(owner, `fixture bytes exist at RVA 0x${rva.toString(16)}`);
    bytes.set(values, owner.rawOffset + rva - owner.rva);
  };
  const put32 = (rva, value) => {
    const raw = pe.sections.find((s) => rva >= s.rva && rva + 4 <= s.rva + s.rawSize);
    assert.ok(raw, `fixture dword exists at RVA 0x${rva.toString(16)}`);
    view.setUint32(raw.rawOffset + rva - raw.rva, value >>> 0, true);
  };
  const setVirtualSize = (name, size) => {
    const s = section(name);
    const table = optional + view.getUint16(peOffset + 20, true);
    const index = pe.sections.indexOf(s);
    view.setUint32(table + index * 40 + 8, size, true);
  };
  return { pe, view, directory, section, writeRva, put32, setVirtualSize };
}

async function withTls(
  {
    templateRva,
    templateSize = 0,
    zeroFill = 0,
    indexRva,
    callbacksRva,
    callbackRvas = [],
    alignment = ALIGN_16,
  } = {},
  sourceBytes,
) {
  const bytes = sourceBytes ?? (await original());
  const l = layout(bytes);
  const rdata = l.section('.rdata');
  const data = l.section('.data');
  const text = l.section('.text');
  const tlsRva = rdata.rva + 0x100;
  const actualTemplateRva = templateRva ?? rdata.rva + 0x140;
  const actualIndexRva = indexRva ?? data.rva + 8;
  const actualCallbacksRva = callbacksRva ?? rdata.rva + 0x180;
  l.view.setUint32(l.directory, tlsRva, true);
  l.view.setUint32(l.directory + 4, IMAGE_TLS_DIRECTORY32_SIZE, true);
  const imageBase = l.pe.imageBase;
  l.put32(tlsRva, templateSize ? imageBase + actualTemplateRva : 0);
  l.put32(tlsRva + 4, templateSize ? imageBase + actualTemplateRva + templateSize : 0);
  l.put32(tlsRva + 8, imageBase + actualIndexRva);
  l.put32(tlsRva + 12, callbacksRva === 0 ? 0 : imageBase + actualCallbacksRva);
  l.put32(tlsRva + 16, zeroFill);
  l.put32(tlsRva + 20, alignment);
  if (templateSize)
    l.writeRva(
      actualTemplateRva,
      Array.from({ length: templateSize }, (_, i) => i + 1),
    );
  if (callbacksRva !== 0) {
    for (let i = 0; i < callbackRvas.length; i++)
      l.put32(actualCallbacksRva + i * 4, imageBase + callbackRvas[i]);
    l.put32(actualCallbacksRva + callbackRvas.length * 4, 0);
  }
  return {
    bytes,
    layout: l,
    templateRva: actualTemplateRva,
    indexRva: actualIndexRva,
    callbacksRva: actualCallbacksRva,
    text,
  };
}

async function fixtureWithExpandedText() {
  const source = await original();
  const pe = parsePE(source, { allowDll: true });
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  const optional = peOffset + 24;
  const sectionTable = optional + view.getUint16(peOffset + 20, true);
  const expandedBy = 0x200;
  const bytes = new Uint8Array(source.length + expandedBy);
  bytes.set(source);
  const textIndex = pe.sections.findIndex((section) => section.name === '.text');
  const outView = new DataView(bytes.buffer);
  outView.setUint32(sectionTable + textIndex * 40 + 16, 0x400, true);
  for (let i = textIndex + 1; i < pe.sections.length; i++) {
    const section = pe.sections[i];
    bytes.set(
      source.subarray(section.rawOffset, section.rawOffset + section.rawSize),
      section.rawOffset + expandedBy,
    );
    outView.setUint32(sectionTable + i * 40 + 20, section.rawOffset + expandedBy, true);
  }
  return bytes;
}

test('parses PE32 TLS template, zero fill, writable index, executable callbacks, and alignment', async () => {
  const callbackRvas = [0x1000, 0x1010];
  const { bytes, templateRva, indexRva } = await withTls({
    templateSize: 3,
    zeroFill: 4,
    callbackRvas,
  });
  const pe = parsePE(bytes, { allowDll: true });
  assert.deepEqual(pe.tls, {
    templateRva,
    templateSize: 3,
    zeroFill: 4,
    indexRva,
    callbackRvas,
    alignment: 16,
  });
});

test('accepts mapped TLS template, index, and empty callback array in virtual zero-fill', async () => {
  const { bytes, layout: l } = await withTls({ templateSize: 8, zeroFill: 8 });
  // Extend .data beyond its file-backed raw bytes, leaving these TLS objects
  // backed only by the loader's zero-filled virtual tail.
  l.setVirtualSize('.data', 0x300);
  const zeroDataRva = l.section('.data').rva + 0x280;
  const tlsRva = l.section('.rdata').rva + 0x100;
  const cbRva = zeroDataRva + 0x20;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const imageBase = l.pe.imageBase;
  l.put32(tlsRva, imageBase + zeroDataRva);
  l.put32(tlsRva + 4, imageBase + zeroDataRva + 8);
  l.put32(tlsRva + 8, imageBase + zeroDataRva + 0x10);
  l.put32(tlsRva + 12, imageBase + cbRva);
  const rdata = l.section('.rdata');
  view.setUint32(rdata.rawOffset + 0x100 + 12, imageBase + cbRva, true);
  const parsed = parsePE(bytes, { allowDll: true });
  assert.equal(parsed.tls.templateRva, zeroDataRva);
  assert.equal(parsed.tls.templateSize, 8);
  assert.equal(parsed.tls.indexRva, zeroDataRva + 0x10);
  assert.deepEqual(parsed.tls.callbackRvas, []);
});

test('accepts a null template and omitted callback pointer while requiring a valid index slot', async () => {
  const { bytes, layout: l } = await withTls({ callbacksRva: 0 });
  const tlsRva = l.section('.rdata').rva + 0x100;
  l.put32(tlsRva + 16, 32);
  assert.deepEqual(parsePE(bytes, { allowDll: true }).tls, {
    templateRva: 0,
    templateSize: 0,
    zeroFill: 32,
    indexRva: l.section('.data').rva + 8,
    callbackRvas: [],
    alignment: 16,
  });
});

test('rejects malformed TLS directories, VAs, permissions, alignment, and oversized arrays/data', async () => {
  {
    const { bytes, layout: l } = await withTls();
    l.view.setUint32(l.directory + 4, 23, true);
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS directory/);
  }
  {
    const { bytes, layout: l } = await withTls({ templateSize: 4 });
    const tlsRva = l.section('.rdata').rva + 0x100;
    l.put32(tlsRva + 4, l.pe.imageBase + l.pe.imageSize + 4);
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS template VAs/);
  }
  {
    const { bytes } = await withTls({ indexRva: 0x3000 });
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS index is not in writable/);
  }
  {
    const { bytes, layout: l } = await withTls({ alignment: 15 << 20 });
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS alignment/);
  }
  {
    const { bytes, layout: l } = await withTls({ zeroFill: 0x100001 });
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS data exceeds/);
  }
  {
    const { bytes, layout: l } = await withTls();
    l.put32(l.section('.rdata').rva + 0x100 + 12, l.pe.imageBase + 0x500000);
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS callback array/);
  }
  {
    const { bytes } = await withTls({ callbackRvas: [0x2000] });
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS callback is not in executable/);
  }
  {
    const source = await fixtureWithExpandedText();
    const pe = parsePE(source, { allowDll: true });
    const callbacks = Array.from({ length: 129 }, () => pe.sections[0].rva + 0x10);
    const { bytes, layout: l } = await withTls(
      { callbacksRva: pe.sections[0].rva + 0x100, callbackRvas: callbacks },
      source,
    );
    assert.throws(() => parsePE(bytes, { allowDll: true }), /TLS callback array exceeds/);
  }
});
