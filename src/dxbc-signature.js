const MAX_DXBC_BYTES = 1024 * 1024;
const MAX_CHUNKS = 128;
const MAX_SIGNATURE_ELEMENTS = 128;
const ISGN_ENTRY_BYTES = 24;

function fail(message) {
  throw new Error(`Invalid or unsupported DXBC input signature: ${message}`);
}

function need(bytes, offset, length, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.byteLength
  )
    fail(`${label} is out of bounds`);
}

function u32(view, bytes, offset, label) {
  need(bytes, offset, 4, label);
  return view.getUint32(offset, true);
}

function tag(bytes, offset) {
  need(bytes, offset, 4, 'chunk tag');
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function semanticString(bytes, offset, limit, floor) {
  if (offset < floor || offset >= limit) fail('semantic name offset is outside the ISGN chunk');
  let end = offset;
  while (end < limit && bytes[end] !== 0 && end - offset <= 127) end++;
  if (end >= limit || bytes[end] !== 0) fail('semantic name is not bounded and terminated');
  let name = '';
  for (let i = offset; i < end; i++) {
    const byte = bytes[i];
    if (byte > 0x7f) fail('semantic name is not ASCII');
    name += String.fromCharCode(byte);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail('semantic name is empty or invalid');
  return name;
}

/**
 * Reflects the legacy SM4/5 ISGN input signature in a DXBC container.
 * Container checksums are intentionally left to the shader compiler.
 */
export function reflectDXBCInputSignature(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('input must be a Uint8Array');
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_DXBC_BYTES)
    fail(`container length must be 32..${MAX_DXBC_BYTES} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== 'DXBC') fail('container signature is missing');
  const totalSize = u32(view, bytes, 24, 'container size');
  if (totalSize !== bytes.byteLength) fail('declared container size does not match input');
  const chunkCount = u32(view, bytes, 28, 'chunk count');
  if (chunkCount > MAX_CHUNKS) fail('chunk count exceeds limit');
  const tableEnd = 32 + chunkCount * 4;
  need(bytes, 32, chunkCount * 4, 'chunk offset table');

  const chunks = [];
  let signature = null;
  for (let i = 0; i < chunkCount; i++) {
    const offset = u32(view, bytes, 32 + i * 4, `chunk ${i} offset`);
    if (offset % 4 || offset < tableEnd) fail(`chunk ${i} offset is invalid`);
    need(bytes, offset, 8, `chunk ${i} header`);
    const size = u32(view, bytes, offset + 4, `chunk ${i} size`);
    need(bytes, offset + 8, size, `chunk ${i} body`);
    const end = offset + 8 + size;
    for (const prior of chunks)
      if (offset < prior.end && prior.offset < end) fail('chunk ranges overlap or repeat');
    const kind = tag(bytes, offset);
    chunks.push({ offset, end });
    if (kind === 'ISG1') fail('ISG1 input signatures are unsupported');
    if (kind === 'ISGN') {
      if (signature) fail('multiple ISGN chunks are unsupported');
      signature = { offset: offset + 8, size };
    }
  }
  if (!signature) fail('ISGN chunk is missing');

  const start = signature.offset;
  const limit = start + signature.size;
  need(bytes, start, 8, 'ISGN header');
  const count = u32(view, bytes, start, 'ISGN element count');
  const headerSize = u32(view, bytes, start + 4, 'ISGN header size');
  if (count > MAX_SIGNATURE_ELEMENTS) fail('ISGN element count exceeds limit');
  if (headerSize < 8 || headerSize % 4) fail('ISGN header size is invalid');
  const recordsStart = start + headerSize;
  const recordsBytes = count * ISGN_ENTRY_BYTES;
  need(bytes, recordsStart, recordsBytes, 'ISGN records');
  if (recordsStart + recordsBytes > limit) fail('ISGN records exceed chunk bounds');
  const seen = new Set();
  const elements = [];

  for (let i = 0; i < count; i++) {
    const record = recordsStart + i * ISGN_ENTRY_BYTES;
    const nameOffset = u32(view, bytes, record, `ISGN element ${i} name offset`);
    const semanticName = semanticString(bytes, start + nameOffset, limit, start);
    const semanticIndex = u32(view, bytes, record + 4, `ISGN element ${i} semantic index`);
    const systemValue = u32(view, bytes, record + 8, `ISGN element ${i} system value`);
    const componentType = u32(view, bytes, record + 12, `ISGN element ${i} component type`);
    const register = u32(view, bytes, record + 16, `ISGN element ${i} register`);
    const packedMask = u32(view, bytes, record + 20, `ISGN element ${i} mask`);
    const mask = packedMask & 0xff;
    const usedMask = (packedMask >>> 8) & 0xff;
    if (componentType > 3) fail(`ISGN element ${i} has unsupported component type`);
    if ((packedMask & 0xffff0000) !== 0 || !mask || mask & ~0x0f || usedMask & ~mask)
      fail(`ISGN element ${i} has invalid component masks`);
    const key = `${semanticName.toUpperCase()}\0${semanticIndex}`;
    if (seen.has(key)) fail(`duplicate semantic ${semanticName}${semanticIndex}`);
    seen.add(key);
    elements.push({ semanticName, semanticIndex, register, mask, usedMask, systemValue });
  }
  return elements;
}
