// Direct3D 10 shader reflection over a DXBC container.
//
// The RDEF chunk carries the constant buffers, their variables and the bound
// resources; ISGN and OSGN carry the input and output signatures. The layouts
// below are the ones vkd3d-shader's own reflection reads (libs/vkd3d-utils
// /reflection.c), including the RD11 extension block that 5.0 containers add:
//
//   rdef_header   28 bytes   buffer_count, buffers_offset, binding_count,
//                            bindings_offset, minor, major, type, flags, creator
//   rdef_rd11     32 bytes   magic 'RD11', then seven size words
//   rdef_buffer   24 bytes   name, var_count, vars_offset, size, flags, type
//   rdef_variable 40 bytes   name, offset, size, flags, type_offset, default,
//                            resource_binding, resource_count, sampler_binding,
//                            sampler_count   (24 bytes on SM4)
//   rdef_binding  40 bytes   name, type, format, dimension, samples, index,
//                            count, flags, space, id   (32 bytes on SM4)
//
// All offsets are relative to the start of the chunk's body, so the module
// works on a slice that begins with the RDEF payload.

const MAX_CHUNKS = 128;
const MAX_ELEMENTS = 4096;

function invalid(message) {
  throw new Error('Invalid DXBC reflection input: ' + message);
}

function tag(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

export function dxbcChunks(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32 || bytes.byteLength > 1024 * 1024)
    invalid('container length is out of range');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== 'DXBC') invalid('container signature is missing');
  if (view.getUint32(24, true) !== bytes.byteLength)
    invalid('declared container size does not match the input');
  const count = view.getUint32(28, true);
  if (count > MAX_CHUNKS) invalid('chunk count exceeds the limit');
  if (32 + count * 4 > bytes.byteLength) invalid('chunk offset table is truncated');
  const chunks = new Map();
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(32 + i * 4, true);
    if (offset % 4 || offset + 8 > bytes.byteLength) invalid(`chunk ${i} offset is invalid`);
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > bytes.byteLength) invalid(`chunk ${i} body is truncated`);
    const name = tag(bytes, offset);
    if (!chunks.has(name)) chunks.set(name, bytes.subarray(offset + 8, offset + 8 + size));
  }
  return chunks;
}

/**
 * Parses a DXBC container into the description shape ID3D10ShaderReflection
 * publishes: `{ version, creator, flags, instructionCount, constantBuffers,
 * variables, bindings, inputs, outputs }`. Strings are plain JavaScript
 * strings; the caller interns them into guest memory.
 */
export function reflectShader(bytes) {
  const chunks = dxbcChunks(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = {
    version: view.getUint32(4, true),
    creator: '',
    flags: 0,
    instructionCount: 0,
    constantBuffers: [],
    variables: [],
    bindings: [],
    inputs: [],
    outputs: [],
  };
  const rdef = chunks.get('RDEF');
  if (rdef) readRdef(rdef, result);
  const sgn = (name) => {
    const body = chunks.get(name);
    return body ? readSignature(body) : [];
  };
  result.inputs = sgn('ISGN');
  result.outputs = sgn('OSGN');
  return result;
}

function readRdef(body, result) {
  if (body.byteLength < 28) invalid('RDEF header is truncated');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const u32 = (offset) => {
    if (offset + 4 > body.byteLength) invalid('RDEF field is out of bounds');
    return view.getUint32(offset, true);
  };
  const bufferCount = u32(0);
  const buffersOffset = u32(4);
  const bindingCount = u32(8);
  const bindingsOffset = u32(12);
  const majorVersion = body[17];
  const minorVersion = body[16];
  result.flags = u32(20);
  const creatorOffset = u32(24);
  result.version = ((majorVersion << 4) | minorVersion) >>> 0;
  if (creatorOffset) result.creator = readString(body, creatorOffset);

  let variableSize = 24;
  let bindingSize = 32;
  if (majorVersion >= 5) {
    if (body.byteLength < 60) invalid('RDEF RD11 block is truncated');
    if (tag(body, 28) !== 'RD11') invalid('RD11 magic is missing');
    // The RD11 block starts right after the 28-byte header: magic, header_size,
    // buffer_size, binding_size, variable_size, type_size, field_size, zero.
    bindingSize = u32(28 + 12);
    variableSize = u32(28 + 16);
    if (variableSize !== 40 && variableSize !== 24) invalid('unexpected variable size');
    if (bindingSize !== 40 && bindingSize !== 32) invalid('unexpected binding size');
  }
  if (bufferCount > MAX_ELEMENTS || bindingCount > MAX_ELEMENTS)
    invalid('RDEF element count exceeds the limit');

  for (let i = 0; i < bufferCount; i++) {
    const base = buffersOffset + i * 24;
    const name = readString(body, u32(base));
    const varCount = u32(base + 4);
    const varsOffset = u32(base + 8);
    const size = u32(base + 12);
    if (varCount > MAX_ELEMENTS) invalid('constant buffer variable count exceeds the limit');
    result.constantBuffers.push({ name, size });
    const variables = [];
    for (let v = 0; v < varCount; v++) {
      const record = varsOffset + v * variableSize;
      variables.push({
        name: readString(body, u32(record)),
        offset: u32(record + 4),
        size: u32(record + 8),
      });
    }
    result.variables.push(variables);
  }

  for (let i = 0; i < bindingCount; i++) {
    const base = bindingsOffset + i * bindingSize;
    result.bindings.push({
      name: readString(body, u32(base)),
      type: u32(base + 4),
      returnType: u32(base + 8),
      dimension: u32(base + 12),
      numSamples: u32(base + 16),
      bindPoint: u32(base + 20),
      bindCount: u32(base + 24),
      flags: u32(base + 28),
    });
  }
}

// ISGN/OSGN: { count, header_size } then 24-byte elements of
// { name_offset, semantic_index, system_value_type, component_type, register,
//   mask, read_write_mask, stream, padding }.
function readSignature(body) {
  if (body.byteLength < 8) invalid('signature header is truncated');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(0, true);
  const headerSize = view.getUint32(4, true);
  if (count > MAX_ELEMENTS || headerSize < 8 || headerSize % 4)
    invalid('signature header is invalid');
  if (headerSize + count * 24 > body.byteLength) invalid('signature elements are truncated');
  const elements = [];
  for (let i = 0; i < count; i++) {
    const record = headerSize + i * 24;
    elements.push({
      name: readString(body, view.getUint32(record, true)),
      semanticIndex: view.getUint32(record + 4, true),
      systemValue: view.getUint32(record + 8, true),
      componentType: view.getUint32(record + 12, true),
      register: view.getUint32(record + 16, true),
      mask: body[record + 20],
      readWriteMask: body[record + 21],
    });
  }
  return elements;
}

function readString(body, offset) {
  if (!offset || offset >= body.byteLength) invalid('string offset is out of bounds');
  let end = offset;
  while (end < body.byteLength && body[end] !== 0 && end - offset <= 4096) end++;
  if (end >= body.byteLength || body[end] !== 0) invalid('string is not terminated');
  return new TextDecoder().decode(body.subarray(offset, end));
}

/**
 * Builds the minimal DXBC container the input-signature blob entry point
 * returns: a 'DXBC' header with one ISGN chunk and no program. A real D3D10
 * CreateInputLayout accepts it because the container only has to carry the
 * signature.
 */
export function inputSignatureContainer(bytes) {
  const body = dxbcChunks(bytes).get('ISGN');
  if (!body) invalid('the shader has no ISGN chunk');
  const size = 32 + 4 + 8 + body.byteLength;
  const total = Math.ceil(size / 4) * 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('DXBC'), 0);
  view.setUint32(20, 1, true);
  view.setUint32(24, total, true);
  view.setUint32(28, 1, true);
  view.setUint32(32, 36, true);
  out.set(new TextEncoder().encode('ISGN'), 36);
  view.setUint32(40, body.byteLength, true);
  out.set(body, 44);
  return out;
}
