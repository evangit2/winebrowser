// Bounded PE32 D3D12/DXGI bootstrap. Slot order and struct offsets are from
// i686-w64-mingw32 d3d12.h/dxgi.h (MinGW-w64 14.0.0).
import { ComObjects, readGuid } from './com.js';
import { validateIndexSnapshot } from './d3d12-indices.js';
import {
  parseCommittedResourceDescriptor,
  parsePipelineDescriptor,
  parseResourceRange,
} from './d3d12-descriptors.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_NOINTERFACE = 0x80004002;
const MAX_BYTES = 1024 * 1024;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_COMMANDS = 256;
const OBJECT = 'c4fec28f-7966-4e95-9f94-f431cb56c3b8';
const CHILD = '905db94b-a00c-4140-9df5-2b64ca9ea357';
const PAGEABLE = '63ee58fb-1268-4835-86da-f008ce62f0d6';
const COMMAND_LIST = '7116d91c-e7e4-47ce-b8c6-ec8168f437e5';
const iids = {
  device: '189819f1-1db6-4b57-be54-1821339b85f7',
  queue: '0ec870a6-5d7e-4c22-8cfc-5baae07616ed',
  allocator: '6102dee4-af59-4b09-b999-b44d73f09b24',
  list: '5b160d0f-ac1b-4185-8ba8-b3ae42a5a455',
  pipeline: '765a30f3-f624-4c6f-a828-ace948622445',
  root: 'c54a6b66-72df-4ee8-8be5-a946a1429214',
  fence: '0a753dcf-c4d8-4b91-adf6-be5a60d95a76',
  heap: '8efb471d-616c-4f49-90f7-127bb763fa51',
  resource: '696442be-a72e-4059-bc79-5b5c98040fad',
  factory: '770aae78-f26f-4dba-a829-253c83d1b387',
  swapchain: '310d36a0-d2e7-4c0a-aa04-6a9d23b8886a',
  swapchain1: '790a45f7-0d42-4876-983a-0a55cfe6f4aa',
  swapchain2: 'a8be2ac4-199f-4946-b331-79599fb98de7',
  swapchain3: '94d99bdb-f1f8-4ab0-b236-7da0170edab1',
  blob: '8ba5fb08-5195-40e2-ac58-0d989c3a0102',
};
const names = {
  device: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetNodeCount CreateCommandQueue CreateCommandAllocator CreateGraphicsPipelineState CreateComputePipelineState CreateCommandList CheckFeatureSupport CreateDescriptorHeap GetDescriptorHandleIncrementSize CreateRootSignature CreateConstantBufferView CreateShaderResourceView CreateUnorderedAccessView CreateRenderTargetView CreateDepthStencilView CreateSampler CopyDescriptors CopyDescriptorsSimple GetResourceAllocationInfo GetCustomHeapProperties CreateCommittedResource CreateHeap CreatePlacedResource CreateReservedResource CreateSharedHandle OpenSharedHandle OpenSharedHandleByName MakeResident Evict CreateFence GetDeviceRemovedReason GetCopyableFootprints CreateQueryHeap SetStablePowerState CreateCommandSignature GetResourceTiling GetAdapterLuid`,
  queue: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice UpdateTileMappings CopyTileMappings ExecuteCommandLists SetMarker BeginEvent EndEvent Signal Wait GetTimestampFrequency GetClockCalibration GetDesc`,
  allocator: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice Reset`,
  list: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice GetType Close Reset ClearState DrawInstanced DrawIndexedInstanced Dispatch CopyBufferRegion CopyTextureRegion CopyResource CopyTiles ResolveSubresource IASetPrimitiveTopology RSSetViewports RSSetScissorRects OMSetBlendFactor OMSetStencilRef SetPipelineState ResourceBarrier ExecuteBundle SetDescriptorHeaps SetComputeRootSignature SetGraphicsRootSignature SetComputeRootDescriptorTable SetGraphicsRootDescriptorTable SetComputeRoot32BitConstant SetGraphicsRoot32BitConstant SetComputeRoot32BitConstants SetGraphicsRoot32BitConstants SetComputeRootConstantBufferView SetGraphicsRootConstantBufferView SetComputeRootShaderResourceView SetGraphicsRootShaderResourceView SetComputeRootUnorderedAccessView SetGraphicsRootUnorderedAccessView IASetIndexBuffer IASetVertexBuffers SOSetTargets OMSetRenderTargets ClearDepthStencilView ClearRenderTargetView ClearUnorderedAccessViewUint ClearUnorderedAccessViewFloat DiscardResource BeginQuery EndQuery ResolveQueryData SetPredication SetMarker BeginEvent EndEvent ExecuteIndirect`,
  pipeline: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice GetCachedBlob`,
  root: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice`,
  fence: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice GetCompletedValue SetEventOnCompletion Signal`,
  heap: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice GetDesc GetCPUDescriptorHandleForHeapStart GetGPUDescriptorHandleForHeapStart`,
  resource: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice Map Unmap GetDesc GetGPUVirtualAddress WriteToSubresource ReadFromSubresource GetHeapProperties`,
  factory: `QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent EnumAdapters MakeWindowAssociation GetWindowAssociation CreateSwapChain CreateSoftwareAdapter EnumAdapters1 IsCurrent`,
  swapchain: `QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent GetDevice Present GetBuffer SetFullscreenState GetFullscreenState GetDesc ResizeBuffers ResizeTarget GetContainingOutput GetFrameStatistics GetLastPresentCount GetDesc1 GetFullscreenDesc GetHwnd GetCoreWindow Present1 IsTemporaryMonoSupported GetRestrictToOutput SetBackgroundColor GetBackgroundColor SetRotation GetRotation SetSourceSize GetSourceSize SetMaximumFrameLatency GetMaximumFrameLatency GetFrameLatencyWaitableObject SetMatrixTransform GetMatrixTransform GetCurrentBackBufferIndex CheckColorSpaceSupport SetColorSpace1 ResizeBuffers1`,
  blob: `QueryInterface AddRef Release GetBufferPointer GetBufferSize`,
};
const name = {
  device: 'ID3D12Device',
  queue: 'ID3D12CommandQueue',
  allocator: 'ID3D12CommandAllocator',
  list: 'ID3D12GraphicsCommandList',
  pipeline: 'ID3D12PipelineState',
  root: 'ID3D12RootSignature',
  fence: 'ID3D12Fence',
  heap: 'ID3D12DescriptorHeap',
  resource: 'ID3D12Resource',
  factory: 'IDXGIFactory1',
  swapchain: 'IDXGISwapChain',
  blob: 'ID3DBlob',
};
const number = (value) => value >>> 0;
const u32 = (r, p, off = 0) => r.read32(p + off) >>> 0;
const f32 = (r, p, off = 0) => r.view.getFloat32(r.check(p + off, 4), true);
function requireBackend(r) {
  const g = r.graphics12;
  if (
    !g?.createSwapChain ||
    !g?.destroySwapChain ||
    !g?.createPipeline ||
    !g?.destroyPipeline ||
    !g?.execute ||
    !g?.present ||
    !g?.serializeRootSignature ||
    !g?.validateRootSignature
  )
    throw Error('D3D12 graphics backend is unavailable');
  return g;
}
function state(r) {
  r.comObjects ??= new ComObjects(r);
  r.d3d12State ??= { descriptors: new Map(), swapchains: new Set() };
  return r.d3d12State;
}
function object(r, pointer, kind, owner = null) {
  const item = r.comObjects?.objects.get(number(pointer));
  if (!item || !item.refs || item.name !== name[kind] || (owner && item.state.device !== owner))
    throw Error(`Invalid or released ${name[kind]} pointer`);
  return item;
}
function iid(r, ptr, expected) {
  return readGuid(r, number(ptr)) === iids[expected];
}
function output(r, ptr) {
  r.check(number(ptr), 4, true);
  r.write32(number(ptr), 0);
}
function make(r, kind, methods, itemState = {}, parent = null, onRelease = null) {
  if (parent) {
    if (parent.refs >= 0x7fffffff) throw Error('D3D12 parent reference limit exceeded');
    parent.refs++;
  }
  try {
    return r.comObjects.create({
      name: name[kind],
      iid: iids[kind],
      iids:
        kind === 'factory'
          ? ['7b7166ec-21c7-44ae-b21a-c9ae321ae369']
          : kind === 'swapchain'
            ? [iids.swapchain1, iids.swapchain2, iids.swapchain3]
            : kind === 'device'
              ? [OBJECT]
              : parent && kind !== 'swapchain'
                ? [
                    OBJECT,
                    CHILD,
                    ...(['queue', 'allocator', 'pipeline', 'heap', 'fence', 'resource'].includes(
                      kind,
                    )
                      ? [PAGEABLE]
                      : []),
                    ...(kind === 'list' ? [COMMAND_LIST] : []),
                  ]
                : [],
      methodNames: names[kind].split(' '),
      methods,
      state: itemState,
      onRelease: async (item) => {
        await onRelease?.(item);
        if (parent) parent.refs--;
      },
    });
  } catch (error) {
    if (parent) parent.refs--;
    throw error;
  }
}
function bytes(r, ptr, count) {
  if (!count || count > MAX_BYTES) throw Error('D3D12 shader/blob size limit exceeded');
  r.check(ptr, count);
  return r.data.slice(ptr, ptr + count);
}
function add(list, command) {
  if (list.state.closed) throw Error('D3D12 command list is closed');
  if (list.state.commands.length >= MAX_COMMANDS) throw Error('D3D12 command limit exceeded');
  list.state.commands.push(command);
}
function descriptor(r, handle) {
  const entry = state(r).descriptors.get(number(handle));
  if (!entry || !entry.heap.refs) throw Error('Invalid D3D12 descriptor handle');
  return entry;
}
function floatBits(value) {
  const data = new DataView(new ArrayBuffer(4));
  data.setUint32(0, number(value), true);
  return data.getFloat32(0, true);
}
function uploadAt(r, address, size, dev) {
  for (const item of r.comObjects.objects.values()) {
    const s = item.state;
    if (
      item.refs &&
      item.name === name.resource &&
      s.device === dev &&
      s.kind === 'buffer' &&
      address >= s.storage &&
      address + size >= address &&
      address + size <= s.storage + s.size
    )
      return item;
  }
  throw Error('D3D12 buffer view is outside an upload resource');
}
function viewport(r, ptr) {
  r.check(ptr, 24);
  const [x, y, width, height, minDepth, maxDepth] = Array.from({ length: 6 }, (_, i) =>
    f32(r, ptr, i * 4),
  );
  if (
    ![x, y, width, height, minDepth, maxDepth].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    minDepth < 0 ||
    maxDepth > 1 ||
    minDepth > maxDepth
  )
    throw Error('Unsupported D3D12 viewport');
  return { x, y, width, height, minDepth, maxDepth };
}
function scissor(r, ptr) {
  r.check(ptr, 16);
  const [left, top, right, bottom] = Array.from({ length: 4 }, (_, i) =>
    r.view.getInt32(ptr + i * 4, true),
  );
  if (left < 0 || top < 0 || right <= left || bottom <= top)
    throw Error('Unsupported D3D12 scissor rect');
  return { left, top, right, bottom };
}
function recordDraw(r, a, o, indexed) {
  const s = o.state;
  const count = number(a(1)),
    instances = number(a(2)),
    first = number(a(3));
  const baseVertex = indexed ? a(4) | 0 : 0;
  const firstInstance = number(a(indexed ? 5 : 4));
  if (
    !count ||
    count > 65535 ||
    instances !== 1 ||
    first > 0x7fffffff - count ||
    firstInstance > 0x7fffffff - instances ||
    !s.pipeline ||
    !s.root ||
    s.pipeline.state.root !== s.root ||
    !s.viewport ||
    !s.scissor ||
    s.topology !== 4 ||
    !s.target
  )
    throw Error(
      'Unsupported D3D12 ' + (indexed ? 'DrawIndexedInstanced' : 'DrawInstanced') + ' state',
    );
  const pipeline = s.pipeline.state;
  let vertexView = null,
    vertexStride = 0;
  if (pipeline.inputLayout.length) {
    const view = s.vertexBuffer;
    if (
      !view ||
      view.stride !== pipeline.vertexStride ||
      (!indexed && (first + count) * view.stride > view.size)
    )
      throw Error('D3D12 draw exceeds the bound vertex buffer');
    object(r, view.resource.pointer, 'resource', s.device);
    vertexView = view;
    vertexStride = view.stride;
  } else if (s.vertexBuffer) throw Error('D3D12 pipeline has no input layout');
  let indexView = null;
  if (indexed) {
    indexView = s.indexBuffer;
    if (!indexView || (first + count) * indexView.width > indexView.size)
      throw Error('D3D12 draw exceeds the bound index buffer');
    object(r, indexView.resource.pointer, 'resource', s.device);
  }
  if (!!pipeline.depth !== !!s.depthTarget)
    throw Error('D3D12 pipeline depth state does not match bound target');
  const snapshotBytes = (vertexView?.size ?? 0) + (indexView?.size ?? 0);
  if (s.vertexBytes + snapshotBytes > MAX_RESOURCE_BYTES)
    throw Error('D3D12 command list upload snapshot limit exceeded');
  add(o, {
    type: 'draw',
    target: s.target.pointer,
    pipeline: s.pipeline.pointer,
    viewport: { ...s.viewport },
    scissor: { ...s.scissor },
    ...(indexed
      ? {
          indexCount: count,
          firstIndex: first,
          baseVertex,
          indexFormat: indexView.format,
          indexView,
        }
      : { vertexCount: count, firstVertex: first }),
    instanceCount: instances,
    firstInstance,
    vertexView,
    vertexStride,
    depthTarget: s.depthTarget?.pointer ?? 0,
  });
  s.vertexBytes += snapshotBytes;
  return undefined;
}
function listMethods() {
  const methods = {
    9: {
      argc: 1,
      invoke(_r, _a, o) {
        if (o.state.closed) return E_INVALIDARG;
        o.state.closed = true;
        o.state.allocator.state.inUse = false;
        return S_OK;
      },
    },
    10: {
      argc: 3,
      invoke(r, a, o) {
        const alloc = object(r, a(1), 'allocator', o.state.device);
        if (!o.state.closed || alloc.state.type !== 0 || alloc.state.inUse) return E_INVALIDARG;
        const p = a(2) ? object(r, a(2), 'pipeline', o.state.device) : null;
        o.state.allocator = alloc;
        o.state.pipeline = p;
        o.state.root = null;
        o.state.target = null;
        o.state.depthTarget = null;
        o.state.vertexBuffer = null;
        o.state.indexBuffer = null;
        o.state.viewport = null;
        o.state.scissor = null;
        o.state.topology = 0;
        o.state.commands = [];
        o.state.vertexBytes = 0;
        o.state.closed = false;
        alloc.state.inUse = true;
        return S_OK;
      },
    },
    12: {
      argc: 5,
      invoke: (r, a, o) => recordDraw(r, a, o, false),
    },
    13: {
      argc: 6,
      invoke: (r, a, o) => recordDraw(r, a, o, true),
    },
    20: {
      argc: 2,
      invoke(_r, a, o) {
        if (number(a(1)) !== 4) throw Error('Unsupported D3D12 primitive topology');
        o.state.topology = 4;
        return undefined;
      },
    },
    21: {
      argc: 3,
      invoke(r, a, o) {
        if (number(a(1)) !== 1) throw Error('Unsupported D3D12 viewport count');
        o.state.viewport = viewport(r, number(a(2)));
        return undefined;
      },
    },
    22: {
      argc: 3,
      invoke(r, a, o) {
        if (number(a(1)) !== 1) throw Error('Unsupported D3D12 scissor count');
        o.state.scissor = scissor(r, number(a(2)));
        return undefined;
      },
    },
    25: {
      argc: 2,
      invoke(r, a, o) {
        o.state.pipeline = object(r, a(1), 'pipeline', o.state.device);
        return undefined;
      },
    },
    26: {
      argc: 3,
      invoke(r, a, o) {
        const count = number(a(1)),
          ptr = number(a(2));
        if (!count || count > 16) throw Error('Unsupported D3D12 barrier count');
        r.check(ptr, count * 24);
        if (o.state.commands.length + count > MAX_COMMANDS)
          throw Error('D3D12 command limit exceeded');
        const barriers = [];
        for (let i = 0; i < count; i++) {
          const p = ptr + i * 24;
          if (u32(r, p) !== 0 || u32(r, p, 4) !== 0 || u32(r, p, 12) !== 0xffffffff)
            throw Error('Unsupported D3D12 barrier type, flags, or subresource');
          const res = object(r, u32(r, p, 8), 'resource', o.state.device);
          const before = u32(r, p, 16),
            after = u32(r, p, 20);
          if (![0, 4].includes(before) || ![0, 4].includes(after) || before === after)
            throw Error('Unsupported D3D12 resource state transition');
          barriers.push({ type: 'barrier', resource: res, before, after });
        }
        o.state.commands.push(...barriers);
        return undefined;
      },
    },
    30: {
      argc: 2,
      invoke(r, a, o) {
        o.state.root = object(r, a(1), 'root', o.state.device);
        return undefined;
      },
    },
    43: {
      argc: 2,
      invoke(r, a, o) {
        const p = number(a(1));
        if (!p) {
          o.state.indexBuffer = null;
          return undefined;
        }
        r.check(p, 16);
        if (u32(r, p, 4)) throw Error('Unsupported 64-bit D3D12 guest GPU address');
        const address = u32(r, p),
          size = u32(r, p, 8),
          format = u32(r, p, 12);
        const width = format === 57 ? 2 : format === 42 ? 4 : 0;
        if (!width || !size || size > MAX_RESOURCE_BYTES || size % width || address % width)
          throw Error('Invalid D3D12 index buffer view');
        o.state.indexBuffer = {
          resource: uploadAt(r, address, size, o.state.device),
          address,
          size,
          width,
          format: width === 2 ? 'uint16' : 'uint32',
        };
        return undefined;
      },
    },
    44: {
      argc: 4,
      invoke(r, a, o) {
        if (number(a(1)) !== 0 || number(a(2)) !== 1)
          throw Error('Unsupported D3D12 vertex buffer slots');
        const p = number(a(3));
        r.check(p, 16);
        if (u32(r, p, 4)) throw Error('Unsupported 64-bit D3D12 guest GPU address');
        const address = u32(r, p),
          size = u32(r, p, 8),
          stride = u32(r, p, 12);
        if (!size || size > MAX_RESOURCE_BYTES || !stride || stride > 256 || size % stride)
          throw Error('Invalid D3D12 vertex buffer view');
        o.state.vertexBuffer = {
          resource: uploadAt(r, address, size, o.state.device),
          address,
          size,
          stride,
        };
        return undefined;
      },
    },
    46: {
      argc: 5,
      invoke(r, a, o) {
        if (number(a(1)) !== 1 || number(a(3)))
          throw Error('Unsupported D3D12 render target count/range');
        const ptr = number(a(2));
        r.check(ptr, 4);
        const d = descriptor(r, u32(r, ptr));
        if (d.heap.state.device !== o.state.device || !d.resource)
          throw Error('Unbound D3D12 RTV descriptor');
        object(r, d.resource.pointer, 'resource', o.state.device);
        o.state.target = d.resource;
        const depthPointer = number(a(4));
        if (depthPointer) {
          r.check(depthPointer, 4);
          const depth = descriptor(r, u32(r, depthPointer));
          if (
            depth.heap.state.type !== 3 ||
            depth.heap.state.device !== o.state.device ||
            !depth.resource
          )
            throw Error('Unbound D3D12 depth descriptor');
          object(r, depth.resource.pointer, 'resource', o.state.device);
          o.state.depthTarget = depth.resource;
        } else o.state.depthTarget = null;
        return undefined;
      },
    },
    47: {
      argc: 7,
      invoke(r, a, o) {
        const d = descriptor(r, a(1));
        const depth = floatBits(a(3));
        if (
          d.heap.state.type !== 3 ||
          d.heap.state.device !== o.state.device ||
          !d.resource ||
          number(a(2)) !== 1 ||
          !Number.isFinite(depth) ||
          depth < 0 ||
          depth > 1 ||
          number(a(4)) ||
          number(a(5)) ||
          number(a(6))
        )
          throw Error('Unsupported D3D12 ClearDepthStencilView parameters');
        object(r, d.resource.pointer, 'resource', o.state.device);
        add(o, { type: 'clear-depth', target: d.resource.pointer, depth });
        return undefined;
      },
    },
    48: {
      argc: 5,
      invoke(r, a, o) {
        const d = descriptor(r, a(1));
        if (d.heap.state.device !== o.state.device || !d.resource || number(a(3)) || number(a(4)))
          throw Error('Unsupported D3D12 ClearRenderTargetView descriptor/rects');
        object(r, d.resource.pointer, 'resource', o.state.device);
        const ptr = number(a(2));
        r.check(ptr, 16);
        const color = Array.from({ length: 4 }, (_, i) => f32(r, ptr, i * 4));
        if (!color.every((x) => Number.isFinite(x) && x >= 0 && x <= 1))
          throw Error('Unsupported D3D12 clear color');
        add(o, { type: 'clear', target: d.resource.pointer, color });
        return undefined;
      },
    },
  };
  for (const [slot, method] of Object.entries(methods)) {
    if (slot === '9' || slot === '10') continue;
    const invoke = method.invoke;
    method.invoke = (r, a, o) => {
      if (o.state.closed) throw Error('D3D12 command list is closed');
      return invoke(r, a, o);
    };
  }
  return methods;
}
function pipelineDesc(r, ptr, dev) {
  const parsed = parsePipelineDescriptor({
    check: r.check.bind(r),
    data: r.data,
    read32: r.read32.bind(r),
    readString: r.string.bind(r),
    pointer: ptr,
  });
  return {
    ...parsed,
    root: object(r, parsed.root, 'root', dev),
    vertex: bytes(r, parsed.vertex.pointer, parsed.vertex.size),
    pixel: bytes(r, parsed.pixel.pointer, parsed.pixel.size),
  };
}
function resourceMethods() {
  return {
    8: {
      argc: 4,
      invoke(r, a, o) {
        if (o.state.kind !== 'buffer' || number(a(1))) return E_INVALIDARG;
        parseResourceRange({
          check: r.check.bind(r),
          read32: r.read32.bind(r),
          pointer: number(a(2)),
          size: o.state.size,
        });
        const out = number(a(3));
        output(r, out);
        r.write32(out, o.state.storage);
        return S_OK;
      },
    },
    9: {
      argc: 3,
      invoke(r, a, o) {
        if (o.state.kind !== 'buffer' || number(a(1)))
          throw Error('Unsupported D3D12 resource Unmap');
        parseResourceRange({
          check: r.check.bind(r),
          read32: r.read32.bind(r),
          pointer: number(a(2)),
          size: o.state.size,
        });
        return undefined;
      },
    },
    11: {
      argc: 1,
      invoke(_r, _a, o) {
        if (o.state.kind !== 'buffer') return { result: 0, resultHigh: 0 };
        return { result: o.state.storage, resultHigh: 0 };
      },
    },
  };
}
function committedResource(r, a) {
  const parsed = parseCommittedResourceDescriptor({
    check: r.check.bind(r),
    data: r.data,
    read32: r.read32.bind(r),
    readFloat32: (pointer) => r.view.getFloat32(pointer, true),
    heap: number(a(1)),
    heapFlags: number(a(2)),
    descriptor: number(a(3)),
    initialState: number(a(4)),
    clearValue: number(a(5)),
    maxBytes: MAX_RESOURCE_BYTES,
  });
  if (!parsed) return E_INVALIDARG;
  return parsed.kind === 'buffer' ? { ...parsed, storage: r.allocate(parsed.size) } : parsed;
}
function deviceMethods() {
  const child = (kind, argc, parse, methods, onRelease) => ({
    argc,
    async invoke(r, a, dev) {
      const out = number(a(argc - 1));
      output(r, out);
      if (!iid(r, a(argc - 2), kind)) return E_NOINTERFACE;
      const extra = parse?.(r, a, dev);
      if (extra === E_INVALIDARG) return extra;
      let item;
      try {
        item = make(
          r,
          kind,
          methods ?? {},
          { device: dev, ...extra },
          dev,
          onRelease ? (o) => onRelease(r, o) : null,
        );
      } catch (error) {
        if (kind === 'heap') r.free(extra.base);
        throw error;
      }
      if (kind === 'heap')
        for (let i = 0; i < extra.count; i++)
          state(r).descriptors.set(extra.base + i * 4, { heap: item, resource: null });
      r.write32(out, item.pointer);
      return S_OK;
    },
  });
  return {
    7: { argc: 1, invoke: () => 1 },
    8: child(
      'queue',
      4,
      (r, a) => {
        const p = number(a(1));
        r.check(p, 16);
        if (u32(r, p) !== 0 || u32(r, p, 4) || u32(r, p, 8) || u32(r, p, 12)) return E_INVALIDARG;
        return { type: 0 };
      },
      queueMethods(),
    ),
    9: child(
      'allocator',
      4,
      (_r, a) => (number(a(1)) === 0 ? { type: 0, inUse: false } : E_INVALIDARG),
      {
        8: {
          argc: 1,
          invoke(_r, _a, o) {
            if (o.state.inUse) return E_INVALIDARG;
            return S_OK;
          },
        },
      },
    ),
    10: {
      argc: 4,
      async invoke(r, a, dev) {
        const out = number(a(3));
        output(r, out);
        if (!iid(r, a(2), 'pipeline')) return E_NOINTERFACE;
        const p = pipelineDesc(r, number(a(1)), dev);
        const item = make(
          r,
          'pipeline',
          {},
          {
            device: dev,
            root: p.root,
            inputLayout: p.inputLayout,
            vertexStride: p.vertexStride,
            depth: p.depth,
          },
          dev,
          async (o) => requireBackend(r).destroyPipeline({ id: o.pointer }),
        );
        try {
          await requireBackend(r).createPipeline({
            id: item.pointer,
            vertex: p.vertex,
            pixel: p.pixel,
            inputLayout: p.inputLayout,
            vertexStride: p.vertexStride,
            depth: p.depth,
          });
        } catch (error) {
          item.refs = 0;
          dev.refs--;
          throw error;
        }
        r.write32(out, item.pointer);
        return S_OK;
      },
    },
    12: {
      argc: 7,
      invoke(r, a, dev) {
        const out = number(a(6));
        output(r, out);
        if (!iid(r, a(5), 'list')) return E_NOINTERFACE;
        const alloc = object(r, a(3), 'allocator', dev);
        const p = a(4) ? object(r, a(4), 'pipeline', dev) : null;
        if (number(a(1)) !== 0 || number(a(2)) !== 0 || alloc.state.type !== 0 || alloc.state.inUse)
          return E_INVALIDARG;
        const item = make(
          r,
          'list',
          listMethods(),
          {
            device: dev,
            allocator: alloc,
            pipeline: p,
            root: null,
            target: null,
            depthTarget: null,
            vertexBuffer: null,
            indexBuffer: null,
            viewport: null,
            scissor: null,
            topology: 0,
            commands: [],
            vertexBytes: 0,
            closed: false,
          },
          dev,
        );
        alloc.state.inUse = true;
        r.write32(out, item.pointer);
        return S_OK;
      },
    },
    14: child(
      'heap',
      4,
      (r, a, dev) => {
        const p = number(a(1));
        r.check(p, 16);
        if (
          ![2, 3].includes(u32(r, p)) ||
          u32(r, p, 4) < 1 ||
          u32(r, p, 4) > 16 ||
          u32(r, p, 8) ||
          u32(r, p, 12)
        )
          return E_INVALIDARG;
        const count = u32(r, p, 4),
          base = r.allocate(count * 4);
        return { base, count, device: dev, type: u32(r, p) };
      },
      {
        9: {
          argc: 2,
          invoke(r, a, o) {
            const out = number(a(1));
            r.check(out, 4, true);
            r.write32(out, o.state.base);
            return out;
          },
        },
        8: {
          argc: 2,
          invoke(r, a, o) {
            const out = number(a(1));
            r.check(out, 16, true);
            r.write32(out, o.state.type);
            r.write32(out + 4, o.state.count);
            r.write32(out + 8, 0);
            r.write32(out + 12, 0);
            return out;
          },
        },
      },
      (r, o) => {
        for (let i = 0; i < o.state.count; i++) state(r).descriptors.delete(o.state.base + i * 4);
        r.free(o.state.base);
      },
    ),
    15: {
      argc: 2,
      invoke(_r, a) {
        return [2, 3].includes(number(a(1))) ? 4 : 0;
      },
    },
    16: {
      argc: 6,
      async invoke(r, a, dev) {
        const out = number(a(5));
        output(r, out);
        if (!iid(r, a(4), 'root')) return E_NOINTERFACE;
        if (number(a(1)) !== 0) return E_INVALIDARG;
        const raw = bytes(r, number(a(2)), number(a(3)));
        const flags = await requireBackend(r).validateRootSignature(raw);
        const item = make(r, 'root', {}, { device: dev, flags }, dev);
        r.write32(out, item.pointer);
        return S_OK;
      },
    },
    20: {
      argc: 4,
      invoke(r, a, dev) {
        const res = object(r, a(1), 'resource', dev);
        if (number(a(2))) throw Error('Unsupported D3D12 explicit RTV description');
        const d = descriptor(r, a(3));
        if (d.heap.state.type !== 2 || d.heap.state.device !== dev)
          throw Error('D3D12 RTV descriptor mismatch');
        d.resource = res;
        return undefined;
      },
    },
    21: {
      argc: 4,
      invoke(r, a, dev) {
        const res = object(r, a(1), 'resource', dev);
        if (res.state.kind !== 'depth') throw Error('D3D12 DSV requires a depth resource');
        const desc = number(a(2));
        if (desc) {
          r.check(desc, 24);
          if (
            u32(r, desc) !== 55 ||
            u32(r, desc, 4) !== 3 ||
            u32(r, desc, 8) ||
            r.data.subarray(desc + 12, desc + 24).some((value) => value !== 0)
          )
            throw Error('Unsupported D3D12 depth view description');
        }
        const d = descriptor(r, a(3));
        if (d.heap.state.type !== 3 || d.heap.state.device !== dev)
          throw Error('D3D12 DSV descriptor mismatch');
        d.resource = res;
        return undefined;
      },
    },
    27: {
      argc: 8,
      async invoke(r, a, dev) {
        const out = number(a(7));
        output(r, out);
        if (!iid(r, a(6), 'resource')) return E_NOINTERFACE;
        const info = committedResource(r, a, dev);
        if (info === E_INVALIDARG) return info;
        let item;
        try {
          item = make(
            r,
            'resource',
            resourceMethods(),
            { device: dev, ...info },
            dev,
            async (o) => {
              if (o.state.kind === 'depth')
                await requireBackend(r).destroyResource({ id: o.pointer });
              else r.free(o.state.storage);
            },
          );
        } catch (error) {
          if (info.kind === 'buffer') r.free(info.storage);
          throw error;
        }
        try {
          if (info.kind === 'depth') {
            const backend = requireBackend(r);
            if (!backend.createResource || !backend.destroyResource)
              throw Error('D3D12 depth backend is unavailable');
            await backend.createResource({
              id: item.pointer,
              kind: 'depth',
              width: info.width,
              height: info.height,
              format: info.format,
            });
          }
        } catch (error) {
          item.refs = 0;
          dev.refs--;
          throw error;
        }
        r.write32(out, item.pointer);
        return S_OK;
      },
    },
    36: {
      argc: 6,
      invoke(r, a, dev) {
        const out = number(a(5));
        output(r, out);
        if (!iid(r, a(4), 'fence')) return E_NOINTERFACE;
        if (number(a(3))) return E_INVALIDARG;
        const value = (BigInt(number(a(2))) << 32n) | BigInt(number(a(1)));
        const item = make(r, 'fence', fenceMethods(), { device: dev, value }, dev);
        r.write32(out, item.pointer);
        return S_OK;
      },
    },
  };
}
function fenceMethods() {
  return {
    8: {
      argc: 1,
      invoke(_r, _a, o) {
        return {
          result: Number(o.state.value & 0xffffffffn),
          resultHigh: Number(o.state.value >> 32n),
        };
      },
    },
  };
}
function queueMethods() {
  return {
    10: {
      argc: 3,
      async invoke(r, a, q) {
        const count = number(a(1)),
          ptr = number(a(2));
        if (!count || count > 16) throw Error('D3D12 command list batch limit exceeded');
        r.check(ptr, count * 4);
        const lists = [];
        for (let i = 0; i < count; i++) {
          const l = object(r, u32(r, ptr, i * 4), 'list', q.state.device);
          if (!l.state.closed) throw Error('Executing open D3D12 command list');
          lists.push(l);
        }
        const states = new Map();
        const commands = [];
        let vertexBytes = 0;
        for (const l of lists)
          for (const c of l.state.commands) {
            if (c.type === 'barrier') {
              object(r, c.resource.pointer, 'resource', q.state.device);
              const current = states.get(c.resource) ?? c.resource.state.state;
              if (current !== c.before) throw Error('D3D12 resource state mismatch');
              states.set(c.resource, c.after);
            } else if (c.type === 'clear-depth') {
              const depth = object(r, c.target, 'resource', q.state.device);
              if (depth.state.kind !== 'depth' || depth.state.state !== 0x10)
                throw Error('D3D12 depth target is not in DEPTH_WRITE state');
              commands.push(c);
            } else {
              const res = object(r, c.target, 'resource', q.state.device);
              if (c.type === 'draw') {
                object(r, c.pipeline, 'pipeline', q.state.device);
                if (c.depthTarget) {
                  const depth = object(r, c.depthTarget, 'resource', q.state.device);
                  if (depth.state.kind !== 'depth' || depth.state.state !== 0x10)
                    throw Error('D3D12 depth target is not in DEPTH_WRITE state');
                }
                if (c.vertexView)
                  object(r, c.vertexView.resource.pointer, 'resource', q.state.device);
                if (c.indexView)
                  object(r, c.indexView.resource.pointer, 'resource', q.state.device);
                vertexBytes += (c.vertexView?.size ?? 0) + (c.indexView?.size ?? 0);
                if (vertexBytes > MAX_RESOURCE_BYTES)
                  throw Error('D3D12 upload snapshot limit exceeded');
              }
              const current = states.get(res) ?? res.state.state;
              if (current !== 4) throw Error('D3D12 render target is not in RENDER_TARGET state');
              if (c.type === 'draw') {
                const delivered = {
                  ...c,
                  vertices: c.vertexView
                    ? r.data.slice(c.vertexView.address, c.vertexView.address + c.vertexView.size)
                    : new Uint8Array(0),
                };
                if (c.indexView) {
                  delivered.indices = r.data.slice(
                    c.indexView.address,
                    c.indexView.address + c.indexView.size,
                  );
                  validateIndexSnapshot(
                    delivered,
                    c.vertexStride ? delivered.vertices.length / c.vertexStride : null,
                  );
                }
                delete delivered.vertexView;
                delete delivered.indexView;
                commands.push(delivered);
              } else commands.push(c);
            }
          }
        if (commands.length > MAX_COMMANDS) throw Error('D3D12 execute command limit exceeded');
        await requireBackend(r).execute({ commands });
        for (const [res, value] of states) res.state.state = value;
        for (const l of lists) l.state.allocator.state.inUse = false;
        return undefined;
      },
    },
    14: {
      argc: 4,
      invoke(r, a, q) {
        const fence = object(r, a(1), 'fence', q.state.device);
        const value = (BigInt(number(a(3))) << 32n) | BigInt(number(a(2)));
        if (value < fence.state.value) return E_INVALIDARG;
        fence.state.value = value;
        return S_OK;
      },
    },
  };
}
function blob(r, raw) {
  const ptr = r.allocate(raw.length);
  r.data.set(raw, ptr);
  try {
    return make(
      r,
      'blob',
      {
        3: { argc: 1, invoke: () => ptr },
        4: { argc: 1, invoke: () => raw.length },
      },
      {},
      null,
      () => r.free(ptr),
    );
  } catch (error) {
    r.free(ptr);
    throw error;
  }
}
export const d3d12Apis = {
  'd3d12.dll!D3D12CreateDevice': (r, a) => {
    const out = number(a(3));
    output(r, out);
    if (number(a(0)) || number(a(1)) !== 0xb000) return { result: E_INVALIDARG, argc: 4 };
    if (!iid(r, a(2), 'device')) return { result: E_NOINTERFACE, argc: 4 };
    requireBackend(r);
    state(r);
    const dev = make(r, 'device', deviceMethods());
    r.write32(out, dev.pointer);
    return { result: S_OK, argc: 4 };
  },
  'd3d12.dll!D3D12SerializeRootSignature': async (r, a) => {
    const out = number(a(2)),
      err = number(a(3));
    output(r, out);
    if (err) output(r, err);
    const p = number(a(0));
    r.check(p, 20);
    if (number(a(1)) !== 1 || u32(r, p) || u32(r, p, 4) || u32(r, p, 8) || u32(r, p, 12))
      return { result: E_INVALIDARG, argc: 4 };
    requireBackend(r);
    state(r);
    const raw = await r.graphics12.serializeRootSignature(u32(r, p, 16));
    if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES)
      throw Error('D3D12 backend returned invalid root signature blob');
    r.write32(out, blob(r, raw).pointer);
    return { result: S_OK, argc: 4 };
  },
};

function swapchainDesc(r, ptr) {
  r.check(ptr, 60);
  const windowId = u32(r, ptr, 44);
  const win = r.windows?.windows?.get(windowId);
  const width = u32(r, ptr) || win?.width,
    height = u32(r, ptr, 4) || win?.height;
  if (
    !win ||
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    u32(r, ptr, 16) !== 28 ||
    u32(r, ptr, 28) !== 1 ||
    u32(r, ptr, 32) ||
    !(u32(r, ptr, 36) & 0x20) ||
    u32(r, ptr, 36) & ~0x20 ||
    u32(r, ptr, 40) !== 2 ||
    u32(r, ptr, 48) !== 1 ||
    u32(r, ptr, 52) !== 4 ||
    u32(r, ptr, 56)
  )
    throw Error('Unsupported DXGI swap chain description');
  return { windowId, width, height };
}
function swapchainMethods() {
  return {
    8: {
      argc: 3,
      async invoke(r, a, o) {
        if (number(a(1)) > 1 || number(a(2)))
          throw Error('Unsupported DXGI Present interval/flags');
        const s = o.state;
        const res = s.buffers[s.index];
        if (res.state.state !== 0) throw Error('DXGI Present requires PRESENT resource state');
        await requireBackend(r).present({ id: o.pointer, index: s.index });
        s.index = (s.index + 1) % 2;
        return S_OK;
      },
    },
    9: {
      argc: 4,
      invoke(r, a, o) {
        const out = number(a(3));
        output(r, out);
        const i = number(a(1));
        if (i > 1) return E_INVALIDARG;
        if (!iid(r, a(2), 'resource')) return E_NOINTERFACE;
        const res = o.state.buffers[i];
        if (!res.refs) throw Error('Released DXGI back buffer');
        if (res.refs >= 0x7fffffff) throw Error('D3D12 resource reference limit exceeded');
        res.refs++;
        r.write32(out, res.pointer);
        return S_OK;
      },
    },
    36: {
      argc: 1,
      invoke(_r, _a, o) {
        return o.state.index;
      },
    },
  };
}
export const dxgiApis = {
  'dxgi.dll!CreateDXGIFactory1': (r, a) => {
    const out = number(a(1));
    output(r, out);
    if (!['7b7166ec-21c7-44ae-b21a-c9ae321ae369', iids.factory].includes(readGuid(r, number(a(0)))))
      return { result: E_NOINTERFACE, argc: 2 };
    requireBackend(r);
    state(r);
    const factory = make(r, 'factory', {
      10: {
        argc: 4,
        async invoke(rt, arg, self) {
          const result = number(arg(3));
          output(rt, result);
          const queue = object(rt, arg(1), 'queue');
          const desc = swapchainDesc(rt, number(arg(2)));
          const s = make(
            rt,
            'swapchain',
            swapchainMethods(),
            { queue, index: 0, buffers: [] },
            self,
            async (item) => {
              for (const b of item.state.buffers) if (!--b.refs) queue.state.device.refs--;
              await requireBackend(rt).destroySwapChain({ id: item.pointer });
              queue.refs--;
            },
          );
          queue.refs++;
          for (let i = 0; i < 2; i++)
            s.state.buffers.push(
              make(
                rt,
                'resource',
                {},
                { device: queue.state.device, kind: 'color', swapchain: s, index: i, state: 0 },
                queue.state.device,
              ),
            );
          try {
            await requireBackend(rt).createSwapChain({
              id: s.pointer,
              ...desc,
              bufferIds: s.state.buffers.map((b) => b.pointer),
            });
          } catch (error) {
            s.refs = 0;
            self.refs--;
            queue.refs--;
            for (const b of s.state.buffers) {
              b.refs = 0;
              queue.state.device.refs--;
            }
            throw error;
          }
          rt.write32(result, s.pointer);
          return S_OK;
        },
      },
    });
    r.write32(out, factory.pointer);
    return { result: S_OK, argc: 2 };
  },
};
