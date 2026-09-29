// Bounded PE32 D3D12/DXGI bootstrap. Slot order and struct offsets are from
// i686-w64-mingw32 d3d12.h/dxgi.h (MinGW-w64 14.0.0).
import { ComObjects, readGuid } from './com.js';
import { createBlob } from './com-blob.js';
import { validateIndexSnapshot } from './d3d12-indices.js';
import {
  parseCommittedResourceDescriptor,
  parsePipelineDescriptor,
  parseResourceRange,
  parseRootSignatureDescriptor,
} from './d3d12-descriptors.js';
import {
  decodeRootSignatureWords,
  planRootSignature,
  resolveDrawBindings,
} from './d3d12-bindings.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_NOINTERFACE = 0x80004002;
const MAX_BYTES = 1024 * 1024;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_COMMANDS = 256;
// Stable synthetic adapter LUID presented through GetAdapterLuid.
const ADAPTER_LUID = 0x4c554944, ADAPTER_LUID_HIGH = 0x57420000;
// D3D12_RESOURCE_STATES values the bounded renderer tracks. Buffers move
// through COMMON/COPY_DEST/COPY_SOURCE and the shader-readable READ states;
// depth targets only ever sit in DEPTH_WRITE; swapchain images alternate
// between PRESENT and RENDER_TARGET.
const BUFFER_STATES = new Set([0, 0x1, 0x2, 0x40, 0x80, 0x200, 0x400, 0x800, 0xac3]);
const DEPTH_STATES = new Set([0, 0x10]);
const COLOR_STATES = new Set([0, 4]);
// A sampled texture starts in COMMON or COPY_DEST and transitions to a
// shader-readable state before the shader reads it.
const TEXTURE_STATES = new Set([0, 0x400, 0x40, 0x80]);
// DXGI_FORMAT -> WebGPU format for the sampled textures this path uploads.
const WEBGPU_FORMAT = { 28: 'rgba8unorm', 87: 'bgra8unorm', 49: 'r16unorm', 61: 'r8unorm' };
// DXGI_FORMAT byte sizes for the texture formats the bounded path models.
const TEXTURE_FORMAT_BYTES = {
  2: 16, 6: 12, 10: 8, 11: 8, 28: 4, 29: 4, 41: 8, 40: 4, 45: 4, 49: 2, 55: 2, 61: 1, 87: 4, 88: 4,
};
// D3D12_FORMAT_SUPPORT1 masks for the formats the bounded path accepts.
const FMT_BUFFER = 0x1,
  FMT_VERTEX = 0x2,
  FMT_INDEX = 0x4,
  FMT_TEX2D = 0x20,
  FMT_LOAD = 0x100,
  FMT_SAMPLE = 0x200,
  FMT_RT = 0x4000,
  FMT_BLEND = 0x8000,
  FMT_DEPTH = 0x10000;
const FORMAT_SUPPORT = {
  2: FMT_BUFFER | FMT_VERTEX | FMT_TEX2D | FMT_LOAD, // R32G32B32A32_FLOAT
  6: FMT_BUFFER | FMT_VERTEX | FMT_TEX2D | FMT_LOAD, // R32G32B32_FLOAT
  28: FMT_TEX2D | FMT_LOAD | FMT_SAMPLE | FMT_RT | FMT_BLEND, // R8G8B8A8_UNORM
  87: FMT_TEX2D | FMT_LOAD | FMT_SAMPLE, // B8G8R8A8_UNORM
  49: FMT_TEX2D | FMT_LOAD | FMT_SAMPLE, // R16_UNORM
  61: FMT_TEX2D | FMT_LOAD | FMT_SAMPLE, // R8_UNORM
  42: FMT_BUFFER | FMT_INDEX, // R32_UINT
  55: FMT_TEX2D | FMT_DEPTH, // D16_UNORM
  57: FMT_BUFFER | FMT_INDEX, // R16_UINT
};
const resourceStates = (kind) =>
  kind === 'depth'
    ? DEPTH_STATES
    : kind === 'color'
      ? COLOR_STATES
      : kind === 'texture'
        ? TEXTURE_STATES
        : BUFFER_STATES;
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
  query: '0d9658ae-ed45-469e-a61d-970ec583cab4', // ID3D12QueryHeap
  factory: '770aae78-f26f-4dba-a829-253c83d1b387', // IDXGIFactory1
  factory1: '770aae78-f26f-4dba-a829-253c83d1b387',
  factoryBase: '7b7166ec-21c7-44ae-b21a-c9ae321ae369',
  factory2: '50c83a1c-e072-4c48-87b0-3630fa36a6d0',
  factory3: '25483823-cd46-4c7d-86ca-47aa95b837bd',
  factory4: '1bc6ea02-ef36-464f-bf0c-21ca39e5168a',
  adapter: '29038f61-3839-4626-91fd-086879011a05',
  swapchain: '310d36a0-d2e7-4c0a-aa04-6a9d23b8886a',
  swapchain1: '790a45f7-0d42-4876-983a-0a55cfe6f4aa',
  swapchain2: 'a8be2ac4-199f-4946-b331-79599fb98de7',
  swapchain3: '94d99bdb-f1f8-4ab0-b236-7da0170edab1',
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
  query: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice`,
  resource: `QueryInterface AddRef Release GetPrivateData SetPrivateData SetPrivateDataInterface SetName GetDevice Map Unmap GetDesc GetGPUVirtualAddress WriteToSubresource ReadFromSubresource GetHeapProperties`,
  factory: `QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent EnumAdapters MakeWindowAssociation GetWindowAssociation CreateSwapChain CreateSoftwareAdapter EnumAdapters1 IsCurrent IsWindowedStereoEnabled CreateSwapChainForHwnd CreateSwapChainForCoreWindow GetSharedResourceAdapterLuid RegisterStereoStatusWindow RegisterStereoStatusEvent UnregisterStereoStatus RegisterOcclusionStatusWindow RegisterOcclusionStatusEvent UnregisterOcclusionStatus CreateSwapChainForComposition GetCreationFlags EnumAdapterByLuid EnumWarpAdapter`,
  adapter: `QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent EnumOutputs GetDesc CheckInterfaceSupport GetDesc1`,
  swapchain: `QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent GetDevice Present GetBuffer SetFullscreenState GetFullscreenState GetDesc ResizeBuffers ResizeTarget GetContainingOutput GetFrameStatistics GetLastPresentCount GetDesc1 GetFullscreenDesc GetHwnd GetCoreWindow Present1 IsTemporaryMonoSupported GetRestrictToOutput SetBackgroundColor GetBackgroundColor SetRotation GetRotation SetSourceSize GetSourceSize SetMaximumFrameLatency GetMaximumFrameLatency GetFrameLatencyWaitableObject SetMatrixTransform GetMatrixTransform GetCurrentBackBufferIndex CheckColorSpaceSupport SetColorSpace1 ResizeBuffers1`,
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
  query: 'ID3D12QueryHeap',
  factory: 'IDXGIFactory1',
  adapter: 'IDXGIAdapter1',
  swapchain: 'IDXGISwapChain',
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
    !g?.validateRootSignature ||
    !g?.buildRootSignature ||
    !g?.inspectRootSignature ||
    !g?.scanShader
  )
    throw Error('D3D12 graphics backend is unavailable');
  return g;
}
function state(r) {
  r.comObjects ??= new ComObjects(r);
  r.d3d12State ??= {
    descriptors: new Map(),
    swapchains: new Set(),
    sharedHandles: new Map(),
    nextSharedHandle: 0x80000000,
  };
  return r.d3d12State;
}
function object(r, pointer, kind, owner = null) {
  const item = r.comObjects?.objects.get(number(pointer));
  if (!item || !item.refs || item.name !== name[kind] || (owner && item.state.device !== owner))
    throw Error(
      `Invalid or released ${name[kind]} pointer (0x${number(pointer).toString(16)}` +
        `${owner ? `, device 0x${owner.pointer.toString(16)}` : ''})`,
    );
  return item;
}
function iid(r, ptr, expected) {
  return readGuid(r, number(ptr)) === iids[expected];
}
function output(r, ptr) {
  r.check(number(ptr), 4, true);
  r.write32(number(ptr), 0);
}
// Additional QueryInterface identities per COM object kind. The factory chain
// shares one vtable with IDXGIFactory4's trailing methods; adapters expose only
// their own interface plus IUnknown.
function extraIids(kind, parent) {
  if (kind === 'factory')
    return [iids.factoryBase, iids.factory1, iids.factory2, iids.factory3, iids.factory4];
  if (kind === 'adapter' || kind === 'swapchain')
    return kind === 'swapchain' ? [iids.swapchain1, iids.swapchain2, iids.swapchain3] : [];
  if (kind === 'device') return [OBJECT];
  if (!parent) return [];
  return [
    OBJECT,
    CHILD,
    ...(['queue', 'allocator', 'pipeline', 'heap', 'fence', 'resource', 'query'].includes(kind)
      ? [PAGEABLE]
      : []),
    ...(kind === 'list' ? [COMMAND_LIST] : []),
  ];
}

// ID3D12Object private-data and debug-name calls appear throughout real
// applications and carry no rendering semantics. Answer them without storing
// anything: GetPrivateData reports "not found" and the setters succeed.
// ID3D12DeviceChild.GetDevice is equally common and hands back the owning
// device with its own reference.
const DEVICE_CHILD_GET_DEVICE = {
  argc: 3,
  invoke(r, a, o) {
    const out = number(a(2));
    if (out) output(r, out);
    if (!iid(r, a(1), 'device')) return E_NOINTERFACE;
    if (!out) return S_OK;
    const device = o.state.device;
    if (!device || !device.refs) throw Error('Released D3D12 device');
    if (device.refs >= 0x7fffffff) throw Error('D3D12 device reference limit exceeded');
    device.refs++;
    r.write32(out, device.pointer);
    return S_OK;
  },
};
const METADATA_METHODS = {
  GetPrivateData: {
    argc: 4,
    invoke(r, a) {
      const size = number(a(2));
      if (size) output(r, size);
      return 0x887a0002; // DXGI_ERROR_NOT_FOUND
    },
  },
  SetPrivateData: { argc: 5, invoke: () => S_OK },
  SetPrivateDataInterface: { argc: 4, invoke: () => S_OK },
  SetName: { argc: 2, invoke: () => S_OK },
};
function make(r, kind, methods, itemState = {}, parent = null, onRelease = null) {
  if (parent) {
    if (parent.refs >= 0x7fffffff) throw Error('D3D12 parent reference limit exceeded');
    parent.refs++;
  }
  const methodNames = names[kind].split(' ');
  const table = { ...methods };
  for (let slot = 0; slot < methodNames.length; slot++)
    if (!table[slot] && METADATA_METHODS[methodNames[slot]])
      table[slot] = METADATA_METHODS[methodNames[slot]];
  // Every non-device object is an ID3D12DeviceChild at the user level, so
  // GetDevice is answered for the whole graph rather than per vtable (the
  // factory and adapter expose no such slot).
  const getDeviceSlot = methodNames.indexOf('GetDevice');
  if (kind !== 'device' && getDeviceSlot >= 0 && !table[getDeviceSlot])
    table[getDeviceSlot] = DEVICE_CHILD_GET_DEVICE;
  try {
    return r.comObjects.create({
      name: name[kind],
      iid: iids[kind],
      iids: extraIids(kind, parent),
      methodNames,
      methods: table,
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
// Descriptor heaps are backed by a fixed set of CPU descriptor handle
// addresses (one 4-byte slot per descriptor). Copying a descriptor duplicates
// the resource binding from the source slot, matching how the RTV/DSV/CBV
// creators store it.
// Resolve a descriptor slot that must belong to a heap of the given type on
// the given device. Descriptor creators write their binding into this slot.
function viewSlot(r, dev, handle, heapType) {
  const entry = state(r).descriptors.get(number(handle));
  if (!entry || !entry.heap.refs || entry.heap.state.device !== dev) return null;
  if (entry.heap.state.type !== heapType) return null;
  return entry;
}
function copyDescriptorRange(r, dev, type, dstHandle, srcHandle, count) {
  for (let i = 0; i < count; i++) {
    const source = state(r).descriptors.get(srcHandle + i * 4);
    const target = state(r).descriptors.get(dstHandle + i * 4);
    if (!source || !source.heap.refs || source.heap.state.device !== dev)
      return E_INVALIDARG;
    if (!target || !target.heap.refs || target.heap.state.device !== dev)
      return E_INVALIDARG;
    if (source.heap.state.type !== type || target.heap.state.type !== type)
      return E_INVALIDARG;
    target.resource = source.resource ?? null;
  }
  return S_OK;
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
// The root signature's planned parameters, so a root-parameter index can be
// validated and interpreted before any binding is recorded.
function rootDescribedParameter(root, index) {
  const plan = root.state.plan;
  const parameter = plan?.parameters?.[index];
  if (!parameter) throw Error('D3D12 root parameter index is out of range');
  return parameter;
}

// Resolves a descriptor-table slot. The table's bound handle is a guest address
// of a 4-byte descriptor slot; `heapSlot` is the range offset within the table,
// so the address is the handle advanced that many descriptors.
function descriptorTableEntry(r, o, entry, heapSlot) {
  const heap = o.state.descriptorHeaps.find((candidate) =>
    entry.handle >= candidate.state.base &&
    entry.handle < candidate.state.base + candidate.state.count * 4,
  );
  if (!heap) throw Error('D3D12 root descriptor table is not backed by a bound heap');
  const base = entry.handle + heapSlot * 4;
  if (base + 4 > heap.state.base + heap.state.count * 4)
    throw Error('D3D12 descriptor table range exceeds the bound heap');
  const descriptor = state(r).descriptors.get(base);
  if (!descriptor || !descriptor.heap.refs) throw Error('D3D12 descriptor table slot is empty');
  if (!descriptor.resource) throw Error('D3D12 descriptor table slot has no resource');
  return descriptor;
}

// Captures the bytes a draw needs for one resolved binding. Buffer-backed
// bindings copy the guest storage the view covers; inline constants copy the
// staged words. Textures and samplers carry their descriptors instead of bytes,
// because the backend owns GPU storage for them.
function bindingSnapshot(r, o, resolved) {
  const { binding, placement, value } = resolved;
  const common = { group: binding.group, binding: binding.binding, type: binding.type };
  if (placement.kind === 'static-sampler')
    return { ...common, kind: 'sampler', sampler: staticSamplerDescription(value) };
  if (placement.kind === 'inline-constants') {
    // Each staged value is one 32-bit constant; WebGPU uniform bindings need a
    // 16-byte multiple, so a shorter parameter is zero-padded.
    const bytes = Math.max(16, Math.ceil((value.length * 4) / 16) * 16);
    const data = new Uint8Array(bytes);
    const view = view32(data);
    for (let i = 0; i < value.length; i++) view.setUint32(i * 4, (value[i] ?? 0) >>> 0, true);
    return { ...common, kind: 'uniform', bytes: data };
  }
  if (placement.kind === 'root-descriptor')
    return { ...common, ...resourceSnapshot(r, value, 0, value.state.size) };
  // Descriptor table: the slot holds the view the creator recorded.
  if (value.kind === 'cbv')
    return { ...common, ...resourceSnapshot(r, value.resource, value.offset, value.size) };
  if (value.kind === 'srv' || value.kind === 'uav')
    return { ...common, kind: 'texture-view', descriptor: value };
  if (value.kind === 'sampler')
    return { ...common, kind: 'sampler', sampler: dynamicSamplerDescription(value.sampler) };
  throw Error('Unsupported D3D12 descriptor table slot kind');
}
function view32(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function resourceSnapshot(r, resource, offset, size) {
  if (resource.state.kind !== 'buffer') return { kind: 'texture-resource', resource };
  if (!size || offset + size > resource.state.size)
    throw Error('D3D12 buffer view exceeds its resource');
  return {
    kind: 'uniform',
    bytes: r.data.slice(resource.state.storage + offset, resource.state.storage + offset + size),
  };
}
// D3D12 marks a comparison (shadow) sampler with the 0x80 bit of the filter
// value. ComparisonFunc is set on ordinary filtering samplers too — normally
// D3D12_COMPARISON_FUNC_NEVER — so it cannot be used to detect one.
function isComparisonFilter(filter) {
  return (filter & 0x80) !== 0;
}
// vkd3d-shader reports a sampler descriptor's comparison mode directly; the
// scan record's flag bit 0x4 is authoritative when a shader declares it.

// A static sampler declared by the root signature.
function staticSamplerDescription(sampler) {
  return {
    filter: sampler.filter,
    addressU: sampler.addressU,
    addressV: sampler.addressV,
    addressW: sampler.addressW,
    maxAnisotropy: sampler.maxAnisotropy,
    comparison: isComparisonFilter(sampler.filter),
  };
}
// A sampler created through CreateSampler: 52 bytes beginning with
// D3D12_FILTER, the three D3D12_TEXTURE_ADDRESS_MODEs, MipLODBias,
// MaxAnisotropy, ComparisonFunc, BorderColor[4], MinLOD and MaxLOD.
function dynamicSamplerDescription(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const filter = data.getUint32(0, true);
  return {
    filter,
    addressU: data.getUint32(4, true),
    addressV: data.getUint32(8, true),
    addressW: data.getUint32(12, true),
    maxAnisotropy: data.getUint32(20, true),
    comparison: isComparisonFilter(filter),
  };
}

// Records a root descriptor binding (CBV/SRV/UAV) from a guest GPU virtual
// address, resolving it to the buffer whose storage contains that address.
function setRootDescriptor(r, a, o, kind) {
  const index = number(a(1)),
    address = number(a(2));
  const root = o.state.root;
  if (!root) throw Error('D3D12 root descriptor requires a root signature');
  const parameter = rootDescribedParameter(root, index);
  if (parameter.type !== kind)
    throw Error(`D3D12 root ${kind} index is not a ${kind} parameter`);
  const resource = uploadAt(r, address, 1, o.state.device);
  o.state.roots.set(index, {
    kind: 'root-descriptor',
    descriptorType: kind,
    resource,
    address,
  });
  return undefined;
}

// Reads a D3D12_TEXTURE_COPY_LOCATION: pResource, Type, then either a
// subresource index or a placed footprint (offset, format, width, height,
// depth, row pitch). Only the two shapes the modelled upload path uses are
// accepted.
function textureCopyLocation(r, o, pointer) {
  if (!pointer) throw Error('D3D12 CopyTextureRegion location is null');
  r.check(pointer, 32);
  const resource = object(r, u32(r, pointer), 'resource', o.state.device);
  const type = u32(r, pointer, 4);
  if (type === 0) {
    if (u32(r, pointer, 8)) throw Error('Unsupported D3D12 texture copy subresource');
    // A subresource-index location names a texture, so it carries the
    // destination's own format and dimension rather than a placed footprint.
    return {
      resource,
      location: { ...resource.state, rowPitch: 0 },
    };
  }
  if (type !== 1) throw Error('Unsupported D3D12 texture copy location type');
  // D3D12_PLACED_SUBRESOURCE_FOOTPRINT: Offset (64-bit), Format, Width, Height,
  // Depth, RowPitch — 32 bytes total on the 32-bit ABI.
  if (u32(r, pointer, 12)) throw Error('Unsupported 64-bit D3D12 placed footprint offset');
  const offset = u32(r, pointer, 8);
  const format = u32(r, pointer, 16);
  const width = u32(r, pointer, 20);
  const height = u32(r, pointer, 24);
  const depth = u32(r, pointer, 28);
  const rowPitch = u32(r, pointer, 32);
  if (resource.state.kind !== 'buffer' || depth !== 1 || !width || !height || !rowPitch)
    throw Error('Unsupported D3D12 placed footprint');
  // An upload buffer has no format of its own; the placed footprint names the
  // texture format, which CopyTextureRegion checks against the destination.
  return { resource, offset, format, location: { width, height, rowPitch } };
}

// The placed texture footprint for a 2D copy: the source buffer supplies the
// row pitch, which GetCopyableFootprints computed with 256-byte alignment.
function textureFootprint(texture, rowPitch) {
  const bytesPerPixel = TEXTURE_FORMAT_BYTES[texture.format];
  if (!bytesPerPixel || !texture.width || !texture.height)
    throw Error('Unsupported D3D12 texture footprint');
  const rowSize = texture.width * bytesPerPixel;
  if (rowPitch < rowSize || rowPitch % 4)
    throw Error('Unsupported D3D12 texture footprint row pitch');
  return {
    width: texture.width,
    height: texture.height,
    rowSize,
    bytesPerRow: rowPitch,
    totalBytes: rowPitch * texture.height,
  };
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
    // A D3D12 draw count is a UINT; the bound vertex/index buffer snapshot is
    // what actually limits how much can be drawn.
    count > 0x7fffffff ||
    instances < 1 ||
    instances > 1024 ||
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
  // Resolve each canonical binding the pipeline's shaders declare against what
  // the command list bound, and capture its data, so the draw is self-contained
  // even though the guest may overwrite the source storage before execution.
  const pipelineBindings = pipeline.bindings ?? [];
  let bindings = null;
  if (pipelineBindings.length) {
    const rootPlan = s.root.state.plan;
    const resolved = resolveDrawBindings({
      bindings: pipelineBindings,
      plan: rootPlan,
      bound: s.roots,
      resolve: { table: (entry, heapSlot) => descriptorTableEntry(r, o, entry, heapSlot) },
    });
    bindings = resolved.map((entry) => bindingSnapshot(r, o, entry));
    for (const entry of bindings)
      if (entry.kind === 'uniform' && entry.bytes) s.vertexBytes += entry.bytes.length;
    if (s.vertexBytes > MAX_RESOURCE_BYTES)
      throw Error('D3D12 binding snapshot limit exceeded');
  }
  add(o, {
    type: 'draw',
    bindings,
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
        o.state.descriptorHeaps = [];
        o.state.roots = new Map();
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
          const allowed = resourceStates(res.state.kind);
          if (!allowed.has(before) || !allowed.has(after) || before === after)
            throw Error('Unsupported D3D12 resource state transition');
          barriers.push({ type: 'barrier', resource: res, before, after });
        }
        o.state.commands.push(...barriers);
        return undefined;
      },
    },
    15: {
      // CopyBufferRegion(dst, DstOffset, src, SrcOffset, NumBytes); the two
      // 64-bit offsets and the size arrive as low/high pairs on i386.
      argc: 9,
      invoke(r, a, o) {
        const dst = object(r, a(1), 'resource', o.state.device);
        const src = object(r, a(4), 'resource', o.state.device);
        if (dst.state.kind !== 'buffer' || src.state.kind !== 'buffer')
          throw Error('D3D12 CopyBufferRegion requires buffers');
        if (number(a(3)) || number(a(6)) || number(a(8)))
          throw Error('Unsupported 64-bit D3D12 CopyBufferRegion offset');
        const dstOffset = number(a(2)),
          srcOffset = number(a(5)),
          size = number(a(7));
        if (
          !size ||
          size > MAX_RESOURCE_BYTES ||
          dstOffset + size > dst.state.size ||
          srcOffset + size > src.state.size
        )
          throw Error('D3D12 CopyBufferRegion exceeds a resource');
        add(o, { type: 'copy-buffer', dst, dstOffset, src, srcOffset, size });
        return undefined;
      },
    },
    // CopyTextureRegion(const D3D12_TEXTURE_COPY_LOCATION *pDst, DstX, DstY,
    //                   DstZ, const D3D12_TEXTURE_COPY_LOCATION *pSrc,
    //                   const D3D12_BOX *pSrcBox). The canonical texture upload
    // copies a placed footprint from an upload buffer into a 2D texture.
    16: {
      argc: 7,
      invoke(r, a, o) {
        if (number(a(2)) || number(a(3)) || number(a(4)))
          throw Error('Unsupported D3D12 CopyTextureRegion destination offset');
        const dst = textureCopyLocation(r, o, number(a(1)));
        const src = textureCopyLocation(r, o, number(a(5)));
        if (dst.resource.state.kind !== 'texture' || src.resource.state.kind !== 'buffer')
          throw Error(
            'D3D12 CopyTextureRegion requires a texture destination and buffer source',
          );
        if (src.format && src.format !== dst.location.format)
          throw Error('D3D12 placed footprint format does not match the destination texture');
        const box = number(a(6));
        if (box) {
          r.check(box, 24);
          // D3D12_BOX: left, top, front, right, bottom, back.
          const left = u32(r, box), top = u32(r, box, 4), front = u32(r, box, 8);
          const right = u32(r, box, 12), bottom = u32(r, box, 16), back = u32(r, box, 20);
          if (left || top || front || back !== 1 || !right || !bottom ||
              right !== dst.location.width || bottom !== dst.location.height)
            throw Error('Unsupported D3D12 CopyTextureRegion box');
        }
        const footprint = textureFootprint(dst.location, src.location.rowPitch);
        footprint.offset = src.offset;
        add(o, { type: 'copy-texture', dst: dst.resource, src: src.resource, footprint });
        return undefined;
      },
    },
    // CopyResource(dst, src): whole-resource copy. Buffers must match in size;
    // textures are handled by the renderer, which this bounded path models only
    // as depth/swap-chain attachments.
    17: {
      argc: 3,
      invoke(r, a, o) {
        const dst = object(r, a(1), 'resource', o.state.device);
        const src = object(r, a(2), 'resource', o.state.device);
        if (dst.state.kind !== 'buffer' || src.state.kind !== 'buffer')
          throw Error('Unsupported D3D12 CopyResource for non-buffer resources');
        if (dst.state.size !== src.state.size)
          throw Error('D3D12 CopyResource requires equal buffer sizes');
        add(o, { type: 'copy-buffer', dst, dstOffset: 0, src, srcOffset: 0, size: dst.state.size });
        return undefined;
      },
    },
    // ExecuteBundle(ID3D12GraphicsCommandList *pCommandList): bundles are not
    // supported; the empty form still fails explicitly.
    27: {
      argc: 2,
      invoke(r, a) {
        if (number(a(1))) throw Error('Unsupported D3D12 ExecuteBundle');
        return undefined;
      },
    },
    // SetDescriptorHeaps(UINT NumDescriptorHeaps,
    //                    ID3D12DescriptorHeap *const *ppDescriptorHeaps)
    // Up to two heaps (CBV/SRV/UAV and SAMPLER) are recorded as bound.
    28: {
      argc: 3,
      invoke(r, a, o) {
        const count = number(a(1)),
          ptr = number(a(2));
        if (count > 2) throw Error('Unsupported D3D12 descriptor heap count');
        if (count) r.check(ptr, count * 4);
        const heaps = [];
        for (let i = 0; i < count; i++) {
          const heap = object(r, u32(r, ptr, i * 4), 'heap', o.state.device);
          if (heap.state.type > 1) throw Error('D3D12 SetDescriptorHeaps requires CPU-visible heaps');
          if (heaps.some((other) => other.state.type === heap.state.type))
            throw Error('D3D12 descriptor heaps must have distinct types');
          heaps.push(heap);
        }
        o.state.descriptorHeaps = heaps;
        return undefined;
      },
    },
    30: {
      argc: 2,
      invoke(r, a, o) {
        o.state.root = object(r, a(1), 'root', o.state.device);
        // Root bindings belong to the signature they were set against; a new
        // signature starts with none, matching the D3D12 contract.
        o.state.roots = new Map();
        return undefined;
      },
    },
    // SetGraphicsRootDescriptorTable(RootParameterIndex, BaseDescriptor): records
    // an offset into the currently bound descriptor heap. The handle is a guest
    // address of a 4-byte slot, so the slot index is derived from the heap base.
    32: {
      argc: 3,
      invoke(r, a, o) {
        const index = number(a(1)),
          handle = number(a(2));
        const root = o.state.root;
        if (!root) throw Error('D3D12 root descriptor table requires a root signature');
        const parameter = rootDescribedParameter(root, index);
        if (parameter.type !== 'descriptor-table')
          throw Error('D3D12 root descriptor table index is not a table');
        o.state.roots.set(index, { kind: 'table', handle });
        return undefined;
      },
    },
    // SetGraphicsRootConstantBufferView / ShaderResourceView / UnorderedAccessView
    // take a GPU virtual address, which is the guest storage of an upload or
    // default-heap buffer.
    38: {
      argc: 3,
      invoke: (r, a, o) => setRootDescriptor(r, a, o, 'cbv'),
    },
    40: {
      argc: 3,
      invoke: (r, a, o) => setRootDescriptor(r, a, o, 'srv'),
    },
    42: {
      argc: 3,
      invoke: (r, a, o) => setRootDescriptor(r, a, o, 'uav'),
    },
    // SetGraphicsRoot32BitConstant(s)(RootParameterIndex, Value(s), DestOffset).
    // Inline constants are staged by 32-bit constant registers: one DWORD for
    // setGraphicsRoot32BitConstant, a bounded run for 32BitConstants (#33/#35
    // are the compute forms the harness shares).
    34: {
      argc: 4,
      invoke(r, a, o) {
        const index = number(a(1)),
          value = number(a(2)),
          offset = number(a(3));
        const root = o.state.root;
        if (!root) throw Error('D3D12 root constants require a root signature');
        const parameter = rootDescribedParameter(root, index);
        if (parameter.type !== '32-bit-constants')
          throw Error('D3D12 root constants index is not a constants parameter');
        if (offset >= parameter.valueCount)
          throw Error('D3D12 root constant offset exceeds the parameter');
        const entry = o.state.roots.get(index) ?? { kind: 'constants', values: [] };
        entry.values[offset] = value >>> 0;
        o.state.roots.set(index, entry);
        return undefined;
      },
    },
    36: {
      argc: 5,
      invoke(r, a, o) {
        // SetGraphicsRoot32BitConstants(RootParameterIndex, Num32BitValuesToSet,
        //                               pSrcData, DestOffsetIn32BitValues)
        const index = number(a(1)),
          count = number(a(2)),
          valuePtr = number(a(3)),
          offset = number(a(4));
        const root = o.state.root;
        if (!root) throw Error('D3D12 root constants require a root signature');
        const parameter = rootDescribedParameter(root, index);
        if (parameter.type !== '32-bit-constants')
          throw Error('D3D12 root constants index is not a constants parameter');
        if (!count || offset + count > parameter.valueCount)
          throw Error('D3D12 root constant range exceeds the parameter');
        r.check(valuePtr, count * 4);
        const entry = o.state.roots.get(index) ?? { kind: 'constants', values: [] };
        for (let i = 0; i < count; i++) entry.values[offset + i] = u32(r, valuePtr, i * 4);
        o.state.roots.set(index, entry);
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
    // GetType reports the DIRECT command-list type created above.
    8: { argc: 1, invoke: () => 0 },
    // ClearState drops every bound resource/state but keeps the list open and
    // still attached to its allocator, matching D3D12's reuse contract.
    11: {
      argc: 1,
      invoke(_r, _a, o) {
        o.state.pipeline = null;
        o.state.root = null;
        o.state.target = null;
        o.state.depthTarget = null;
        o.state.vertexBuffer = null;
        o.state.indexBuffer = null;
        o.state.viewport = null;
        o.state.scissor = null;
        o.state.topology = 0;
        o.state.descriptorHeaps = [];
        o.state.roots = new Map();
        return undefined;
      },
    },
    // Output-merger blend factor and stencil reference carry no weight for the
    // opaque pipelines this bounded path builds; validate and record nothing.
    23: {
      argc: 2,
      invoke(r, a) {
        const ptr = number(a(1));
        r.check(ptr, 16);
        if (
          ![0, 1, 2, 3].every(
            (i) => Number.isFinite(f32(r, ptr, i * 4)) && f32(r, ptr, i * 4) >= 0 && f32(r, ptr, i * 4) <= 1,
          )
        )
          throw Error('Unsupported D3D12 blend factor');
        return undefined;
      },
    },
    24: { argc: 2, invoke: () => undefined },
    // Stream output is not implemented; the empty-target form is a legal no-op.
    45: {
      argc: 4,
      invoke(_r, a) {
        if (number(a(1))) throw Error('Unsupported D3D12 stream output targets');
        return undefined;
      },
    },
    // DiscardResource marks contents undefined. The renderer always writes full
    // attachments, so the hint needs no work.
    51: {
      argc: 3,
      invoke(r, a, o) {
        object(r, a(1), 'resource', o.state.device);
        return undefined;
      },
    },
    // BeginQuery/EndQuery record a virtual-clock sample for TIMESTAMP queries;
    // OCCLUSION queries count as a fully-visible pass. Values are written at
    // execution time in command order, like the resource copies.
    52: {
      argc: 4,
      invoke(r, a, o) {
        const heap = object(r, a(1), 'query', o.state.device);
        const type = number(a(2)),
          index = number(a(3));
        if (type !== (heap.state.type === 1 ? 2 : 0) || index >= heap.state.count)
          throw Error('Unsupported D3D12 BeginQuery');
        add(o, { type: 'query-begin', heap, queryType: type, index });
        return undefined;
      },
    },
    53: {
      argc: 4,
      invoke(r, a, o) {
        const heap = object(r, a(1), 'query', o.state.device);
        const type = number(a(2)),
          index = number(a(3));
        if (type !== (heap.state.type === 1 ? 2 : 0) || index >= heap.state.count)
          throw Error('Unsupported D3D12 EndQuery');
        add(o, { type: 'query-end', heap, queryType: type, index });
        return undefined;
      },
    },
    // ResolveQueryData(heap, type, start, count, dstBuffer, offset (UINT64)).
    54: {
      argc: 8,
      invoke(r, a, o) {
        const heap = object(r, a(1), 'query', o.state.device);
        const type = number(a(2)),
          start = number(a(3)),
          count = number(a(4));
        const dst = object(r, a(5), 'resource', o.state.device);
        const offsetLow = number(a(6)),
          offsetHigh = number(a(7));
        if (type !== (heap.state.type === 1 ? 2 : 0) || !count || start + count > heap.state.count)
          throw Error('Unsupported D3D12 ResolveQueryData');
        if (dst.state.kind !== 'buffer' || offsetHigh)
          throw Error('Unsupported D3D12 ResolveQueryData destination');
        if (offsetLow + count * 8 > dst.state.size)
          throw Error('D3D12 ResolveQueryData exceeds the destination buffer');
        add(o, { type: 'query-resolve', heap, queryType: type, start, count, dst, offset: offsetLow });
        return undefined;
      },
    },
    // Predication is only accepted in its disabled (null buffer) form.
    55: {
      argc: 4,
      invoke(_r, a) {
        if (number(a(1))) throw Error('Unsupported D3D12 predication');
        return undefined;
      },
    },
    // Debug markers and PIX events are pure annotations.
    56: {
      argc: 3,
      invoke(r, a) {
        if (number(a(2))) r.check(number(a(1)), number(a(2)));
        return undefined;
      },
    },
    57: {
      argc: 3,
      invoke(r, a) {
        if (number(a(2))) r.check(number(a(1)), number(a(2)));
        return undefined;
      },
    },
    58: { argc: 1, invoke: () => undefined },
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
    // GetDesc reconstructs the 56-byte D3D12_RESOURCE_DESC the guest handed
    // the device. Buffers report their byte width; textures report their
    // dimensions, format and depth/stencil flag.
    10: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 56, true);
        r.data.fill(0, out, out + 56);
        if (o.state.kind === 'buffer') {
          r.write32(out, 1); // D3D12_RESOURCE_DIMENSION_BUFFER
          r.write32(out + 16, o.state.size);
          r.write32(out + 24, 1);
          r.view.setUint16(out + 28, 1, true);
          r.view.setUint16(out + 30, 1, true);
          r.write32(out + 36, 1); // SampleDesc.Count
          r.write32(out + 44, 1); // D3D12_TEXTURE_LAYOUT_ROW_MAJOR
        } else {
          const swapchain = o.state.kind === 'color' ? o.state.swapchain : null;
          const width = swapchain ? swapchain.width : o.state.width;
          const height = swapchain ? swapchain.height : o.state.height;
          r.write32(out, 3); // D3D12_RESOURCE_DIMENSION_TEXTURE2D
          r.write32(out + 16, width);
          r.write32(out + 24, height);
          r.view.setUint16(out + 28, 1, true);
          r.view.setUint16(out + 30, 1, true);
          r.write32(
            out + 32,
            o.state.kind === 'depth' ? 55 : o.state.kind === 'texture' ? o.state.format : 28,
          );
          r.write32(out + 36, 1); // SampleDesc.Count
          if (o.state.kind === 'depth') r.write32(out + 48, 2);
        }
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
    // WriteToSubresource/ReadFromSubresource copy between the resource's guest
    // storage and the caller's buffer for buffer resources (the documented
    // destination/source boxes and pitches apply to textures, which this
    // bounded path models only as depth/swap-chain images).
    12: {
      argc: 7,
      invoke(r, a, o) {
        if (o.state.kind !== 'buffer') throw Error('Unsupported D3D12 WriteToSubresource');
        if (number(a(1))) return E_INVALIDARG;
        const src = number(a(2));
        const size = o.state.size;
        r.check(src, size);
        r.data.copyWithin(o.state.storage, src, src + size);
        return S_OK;
      },
    },
    13: {
      argc: 7,
      invoke(r, a, o) {
        if (o.state.kind !== 'buffer') throw Error('Unsupported D3D12 ReadFromSubresource');
        const dst = number(a(1));
        const size = o.state.size;
        r.check(dst, size, true);
        r.data.copyWithin(dst, o.state.storage, o.state.storage + size);
        return S_OK;
      },
    },
    // GetHeapProperties(D3D12_HEAP_PROPERTIES *pHeapProperties, D3D12_HEAP_FLAGS
    // *pHeapFlags): report the heap type the resource was created in.
    14: {
      argc: 3,
      invoke(r, a, o) {
        const props = number(a(1)),
          flags = number(a(2));
        if (props) {
          r.check(props, 20, true);
          r.data.fill(0, props, props + 20);
          r.write32(props, o.state.upload ? 2 : o.state.readback ? 3 : 1);
          r.write32(props + 12, 1);
          r.write32(props + 16, 1);
        }
        if (flags) {
          r.check(flags, 4, true);
          r.write32(flags, 0);
        }
        return S_OK;
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
            plan: p.root.state.plan,
            inputLayout: p.inputLayout,
            vertexStride: p.vertexStride,
            depth: p.depth,
          },
          dev,
          async (o) => requireBackend(r).destroyPipeline({ id: o.pointer }),
        );
        try {
          const created = await requireBackend(r).createPipeline({
            id: item.pointer,
            vertex: p.vertex,
            pixel: p.pixel,
            inputLayout: p.inputLayout,
            vertexStride: p.vertexStride,
            depth: p.depth,
            cullMode: p.cullMode,
            frontFace: p.frontFace,
            // The pipeline's binding layout must follow the root signature the
            // pipeline state was created against.
            rootPlan: p.root.state.plan,
          });
          // Retain the canonical bindings the backend compiled the shaders
          // against, so each draw can resolve its declared registers to bound
          // data without rescanning the shader.
          item.state.bindings = created?.bindings ?? [];
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
            descriptorHeaps: [],
            roots: new Map(),
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
    // CheckFeatureSupport answers the capability probes real applications make
    // at startup from a fixed, honest profile of the implemented backend.
    13: {
      argc: 3,
      invoke(r, a) {
        // COM method: argument(0) is `this`.
        const feature = number(a(1));
        const data = number(a(2));
        const size = number(a(3));
        if (!data || !size) return E_INVALIDARG;
        const write = (bytes, fill) => {
          if (size < bytes) return E_INVALIDARG;
          r.check(data, bytes, true);
          r.data.fill(0, data, data + bytes);
          fill();
          return S_OK;
        };
        switch (feature) {
          case 0: // D3D12_FEATURE_D3D12_OPTIONS (15 DWORDs)
            return write(60, () => {
              r.write32(data + 16, 1); // ResourceBindingTier = TIER_1
              r.write32(data + 36, 32); // MaxGPUVirtualAddressBitsPerResource
              r.write32(data + 56, 1); // ResourceHeapTier = TIER_1
            });
          case 1: {
            // D3D12_FEATURE_DATA_ARCHITECTURE: NodeIndex and the three WINBOOL
            // outputs. Only node 0 exists; the adapter is a discrete-like,
            // non-UMA device as far as this bounded backend is concerned.
            if (size < 16) return E_INVALIDARG;
            r.check(data, 16, true);
            const nodeIndex = u32(r, data);
            if (nodeIndex !== 0) return E_INVALIDARG;
            r.data.fill(0, data, data + 16);
            return S_OK;
          }
          case 2: {
            // D3D12_FEATURE_DATA_FEATURE_LEVELS; clamp to what the translator
            // actually compiles (SM5 DXBC, feature level 11_0).
            if (size < 12) return E_INVALIDARG;
            r.check(data, 12, true);
            const count = u32(r, data);
            const list = u32(r, data + 4);
            if (!count || count > 16 || !list) return E_INVALIDARG;
            r.check(list, count * 4);
            let best = 0;
            for (let i = 0; i < count; i++) {
              const level = u32(r, list, i * 4);
              if (level <= 0xb000 && level > best) best = level;
            }
            r.data.fill(0, data, data + 12);
            r.write32(data, count);
            r.write32(data + 4, list);
            r.write32(data + 8, best || 0xb000);
            return S_OK;
          }
          case 6: // GPU_VIRTUAL_ADDRESS_SUPPORT
            return write(8, () => {
              r.write32(data, 32);
              r.write32(data + 4, 32);
            });
          case 7: // SHADER_MODEL
            return write(4, () => r.write32(data, 0x51)); // D3D_SHADER_MODEL_5_1
          case 3: {
            // D3D12_FEATURE_DATA_FORMAT_SUPPORT: the caller supplies Format and
            // receives the support masks. Answer only for the formats the
            // bounded renderer actually accepts.
            if (size < 12) return E_INVALIDARG;
            r.check(data, 12, true);
            const format = u32(r, data);
            const support = FORMAT_SUPPORT[format] ?? 0;
            r.write32(data + 4, support & 0xffffffff);
            r.write32(data + 8, 0);
            return S_OK;
          }
          case 4: {
            // D3D12_FEATURE_DATA_MULTISAMPLE_QUALITY_LEVELS. Only single
            // sampling is implemented, so counts above one report no levels.
            if (size < 16) return E_INVALIDARG;
            r.check(data, 16, true);
            const sampleCount = u32(r, data + 4);
            r.write32(data + 12, sampleCount === 1 ? 1 : 0);
            return S_OK;
          }
          case 8: // D3D12_FEATURE_DATA_D3D12_OPTIONS1: no wave ops advertised.
            return write(24, () => {});
          case 19: // D3D12_FEATURE_DATA_SHADER_CACHE: caching is not exposed.
            return write(4, () => {});
          case 22: // D3D12_FEATURE_DATA_EXISTING_HEAPS: not supported.
            return write(4, () => r.write32(data, 0));
          case 12: // ROOT_SIGNATURE
            return write(4, () => r.write32(data, 1)); // D3D_ROOT_SIGNATURE_VERSION_1
          default:
            return E_INVALIDARG;
        }
      },
    },
    14: child(
      'heap',
      4,
      (r, a, dev) => {
        const p = number(a(1));
        r.check(p, 16);
        // D3D12_DESCRIPTOR_HEAP_DESC: Type, NumDescriptors, Flags, NodeMask.
        // Type 0 is CBV_SRV_UAV, 1 SAMPLER, 2 RTV, 3 DSV. Flags must be NONE or
        // SHADER_VISIBLE; the runtime owns the descriptor storage itself.
        const type = u32(r, p),
          count = u32(r, p, 4),
          flags = u32(r, p, 8),
          nodeMask = u32(r, p, 12);
        if (type > 3 || count < 1 || count > 256 || flags & ~1 || nodeMask & ~1)
          return E_INVALIDARG;
        const base = r.allocate(count * 4);
        return { base, count, device: dev, type, shaderVisible: !!(flags & 1) };
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
        // GetGPUDescriptorHandleForHeapStart returns the same slot address as a
        // 64-bit GPU handle; the runtime has no separate GPU address space.
        10: {
          argc: 2,
          invoke(r, a, o) {
            const out = number(a(1));
            r.check(out, 8, true);
            r.write32(out, o.state.base);
            r.write32(out + 4, 0);
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
      // Descriptor handles are guest addresses of 4-byte slots in our table,
      // so the increment reported for every heap type stays 4.
      argc: 2,
      invoke(_r, a) {
        return number(a(1)) <= 3 ? 4 : 0;
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
        const backend = requireBackend(r);
        // Inspecting both validates the container and yields the structure the
        // command list needs to resolve each shader descriptor's register to a
        // root parameter, and that the pipeline needs to derive its canonical
        // WebGPU binding layout. The signature may be any version 1.0 shape.
        const inspected = await backend.inspectRootSignature(raw);
        const plan = planRootSignature(decodeRootSignatureWords(inspected.words));
        const item = make(r, 'root', {}, { device: dev, flags: inspected.flags, plan }, dev);
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
    // CreateConstantBufferView(const D3D12_CONSTANT_BUFFER_VIEW_DESC *pDesc,
    //                         D3D12_CPU_DESCRIPTOR_HANDLE DestDescriptor)
    17: {
      argc: 3,
      invoke(r, a, dev) {
        const desc = number(a(1)),
          handle = number(a(2));
        const slot = viewSlot(r, dev, handle, 0);
        if (!slot) return E_INVALIDARG;
        r.check(desc, 16);
        const location = u32(r, desc),
          locationHigh = u32(r, desc, 4),
          size = u32(r, desc, 8);
        if (locationHigh) return E_INVALIDARG;
        const resource = uploadAt(r, location, 1, dev);
        if (size < 1 || location + size > resource.state.storage + resource.state.size)
          return E_INVALIDARG;
        slot.kind = 'cbv';
        slot.resource = resource;
        slot.offset = location - resource.state.storage;
        slot.size = size;
        return S_OK;
      },
    },
    // CreateShaderResourceView(ID3D12Resource *pResource,
    //                          const D3D12_SHADER_RESOURCE_VIEW_DESC *pDesc,
    //                          D3D12_CPU_DESCRIPTOR_HANDLE DestDescriptor)
    18: {
      argc: 4,
      invoke(r, a, dev) {
        const resource = object(r, a(1), 'resource', dev);
        const desc = number(a(2)),
          handle = number(a(3));
        const slot = viewSlot(r, dev, handle, 0);
        if (!slot) return E_INVALIDARG;
        if (resource.state.kind !== 'buffer' && resource.state.kind !== 'texture')
          return E_INVALIDARG;
        let format = 0,
          dimension = 0,
          componentMapping = 0;
        if (desc) {
          r.check(desc, 40);
          format = u32(r, desc);
          dimension = u32(r, desc, 4);
          componentMapping = u32(r, desc, 8);
          if (dimension === 1) {
            if (resource.state.kind !== 'buffer') return E_INVALIDARG;
            // D3D12_BUFFER_SRV: FirstElement, NumElements, StructureByteStride.
            r.check(desc + 16, 24);
            const first = u32(r, desc, 16),
              count = u32(r, desc, 24),
              stride = u32(r, desc, 28);
            if (first + count > resource.state.size) return E_INVALIDARG;
            slot.firstElement = first;
            slot.elementCount = count;
            slot.stride = stride;
          } else if (dimension === 4) {
            // D3D12_TEX2D_SRV: MostDetailedMip, MipLevels, PlaneSlice,
            // ResourceMinLODClamp. Only a full single-mip view is modelled.
            if (resource.state.kind !== 'texture') return E_INVALIDARG;
            r.check(desc + 16, 20);
            if (u32(r, desc, 16) || u32(r, desc, 24) || u32(r, desc, 28) ||
                f32(r, desc, 32) !== 0)
              return E_INVALIDARG;
            if (format && format !== resource.state.format) return E_INVALIDARG;
            format = resource.state.format;
          } else {
            return E_INVALIDARG; // Only BUFFER and TEXTURE2D are modeled.
          }
        } else if (resource.state.kind !== 'buffer') {
          // A null description on a 2D texture is the typed default view.
          format = resource.state.format;
          dimension = 4;
        }
        slot.kind = 'srv';
        slot.resource = resource;
        slot.format = format;
        slot.dimension = dimension;
        slot.componentMapping = componentMapping;
        return S_OK;
      },
    },
    // CreateUnorderedAccessView(ID3D12Resource *pResource,
    //                           ID3D12Resource *pCounterResource,
    //                           const D3D12_UNORDERED_ACCESS_VIEW_DESC *pDesc,
    //                           D3D12_CPU_DESCRIPTOR_HANDLE DestDescriptor)
    19: {
      argc: 5,
      invoke(r, a, dev) {
        const resource = object(r, a(1), 'resource', dev);
        const counter = a(2) ? object(r, a(2), 'resource', dev) : null;
        const desc = number(a(3)),
          handle = number(a(4));
        const slot = viewSlot(r, dev, handle, 0);
        if (!slot || resource.state.kind !== 'buffer') return E_INVALIDARG;
        if (counter && counter.state.kind !== 'buffer') return E_INVALIDARG;
        let format = 0,
          dimension = 0;
        if (desc) {
          r.check(desc, 40);
          format = u32(r, desc);
          dimension = u32(r, desc, 4);
          if (dimension === 1) {
            const first = u32(r, desc, 8),
              count = u32(r, desc, 16),
              stride = u32(r, desc, 20);
            if (first + count > resource.state.size) return E_INVALIDARG;
            slot.firstElement = first;
            slot.elementCount = count;
            slot.stride = stride;
          } else if (dimension !== 4) {
            return E_INVALIDARG;
          }
        }
        slot.kind = 'uav';
        slot.resource = resource;
        slot.counter = counter;
        slot.format = format;
        slot.dimension = dimension;
        return S_OK;
      },
    },
    // CreateSampler(const D3D12_SAMPLER_DESC *pDesc,
    //               D3D12_CPU_DESCRIPTOR_HANDLE DestDescriptor)
    22: {
      argc: 3,
      invoke(r, a, dev) {
        const desc = number(a(1)),
          handle = number(a(2));
        const slot = viewSlot(r, dev, handle, 1);
        if (!slot) return E_INVALIDARG;
        r.check(desc, 52);
        slot.kind = 'sampler';
        // Retain the raw description so a future sampler path can read it back.
        slot.sampler = r.data.slice(desc, desc + 52);
        return S_OK;
      },
    },
    // CreateQueryHeap(const D3D12_QUERY_HEAP_DESC *pDesc, REFIID, void **).
    // D3D12_QUERY_HEAP_TYPE_OCCLUSION(0)/TIMESTAMP(1); 12-byte descriptor.
    39: child(
      'query',
      4,
      (r, a, dev) => {
        const p = number(a(1));
        r.check(p, 12);
        const type = u32(r, p),
          count = u32(r, p, 4),
          nodeMask = u32(r, p + (8));
        if (type > 1 || !count || count > 4096 || nodeMask > 1) return E_INVALIDARG;
        return { type, count, values: new Array(count).fill(0n) };
      },
    ),
    // SetStablePowerState(BOOL Enable) is a developer-only hint.
    40: { argc: 2, invoke: () => S_OK },
    // CopyDescriptorsSimple: duplicate `count` descriptors between two heap
    // slots of the same type.
    24: {
      argc: 5,
      invoke(r, a, dev) {
        const count = number(a(1)),
          dst = number(a(2)),
          src = number(a(3)),
          type = number(a(4));
        if (!count || count > 256) return E_INVALIDARG;
        return copyDescriptorRange(r, dev, type, dst, src, count);
      },
    },
    // CopyDescriptors: the ranged form. Destination and source ranges must
    // describe the same total number of descriptors.
    23: {
      argc: 8,
      invoke(r, a, dev) {
        const dstCount = number(a(1)),
          dstOffsets = number(a(2)),
          dstSizes = number(a(3)),
          srcCount = number(a(4)),
          srcOffsets = number(a(5)),
          srcSizes = number(a(6)),
          type = number(a(7));
        if (!dstCount || dstCount > 16 || !srcCount || srcCount > 16) return E_INVALIDARG;
        r.check(dstOffsets, dstCount * 4);
        r.check(dstSizes, dstCount * 4);
        r.check(srcOffsets, srcCount * 4);
        r.check(srcSizes, srcCount * 4);
        const ranges = (offsets, sizes, count) =>
          Array.from({ length: count }, (_, i) => ({
            handle: u32(r, offsets, i * 4),
            size: u32(r, sizes, i * 4),
          }));
        const destinations = ranges(dstOffsets, dstSizes, dstCount);
        const sources = ranges(srcOffsets, srcSizes, srcCount);
        if (destinations.some((entry) => !entry.size) || sources.some((entry) => !entry.size))
          return E_INVALIDARG;
        const total = (list) => list.reduce((sum, entry) => sum + entry.size, 0);
        if (total(destinations) !== total(sources)) return E_INVALIDARG;
        let srcIndex = 0,
          srcOffset = 0;
        for (const destination of destinations) {
          let remaining = destination.size,
            dstHandle = destination.handle;
          while (remaining) {
            const source = sources[srcIndex];
            const take = Math.min(remaining, source.size - srcOffset);
            const result = copyDescriptorRange(
              r,
              dev,
              type,
              dstHandle,
              source.handle + srcOffset * 4,
              take,
            );
            if (result !== S_OK) return result;
            dstHandle += take * 4;
            remaining -= take;
            srcOffset += take;
            if (srcOffset === source.size) {
              srcIndex++;
              srcOffset = 0;
            }
          }
        }
        return S_OK;
      },
    },
    // GetResourceAllocationInfo uses the WIDL aggregate-return ABI: the caller
    // supplies the 16-byte output as the first argument.
    25: {
      argc: 5,
      invoke(r, a) {
        const out = number(a(1));
        const count = number(a(3));
        if (!out || !count || count > 8) return E_INVALIDARG;
        const descs = number(a(4));
        r.check(descs, count * 56);
        let size = 0;
        for (let i = 0; i < count; i++) {
          const dimension = u32(r, descs, i * 56);
          if (dimension === 1) size += u32(r, descs, i * 56 + 16);
          else return E_INVALIDARG;
        }
        r.check(out, 16, true);
        r.data.fill(0, out, out + 16);
        r.write32(out, size);
        r.write32(out + 4, 1); // Alignment.
        return undefined;
      },
    },
    // GetCustomHeapProperties also returns a struct by hidden pointer.
    26: {
      argc: 4,
      invoke(r, a) {
        const out = number(a(1));
        const nodeMask = number(a(2));
        const heapType = number(a(3));
        if (!out || nodeMask !== 1 || ![1, 2, 3].includes(heapType)) return E_INVALIDARG;
        r.check(out, 20, true);
        r.data.fill(0, out, out + 20);
        r.write32(out, heapType);
        r.write32(out + 12, 1); // CreationNodeMask.
        r.write32(out + 16, 1); // VisibleNodeMask.
        return undefined;
      },
    },
    // GetCopyableFootprints(desc, first_sub_resource, sub_resource_count,
    //                       base_offset (UINT64), layouts, row_count,
    //                       row_size, total_bytes). Buffers and mip-0 2D
    // textures get the documented 256-byte row alignment.
    38: {
      argc: 10,
      invoke(r, a) {
        const desc = number(a(1)),
          first = number(a(2)),
          count = number(a(3)),
          offsetLow = number(a(4)),
          offsetHigh = number(a(5));
        if (!desc || !count || count > 16 || first || offsetHigh) return E_INVALIDARG;
        r.check(desc, 56);
        const layouts = number(a(6)),
          rowCountOut = number(a(7)),
          rowSizeOut = number(a(8)),
          totalOut = number(a(9));
        if (layouts) r.check(layouts, count * 32);
        if (rowCountOut) r.check(rowCountOut, count * 4, true);
        if (rowSizeOut) r.check(rowSizeOut, count * 8, true);
        if (totalOut) r.check(totalOut, 8, true);
        const dimension = u32(r, desc);
        const width = u32(r, desc, 16),
          height = u32(r, desc, 24),
          format = u32(r, desc, 32);
        const align256 = (value) => (value + 255) & ~255;
        const pieces = [];
        if (dimension === 1) {
          if (!width) return E_INVALIDARG;
          pieces.push({ width, height: 1, rowPitch: align256(width), rowSize: width });
        } else if (dimension === 3) {
          const bpp = TEXTURE_FORMAT_BYTES[format];
          if (!bpp || !width || !height || count !== 1) return E_INVALIDARG;
          const rowSize = width * bpp;
          pieces.push({ width, height, rowPitch: align256(rowSize), rowSize });
        } else return E_INVALIDARG;
        let offset = offsetLow;
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i];
          if (layouts) {
            r.write32(layouts + i * 32, offset);
            r.write32(layouts + i * 32 + 4, 0);
            r.write32(layouts + i * 32 + 8, dimension === 1 ? 0 : format);
            r.write32(layouts + i * 32 + 12, piece.width);
            r.write32(layouts + i * 32 + 16, piece.height);
            r.write32(layouts + i * 32 + 20, 1);
            r.write32(layouts + i * 32 + 24, piece.rowPitch);
          }
          if (rowCountOut) r.write32(rowCountOut + i * 4, piece.height);
          if (rowSizeOut) {
            r.write32(rowSizeOut + i * 8, piece.rowSize);
            r.write32(rowSizeOut + i * 8 + 4, 0);
          }
          offset += piece.rowPitch * piece.height;
        }
        if (totalOut) {
          r.write32(totalOut, offset);
          r.write32(totalOut + 4, 0);
        }
        return undefined;
      },
    },
    // Residency is a hint; every object is already resident in this bounded
    // model, so both calls validate the list and succeed.
    34: {
      argc: 3,
      invoke(r, a, dev) {
        const count = number(a(1)),
          list = number(a(2));
        if (count > 16) return E_INVALIDARG;
        if (count) {
          r.check(list, count * 4);
          for (let i = 0; i < count; i++) object(r, u32(r, list, i * 4), 'resource', dev);
        }
        return S_OK;
      },
    },
    35: {
      argc: 3,
      invoke(r, a, dev) {
        const count = number(a(1)),
          list = number(a(2));
        if (count > 16) return E_INVALIDARG;
        if (count) {
          r.check(list, count * 4);
          for (let i = 0; i < count; i++) object(r, u32(r, list, i * 4), 'resource', dev);
        }
        return S_OK;
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
              if (o.state.kind === 'depth' || o.state.kind === 'texture')
                await requireBackend(r).destroyResource({ id: o.pointer });
              else if (o.state.kind === 'buffer') r.free(o.state.storage);
            },
          );
        } catch (error) {
          if (info.kind === 'buffer') r.free(info.storage);
          throw error;
        }
        try {
          if (info.kind === 'depth' || info.kind === 'texture') {
            const backend = requireBackend(r);
            if (!backend.createResource || !backend.destroyResource)
              throw Error('D3D12 texture backend is unavailable');
            await backend.createResource({
              id: item.pointer,
              kind: info.kind,
              width: info.width,
              height: info.height,
              format: info.kind === 'depth' ? info.format : WEBGPU_FORMAT[info.format],
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
    // CreateSharedHandle(object, attributes, access, name, HANDLE *): only
    // unnamed, in-process sharing is modeled. The handle is a synthetic value
    // that OpenSharedHandle maps back to the same COM object.
    31: {
      argc: 6,
      invoke(r, a, dev) {
        const target = object(r, a(1), 'resource', dev);
        if (number(a(2)) || number(a(3)) || number(a(4)))
          throw Error('Unsupported D3D12 named or secured shared handle');
        const out = number(a(5));
        r.check(out, 4, true);
        const state12 = state(r);
        if (state12.nextSharedHandle >= 0xbfffffff)
          throw Error('D3D12 shared handle limit exceeded');
        const handle = state12.nextSharedHandle++;
        state12.sharedHandles.set(handle, target);
        r.write32(out, handle);
        return S_OK;
      },
    },
    32: {
      argc: 4,
      invoke(r, a, dev) {
        const out = number(a(3));
        output(r, out);
        if (!iid(r, a(2), 'resource')) return E_NOINTERFACE;
        const target = state(r).sharedHandles.get(number(a(1)));
        if (!target || !target.refs) return E_INVALIDARG;
        if (target.state.device !== dev) throw Error('Shared handle belongs to another device');
        if (target.refs >= 0x7fffffff) throw Error('D3D12 resource reference limit exceeded');
        target.refs++;
        r.write32(out, target.pointer);
        return S_OK;
      },
    },
    33: {
      // OpenSharedHandleByName is not modeled: no cross-process name table.
      argc: 4,
      invoke(r, a) {
        if (number(a(2))) output(r, number(a(2)));
        return E_INVALIDARG;
      },
    },
    // GetResourceTiling(resource, totalTileCount, packedMipInfo, tileShape,
    //                   subresourceTilingCount, firstSubresource, tilings).
    // Every modeled resource is committed, never reserved/tiled.
    42: {
      argc: 8,
      invoke(r, a, dev) {
        object(r, a(1), 'resource', dev);
        const total = number(a(2)),
          packed = number(a(3)),
          shape = number(a(4)),
          count = number(a(5)),
          first = number(a(6)),
          tilings = number(a(7));
        if (first) return E_INVALIDARG;
        if (total) {
          r.check(total, 4, true);
          r.write32(total, 0);
        }
        if (packed) {
          r.check(packed, 12, true);
          r.data.fill(0, packed, packed + 12);
        }
        if (shape) {
          // A fixed 64 KiB tile shape for the modeled formats.
          r.check(shape, 12, true);
          r.write32(shape, 256);
          r.write32(shape + 4, 256);
          r.write32(shape + 8, 1);
        }
        if (count) {
          r.check(count, 4, true);
          r.write32(count, 0);
        }
        if (tilings) return E_INVALIDARG; // No subresources are tiled.
        return undefined;
      },
    },
    // A removed device is never simulated; the reason is always S_OK.
    37: { argc: 1, invoke: () => S_OK },
    // GetAdapterLuid: the default adapter's stable synthetic LUID.
    43: {
      argc: 2,
      invoke(r, a) {
        const out = number(a(1));
        r.check(out, 8, true);
        r.write32(out, ADAPTER_LUID & 0xffffffff);
        r.write32(out + 4, ADAPTER_LUID_HIGH);
        return undefined;
      },
    },
  };
}
function fenceMethods() {
  const readValue = (a) => (BigInt(number(a(2))) << 32n) | BigInt(number(a(1)));
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
    // SetEventOnCompletion(Value, HANDLE): fences complete synchronously in
    // this model, so a value at or below the current one signals the event now;
    // a higher value is retained and signalled when a later Signal/Wait
    // reaches it. Only one waiter is tracked per fence.
    9: {
      argc: 4,
      invoke(r, a, o) {
        const value = readValue(a);
        const event = number(a(3));
        if (!event) return E_INVALIDARG;
        if (value <= o.state.value) r.syncObjects?.signal(event);
        else o.state.waiters ??= [], o.state.waiters.push({ value, event });
        return S_OK;
      },
    },
    // Signal(Value): raise the fence and release any reached waiters.
    10: {
      argc: 3,
      invoke(r, a, o) {
        const value = readValue(a);
        if (value < o.state.value) return E_INVALIDARG;
        o.state.value = value;
        for (const waiter of o.state.waiters ?? []) if (waiter.value <= value) r.syncObjects?.signal(waiter.event);
        if (o.state.waiters) o.state.waiters = o.state.waiters.filter((w) => w.value > value);
        return S_OK;
      },
    },
  };
}
function queueMethods() {
  return {
    // Debug markers carry no rendering semantics.
    11: {
      argc: 4,
      invoke(r, a) {
        const size = number(a(3));
        if (size) r.check(number(a(2)), size);
        return undefined;
      },
    },
    12: {
      argc: 4,
      invoke(r, a) {
        const size = number(a(3));
        if (size) r.check(number(a(2)), size);
        return undefined;
      },
    },
    13: { argc: 1, invoke: () => undefined },
    // GetTimestampFrequency(UINT64 *pFrequency): one tick per virtual
    // nanosecond, matching the guest performance clock and RDTSC.
    16: {
      argc: 2,
      invoke(r, a) {
        const out = number(a(1));
        r.check(out, 8, true);
        r.write32(out, 0x40000000);
        r.write32(out + 4, 0x3b9aca00); // 1,000,000,000
        return S_OK;
      },
    },
    // GetClockCalibration(UINT64 *pGpuTimestamp, UINT64 *pCpuTimestamp): both
    // domains read the same monotonic guest clock.
    17: {
      argc: 3,
      invoke(r, a) {
        const gpu = number(a(1)),
          cpu = number(a(2));
        const now = r.performanceClock ? r.performanceClock.read() : 0n;
        for (const out of [gpu, cpu]) {
          if (!out) continue;
          r.check(out, 8, true);
          const ticks = BigInt.asUintN(64, now);
          r.write32(out, Number(ticks & 0xffffffffn) >>> 0);
          r.write32(out + 4, Number(ticks >> 32n) >>> 0);
        }
        return S_OK;
      },
    },
    18: {
      argc: 2,
      invoke(r, a, q) {
        const out = number(a(1));
        r.check(out, 16, true);
        r.data.fill(0, out, out + 16);
        return undefined;
      },
    },
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
            } else if (c.type === 'copy-texture') {
              const dst = object(r, c.dst.pointer, 'resource', q.state.device);
              const src = object(r, c.src.pointer, 'resource', q.state.device);
              if (dst.state.kind !== 'texture' || src.state.kind !== 'buffer')
                throw Error('D3D12 CopyTextureRegion requires a texture and a buffer');
              const dstState = states.get(dst) ?? dst.state.state;
              const srcState = states.get(src) ?? src.state.state;
              if (![0, 0x400].includes(dstState))
                throw Error('D3D12 CopyTextureRegion destination is not copyable');
              if (!(srcState & 0x800))
                throw Error('D3D12 CopyTextureRegion source is not an upload buffer');
              const { bytesPerRow, height, totalBytes, offset } = c.footprint;
              if (offset + totalBytes > src.state.size)
                throw Error('D3D12 texture upload exceeds the source buffer');
              const rows = r.data.slice(
                src.state.storage + offset,
                src.state.storage + offset + totalBytes,
              );
              await requireBackend(r).uploadTexture({
                id: dst.pointer,
                width: c.footprint.width,
                height,
                bytesPerRow,
                rows,
              });
            } else if (c.type === 'copy-buffer') {
              // The canonical upload pattern: Map an upload-heap buffer, write
              // bytes, unmap, then CopyBufferRegion into a default-heap buffer
              // before a state transition makes it shader-readable. The copy
              // runs in command order against the guest storage, so a later
              // vertex/index view that points at the default buffer sees it.
              const dst = object(r, c.dst.pointer, 'resource', q.state.device);
              const src = object(r, c.src.pointer, 'resource', q.state.device);
              if (dst.state.kind !== 'buffer' || src.state.kind !== 'buffer')
                throw Error('D3D12 CopyBufferRegion requires buffers');
              const dstState = states.get(dst) ?? dst.state.state;
              const srcState = states.get(src) ?? src.state.state;
              if (![0, 0x400].includes(dstState))
                throw Error('D3D12 CopyBufferRegion destination is not in a copyable state');
              if (![0x800, 0xac3].includes(srcState))
                throw Error('D3D12 CopyBufferRegion source is not in a copyable state');
              if (
                c.dstOffset + c.size > dst.state.size ||
                c.srcOffset + c.size > src.state.size
              )
                throw Error('D3D12 CopyBufferRegion exceeds a resource');
              const from = src.state.storage + c.srcOffset;
              const to = dst.state.storage + c.dstOffset;
              r.data.copyWithin(to, from, from + c.size);
            } else if (c.type === 'query-begin' || c.type === 'query-end') {
              // A TIMESTAMP query samples the monotonic guest clock; an
              // OCCLUSION pair counts as a fully-visible pass.
              const heap = object(r, c.heap.pointer, 'query', q.state.device);
              if (c.queryType === 2)
                heap.state.values[c.index] = r.performanceClock ? r.performanceClock.read() : 0n;
              else if (c.type === 'query-begin') heap.state.values[c.index] = 0xffffffffn;
            } else if (c.type === 'query-resolve') {
              const heap = object(r, c.heap.pointer, 'query', q.state.device);
              const dst = object(r, c.dst.pointer, 'resource', q.state.device);
              if (dst.state.kind !== 'buffer')
                throw Error('D3D12 ResolveQueryData requires a buffer');
              for (let i = 0; i < c.count; i++) {
                const value = BigInt.asUintN(64, heap.state.values[c.start + i] ?? 0n);
                const at = dst.state.storage + c.offset + i * 8;
                r.write32(at, Number(value & 0xffffffffn) >>> 0);
                r.write32(at + 4, Number(value >> 32n) >>> 0);
              }
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
        for (const waiter of fence.state.waiters ?? []) if (waiter.value <= value) r.syncObjects?.signal(waiter.event);
        if (fence.state.waiters) fence.state.waiters = fence.state.waiters.filter((w) => w.value > value);
        return S_OK;
      },
    },
  };
}
export const d3d12Apis = {
  'd3d12.dll!D3D12CreateDevice': (r, a) => {
    // A NULL adapter selects the default hardware adapter; a NULL output is the
    // documented capability probe that must not create a device.
    const adapter = number(a(0));
    if (adapter) {
      const item = r.comObjects?.objects.get(adapter);
      if (!item || !item.refs || item.name !== name.adapter)
        return { result: E_INVALIDARG, argc: 4 };
    }
    const out = number(a(3));
    if (out) output(r, out);
    if (number(a(1)) !== 0xb000) return { result: E_INVALIDARG, argc: 4 };
    if (!iid(r, a(2), 'device')) return { result: E_NOINTERFACE, argc: 4 };
    if (!out) return { result: S_OK, argc: 4 };
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
    // The application's own description is honoured: parse the guest
    // D3D12_ROOT_SIGNATURE_DESC into the flattened layout the shader bridge
    // builds, then serialize that into a real DXBC container.
    if (number(a(1)) !== 1) return { result: E_INVALIDARG, argc: 4 };
    requireBackend(r);
    state(r);
    const words = parseRootSignatureDescriptor({
      check: r.check.bind(r),
      read32: r.read32.bind(r),
      readFloat32: (pointer) => r.view.getFloat32(r.check(pointer, 4), true),
      pointer: p,
    });
    if (!words) return { result: E_INVALIDARG, argc: 4 };
    const raw = await r.graphics12.buildRootSignature(words);
    if (!(raw instanceof Uint8Array) || !raw.length || raw.length > MAX_BYTES)
      throw Error('D3D12 backend returned invalid root signature blob');
    r.write32(out, createBlob(r, raw).pointer);
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
// DXGI_ADAPTER_DESC1 is 296 bytes on i386: a WCHAR[128] description, four
// UINT ids, three SIZE_T memory counts, an 8-byte LUID and a flags word.
function writeAdapterDesc(r, ptr, withFlags, warp) {
  const size = withFlags ? 296 : 292;
  r.check(ptr, size, true);
  r.data.fill(0, ptr, ptr + size);
  for (const [i, ch] of [...'WineBrowser WebGPU Adapter'].entries())
    r.view.setUint16(ptr + i * 2, ch.charCodeAt(0), true);
  r.write32(ptr + 256, 0x1af4); // VendorId.
  r.write32(ptr + 260, 0x1050); // DeviceId.
  r.write32(ptr + 272, 0x40000000); // DedicatedVideoMemory.
  r.write32(ptr + 280, 0x40000000); // SharedSystemMemory.
  if (withFlags) r.write32(ptr + 292, warp ? 2 : 0); // DXGI_ADAPTER_FLAG_SOFTWARE.
  return S_OK;
}

// DXGI_SWAP_CHAIN_DESC1 is 48 bytes; the same offscreen swap chain backend is
// reused with the FLIP_DISCARD defaults the modern samples request.
function swapchainDesc1(r, ptr, windowId) {
  r.check(ptr, 48);
  if (!r.windows?.windows?.has(windowId))
    throw Error('DXGI swap chain window is not a live guest window');
  const width = u32(r, ptr),
    height = u32(r, ptr, 4);
  if (
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    u32(r, ptr, 8) !== 28 ||
    u32(r, ptr, 12) ||
    u32(r, ptr, 16) !== 1 ||
    u32(r, ptr, 20) ||
    u32(r, ptr, 24) !== 0x20 ||
    u32(r, ptr, 28) !== 2 ||
    u32(r, ptr, 32) ||
    u32(r, ptr, 36) !== 4 ||
    u32(r, ptr, 40) ||
    u32(r, ptr, 44)
  )
    throw Error('Unsupported DXGI swap chain description 1');
  return { windowId, width, height };
}

// Shared creation path for IDXGIFactory.CreateSwapChain and the ForHwnd variant.
async function createSwapChain(rt, self, queue, desc, result) {
  output(rt, result);
  const s = make(
    rt,
    'swapchain',
    swapchainMethods(),
    {
      queue,
      index: 0,
      buffers: [],
      width: desc.width,
      height: desc.height,
      windowId: desc.windowId,
    },
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
}

// The virtual desktop exposes exactly one hardware adapter. A second
// enumeration returns DXGI_ERROR_NOT_FOUND, which ends the sample's loop.
function enumAdapter(r, index, out, self) {
  output(r, out);
  if (index !== 0) return 0x887a0002;
  const adapter = make(r, 'adapter', adapterMethods(), {}, self);
  r.write32(out, adapter.pointer);
  return S_OK;
}

function factoryMethods() {
  return {
    7: {
      argc: 3,
      invoke: (r, a, self) => enumAdapter(r, number(a(1)), number(a(2)), self),
    },
    8: {
      argc: 3,
      invoke(r, a, self) {
        const win = r.windows?.windows?.get(number(a(1)));
        // DXGI_MWA_VALID is 0x7; DXGI_MWA_NO_ALT_ENTER (0x2) is what the
        // Microsoft samples request, and all three no-op flags are accepted.
        if (!win || number(a(2)) & ~0x07) return E_INVALIDARG;
        self.state.windowAssociation = number(a(1));
        return S_OK;
      },
    },
    9: {
      argc: 2,
      invoke(r, a, self) {
        output(r, number(a(1)));
        r.write32(number(a(1)), self.state.windowAssociation ?? 0);
        return S_OK;
      },
    },
    10: {
      argc: 4,
      async invoke(rt, arg, self) {
        const queue = object(rt, arg(1), 'queue');
        return createSwapChain(rt, self, queue, swapchainDesc(rt, number(arg(2))), number(arg(3)));
      },
    },
    12: {
      argc: 3,
      invoke: (r, a, self) => enumAdapter(r, number(a(1)), number(a(2)), self),
    },
    13: {
      argc: 1,
      invoke: (_r, _a, self) => (self.state.current === false ? 0 : 1),
    },
    15: {
      argc: 7,
      async invoke(rt, arg, self) {
        if (number(arg(4)) || number(arg(5)))
          throw Error('Unsupported DXGI swap chain fullscreen or output restriction');
        const windowId = number(arg(2));
        if (!rt.windows?.windows?.has(windowId)) return E_INVALIDARG;
        const queue = object(rt, arg(1), 'queue');
        return createSwapChain(
          rt,
          self,
          queue,
          swapchainDesc1(rt, number(arg(3)), windowId),
          number(arg(6)),
        );
      },
    },
    25: {
      argc: 1,
      invoke: (_r, _a, self) => self.state.creationFlags ?? 0,
    },
    27: {
      // EnumWarpAdapter(IID, void **) — the software adapter is exposed only
      // when explicitly requested, and it carries the software flag.
      argc: 3,
      invoke(rt, arg, self) {
        const out = number(arg(2));
        output(rt, out);
        if (!iid(rt, arg(1), 'adapter')) return E_NOINTERFACE;
        const adapter = make(rt, 'adapter', adapterMethods(), { warp: true }, self);
        rt.write32(out, adapter.pointer);
        return S_OK;
      },
    },
  };
}

function adapterMethods() {
  return {
    7: {
      // EnumOutputs(Output, IDXGIOutput **) — no outputs on the virtual adapter.
      argc: 3,
      invoke: (r, a) => {
        output(r, number(a(2)));
        return 0x887a0002;
      },
    },
    8: {
      argc: 2,
      invoke: (r, a) => writeAdapterDesc(r, number(a(1)), false, false),
    },
    9: {
      argc: 3,
      invoke(r, a) {
        output(r, number(a(2)));
        return number(a(1)) === 0xb000 ? S_OK : E_INVALIDARG;
      },
    },
    10: {
      argc: 2,
      invoke: (r, a, self) => writeAdapterDesc(r, number(a(1)), true, !!self.state.warp),
    },
  };
}

const createFactoryApi = (argc, flagsIndex, iidIndex, outIndex) => (r, a) => {
  const out = number(a(outIndex));
  output(r, out);
  if (
    ![iids.factoryBase, iids.factory1, iids.factory2, iids.factory3, iids.factory4].includes(
      readGuid(r, number(a(iidIndex))),
    )
  )
    return { result: E_NOINTERFACE, argc };
  const flags = flagsIndex === null ? 0 : number(a(flagsIndex));
  // Only DXGI_CREATE_FACTORY_DEBUG is defined and it is a no-op for the harness.
  if (flags & ~1) return { result: E_INVALIDARG, argc };
  requireBackend(r);
  state(r);
  const factory = make(r, 'factory', factoryMethods(), { creationFlags: flags }, null);
  r.write32(out, factory.pointer);
  return { result: S_OK, argc };
};

export const dxgiApis = {
  'dxgi.dll!CreateDXGIFactory': createFactoryApi(2, null, 0, 1),
  'dxgi.dll!CreateDXGIFactory1': createFactoryApi(2, null, 0, 1),
  'dxgi.dll!CreateDXGIFactory2': createFactoryApi(3, 0, 1, 2),
};
