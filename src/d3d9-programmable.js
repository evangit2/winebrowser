const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const MAX_SHADER_BYTES = 1024 * 1024;

const SHADER_METHODS = 'QueryInterface AddRef Release GetDevice GetFunction'.split(' ');
const DECLARATION_METHODS = 'QueryInterface AddRef Release GetDevice GetDeclaration'.split(' ');
const IIDS = {
  vertex: 'efc5557e-6265-4613-8a94-43857889eb36',
  pixel: '6d3bdbdc-5b02-4415-b852-ce5e8bccb289',
  declaration: 'dd13c59c-36fa-4098-a8fb-c7ed39dc8546',
};
const NAMES = {
  vertex: 'IDirect3DVertexShader9',
  pixel: 'IDirect3DPixelShader9',
  declaration: 'IDirect3DVertexDeclaration9',
};

export async function releaseComReference(object) {
  if (!object.refs) throw Error(`Released COM object ${object.name}`);
  object.refs--;
  if (!object.refs) await object.onRelease?.(object);
  return object.refs;
}

// SM1 encodes operand counts in the opcode rather than the instruction token.
// Other opcodes fail explicitly during shader creation.
const SM1_OPERANDS = new Map([
  [0, 0],
  [1, 2],
  [2, 3],
  [3, 3],
  [4, 4],
  [5, 3],
  [6, 2],
  [7, 2],
  [8, 3],
  [9, 3],
  [10, 3],
  [11, 3],
  [12, 3],
  [13, 3],
  [14, 2],
  [15, 2],
  [16, 2],
  [17, 3],
  [18, 4],
  [19, 2],
  [20, 3],
  [21, 3],
  [22, 3],
  [23, 3],
  [24, 3],
  [31, 2],
  [78, 2],
  [79, 2],
  [81, 5],
]);

function instructionOperands(token, major) {
  const opcode = token & 0xffff;
  if (opcode === 0xfffe) return { opcode, operands: (token >>> 16) & 0x7fff, comment: true };
  const operands = major >= 2 ? (token >>> 24) & 0xf : SM1_OPERANDS.get(opcode);
  if (operands === undefined)
    throw Error(`Unsupported D3D9 SM${major} shader opcode 0x${opcode.toString(16)}`);
  return { opcode, operands, comment: false };
}

function walkWords(words, visit) {
  const major = (words[0] >>> 8) & 0xff;
  for (let index = 1; index < words.length;) {
    const token = words[index];
    if (token === 0xffff) return;
    const instruction = instructionOperands(token, major);
    if (index + 1 + instruction.operands > words.length)
      throw Error('Truncated D3D9 shader instruction');
    if (!instruction.comment) visit(instruction, words, index);
    index += 1 + instruction.operands;
  }
  throw Error('D3D9 shader END token is missing');
}

function shaderTokens(runtime, pointer, stage) {
  pointer >>>= 0;
  runtime.check(pointer, 8);
  const version = runtime.read32(pointer) >>> 0;
  const marker = version >>> 16;
  const major = (version >>> 8) & 0xff;
  const minor = version & 0xff;
  const valid =
    stage === 'vertex'
      ? marker === 0xfffe &&
        ((major === 1 && minor === 1) || ((major === 2 || major === 3) && minor === 0))
      : marker === 0xffff &&
        ((major === 1 && minor <= 4) || ((major === 2 || major === 3) && minor === 0));
  if (!valid) throw Error(`Unsupported D3D9 ${stage} shader version`);
  const words = [version];
  let offset = 4;
  while (offset < MAX_SHADER_BYTES) {
    runtime.check(pointer + offset, 4);
    const token = runtime.read32(pointer + offset) >>> 0;
    words.push(token);
    offset += 4;
    if (token === 0xffff) return new Uint8Array(new Uint32Array(words).buffer);
    const { operands } = instructionOperands(token, major);
    const operandBytes = operands * 4;
    if (offset + operandBytes > MAX_SHADER_BYTES)
      throw Error('D3D9 shader exceeds the bytecode limit');
    runtime.check(pointer + offset, operandBytes);
    for (let i = 0; i < operands; i++) words.push(runtime.read32(pointer + offset + i * 4) >>> 0);
    offset += operandBytes;
  }
  throw Error('D3D9 shader exceeds the bytecode limit');
}

export function parseVertexDeclaration(runtime, pointer) {
  const elements = [];
  for (let i = 0; i < 16; i++) {
    const p = (pointer >>> 0) + i * 8;
    runtime.check(p, 8);
    const stream = runtime.view.getUint16(p, true);
    if (stream === 0xff) {
      if (
        runtime.view.getUint16(p + 2, true) ||
        runtime.data[p + 4] !== 17 ||
        runtime.data[p + 5] ||
        runtime.data[p + 6] ||
        runtime.data[p + 7]
      )
        throw Error('Invalid D3D9 vertex declaration terminator');
      if (!elements.length) throw Error('Empty D3D9 vertex declaration');
      return elements;
    }
    const offset = runtime.view.getUint16(p + 2, true);
    const type = runtime.data[p + 4];
    const method = runtime.data[p + 5];
    const usage = runtime.data[p + 6];
    const usageIndex = runtime.data[p + 7];
    const info = {
      0: ['float32', 4],
      1: ['float32x2', 8],
      2: ['float32x3', 12],
      3: ['float32x4', 16],
      4: ['unorm8x4', 4],
    }[type];
    if (stream || method || !info || offset % 4 || usageIndex > 15)
      throw Error('Unsupported D3D9 vertex declaration element');
    if (elements.some((entry) => entry.usage === usage && entry.usageIndex === usageIndex))
      throw Error('Duplicate D3D9 vertex declaration semantic');
    elements.push({ offset, format: info[0], size: info[1], type, usage, usageIndex });
  }
  throw Error('D3D9 vertex declaration has no terminator');
}

function vertexInputs(bytes) {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const inputs = [];
  walkWords(words, ({ opcode, operands }, tokens, index) => {
    if (opcode !== 31) return;
    if (operands !== 2) throw Error('Invalid D3D9 vertex shader input declaration');
    const semantic = tokens[index + 1];
    const registerToken = tokens[index + 2];
    const register = registerToken & 0x7ff;
    if ((registerToken & 0x70000000) !== 0x10000000 || register > 15)
      throw Error('Unsupported D3D9 vertex shader input declaration');
    inputs.push({ usage: semantic & 0x1f, usageIndex: (semantic >>> 16) & 0xf, register });
  });
  return inputs;
}

function deviceMethod(device) {
  return {
    argc: 2,
    invoke(runtime, argument) {
      const out = argument(1) >>> 0;
      runtime.check(out, 4, true);
      if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
      device.refs++;
      runtime.write32(out, device.pointer);
      return D3D_OK;
    },
  };
}

function functionMethod(bytes) {
  return {
    argc: 3,
    invoke(runtime, argument) {
      const destination = argument(1) >>> 0;
      const sizePointer = argument(2) >>> 0;
      runtime.check(sizePointer, 4, true);
      if (!destination) {
        runtime.write32(sizePointer, bytes.length);
        return D3D_OK;
      }
      if (runtime.read32(sizePointer) >>> 0 < bytes.length) return D3DERR_INVALIDCALL;
      runtime.check(destination, bytes.length, true);
      runtime.data.set(bytes, destination);
      runtime.write32(sizePointer, bytes.length);
      return D3D_OK;
    },
  };
}

function declarationMethod(elements) {
  const bytes = declarationBytes(elements);
  return {
    argc: 3,
    invoke(runtime, argument) {
      const destination = argument(1) >>> 0;
      const countPointer = argument(2) >>> 0;
      runtime.check(countPointer, 4, true);
      const count = elements.length + 1;
      if (!destination) {
        runtime.write32(countPointer, count);
        return D3D_OK;
      }
      if (runtime.read32(countPointer) >>> 0 < count) return D3DERR_INVALIDCALL;
      runtime.check(destination, bytes.length, true);
      runtime.data.set(bytes, destination);
      runtime.write32(countPointer, count);
      return D3D_OK;
    },
  };
}

function declarationBytes(elements) {
  const bytes = new Uint8Array((elements.length + 1) * 8);
  const view = new DataView(bytes.buffer);
  elements.forEach((element, index) => {
    const p = index * 8;
    view.setUint16(p, 0, true);
    view.setUint16(p + 2, element.offset, true);
    bytes[p + 4] = element.type;
    bytes[p + 5] = 0;
    bytes[p + 6] = element.usage;
    bytes[p + 7] = element.usageIndex;
  });
  const end = elements.length * 8;
  view.setUint16(end, 0xff, true);
  bytes[end + 4] = 17;
  return bytes;
}

export function createShaderObject(runtime, device, pointer, stage) {
  const bytes = shaderTokens(runtime, pointer, stage);
  if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
  device.refs++;
  try {
    return runtime.comObjects.create({
      name: NAMES[stage],
      iid: IIDS[stage],
      methodNames: SHADER_METHODS,
      methods: { 3: deviceMethod(device), 4: functionMethod(bytes) },
      state: {
        device,
        stage,
        bytes,
        inputs: stage === 'vertex' ? vertexInputs(bytes) : [],
        internalRefs: 0,
      },
      onRelease: () => releaseComReference(device),
    });
  } catch (error) {
    device.refs--;
    throw error;
  }
}

export function createDeclarationObject(runtime, device, pointer) {
  const elements = parseVertexDeclaration(runtime, pointer);
  if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
  device.refs++;
  try {
    return runtime.comObjects.create({
      name: NAMES.declaration,
      iid: IIDS.declaration,
      methodNames: DECLARATION_METHODS,
      methods: { 3: deviceMethod(device), 4: declarationMethod(elements) },
      state: { device, elements, internalRefs: 0 },
      onRelease: () => releaseComReference(device),
    });
  } catch (error) {
    device.refs--;
    throw error;
  }
}

export function bindObject(runtime, device, field, pointer, name) {
  const previous = device.state[field];
  let next = null;
  if (pointer) {
    next = runtime.comObjects.objects.get(pointer >>> 0);
    if (!next || !next.refs || next.name !== name || next.state.device !== device)
      return D3DERR_INVALIDCALL;
  }
  if (next === previous) return D3D_OK;
  if (next) {
    if (next.state.internalRefs >= 0x7fffffff) throw Error(`${name} binding limit exceeded`);
    next.state.internalRefs++;
  }
  if (previous) previous.state.internalRefs--;
  device.state[field] = next;
  return D3D_OK;
}

export function getBoundObject(runtime, device, field, output) {
  output >>>= 0;
  runtime.check(output, 4, true);
  const value = device.state[field];
  if (value) {
    if (!value.refs && !value.state.internalRefs) throw Error('D3D9 bound object has no owner');
    if (value.refs >= 0x7fffffff) throw Error('D3D9 object reference limit exceeded');
    if (!value.refs) {
      if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
      device.refs++;
    }
    value.refs++;
  }
  runtime.write32(output, value?.pointer ?? 0);
  return D3D_OK;
}

export function setFloatConstants(runtime, state, start, pointer, count, limit) {
  start >>>= 0;
  pointer >>>= 0;
  count >>>= 0;
  if (!count || start >= limit || count > limit - start) return D3DERR_INVALIDCALL;
  runtime.check(pointer, count * 16);
  for (let i = 0; i < count * 4; i++) {
    const value = runtime.view.getFloat32(pointer + i * 4, true);
    if (!Number.isFinite(value)) throw Error('Unsupported D3D9 non-finite shader constant');
    state[start * 4 + i] = value;
  }
  return D3D_OK;
}

export function getFloatConstants(runtime, state, start, pointer, count, limit) {
  start >>>= 0;
  pointer >>>= 0;
  count >>>= 0;
  if (!count || start >= limit || count > limit - start) return D3DERR_INVALIDCALL;
  runtime.check(pointer, count * 16, true);
  for (let i = 0; i < count * 4; i++)
    runtime.view.setFloat32(pointer + i * 4, state[start * 4 + i], true);
  return D3D_OK;
}

export function programmableDraw(runtime, state, pointer, stride, vertexCount) {
  const vertex = state.vertexShader;
  const pixel = state.pixelShader;
  const declaration = state.vertexDeclaration;
  if (!vertex && !pixel && !declaration) return null;
  if (!vertex || !pixel || !declaration)
    throw Error('Programmable D3D9 draw requires vertex declaration and both shaders');
  const inputs = vertex.state.inputs;
  const attributes = declaration.state.elements.map((element) => {
    const input = inputs.find(
      (entry) => entry.usage === element.usage && entry.usageIndex === element.usageIndex,
    );
    if (!input) throw Error('D3D9 declaration does not match vertex shader inputs');
    return {
      shaderLocation: input.register,
      offset: element.offset,
      format: element.format,
      d3dColor: element.type === 4,
      size: element.size,
    };
  });
  if (inputs.length !== attributes.length || attributes.some((a) => a.offset + a.size > stride))
    throw Error('D3D9 declaration does not cover the vertex shader inputs');
  const size = vertexCount * stride;
  runtime.check(pointer, size);
  const vertices = runtime.data.slice(pointer, pointer + size);
  for (const attribute of attributes)
    if (attribute.d3dColor)
      for (let offset = attribute.offset; offset < vertices.length; offset += stride)
        [vertices[offset], vertices[offset + 2]] = [vertices[offset + 2], vertices[offset]];
  return {
    type: 'draw-programmable',
    vertices,
    vertexCount,
    stride,
    attributes: attributes.map(({ d3dColor: _ignored, size: _size, ...attribute }) => attribute),
    vertexShader: vertex.state.bytes.slice(),
    pixelShader: pixel.state.bytes.slice(),
    vertexShaderId: vertex.pointer,
    pixelShaderId: pixel.pointer,
    vertexConstants: state.vertexConstants.slice(),
    pixelConstants: state.pixelConstants.slice(),
    depthTest: state.depthTest,
    depthWrite: state.depthWrite,
    cullMode: state.cullMode,
    payloadBytes:
      vertices.length +
      vertex.state.bytes.length +
      pixel.state.bytes.length +
      state.vertexConstants.byteLength +
      state.pixelConstants.byteLength,
  };
}
