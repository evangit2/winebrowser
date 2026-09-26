import { getBoundObject, releaseComReference } from './d3d9-programmable.js';
import { fvfLayout } from './d3d-fvf.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_VERTICES = 65535;
const D3DPT_TRIANGLELIST = 4;
const D3DPT_TRIANGLESTRIP = 5;
const D3DPT_TRIANGLEFAN = 6;
const D3DUSAGE_WRITEONLY = 0x8;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DLOCK_READONLY = 0x10;
const D3DLOCK_NOSYSLOCK = 0x800;
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DLOCK_DISCARD = 0x2000;

// PE32 COM slot order for IDirect3DVertexBuffer8/9 and the matching index
// interfaces is identical; only the IIDs and the device-level signatures move.
const BUFFER_METHODS =
  'QueryInterface AddRef Release GetDevice SetPrivateData GetPrivateData FreePrivateData SetPriority GetPriority PreLoad GetType Lock Unlock GetDesc'.split(
    ' ',
  );

const BUFFER_INFO = {
  vertex: {
    name9: 'IDirect3DVertexBuffer9',
    iid9: 'b64bb1b5-fd70-4df6-bf91-19d0a12455e3',
    name8: 'IDirect3DVertexBuffer8',
    iid8: '8aeeeac7-05f9-44d4-b591-000b0df1cb95',
    resourceType: 6,
  },
  index: {
    name9: 'IDirect3DIndexBuffer9',
    iid9: '7c9dd65e-d3f7-4529-acee-785830acde35',
    name8: 'IDirect3DIndexBuffer8',
    iid8: '0e689c9a-053d-44a0-9d92-db0e3d750f86',
    resourceType: 7,
  },
};

export function bufferInterface(kind, version) {
  const info = BUFFER_INFO[kind];
  if (!info) throw Error('Invalid D3D9 buffer kind');
  return version === 8
    ? { name: info.name8, iid: info.iid8 }
    : { name: info.name9, iid: info.iid9 };
}

function deviceMethod(device) {
  return {
    argc: 2,
    invoke(runtime, argument) {
      const output = argument(1) >>> 0;
      runtime.check(output, 4, true);
      if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
      device.refs++;
      runtime.write32(output, device.pointer);
      return D3D_OK;
    },
  };
}

function lockMethod() {
  return {
    // Lock(OffsetToLock, SizeToLock, ppbData, Flags) plus the this pointer.
    argc: 5,
    invoke(runtime, argument, object) {
      const state = object.state;
      const offset = argument(1) >>> 0;
      const requestedSize = argument(2) >>> 0;
      const output = argument(3) >>> 0;
      const flags = argument(4) >>> 0;
      runtime.check(output, 4, true);
      runtime.write32(output, 0);
      if (state.locked || offset >= state.size) return D3DERR_INVALIDCALL;
      const size = requestedSize || state.size - offset;
      if (size > state.size - offset) return D3DERR_INVALIDCALL;
      const allowed = D3DLOCK_READONLY | D3DLOCK_NOSYSLOCK | D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD;
      if (
        flags & ~allowed ||
        (flags & D3DLOCK_READONLY && state.usage & D3DUSAGE_WRITEONLY) ||
        (flags & (D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD) && !(state.usage & D3DUSAGE_DYNAMIC)) ||
        (flags & D3DLOCK_NOOVERWRITE && flags & D3DLOCK_DISCARD) ||
        (flags & D3DLOCK_DISCARD && (offset || size !== state.size))
      )
        throw Error(`Unsupported ${object.name}.Lock flags or range`);
      state.locked = { offset, size, flags };
      runtime.write32(output, state.address + offset);
      return D3D_OK;
    },
  };
}

function descMethod(kind) {
  return {
    argc: 2,
    invoke(runtime, argument, object) {
      const output = argument(1) >>> 0;
      const state = object.state;
      const size = kind === 'vertex' ? 24 : 20;
      runtime.check(output, size, true);
      runtime.data.fill(0, output, output + size);
      // D3DFMT_VERTEXDATA for vertex buffers; the index format otherwise.
      runtime.write32(output, kind === 'vertex' ? 100 : state.format);
      runtime.write32(output + 4, BUFFER_INFO[kind].resourceType);
      runtime.write32(output + 8, state.usage);
      runtime.write32(output + 12, state.pool);
      runtime.write32(output + 16, state.size);
      if (kind === 'vertex') runtime.write32(output + 20, state.fvf);
      return D3D_OK;
    },
  };
}

function bufferMethods(device, kind) {
  return {
    3: deviceMethod(device),
    7: {
      argc: 2,
      invoke(_runtime, argument, object) {
        const previous = object.state.priority;
        object.state.priority = argument(1) >>> 0;
        return previous;
      },
    },
    8: { argc: 1, invoke: (_runtime, _argument, object) => object.state.priority },
    9: { argc: 1, invoke: () => D3D_OK },
    10: { argc: 1, invoke: () => BUFFER_INFO[kind].resourceType },
    11: lockMethod(),
    12: {
      argc: 1,
      invoke(_runtime, _argument, object) {
        if (!object.state.locked) return D3DERR_INVALIDCALL;
        object.state.locked = null;
        return D3D_OK;
      },
    },
    13: descMethod(kind),
  };
}

export function createBufferObject(runtime, device, kind, version, options) {
  const info = BUFFER_INFO[kind];
  if (!info) throw Error('Invalid D3D9 buffer kind');
  const size = options.size >>> 0;
  const usage = options.usage >>> 0;
  const pool = options.pool >>> 0;
  if (!size || size > MAX_BUFFER_BYTES) throw Error('Unsupported D3D9 buffer size');
  if (usage & ~(D3DUSAGE_WRITEONLY | D3DUSAGE_DYNAMIC))
    throw Error(`Unsupported ${bufferInterface(kind, version).name} usage 0x${usage.toString(16)}`);
  if (pool > 1 || (usage & D3DUSAGE_DYNAMIC && pool !== 0))
    throw Error(`Unsupported ${bufferInterface(kind, version).name} pool ${pool}`);
  const fvf = options.fvf >>> 0;
  if (kind === 'vertex' && fvf && !fvfLayout(fvf))
    throw Error(`Unsupported ${bufferInterface(kind, version).name} FVF 0x${fvf.toString(16)}`);
  const format = options.format >>> 0;
  if (kind === 'index' && ![101, 102].includes(format))
    throw Error(`Unsupported D3D9 index format ${format}`);
  const width = kind === 'index' ? (format === 101 ? 2 : 4) : 0;
  if (width && size % width) return D3DERR_INVALIDCALL;
  if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
  const address = runtime.allocate(size);
  runtime.data.fill(0, address, address + size);
  device.refs++;
  const { name, iid } = bufferInterface(kind, version);
  try {
    return runtime.comObjects.create({
      name,
      iid,
      methodNames: BUFFER_METHODS,
      methods: bufferMethods(device, kind),
      state: {
        device,
        kind,
        address,
        size,
        usage,
        pool,
        fvf,
        format,
        width,
        priority: 0,
        locked: null,
        internalRefs: 0,
      },
      onRelease: () => releaseComReference(device),
    });
  } catch (error) {
    device.refs--;
    throw error;
  }
}

function bufferObject(runtime, device, pointer, kind, version) {
  const object = runtime.comObjects.objects.get(pointer >>> 0);
  const { name } = bufferInterface(kind, version);
  if (!object || !object.refs || object.name !== name || object.state.device !== device)
    return null;
  return object;
}

function createBufferMethod(kind, version) {
  return {
    // CreateVertexBuffer/IndexBuffer(Length, Usage, FVF|Format, Pool, **out
    // [, pSharedHandle]). argument(0) is the interface `this` pointer, so the
    // output pointer is argument(5) and argc counts `this`.
    argc: version === 8 ? 6 : 7,
    invoke(runtime, argument, device) {
      const output = argument(5) >>> 0;
      if (version === 9 && argument(6)) return D3DERR_INVALIDCALL;
      runtime.check(output, 4, true);
      runtime.write32(output, 0);
      const object = createBufferObject(runtime, device, kind, version, {
        size: argument(1) >>> 0,
        usage: argument(2) >>> 0,
        fvf: kind === 'vertex' ? argument(3) >>> 0 : 0,
        format: kind === 'index' ? argument(3) >>> 0 : 0,
        pool: argument(4) >>> 0,
      });
      if (typeof object === 'number') return object;
      runtime.write32(output, object.pointer);
      return D3D_OK;
    },
  };
}

export const createVertexBufferMethod = (version) => createBufferMethod('vertex', version);
export const createIndexBufferMethod = (version) => createBufferMethod('index', version);

export function setStreamSource(runtime, device, version, argument) {
  if (argument(1) >>> 0 !== 0) throw Error(`Unsupported D3D9 vertex stream ${argument(1)}`);
  const pointer = argument(2) >>> 0;
  const offset = version === 8 ? 0 : argument(3) >>> 0;
  // D3D9 inserts OffsetInBytes before Stride; D3D8 has no per-stream offset.
  const stride = argument(version === 8 ? 3 : 4) >>> 0;
  const previous = device.state.streamSource;
  if (!pointer) {
    if (offset || stride) return D3DERR_INVALIDCALL;
    if (previous) previous.object.state.internalRefs--;
    device.state.streamSource = null;
    return D3D_OK;
  }
  const object = bufferObject(runtime, device, pointer, 'vertex', version);
  if (!object) return D3DERR_INVALIDCALL;
  if (offset % 4 || offset >= object.state.size || stride < 4 || stride > 256 || stride % 4)
    return D3DERR_INVALIDCALL;
  if (previous?.object !== object) {
    if (object.state.internalRefs >= 0x7fffffff)
      throw Error('IDirect3DVertexBuffer9 binding limit exceeded');
    object.state.internalRefs++;
    if (previous) previous.object.state.internalRefs--;
  }
  device.state.streamSource = { object, offset, stride };
  return D3D_OK;
}

export function getStreamSource(runtime, device, version, argument) {
  if (argument(1) >>> 0 !== 0) throw Error(`Unsupported D3D9 vertex stream ${argument(1)}`);
  const output = argument(2) >>> 0;
  const offsetOutput = version === 9 ? argument(3) >>> 0 : 0;
  const strideOutput = argument(version === 8 ? 3 : 4) >>> 0;
  runtime.check(output, 4, true);
  if (offsetOutput) runtime.check(offsetOutput, 4, true);
  runtime.check(strideOutput, 4, true);
  const binding = device.state.streamSource;
  if (binding) {
    const object = binding.object;
    if (!object.refs && !object.state.internalRefs) throw Error('D3D9 bound buffer has no owner');
    if (object.refs >= 0x7fffffff) throw Error('D3D9 object reference limit exceeded');
    if (!object.refs) {
      if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
      device.refs++;
    }
    object.refs++;
  }
  runtime.write32(output, binding?.object.pointer ?? 0);
  runtime.write32(strideOutput, binding?.stride ?? 0);
  if (offsetOutput) runtime.write32(offsetOutput, binding?.offset ?? 0);
  return D3D_OK;
}

export function setIndices(runtime, device, version, argument) {
  const pointer = argument(1) >>> 0;
  // D3D8 SetIndices carries a BaseVertexIndex; D3D9 passes it per indexed draw.
  const baseVertex = version === 8 ? argument(2) | 0 : 0;
  const result = pointer ? bufferObject(runtime, device, pointer, 'index', version) : null;
  if (pointer && !result) return D3DERR_INVALIDCALL;
  const previous = device.state.indexBuffer;
  if (result !== previous) {
    if (result) result.state.internalRefs++;
    if (previous) previous.state.internalRefs--;
    device.state.indexBuffer = result;
  }
  device.state.indexBaseVertex = baseVertex;
  return D3D_OK;
}

export function getIndices(runtime, device, version, argument) {
  const output = argument(1) >>> 0;
  runtime.check(output, 4, true);
  const value = device.state.indexBuffer;
  if (value) {
    if (!value.refs && !value.state.internalRefs) throw Error('D3D9 bound buffer has no owner');
    if (value.refs >= 0x7fffffff) throw Error('D3D9 object reference limit exceeded');
    if (!value.refs) {
      if (device.refs >= 0x7fffffff) throw Error('D3D9 device reference limit exceeded');
      device.refs++;
    }
    value.refs++;
  }
  runtime.write32(output, value?.pointer ?? 0);
  if (version === 8) {
    const baseOutput = argument(2) >>> 0;
    runtime.check(baseOutput, 4, true);
    runtime.write32(baseOutput, device.state.indexBaseVertex ?? 0);
  }
  return D3D_OK;
}

// Vertices the draw consumes for a primitive count. Triangle strips and fans
// need count + 2 vertices; expansion to a list happens in the draw builder.
function primitiveVertexCount(primitive, primitiveCount) {
  if (!primitiveCount) throw Error('D3D9 draw requires a positive primitive count');
  const vertexCount =
    primitive === D3DPT_TRIANGLELIST
      ? primitiveCount * 3
      : primitive === D3DPT_TRIANGLESTRIP || primitive === D3DPT_TRIANGLEFAN
        ? primitiveCount + 2
        : 0;
  if (!vertexCount) throw Error(`Unsupported D3D9 primitive type ${primitive}`);
  if (vertexCount > MAX_VERTICES) throw Error('D3D9 vertex count limit exceeded');
  return vertexCount;
}

// Non-indexed buffered draw: copy [startVertex, startVertex + count) from the
// bound stream so the renderer receives an immutable, contiguous snapshot.
export function bufferedVertices(runtime, device, startVertex, primitive, primitiveCount) {
  const vertexCount = primitiveVertexCount(primitive, primitiveCount);
  const binding = device.state.streamSource;
  if (!binding) throw Error('D3D9 buffered draw requires a vertex stream');
  if (binding.object.state.locked)
    throw Error('D3D9 buffered draw requires an unlocked vertex buffer');
  startVertex >>>= 0;
  const { object, offset, stride } = binding;
  const capacity = Math.floor((object.state.size - offset) / stride);
  if (startVertex + vertexCount > capacity)
    throw Error('D3D9 buffered draw exceeds the bound vertex buffer');
  const begin = object.state.address + offset + startVertex * stride;
  return { vertices: runtime.data.slice(begin, begin + vertexCount * stride), stride, vertexCount };
}

export function indexedVertices(runtime, device, primitive, primitiveCount, params) {
  const vertexCount = primitiveVertexCount(primitive, primitiveCount);
  const object = device.state.indexBuffer;
  if (!object) throw Error('D3D9 indexed draw requires an index buffer');
  if (object.state.locked) throw Error('D3D9 indexed draw requires an unlocked index buffer');
  const binding = device.state.streamSource;
  if (!binding) throw Error('D3D9 indexed draw requires a vertex stream');
  if (binding.object.state.locked)
    throw Error('D3D9 indexed draw requires an unlocked vertex buffer');
  const { address, size, width } = object.state;
  const capacity = size / width;
  const startIndex = params.startIndex >>> 0;
  if (startIndex + vertexCount > capacity)
    throw Error('D3D9 indexed draw exceeds the bound index buffer');
  const baseVertex = (params.baseVertex | 0) + (device.state.indexBaseVertex ?? 0);
  const { offset, stride } = binding;
  const streamCapacity = Math.floor((binding.object.state.size - offset) / stride);
  const view = new DataView(runtime.data.buffer, runtime.data.byteOffset, runtime.data.byteLength);
  const out = new Uint8Array(vertexCount * stride);
  const windowStart = params.minVertexIndex >>> 0;
  const windowEnd = windowStart + (params.numVertices >>> 0);
  if (windowEnd > streamCapacity) throw Error('D3D9 indexed draw exceeds the bound vertex window');
  for (let i = 0; i < vertexCount; i++) {
    const raw =
      width === 2
        ? view.getUint16(address + (startIndex + i) * 2, true)
        : view.getUint32(address + (startIndex + i) * 4, true);
    const relative = raw - windowStart;
    if (relative < 0 || relative >= params.numVertices >>> 0)
      throw Error('D3D9 indexed draw references a vertex outside the declared window');
    const vertex = baseVertex + windowStart + relative;
    if (vertex < 0 || vertex >= streamCapacity)
      throw Error('D3D9 indexed draw references a vertex outside the bound stream');
    const source = binding.object.state.address + offset + vertex * stride;
    out.set(runtime.data.subarray(source, source + stride), i * stride);
  }
  return { vertices: out, stride, vertexCount };
}

export function releaseBufferBindings(state) {
  if (state.streamSource) state.streamSource.object.state.internalRefs--;
  state.streamSource = null;
  if (state.indexBuffer) state.indexBuffer.state.internalRefs--;
  state.indexBuffer = null;
  state.indexBaseVertex = 0;
}
