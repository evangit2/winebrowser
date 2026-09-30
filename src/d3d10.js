// Bounded PE32 Direct3D 10 frontend. Slot order, argument counts and struct
// offsets are taken from the i686-w64-mingw32 d3d10.h/d3d10shader.h headers
// (MinGW-w64 14.0.0) and confirmed with the compiler: every vtable arity below
// was derived by compiling a call, so a mismatch with the guest's stack
// correction is a build error rather than a silent corruption.
//
// D3D10 differs from D3D12 in the two ways that shape this module:
//
//   * there is no root signature and no command list. Each stage owns its own
//     register file (`VSSetConstantBuffers` and `PSSetConstantBuffers` name
//     different resources) and every draw executes immediately;
//   * a pipeline is implied by the currently bound shaders, input layout and
//     state objects rather than by one explicit pipeline object.
//
// The frontend therefore derives a pipeline at draw time from whatever is
// bound, caches it under the bound state, and resolves each stage's registers
// from that stage's own slots.
import { ComObjects, readGuid } from './com.js';
import { createBlob } from './com-blob.js';
import {
  INPUT_FORMATS,
  BLEND_FACTORS,
  BLEND_OPERATIONS,
  DEPTH_COMPARE,
} from './d3d12-descriptors.js';
import { validateIndexSnapshot } from './d3d12-indices.js';
import { reflectDXBCInputSignature } from './dxbc-signature.js';
import { RESOURCE_BUFFER, DESCRIPTOR_CBV } from './d3d12-bindings.js';
import { planStageBindings, STAGE_VERTEX } from './d3d10-bindings.js';
import { inputSignatureContainer, reflectShader as reflectDxbc } from './d3d10-reflection.js';
import { compile as compileHlsl, COMPILE_SHADER_10_LAYOUT } from './d3dcompiler.js';
import { registerSwapChainProvider } from './d3d12.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_NOINTERFACE = 0x80004002;
const E_FAIL = 0x80004005;
const E_OUTOFMEMORY = 0x8007000e;
const DXGI_ERROR_NOT_FOUND = 0x887a0002;
const MAX_BYTES = 1024 * 1024;
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SHADER_BYTES = 1024 * 1024;
const MAX_PIPELINES = 64;

// D3D10_SDK_VERSION. The runtime accepts the version the headers were built
// with and ignores it otherwise, so it is only validated for plausibility.
const D3D10_SDK_VERSION = 29;
// D3D10_DRIVER_TYPE: HARDWARE, REFERENCE, NULL, SOFTWARE and WARP. SOFTWARE
// additionally requires the caller's rasterizer module.
const DRIVER_TYPES = new Set([0, 1, 2, 3, 5]);
// D3D10_CREATE_DEVICE_FLAG. Every documented flag is accepted; they are hints
// about threading, layer settings and validation that do not change what the
// bounded device models. Rejecting one the header defines would refuse an
// application over a flag that has no semantic weight here.
const CREATE_FLAGS =
  0x1 | // SINGLETHREADED
  0x2 | // DEBUG
  0x4 | // SWITCH_TO_REF
  0x8 | // PREVENT_INTERNAL_THREADING_OPTIMIZATIONS
  0x10 | // ALLOW_NULL_FROM_MAP
  0x20 | // BGRA_SUPPORT
  0x80 | // PREVENT_ALTERING_LAYER_SETTINGS_FROM_REGISTRY
  0x200 | // STRICT_VALIDATION
  0x400; // DEBUGGABLE

const USAGE_DEFAULT = 0,
  USAGE_IMMUTABLE = 1,
  USAGE_DYNAMIC = 2,
  USAGE_STAGING = 3;
const BIND = { VERTEX: 0x1, INDEX: 0x2, CONSTANT: 0x4, SRV: 0x8, RT: 0x20, DEPTH: 0x40 };
const BIND_MASK = 0x7f;
const CPU_ACCESS = 0x30000;
const CPU_WRITE = 0x10000;
const CPU_READ = 0x20000;

const PRIMITIVE_TRIANGLELIST = 4;
const CULL_MODES = ['none', 'front', 'back'];
const FILL_SOLID = 3;
const D3D10_ADDRESS = { 1: 'repeat', 2: 'mirror-repeat', 3: 'clamp-to-edge' };

// Maps a DXGI index-buffer format to the WebGPU index format.
const INDEX_FORMATS = { 57: 'uint16', 42: 'uint32' };
// DXGI_FORMAT -> the WebGPU texture format the shared backend can host.
const RENDER_TARGET_FORMATS = { 28: 'rgba8unorm', 87: 'bgra8unorm' };
const SHADER_RESOURCE_FORMATS = {
  28: 'rgba8unorm',
  87: 'bgra8unorm',
  49: 'r16unorm',
  61: 'r8unorm',
};
const DEPTH_FORMATS = { 55: 'depth16unorm' };
// DXGI_ADAPTER / DXGI object identities reused from the DXGI model.
const IUNKNOWN = '00000000-0000-0000-c000-000000000046';
const DXGI_OBJECT = 'aec22fb8-76f9-463b-9ef9-28e6eb54df88';
const SWAPCHAIN_IID = '310d36a0-d2e7-4c0a-aa04-6a9d23b8886a';

const iids = {
  device: '9b7e4c0f-342c-4106-a19f-4f2704f689f0',
  deviceChild: '9b7e4c00-342c-4106-a19f-4f2704f689f0',
  resource: '9b7e4c01-342c-4106-a19f-4f2704f689f0',
  buffer: '9b7e4c02-342c-4106-a19f-4f2704f689f0',
  texture1d: '9b7e4c03-342c-4106-a19f-4f2704f689f0',
  texture2d: '9b7e4c04-342c-4106-a19f-4f2704f689f0',
  texture3d: '9b7e4c05-342c-4106-a19f-4f2704f689f0',
  view: 'c902b03f-60a7-49ba-9936-2a3ab37a7e33',
  depthStencilView: '9b7e4c09-342c-4106-a19f-4f2704f689f0',
  renderTargetView: '9b7e4c08-342c-4106-a19f-4f2704f689f0',
  shaderResourceView: '9b7e4c07-342c-4106-a19f-4f2704f689f0',
  blendState: 'edad8d19-8a35-4d6d-8566-2ea276cde161',
  depthStencilState: '2b4b1cc8-a4ad-41f8-8322-ca86fc3ec675',
  geometryShader: '6316be88-54cd-4040-ab44-20461bc81f68',
  inputLayout: '9b7e4c0b-342c-4106-a19f-4f2704f689f0',
  pixelShader: '4968b601-9d00-4cde-8346-8e7f675819b6',
  rasterizerState: 'a2a07292-89af-4345-be2e-c53d9fbb6e9f',
  samplerState: '9b7e4c0c-342c-4106-a19f-4f2704f689f0',
  vertexShader: '9b7e4c0a-342c-4106-a19f-4f2704f689f0',
  asynchronous: '9b7e4c0d-342c-4106-a19f-4f2704f689f0',
  counter: '9b7e4c11-342c-4106-a19f-4f2704f689f0',
  query: '9b7e4c0e-342c-4106-a19f-4f2704f689f0',
  predicate: '9b7e4c10-342c-4106-a19f-4f2704f689f0',
  multithread: '9b7e4e00-342c-4106-a19f-4f2704f689f0',
  shaderReflection: 'd40e946b-806b-47de-bea7-b6f0e8ba70ce',
  swapchain: SWAPCHAIN_IID,
  // IDXGIDevice: the identity a framework asks for when it wants the DXGI side
  // of a rendering device, which is what CreateSwapChain takes.
  dxgiDevice: '54ec77fa-1377-44e6-8c32-88fd5f44c84c',
  adapter: '29038f61-3839-4626-91fd-086879011a05',
};

// Vtable member names in declaration order. Slot indices are positional and
// were read from the headers, so the lists are the single source of the layout.
const CHILD =
  'QueryInterface AddRef Release GetDevice GetPrivateData SetPrivateData SetPrivateDataInterface';
const RESOURCE = `${CHILD} GetType SetEvictionPriority GetEvictionPriority`;
const names = {
  device: `QueryInterface AddRef Release VSSetConstantBuffers PSSetShaderResources PSSetShader PSSetSamplers VSSetShader DrawIndexed Draw PSSetConstantBuffers IASetInputLayout IASetVertexBuffers IASetIndexBuffer DrawIndexedInstanced DrawInstanced GSSetConstantBuffers GSSetShader IASetPrimitiveTopology VSSetShaderResources VSSetSamplers SetPredication GSSetShaderResources GSSetSamplers OMSetRenderTargets OMSetBlendState OMSetDepthStencilState SOSetTargets DrawAuto RSSetState RSSetViewports RSSetScissorRects CopySubresourceRegion CopyResource UpdateSubresource ClearRenderTargetView ClearDepthStencilView GenerateMips ResolveSubresource VSGetConstantBuffers PSGetShaderResources PSGetShader PSGetSamplers VSGetShader PSGetConstantBuffers IAGetInputLayout IAGetVertexBuffers IAGetIndexBuffer GSGetConstantBuffers GSGetShader IAGetPrimitiveTopology VSGetShaderResources VSGetSamplers GetPredication GSGetShaderResources GSGetSamplers OMGetRenderTargets OMGetBlendState OMGetDepthStencilState SOGetTargets RSGetState RSGetViewports RSGetScissorRects GetDeviceRemovedReason SetExceptionMode GetExceptionMode GetPrivateData SetPrivateData SetPrivateDataInterface ClearState Flush CreateBuffer CreateTexture1D CreateTexture2D CreateTexture3D CreateShaderResourceView CreateRenderTargetView CreateDepthStencilView CreateInputLayout CreateVertexShader CreateGeometryShader CreateGeometryShaderWithStreamOutput CreatePixelShader CreateBlendState CreateDepthStencilState CreateRasterizerState CreateSamplerState CreateQuery CreatePredicate CreateCounter CheckFormatSupport CheckMultisampleQualityLevels CheckCounterInfo CheckCounter GetCreationFlags OpenSharedResource SetTextFilterSize GetTextFilterSize`,
  buffer: `${RESOURCE} Map Unmap GetDesc`,
  texture1d: `${RESOURCE} Map Unmap GetDesc`,
  texture2d: `${RESOURCE} Map Unmap GetDesc`,
  texture3d: `${RESOURCE} Map Unmap GetDesc`,
  view: `${CHILD} GetResource`,
  renderTargetView: `${CHILD} GetResource GetDesc`,
  depthStencilView: `${CHILD} GetResource GetDesc`,
  shaderResourceView: `${CHILD} GetResource GetDesc`,
  blendState: `${CHILD} GetDesc`,
  depthStencilState: `${CHILD} GetDesc`,
  rasterizerState: `${CHILD} GetDesc`,
  samplerState: `${CHILD} GetDesc`,
  vertexShader: CHILD,
  pixelShader: CHILD,
  geometryShader: CHILD,
  inputLayout: CHILD,
  asynchronous: `${CHILD} Begin End GetData GetDataSize`,
  query: `${CHILD} Begin End GetData GetDataSize GetDesc`,
  predicate: `${CHILD} Begin End GetData GetDataSize GetDesc`,
  counter: `${CHILD} Begin End GetData GetDataSize GetDesc`,
  multithread:
    'QueryInterface AddRef Release Enter Leave SetMultithreadProtected GetMultithreadProtected',
  shaderReflection:
    'QueryInterface AddRef Release GetDesc GetConstantBufferByIndex GetConstantBufferByName GetResourceBindingDesc GetInputParameterDesc GetOutputParameterDesc',
  swapchain:
    'QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent GetDevice Present GetBuffer SetFullscreenState GetFullscreenState GetDesc ResizeBuffers ResizeTarget GetContainingOutput GetFrameStatistics GetLastPresentCount',
  dxgiDevice:
    'QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent GetAdapter CreateSurface QueryResourceResidency SetGPUThreadPriority GetGPUThreadPriority',
  adapter:
    'QueryInterface AddRef Release SetPrivateData SetPrivateDataInterface GetPrivateData GetParent EnumOutputs GetDesc CheckInterfaceSupport GetDesc1',
};
const name = {
  device: 'ID3D10Device',
  buffer: 'ID3D10Buffer',
  texture1d: 'ID3D10Texture1D',
  texture2d: 'ID3D10Texture2D',
  texture3d: 'ID3D10Texture3D',
  view: 'ID3D10View',
  renderTargetView: 'ID3D10RenderTargetView',
  depthStencilView: 'ID3D10DepthStencilView',
  shaderResourceView: 'ID3D10ShaderResourceView',
  blendState: 'ID3D10BlendState',
  depthStencilState: 'ID3D10DepthStencilState',
  rasterizerState: 'ID3D10RasterizerState',
  samplerState: 'ID3D10SamplerState',
  vertexShader: 'ID3D10VertexShader',
  pixelShader: 'ID3D10PixelShader',
  geometryShader: 'ID3D10GeometryShader',
  inputLayout: 'ID3D10InputLayout',
  asynchronous: 'ID3D10Asynchronous',
  query: 'ID3D10Query',
  predicate: 'ID3D10Predicate',
  counter: 'ID3D10Counter',
  multithread: 'ID3D10Multithread',
  shaderReflection: 'ID3D10ShaderReflection',
  swapchain: 'IDXGISwapChain',
  dxgiDevice: 'IDXGIDevice',
  adapter: 'IDXGIAdapter1',
};

// The dimension GetType reports for each texture interface.
const DIMENSION = { buffer: 1, texture1d: 2, texture2d: 3, texture3d: 4 };

const number = (value) => value >>> 0;
// A by-value FLOAT argument arrives as its IEEE-754 bit pattern.
const floatScratch = new DataView(new ArrayBuffer(4));
const bitsToFloat = (bits) => {
  floatScratch.setUint32(0, bits >>> 0, true);
  return floatScratch.getFloat32(0, true);
};
const u32 = (r, p, off = 0) => r.read32(p + off) >>> 0;
const f32 = (r, p, off = 0) => r.view.getFloat32(r.check(p + off, 4), true);

const BACKEND_METHODS = [
  'createSwapChain',
  'destroySwapChain',
  'createResource',
  'destroyResource',
  'createPipeline',
  'destroyPipeline',
  'execute',
  'present',
  'planD3D10Bindings',
];

function requireBackend(r) {
  const g = r.graphics12;
  const missing = BACKEND_METHODS.filter((method) => typeof g?.[method] !== 'function');
  if (missing.length)
    throw Error(
      `D3D10 graphics backend is unavailable (missing ${missing.join(', ')}; backend ${g ? 'present' : 'absent'})`,
    );
  return g;
}

function state(r) {
  r.comObjects ??= new ComObjects(r);
  r.d3d10 ??= { devices: new Set() };
  return r.d3d10;
}

// A view may be created over any device child — buffer, texture or another
// view — so resource validation cannot require one exact interface kind.
function checkDeviceChild(r, pointer, owner) {
  const item = r.comObjects?.objects.get(number(pointer));
  if (!item || !item.refs || (!item.iids.has(iids.deviceChild) && item.name !== name.device))
    throw Error(
      `Invalid or released D3D10 device child pointer (0x${number(pointer).toString(16)})`,
    );
  if (owner && item.state.device !== owner) throw Error('D3D10 object belongs to another device');
  return item;
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

// Every D3D10 interface except the device derives from ID3D10DeviceChild, and
// every resource from ID3D10Resource; a view additionally answers ID3D10View
// and a render-target/depth-stencil/shader-resource view its own identity.
function extraIids(kind) {
  if (kind === 'device') return [];
  if (
    kind === 'multithread' ||
    kind === 'shaderReflection' ||
    kind === 'swapchain' ||
    kind === 'dxgiDevice' ||
    kind === 'adapter'
  )
    return [];
  const list = [iids.deviceChild];
  if (kind === 'buffer' || kind === 'texture1d' || kind === 'texture2d' || kind === 'texture3d') {
    list.push(iids.resource);
    return list;
  }
  if (kind === 'renderTargetView' || kind === 'depthStencilView' || kind === 'shaderResourceView')
    list.push(iids.view);
  else if (kind === 'view') return [iids.deviceChild];
  return list;
}

// ID3D10Object private-data and debug-name calls carry no rendering semantics.
// GetPrivateData reports "not found"; the setters succeed. The arities are the
// ones the compiler reports for the D3D10 declarations.
const METADATA_METHODS = {
  GetPrivateData: {
    argc: 4,
    invoke(r, a) {
      const size = number(a(2));
      if (size) output(r, size);
      return DXGI_ERROR_NOT_FOUND;
    },
  },
  SetPrivateData: { argc: 4, invoke: () => S_OK },
  SetPrivateDataInterface: { argc: 3, invoke: () => S_OK },
};

// ID3D10DeviceChild.GetDevice(this, ID3D10Device **ppDevice) — two stack slots,
// unlike D3D12's three-slot (this, riid, out) form.
const GET_DEVICE = {
  argc: 2,
  invoke(r, a, o) {
    const out = number(a(1));
    // An application is allowed to unbind with a null output.
    if (!out) return undefined;
    r.check(out, 4, true);
    const device = o.state.device;
    if (!device || !device.refs) throw Error('Released D3D10 device');
    if (device.refs >= 0x7fffffff) throw Error('D3D10 device reference limit exceeded');
    device.refs++;
    r.write32(out, device.pointer);
    return undefined;
  },
};

// A device's QueryInterface answers IDXGIDevice with a separate object: the
// interface has its own vtable, so handing back the ID3D10Device pointer would
// dispatch DXGI methods into D3D10 slots. The object is cached on the device so
// repeated queries return the same identity, and it keeps the device alive.
function deviceQueryInterface(r, device) {
  return (requested, owner) => {
    if (requested === iids.dxgiDevice) {
      owner.state.dxgiDevice ??= make(r, 'dxgiDevice', dxgiDeviceMethods(), { owner }, null);
      return owner.state.dxgiDevice;
    }
    return requested === IUNKNOWN || owner.iids.has(requested) ? owner : null;
  };
}

// IDXGIDevice describes the adapter a device renders through and where its
// surfaces would live. The virtual machine has one adapter and no shared
// surfaces, so GetAdapter reports that adapter and CreateSurface refuses.
function dxgiDeviceMethods() {
  return {
    6: {
      argc: 3,
      invoke(r, a) {
        output(r, number(a(2)));
        return DXGI_ERROR_NOT_FOUND;
      },
    },
    7: {
      argc: 3,
      invoke(r, a, o) {
        const out = number(a(2));
        output(r, out);
        if (!iid(r, a(1), 'adapter')) return E_NOINTERFACE;
        o.state.adapter ??= make(
          r,
          'adapter',
          dxgiAdapterMethods(),
          { owner: o.state.owner },
          null,
        );
        r.write32(out, o.state.adapter.pointer);
        return S_OK;
      },
    },
    8: {
      argc: 5,
      invoke(r, a) {
        output(r, number(a(4)));
        // Shared surfaces require a shared handle across adapters; there is
        // one adapter, so the documented refusal is the honest answer.
        return DXGI_ERROR_INVALID_CALL;
      },
    },
    9: {
      argc: 4,
      invoke: () => E_INVALIDARG,
    },
    10: {
      argc: 2,
      invoke: (_r, a) => ((a(1) | 0) >= -7 && (a(1) | 0) <= 7 ? undefined : E_INVALIDARG),
    },
    11: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 4, true);
        r.write32(out, o.state.gpuThreadPriority ?? 0);
        return undefined;
      },
    },
  };
}

// The adapter an IDXGIDevice reports is the same virtual adapter the factory
// enumerates, so a caller that walks either route sees one device.
function dxgiAdapterMethods() {
  return {
    6: {
      argc: 3,
      invoke(r, a) {
        output(r, number(a(2)));
        return DXGI_ERROR_NOT_FOUND;
      },
    },
    7: {
      argc: 3,
      invoke(r, a) {
        output(r, number(a(2)));
        return DXGI_ERROR_NOT_FOUND;
      },
    },
  };
}

function make(r, kind, methods, itemState = {}, device = null, onRelease = null) {
  if (device) {
    if (device.refs >= 0x7fffffff) throw Error('D3D10 device reference limit exceeded');
    device.refs++;
  }
  const methodNames = names[kind].split(' ');
  const table = { ...methods };
  for (const [slot, methodName] of methodNames.entries()) {
    if (table[slot]) continue;
    if (METADATA_METHODS[methodName]) table[slot] = METADATA_METHODS[methodName];
    else if (methodName === 'GetDevice') table[slot] = GET_DEVICE;
  }
  try {
    return r.comObjects.create({
      name: name[kind],
      iid: iids[kind],
      iids: extraIids(kind),
      // A device answers IDXGIDevice as well, through a separate object.
      queryInterface:
        kind === 'device'
          ? (requested, owner) => deviceQueryInterface(r, owner)(requested, owner)
          : undefined,
      methodNames,
      methods: table,
      state: { ...itemState, device },
      // The COM store calls this with the object alone; the runtime is passed
      // explicitly so a module-level factory can reach the graphics backend.
      onRelease: async (item) => {
        await onRelease?.(item, r);
        if (device) device.refs--;
      },
    });
  } catch (error) {
    if (device) device.refs--;
    throw error;
  }
}

function blobBytes(r, pointer, size, label) {
  if (!pointer || !size || size > MAX_SHADER_BYTES) throw Error(`Invalid D3D10 ${label} bytecode`);
  r.check(pointer, size);
  return r.data.slice(pointer, pointer + size);
}

// --- resources -------------------------------------------------------------

// A D3D10_MAPPED_TEXTURE2D is { void *pData; UINT RowPitch; } — 8 bytes.
function writeMapped(r, out, pointer, rowPitch) {
  r.check(out, 8, true);
  r.write32(out, pointer);
  r.write32(out + 4, rowPitch);
  return undefined;
}

function resourceMethods() {
  return {
    7: { argc: 2, invoke: (_r, _a, o) => DIMENSION[o.state.kind] },
    8: {
      argc: 2,
      invoke(_r, a, o) {
        const priority = number(a(1));
        if (priority > 2) return E_INVALIDARG;
        o.state.evictionPriority = priority;
        return undefined;
      },
    },
    9: { argc: 1, invoke: (_r, _a, o) => o.state.evictionPriority ?? 0 },
    // ID3D10Buffer.Map(this, D3D10_MAP, UINT Flags, void **ppData). A buffer's
    // mapped pointer is its guest storage, so the bytes the application writes
    // are the bytes the next draw samples — exactly as on the device.
    10: {
      argc: 4,
      invoke(r, a, o) {
        const out = number(a(3));
        if (!out) return E_INVALIDARG;
        r.check(out, 4, true);
        const map = number(a(1));
        if (!(map >= 1 && map <= 5) || number(a(2)) & ~0x1)
          throw Error('Unsupported D3D10 buffer Map flags');
        if (o.state.usage === USAGE_IMMUTABLE) return E_INVALIDARG;
        if (o.state.usage === USAGE_DEFAULT && !(o.state.cpuAccess & CPU_WRITE))
          return E_INVALIDARG;
        if (o.state.kind === 'buffer' && map === 4)
          r.data.fill(0, o.state.storage, o.state.storage + o.state.size);
        r.write32(out, o.state.storage);
        o.state.mapped = true;
        return S_OK;
      },
    },
    11: {
      argc: 1,
      invoke(_r, _a, o) {
        if (!o.state.mapped) return undefined;
        o.state.mapped = false;
        return undefined;
      },
    },
    // GetDesc reconstructs the 20-byte D3D10_BUFFER_DESC the buffer was created
    // with: ByteWidth, Usage, BindFlags, CPUAccessFlags, MiscFlags.
    12: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 20, true);
        r.data.fill(0, out, out + 20);
        r.write32(out, o.state.size);
        r.write32(out + 4, o.state.usage);
        r.write32(out + 8, o.state.bindFlags);
        r.write32(out + 12, o.state.cpuAccess);
        return undefined;
      },
    },
  };
}

// ID3D10Texture2D.Map(this, UINT Subresource, D3D10_MAP, UINT Flags,
//                     D3D10_MAPPED_TEXTURE2D *pMappedTex2D). Only subresource 0
// of a one-mip, one-array-element texture is modelled; a staging or dynamic
// texture is read back from its own guest storage.
function textureMapMethods(bytesPerPixel) {
  return {
    10: {
      argc: 5,
      invoke(r, a, o) {
        const out = number(a(4));
        if (!out) return E_INVALIDARG;
        if (number(a(1))) throw Error('Unsupported D3D10 texture subresource Map');
        const map = number(a(2));
        if (!(map >= 1 && map <= 5) || number(a(3)) & ~0x1)
          throw Error('Unsupported D3D10 texture Map flags');
        if (o.state.usage === USAGE_IMMUTABLE) return E_INVALIDARG;
        // A row pitch is the D3D10 requirement: rows align to D3D10_TEXTURE_DATA_PITCH_ALIGNMENT (256).
        const rowPitch = Math.ceil((o.state.width * bytesPerPixel) / 256) * 256;
        o.state.rowPitch = rowPitch;
        o.state.mapped = true;
        return writeMapped(r, out, o.state.storage, rowPitch);
      },
    },
    11: {
      argc: 2,
      invoke(r, a, o) {
        if (number(a(1))) throw Error('Unsupported D3D10 texture subresource Unmap');
        o.state.mapped = false;
        return undefined;
      },
    },
  };
}

function texture2dMethods() {
  return {
    ...resourceMethods(),
    ...textureMapMethods(4),
    12: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 44, true);
        r.data.fill(0, out, out + 44);
        r.write32(out, o.state.width);
        r.write32(out + 4, o.state.height);
        r.write32(out + 8, 1); // MipLevels
        r.write32(out + 12, 1); // ArraySize
        r.write32(out + 16, o.state.format);
        r.write32(out + 20, 1); // SampleDesc.Count
        r.write32(out + 28, o.state.usage);
        r.write32(out + 32, o.state.bindFlags);
        r.write32(out + 36, o.state.cpuAccess);
        return undefined;
      },
    },
  };
}

function viewMethods(withDesc) {
  const methods = {
    7: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        if (!out) return undefined;
        r.check(out, 4, true);
        const resource = o.state.resource;
        if (!resource?.refs) throw Error('Released D3D10 view resource');
        if (resource.refs >= 0x7fffffff) throw Error('D3D10 resource reference limit exceeded');
        resource.refs++;
        r.write32(out, resource.pointer);
        return undefined;
      },
    },
  };
  if (withDesc)
    methods[8] = {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 20, true);
        r.data.fill(0, out, out + 20);
        r.write32(out, o.state.format);
        r.write32(out + 4, o.state.viewDimension);
        r.write32(out + 8, o.state.descBuffer);
        r.write32(out + 12, o.state.descBuffer + 4);
        return undefined;
      },
    };
  return methods;
}

// --- state objects ---------------------------------------------------------

function stateDescMethods(write) {
  return {
    7: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, write.size, true);
        write.fill(r, out, o.state);
        return undefined;
      },
    },
  };
}

function blendStateMethods() {
  return stateDescMethods({
    size: 68,
    fill(r, out, s) {
      r.data.fill(0, out, out + 68);
      r.write32(out, s.alphaToCoverage ? 1 : 0);
      for (let i = 0; i < 8; i++) r.write32(out + 4 + i * 4, s.blendEnable[i] ? 1 : 0);
      r.write32(out + 36, s.srcBlend);
      r.write32(out + 40, s.destBlend);
      r.write32(out + 44, s.blendOp);
      r.write32(out + 48, s.srcBlendAlpha);
      r.write32(out + 52, s.destBlendAlpha);
      r.write32(out + 56, s.blendOpAlpha);
      for (let i = 0; i < 8; i++) r.data[out + 60 + i] = s.writeMask[i];
    },
  });
}

function depthStencilStateMethods() {
  return stateDescMethods({
    size: 52,
    fill(r, out, s) {
      r.data.fill(0, out, out + 52);
      r.write32(out, s.depthEnable ? 1 : 0);
      r.write32(out + 4, s.depthWriteMask);
      r.write32(out + 8, s.depthFunc);
      r.write32(out + 12, s.stencilEnable ? 1 : 0);
      r.data[out + 16] = s.stencilReadMask;
      r.data[out + 17] = s.stencilWriteMask;
      for (const [index, ops] of [s.frontFace, s.backFace].entries())
        for (const [slot, value] of ops.entries())
          r.write32(out + 20 + index * 16 + slot * 4, value);
    },
  });
}

function rasterizerStateMethods() {
  return stateDescMethods({
    size: 40,
    fill(r, out, s) {
      r.data.fill(0, out, out + 40);
      r.write32(out, s.fillMode);
      r.write32(out + 4, s.cullMode);
      r.write32(out + 8, s.frontCounterClockwise ? 1 : 0);
      r.write32(out + 12, s.depthBias | 0);
      for (const [offset, value] of [
        [16, s.depthBiasClamp],
        [20, s.slopeScaledDepthBias],
      ])
        r.view.setFloat32(out + offset, value, true);
      r.write32(out + 24, s.depthClipEnable ? 1 : 0);
      r.write32(out + 28, s.scissorEnable ? 1 : 0);
      r.write32(out + 32, s.multisampleEnable ? 1 : 0);
      r.write32(out + 36, s.antialiasedLineEnable ? 1 : 0);
    },
  });
}

function samplerStateMethods() {
  return stateDescMethods({
    size: 52,
    fill(r, out, s) {
      r.data.fill(0, out, out + 52);
      r.write32(out, s.filter);
      r.write32(out + 4, s.addressU);
      r.write32(out + 8, s.addressV);
      r.write32(out + 12, s.addressW);
      r.view.setFloat32(out + 16, s.mipLodBias, true);
      r.write32(out + 20, s.maxAnisotropy);
      r.write32(out + 24, s.comparisonFunc);
      for (let i = 0; i < 4; i++) r.view.setFloat32(out + 28 + i * 4, s.borderColor[i], true);
      r.view.setFloat32(out + 44, s.minLod, true);
      r.view.setFloat32(out + 48, s.maxLod, true);
    },
  });
}

// --- shaders and input layouts --------------------------------------------

// A D3D10 shader object retains its DXBC bytecode, which is what the shared
// compiler turns into a WebGPU module at pipeline creation.

// --- device state ----------------------------------------------------------

const CB_SLOTS = 16;
const SRV_SLOTS = 128;
const SAMPLER_SLOTS = 16;
const VERTEX_SLOTS = 16;
const MAX_RENDER_TARGETS = 8;
const MAX_VIEWPORTS = 16;

function stageState(shader = null) {
  return {
    shader,
    constantBuffers: new Array(CB_SLOTS).fill(null),
    resources: new Array(SRV_SLOTS).fill(null),
    samplers: new Array(SAMPLER_SLOTS).fill(null),
  };
}

function deviceState(flags) {
  return {
    flags,
    vs: stageState(),
    ps: stageState(),
    gs: stageState(),
    layout: null,
    vertexBuffers: new Array(VERTEX_SLOTS).fill(null),
    indexBuffer: null,
    topology: 0,
    renderTargets: [],
    depthStencil: null,
    viewports: [],
    scissors: [],
    blendState: null,
    blendFactor: [1, 1, 1, 1],
    sampleMask: 0xffffffff,
    depthStencilState: null,
    stencilRef: 0,
    rasterizer: null,
    predicate: null,
    pipelines: new Map(),
    pipelineIds: [],
    swapchains: new Set(),
  };
}

// A D3D10 constant buffer is a window of guest memory the shader reads at draw
// time, so a draw snapshot has to copy the bytes the application most recently
// wrote through Map or UpdateSubresource.
function constantBufferBytes(r, buffer) {
  const bytes = r.data.slice(buffer.state.storage, buffer.state.storage + buffer.state.size);
  // WebGPU uniform bindings need a 16-byte multiple; the tail is padding that
  // no declared member reaches.
  const padded = new Uint8Array(Math.max(16, Math.ceil(bytes.length / 16) * 16));
  padded.set(bytes);
  return padded;
}

function samplerDescription(s) {
  const address = (mode) => {
    const mapped = D3D10_ADDRESS[mode];
    if (!mapped) throw Error('Unsupported D3D10 sampler address mode ' + mode);
    return mapped;
  };
  return {
    filter: s.filter,
    addressU: address(s.addressU),
    addressV: address(s.addressV),
    addressW: address(s.addressW),
    maxAnisotropy: s.maxAnisotropy,
    comparison: false,
  };
}

// One resolved binding for the shared backend. The stage is part of the
// binding, because D3D10 keeps a separate register file per stage.
function bindingSnapshot(r, o, binding) {
  const stage = binding.stage === STAGE_VERTEX ? o.state.vs : o.state.ps;
  const common = { group: binding.group, binding: binding.binding, type: binding.type };
  if (binding.type === DESCRIPTOR_CBV) {
    const buffer = stage.constantBuffers[binding.register];
    if (!buffer) throw Error(`D3D10 constant buffer register ${binding.register} was never bound`);
    return { ...common, kind: 'uniform', bytes: constantBufferBytes(r, buffer) };
  }
  if (binding.type === DESCRIPTOR_SAMPLER) {
    const sampler = stage.samplers[binding.register];
    if (!sampler) throw Error(`D3D10 sampler register ${binding.register} was never bound`);
    return { ...common, kind: 'sampler', sampler: samplerDescription(sampler.state) };
  }
  const view = stage.resources[binding.register];
  if (!view) throw Error(`D3D10 shader resource register ${binding.register} was never bound`);
  const resource = view.state.resource;
  if (resource.state.kind === 'buffer')
    throw Error('Unsupported D3D10 buffer shader resource view');
  return {
    ...common,
    kind: 'texture-view',
    descriptor: { kind: 'srv', resource, format: view.state.format },
  };
}

function viewport(r, ptr) {
  r.check(ptr, 24);
  const [x, y, width, height, minDepth, maxDepth] = [
    r.view.getInt32(ptr, true),
    r.view.getInt32(ptr + 4, true),
    u32(r, ptr, 8),
    u32(r, ptr, 12),
    f32(r, ptr, 16),
    f32(r, ptr, 20),
  ];
  if (
    ![x, y, width, height, minDepth, maxDepth].every(Number.isFinite) ||
    !width ||
    !height ||
    minDepth < 0 ||
    maxDepth > 1 ||
    minDepth > maxDepth
  )
    throw Error('Unsupported D3D10 viewport');
  return { x, y, width, height, minDepth, maxDepth };
}

function scissor(r, ptr) {
  r.check(ptr, 16);
  const [left, top, right, bottom] = [
    r.view.getInt32(ptr, true),
    r.view.getInt32(ptr + 4, true),
    r.view.getInt32(ptr + 8, true),
    r.view.getInt32(ptr + 12, true),
  ];
  if (left < 0 || top < 0 || right <= left || bottom <= top)
    throw Error('Unsupported D3D10 scissor rect');
  return { left, top, right, bottom };
}

// The pipeline a D3D10 draw runs with is implied by the currently bound
// shaders, input layout and state objects. It is cached under exactly those
// objects so a state change creates a new one and a repeat reuses it.
async function ensurePipeline(r, o, target) {
  const s = o.state;
  const vs = s.vs.shader,
    ps = s.ps.shader;
  if (!vs) throw Error('D3D10 draw requires a vertex shader');
  if (!ps) throw Error('D3D10 draw requires a pixel shader');
  if (s.topology !== PRIMITIVE_TRIANGLELIST)
    throw Error('Unsupported D3D10 primitive topology ' + s.topology);
  const layout = s.layout;
  const inputLayout = layout ? layout.state.attributes : [];
  const vertexStride = s.vertexBuffers[0]?.stride ?? 0;
  if (inputLayout.length && !s.vertexBuffers[0])
    throw Error('D3D10 draw requires a vertex buffer for its input layout');
  const raster = s.rasterizer;
  const cullMode = raster ? CULL_MODES[raster.state.cullMode - 1] : 'none';
  if (raster && !cullMode) throw Error('Unsupported D3D10 cull mode ' + raster.state.cullMode);
  const frontFace = raster?.state.frontCounterClockwise ? 'ccw' : 'cw';
  if (raster && raster.state.fillMode !== FILL_SOLID)
    throw Error('Unsupported D3D10 wireframe fill mode');

  const depthState = s.depthStencilState;
  const depthEnabled = !!(depthState && depthState.state.depthEnable);
  if (depthEnabled && !s.depthStencil)
    throw Error('D3D10 depth testing requires a depth-stencil view');
  const depth = depthEnabled
    ? {
        format: 'depth16unorm',
        testEnabled: true,
        writeEnabled: depthState.state.depthWriteMask === 1,
        compare: DEPTH_COMPARE[depthState.state.depthFunc],
      }
    : null;
  if (depth && !depth.compare) throw Error('Unsupported D3D10 depth comparison function');

  const blendState = s.blendState;
  const targetFormat = RENDER_TARGET_FORMATS[target.state.format];
  if (!targetFormat) throw Error('Unsupported D3D10 render target format ' + target.state.format);
  const blend = [blendState ? blendTarget(blendState.state) : { writeMask: 0xf, enabled: false }];

  const key = [
    vs.pointer,
    ps.pointer,
    layout?.pointer ?? 0,
    blendState?.pointer ?? 0,
    depthState?.pointer ?? 0,
    raster?.pointer ?? 0,
    targetFormat,
  ].join(':');
  const cached = s.pipelines.get(key);
  if (cached) return cached;
  if (s.pipelines.size >= 32) throw Error('D3D10 pipeline limit exceeded');

  const backend = requireBackend(r);
  const stagePlan = await backend.planD3D10Bindings(vs.state.bytecode, ps.state.bytecode);
  const id = r.allocate(4);
  let created;
  try {
    created = await backend.createPipeline({
      id,
      vertex: vs.state.bytecode,
      pixel: ps.state.bytecode,
      inputLayout,
      vertexStride,
      depth,
      cullMode,
      frontFace,
      blend,
      alphaToCoverage: !!blendState?.state.alphaToCoverage,
      targetFormat,
      stagePlan,
    });
  } catch (error) {
    r.free(id);
    throw error;
  }
  const entry = { id, bindings: created.bindings, depth: !!depth };
  s.pipelines.set(key, entry);
  s.pipelineIds.push(id);
  return entry;
}

// D3D10_RENDER_TARGET_BLEND_DESC is a single record covering every render
// target, unlike D3D12's per-target array.
function blendTarget(s) {
  const component = (source, destination, operation, label) => {
    const op = BLEND_OPERATIONS[operation];
    const src = BLEND_FACTORS[source];
    const dst = BLEND_FACTORS[destination];
    if (!op || !src || !dst)
      throw Error(`Unsupported D3D10 ${label} blend state ${source}/${destination}/${operation}`);
    return { operation: op, srcFactor: src, dstFactor: dst };
  };
  const enabled = !!s.blendEnable[0];
  const writeMask = s.writeMask[0];
  if (writeMask & ~0xf) throw Error('Unsupported D3D10 blend write mask');
  if (!enabled) return { writeMask, enabled: false };
  return {
    writeMask,
    enabled: true,
    color: component(s.srcBlend, s.destBlend, s.blendOp, 'colour'),
    alpha: component(s.srcBlendAlpha, s.destBlendAlpha, s.blendOpAlpha, 'alpha'),
  };
}

// --- draw submission -------------------------------------------------------

// Submits one command immediately. D3D10 has no command list: every draw and
// every clear takes effect in the order the application issues it, so each one
// becomes its own ordered submission.
async function submit(r, command) {
  const backend = requireBackend(r);
  try {
    await backend.execute({ commands: [command] });
  } catch (error) {
    throw Error('D3D10 draw failed: ' + (error.message ?? String(error)));
  }
}

async function recordDraw(r, a, o, indexed, instanced) {
  const s = o.state;
  const target = s.renderTargets[0];
  if (!target) throw Error('D3D10 draw requires a render target');
  const resource = target.state.resource;
  const entry = await ensurePipeline(r, o, resource);
  if (s.viewports.length > 1 || s.scissors.length > 1)
    throw Error('Unsupported D3D10 draw with multiple viewports or scissor rects');
  const drawViewport = s.viewports[0] ?? defaultViewport(resource);
  const drawScissor = s.scissors[0] ?? defaultScissor(resource);

  const counts = instanced
    ? {
        count: number(a(1)),
        instances: number(a(2)),
        first: number(a(3)),
        baseVertex: indexed ? a(4) | 0 : 0,
        firstInstance: number(a(4 + (indexed ? 1 : 0))),
      }
    : indexed
      ? {
          count: number(a(1)),
          instances: 1,
          first: number(a(2)),
          baseVertex: a(3) | 0,
          firstInstance: 0,
        }
      : { count: number(a(1)), instances: 1, first: number(a(2)), baseVertex: 0, firstInstance: 0 };

  const vertexView = s.vertexBuffers[0];
  let vertices = new Uint8Array(0),
    vertexStride = 0;
  if (s.layout) {
    if (!vertexView) throw Error('D3D10 draw requires a vertex buffer');
    vertexStride = vertexView.stride;
    vertices = r.data.slice(
      vertexView.buffer.state.storage + vertexView.offset,
      vertexView.buffer.state.storage + vertexView.buffer.state.size,
    );
    if (!indexed && (counts.first + counts.count) * vertexStride > vertices.length)
      throw Error('D3D10 draw exceeds the bound vertex buffer');
  }
  let indices = new Uint8Array(0),
    indexFormat = '';
  if (indexed) {
    const indexView = s.indexBuffer;
    if (!indexView) throw Error('D3D10 indexed draw requires an index buffer');
    indexFormat = INDEX_FORMATS[indexView.format];
    if (!indexFormat) throw Error('Unsupported D3D10 index format ' + indexView.format);
    indices = r.data.slice(
      indexView.buffer.state.storage + indexView.offset,
      indexView.buffer.state.storage + indexView.buffer.state.size,
    );
  }
  const command = {
    type: 'draw',
    // Resolving the bindings here, at draw time, is what makes D3D10's
    // immediately-executed model work: the bytes are copied before the
    // application can overwrite the buffer for the next frame.
    bindings: entry.bindings.map((binding) => bindingSnapshot(r, o, binding)),
    target: resource.pointer,
    pipeline: entry.id,
    viewport: { ...drawViewport },
    scissor: { ...drawScissor },
    instanceCount: counts.instances,
    firstInstance: counts.firstInstance,
    vertexStride,
    vertices,
    // The shared backend attaches a depth target only when the pipeline tests
    // depth; D3D10 may bind a depth-stencil view with testing disabled.
    depthTarget: entry.depth ? s.depthStencil.state.resource.pointer : 0,
    ...(indexed
      ? {
          indexCount: counts.count,
          firstIndex: counts.first,
          baseVertex: counts.baseVertex,
          indexFormat,
          indices,
        }
      : { vertexCount: counts.count, firstVertex: counts.first }),
  };
  if (indexed) validateIndexSnapshot(command, vertexStride ? vertices.length / vertexStride : null);
  await submit(r, command);
}

function defaultViewport(resource) {
  return {
    x: 0,
    y: 0,
    width: resource.state.width,
    height: resource.state.height,
    minDepth: 0,
    maxDepth: 1,
  };
}

function defaultScissor(resource) {
  return { left: 0, top: 0, right: resource.state.width, bottom: resource.state.height };
}

// Clear-flags for ClearDepthStencilView.
const CLEAR_DEPTH = 0x1,
  CLEAR_STENCIL = 0x2;

// --- device vtable ---------------------------------------------------------

// A create-time helper: validate the out parameter, let the caller parse the
// description and build the object. D3D10's device Create* methods take no
// REFIID — the object is created with its own interface identity and narrowed
// later through QueryInterface — so there is nothing to check here.
// `parse` runs before the object exists, so a rejected description allocates
// nothing, and it may return an `after` hook to create the backend resource the
// object owns.
function creator(kind, argc, parse, methods, onRelease) {
  return {
    argc,
    async invoke(r, a, device) {
      const out = number(a(argc - 1));
      output(r, out);
      const extra = parse?.(r, a, device);
      if (extra === E_INVALIDARG) return E_INVALIDARG;
      let item;
      try {
        item = make(r, kind, methods ?? {}, { ...extra }, device, onRelease ?? null);
      } catch (error) {
        if (extra?.storage) r.free(extra.storage);
        throw error;
      }
      try {
        await extra?.after?.(item);
      } catch (error) {
        item.refs = 0;
        device.refs--;
        if (extra?.storage) r.free(extra.storage);
        throw error;
      }
      r.write32(out, item.pointer);
      return S_OK;
    },
  };
}

function bufferParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 20);
  const size = u32(r, desc);
  const usage = u32(r, desc, 4);
  const bindFlags = u32(r, desc, 8);
  const cpuAccess = u32(r, desc, 12);
  if (
    !size ||
    size > MAX_RESOURCE_BYTES ||
    usage > USAGE_STAGING ||
    bindFlags & ~BIND_MASK ||
    cpuAccess & ~CPU_ACCESS ||
    u32(r, desc, 16)
  )
    return E_INVALIDARG;
  if (usage === USAGE_IMMUTABLE && (cpuAccess || !number(a(2)))) return E_INVALIDARG;
  if (usage === USAGE_DYNAMIC && cpuAccess !== CPU_WRITE) return E_INVALIDARG;
  if (usage === USAGE_DYNAMIC && bindFlags & ~(BIND.VERTEX | BIND.INDEX | BIND.CONSTANT))
    return E_INVALIDARG;
  if (usage === USAGE_STAGING && !cpuAccess) return E_INVALIDARG;
  const storage = r.allocate(size);
  const initial = number(a(2));
  if (initial) {
    r.check(initial, 12);
    const source = u32(r, initial);
    if (source) {
      r.check(source, size);
      r.data.copyWithin(storage, source, source + size);
    }
  }
  return { kind: 'buffer', size, usage, bindFlags, cpuAccess, storage, evictionPriority: 0 };
}

function texture2dParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 44);
  const width = u32(r, desc),
    height = u32(r, desc, 4);
  const format = u32(r, desc, 16);
  const usage = u32(r, desc, 28);
  const bindFlags = u32(r, desc, 32);
  const cpuAccess = u32(r, desc, 36);
  if (
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    u32(r, desc, 8) !== 1 ||
    u32(r, desc, 12) !== 1 ||
    u32(r, desc, 20) !== 1 ||
    u32(r, desc, 24) ||
    usage > USAGE_STAGING ||
    bindFlags & ~BIND_MASK ||
    cpuAccess & ~CPU_ACCESS ||
    u32(r, desc, 40) ||
    // Initial texture data would need the placed-footprint upload path, which
    // this bounded frontend does not model; UpdateSubresource covers the rest.
    number(a(2))
  )
    return E_INVALIDARG;
  const depthBound = !!(bindFlags & BIND.DEPTH);
  const renderBound = !!(bindFlags & BIND.RT);
  const shaderBound = !!(bindFlags & BIND.SRV);
  if (depthBound && (renderBound || shaderBound)) return E_INVALIDARG;
  const kind = depthBound
    ? 'depth'
    : renderBound
      ? 'render-texture'
      : shaderBound
        ? 'texture'
        : null;
  if (!kind) return E_INVALIDARG;
  const allowed = depthBound
    ? DEPTH_FORMATS
    : renderBound
      ? RENDER_TARGET_FORMATS
      : SHADER_RESOURCE_FORMATS;
  if (!allowed[format]) return E_INVALIDARG;
  return {
    kind,
    width,
    height,
    format,
    usage,
    bindFlags,
    cpuAccess,
    storage: r.allocate(width * height * 4),
    evictionPriority: 0,
    // The backend owns a GPU texture for a sampled, render-target or depth
    // resource, so it is created here and torn down with the object.
    after: async (item) => {
      await requireBackend(r).createResource({
        id: item.pointer,
        kind,
        width,
        height,
        format: allowed[format],
      });
    },
  };
}

const VIEW_DIMENSION = { texture1d: 0, texture2d: 3, depth: 3 };

function viewParse(r, a, device) {
  const resource = checkDeviceChild(r, a(1), device);
  const desc = number(a(2));
  if (desc) {
    r.check(desc, 20);
    const dimension = u32(r, desc, 4);
    const expected = resource.state.kind === 'depth' ? 3 : 4;
    if (u32(r, desc) || dimension !== expected || u32(r, desc, 8) || u32(r, desc, 12))
      return E_INVALIDARG;
  }
  void VIEW_DIMENSION;
  return {
    resource,
    format: resource.state.format,
    viewDimension: resource.state.kind === 'depth' ? 3 : 4,
    descBuffer: 0,
  };
}

function inputLayoutParse(r, a) {
  const elements = number(a(1));
  const count = number(a(2));
  const bytecodePointer = number(a(3));
  const bytecodeSize = number(a(4));
  if (!elements || !count || count > 32 || !bytecodePointer || !bytecodeSize) return E_INVALIDARG;
  const attributes = [];
  for (let index = 0; index < count; index++) {
    const element = elements + index * 28;
    r.check(element, 28);
    const semanticName = r.string(u32(r, element));
    const semanticIndex = u32(r, element, 4);
    const described = INPUT_FORMATS[u32(r, element, 8)];
    const inputSlot = u32(r, element, 12);
    const offset = u32(r, element, 16);
    const classification = u32(r, element, 20);
    const stepRate = u32(r, element, 24);
    if (!described || !semanticName || inputSlot || classification || stepRate) return E_INVALIDARG;
    attributes.push({
      semanticName,
      semanticIndex,
      format: described.format,
      offset,
      components: described.components,
    });
  }
  return {
    attributes,
    bytecode: blobBytes(r, bytecodePointer, bytecodeSize, 'input-layout'),
  };
}

// A D3D10 shader object retains its bytecode; the shared compiler turns it into
// WebGPU shader modules when the pipeline is first needed.
function shaderParse(r, a) {
  return { bytecode: blobBytes(r, number(a(1)), number(a(2)), 'shader') };
}

function blendStateParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 68);
  const state = { alphaToCoverage: !!u32(r, desc), blendEnable: [], writeMask: [] };
  for (let i = 0; i < 8; i++) state.blendEnable.push(!!u32(r, desc, 4 + i * 4));
  state.srcBlend = u32(r, desc, 36);
  state.destBlend = u32(r, desc, 40);
  state.blendOp = u32(r, desc, 44);
  state.srcBlendAlpha = u32(r, desc, 48);
  state.destBlendAlpha = u32(r, desc, 52);
  state.blendOpAlpha = u32(r, desc, 56);
  for (let i = 0; i < 8; i++) state.writeMask.push(r.data[desc + 60 + i]);
  if (state.writeMask.some((mask) => mask & ~0xf)) return E_INVALIDARG;
  if (state.blendEnable[0]) {
    const component = (source, destination, operation) => {
      const op = BLEND_OPERATIONS[operation];
      const src = BLEND_FACTORS[source];
      const dst = BLEND_FACTORS[destination];
      if (!op || !src || !dst) return false;
      // MIN/MAX ignore the factors, and D3D requires them to be ONE.
      return operation < 4 || (source === 2 && destination === 2);
    };
    if (!component(state.srcBlend, state.destBlend, state.blendOp)) return E_INVALIDARG;
    if (!component(state.srcBlendAlpha, state.destBlendAlpha, state.blendOpAlpha))
      return E_INVALIDARG;
  }
  return state;
}

function depthStencilStateParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 52);
  const writeMask = u32(r, desc, 4);
  const depthFunc = u32(r, desc, 8);
  if (writeMask > 1 || !DEPTH_COMPARE[depthFunc]) return E_INVALIDARG;
  const ops = (base) => [
    u32(r, desc, base),
    u32(r, desc, base + 4),
    u32(r, desc, base + 8),
    u32(r, desc, base + 12),
  ];
  return {
    depthEnable: !!u32(r, desc),
    depthWriteMask: writeMask,
    depthFunc,
    stencilEnable: !!u32(r, desc, 12),
    stencilReadMask: r.data[desc + 16],
    stencilWriteMask: r.data[desc + 17],
    frontFace: ops(20),
    backFace: ops(36),
  };
}

function rasterizerStateParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 40);
  const fillMode = u32(r, desc),
    cullMode = u32(r, desc, 4);
  if (fillMode !== FILL_SOLID || !CULL_MODES[cullMode - 1]) return E_INVALIDARG;
  if (u32(r, desc, 28)) return E_INVALIDARG; // scissor testing is always on here
  return {
    fillMode,
    cullMode,
    frontCounterClockwise: !!u32(r, desc, 8),
    depthBias: r.view.getInt32(r.check(desc + 12, 4), true),
    depthBiasClamp: f32(r, desc, 16),
    slopeScaledDepthBias: f32(r, desc, 20),
    depthClipEnable: !!u32(r, desc, 24),
    scissorEnable: false,
    multisampleEnable: !!u32(r, desc, 32),
    antialiasedLineEnable: !!u32(r, desc, 36),
  };
}

function samplerStateParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 52);
  const filter = u32(r, desc);
  const address = [u32(r, desc, 4), u32(r, desc, 8), u32(r, desc, 12)];
  const comparisonFunc = u32(r, desc, 24);
  if (filter > 0x155 || address.some((mode) => !D3D10_ADDRESS[mode])) return E_INVALIDARG;
  if (!DEPTH_COMPARE[comparisonFunc]) return E_INVALIDARG;
  return {
    filter,
    addressU: address[0],
    addressV: address[1],
    addressW: address[2],
    mipLodBias: f32(r, desc, 16),
    maxAnisotropy: u32(r, desc, 20),
    comparisonFunc,
    borderColor: Array.from({ length: 4 }, (_, i) => f32(r, desc, 28 + i * 4)),
    minLod: f32(r, desc, 44),
    maxLod: f32(r, desc, 48),
  };
}

function queryParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 8);
  if (u32(r, desc) > 7 || u32(r, desc, 4)) return E_INVALIDARG;
  return { type: u32(r, desc), begun: false, ended: false };
}

function counterParse(r, a) {
  const desc = number(a(1));
  if (!desc) return E_INVALIDARG;
  r.check(desc, 8);
  if (u32(r, desc) > 15 || u32(r, desc, 4)) return E_INVALIDARG;
  return null;
}

// A query answers the two calls every timing or occlusion measurement makes:
// Begin/End bracket the work and GetData reports the counted result. The
// virtual device has one queue and no timestamps, so a finished query reports
// zero, which is a truthful "nothing was measured".
function queryMethods(dataSize) {
  return {
    7: {
      argc: 1,
      invoke(_r, _a, o) {
        o.state.begun = true;
        return undefined;
      },
    },
    8: {
      argc: 1,
      invoke(_r, _a, o) {
        o.state.ended = true;
        return undefined;
      },
    },
    9: {
      argc: 4,
      invoke(r, a, o) {
        const out = number(a(1)),
          size = number(a(2)),
          flags = number(a(3));
        if (!out) return E_INVALIDARG;
        if (size < dataSize) return E_INVALIDARG;
        // D3D10_ASYNC_GETDATA_DONOTFLUSH (0x1) never blocks; without it a query
        // that has not run yet reports S_FALSE.
        if (!o.state.ended && !(flags & 0x1)) return 0x00000001; // S_FALSE
        if (!o.state.ended) return 0x00000001;
        r.check(out, dataSize, true);
        r.data.fill(0, out, out + dataSize);
        return S_OK;
      },
    },
    10: { argc: 1, invoke: () => dataSize },
  };
}

function deviceMethods() {
  // A stage's register file is addressed as `<stage>.<field>` so the same
  // helper serves both shader stages.
  const registerFile = (state, field) => {
    const [stage, list] = field.split('.');
    return state[stage][list];
  };
  const setStage = (slot, length, field, validate) => ({
    [slot]: {
      argc: 4,
      invoke(r, a, o) {
        const start = number(a(1)),
          count = number(a(2));
        if (start + count > length) throw Error('D3D10 stage register range is out of bounds');
        const pointer = number(a(3));
        if (count) r.check(pointer, count * 4);
        const file = registerFile(o.state, field);
        for (let i = 0; i < count; i++) {
          const handle = u32(r, pointer, i * 4);
          file[start + i] = handle ? validate(r, handle, o) : null;
        }
        return undefined;
      },
    },
  });
  const buffer = (r, handle, o) => object(r, handle, 'buffer', o);
  const view = (kind) => (r, handle, o) => object(r, handle, kind, o);
  const sampler = (r, handle, o) => object(r, handle, 'samplerState', o);

  return {
    ...setStage(3, CB_SLOTS, 'vs.constantBuffers', (r, h, o) => {
      const b = buffer(r, h, o);
      if (!(b.state.bindFlags & BIND.CONSTANT))
        throw Error('D3D10 vertex constant buffer is not a constant buffer');
      return b;
    }),
    ...setStage(4, SRV_SLOTS, 'ps.resources', view('shaderResourceView')),
    ...setStage(19, SRV_SLOTS, 'vs.resources', view('shaderResourceView')),
    ...setStage(20, SAMPLER_SLOTS, 'vs.samplers', sampler),
    ...setStage(6, SAMPLER_SLOTS, 'ps.samplers', sampler),
    ...setStage(10, CB_SLOTS, 'ps.constantBuffers', (r, h, o) => {
      const b = buffer(r, h, o);
      if (!(b.state.bindFlags & BIND.CONSTANT))
        throw Error('D3D10 pixel constant buffer is not a constant buffer');
      return b;
    }),
    5: {
      argc: 2,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.ps.shader = handle ? object(r, handle, 'pixelShader', o) : null;
        return undefined;
      },
    },
    7: {
      argc: 2,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.vs.shader = handle ? object(r, handle, 'vertexShader', o) : null;
        return undefined;
      },
    },
    8: { argc: 4, invoke: (r, a, o) => recordDraw(r, a, o, true, false) },
    9: { argc: 3, invoke: (r, a, o) => recordDraw(r, a, o, false, false) },
    11: {
      argc: 2,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.layout = handle ? object(r, handle, 'inputLayout', o) : null;
        return undefined;
      },
    },
    12: {
      argc: 6,
      invoke(r, a, o) {
        const start = number(a(1)),
          count = number(a(2));
        if (start || count > 1) throw Error('D3D10 vertex buffer slots beyond 0 are unsupported');
        const pointer = number(a(3));
        if (!count) {
          o.state.vertexBuffers[0] = null;
          return undefined;
        }
        r.check(pointer, 4);
        const strides = number(a(4)),
          offsets = number(a(5));
        r.check(strides, 4);
        r.check(offsets, 4);
        const buffer = object(r, u32(r, pointer), 'buffer', o);
        if (!(buffer.state.bindFlags & BIND.VERTEX))
          throw Error('D3D10 vertex buffer is not a vertex buffer');
        const stride = u32(r, strides);
        const offset = u32(r, offsets);
        if (!stride || stride > 256 || stride % 4 || offset + stride > buffer.state.size)
          throw Error('Unsupported D3D10 vertex buffer stride or offset');
        o.state.vertexBuffers[0] = { buffer, stride, offset };
        return undefined;
      },
    },
    13: {
      argc: 4,
      invoke(r, a, o) {
        const handle = number(a(1));
        if (!handle) {
          o.state.indexBuffer = null;
          return undefined;
        }
        const buffer = object(r, handle, 'buffer', o);
        if (!(buffer.state.bindFlags & BIND.INDEX))
          throw Error('D3D10 index buffer is not an index buffer');
        const format = number(a(2)),
          offset = number(a(3));
        const width = format === 57 ? 2 : format === 42 ? 4 : 0;
        if (!width || offset + width > buffer.state.size)
          throw Error('Unsupported D3D10 index buffer format or offset');
        o.state.indexBuffer = { buffer, format, offset };
        return undefined;
      },
    },
    14: { argc: 6, invoke: (r, a, o) => recordDraw(r, a, o, true, true) },
    15: { argc: 5, invoke: (r, a, o) => recordDraw(r, a, o, false, true) },
    18: {
      argc: 2,
      invoke(_r, a, o) {
        const topology = number(a(1));
        if (topology !== PRIMITIVE_TRIANGLELIST && topology !== 0)
          throw Error('Unsupported D3D10 primitive topology ' + topology);
        o.state.topology = topology;
        return undefined;
      },
    },
    21: {
      argc: 3,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.predicate = handle ? object(r, handle, 'predicate', o) : null;
        void a;
        return undefined;
      },
    },
    24: {
      argc: 4,
      invoke(r, a, o) {
        const count = number(a(1)),
          pointer = number(a(2));
        if (count > MAX_RENDER_TARGETS) throw Error('D3D10 render target count exceeds the limit');
        if (count) r.check(pointer, count * 4);
        const targets = [];
        for (let i = 0; i < count; i++) {
          const handle = u32(r, pointer, i * 4);
          const item = handle ? object(r, handle, 'renderTargetView', o) : null;
          if (item) targets.push(item);
        }
        const depthHandle = number(a(3));
        o.state.renderTargets = targets;
        o.state.depthStencil = depthHandle ? object(r, depthHandle, 'depthStencilView', o) : null;
        return undefined;
      },
    },
    25: {
      argc: 4,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.blendState = handle ? object(r, handle, 'blendState', o) : null;
        const factor = number(a(2));
        if (factor) {
          r.check(factor, 16);
          o.state.blendFactor = Array.from({ length: 4 }, (_, i) => f32(r, factor, i * 4));
        }
        o.state.sampleMask = number(a(3));
        return undefined;
      },
    },
    26: {
      argc: 3,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.depthStencilState = handle ? object(r, handle, 'depthStencilState', o) : null;
        o.state.stencilRef = number(a(2));
        return undefined;
      },
    },
    29: {
      argc: 2,
      invoke(r, a, o) {
        const handle = number(a(1));
        o.state.rasterizer = handle ? object(r, handle, 'rasterizerState', o) : null;
        return undefined;
      },
    },
    30: {
      argc: 3,
      invoke(r, a, o) {
        const count = number(a(1)),
          pointer = number(a(2));
        if (count > MAX_VIEWPORTS) throw Error('D3D10 viewport count exceeds the limit');
        if (count) r.check(pointer, count * 24);
        o.state.viewports = Array.from({ length: count }, (_, i) => viewport(r, pointer + i * 24));
        return undefined;
      },
    },
    31: {
      argc: 3,
      invoke(r, a, o) {
        const count = number(a(1)),
          pointer = number(a(2));
        if (count > MAX_VIEWPORTS) throw Error('D3D10 scissor count exceeds the limit');
        if (count) r.check(pointer, count * 16);
        o.state.scissors = Array.from({ length: count }, (_, i) => scissor(r, pointer + i * 16));
        return undefined;
      },
    },
    32: {
      argc: 9,
      invoke(r, a, o) {
        const dst = object(r, a(1), 'resource', o);
        const src = object(r, a(7), 'resource', o);
        if (number(a(2)) || number(a(8)))
          throw Error('Unsupported D3D10 CopySubresourceRegion subresource');
        const [x, y, z] = [number(a(3)), number(a(4)), number(a(5))];
        const box = number(a(9));
        if (box) r.check(box, 24);
        // Only a whole-buffer copy is modelled; the modeled resource kinds have
        // no mip chain to address.
        if (x || y || z || box) throw Error('Unsupported D3D10 CopySubresourceRegion region');
        copyResourceBytes(r, dst, src);
        return undefined;
      },
    },
    33: {
      argc: 3,
      invoke(r, a, o) {
        copyResourceBytes(r, object(r, a(1), 'resource', o), object(r, a(2), 'resource', o));
        return undefined;
      },
    },
    34: {
      argc: 7,
      invoke(r, a, o) {
        const dst = object(r, a(1), 'resource', o);
        if (number(a(2))) throw Error('Unsupported D3D10 UpdateSubresource subresource');
        if (number(a(3))) throw Error('Unsupported D3D10 UpdateSubresource destination box');
        const source = number(a(4));
        const size =
          dst.state.kind === 'buffer' ? dst.state.size : dst.state.width * 4 * dst.state.height;
        if (!source) throw Error('D3D10 UpdateSubresource requires source data');
        r.check(source, size);
        if (dst.state.kind === 'buffer') {
          r.data.copyWithin(dst.state.storage, source, source + size);
          return undefined;
        }
        throw Error('Unsupported D3D10 UpdateSubresource on a texture');
      },
    },
    35: {
      argc: 3,
      invoke(r, a, o) {
        const target = object(r, a(1), 'renderTargetView', o);
        r.check(number(a(2)), 16);
        const color = Array.from({ length: 4 }, (_, i) => f32(r, number(a(2)), i * 4));
        if (!color.every((value) => Number.isFinite(value) && value >= 0 && value <= 1))
          throw Error('Unsupported D3D10 clear colour');
        o.state.pendingClear = { target: target.state.resource, color };
        return submit(r, {
          type: 'clear',
          target: target.state.resource.pointer,
          color,
        });
      },
    },
    36: {
      argc: 5,
      invoke(r, a, o) {
        const view = object(r, a(1), 'depthStencilView', o);
        const flags = number(a(2));
        if (!(flags & CLEAR_DEPTH) || flags & ~(CLEAR_DEPTH | CLEAR_STENCIL))
          throw Error('Unsupported D3D10 clear flags');
        // Depth is a FLOAT passed by value, so the stack word *is* the bit
        // pattern; interference with a pointer would read guest memory.
        const depth = bitsToFloat(a(3));
        if (!Number.isFinite(depth) || depth < 0 || depth > 1)
          throw Error('Unsupported D3D10 depth clear value');
        return submit(r, {
          type: 'clear-depth',
          target: view.state.resource.pointer,
          depth,
        });
      },
    },
    37: {
      argc: 2,
      invoke() {
        throw Error('Unsupported D3D10 GenerateMips');
      },
    },
    38: {
      argc: 6,
      invoke() {
        throw Error('Unsupported D3D10 ResolveSubresource');
      },
    },
    ...getters(),
    // The device's own private-data slots sit after the stage getters, exactly
    // where the header places them.
    63: { argc: 1, invoke: () => S_OK },
    64: { argc: 2, invoke: () => S_OK },
    65: { argc: 1, invoke: () => 0 },
    66: { argc: 4, invoke: (r, a) => METADATA_METHODS.GetPrivateData.invoke(r, a) },
    67: { argc: 4, invoke: () => S_OK },
    68: { argc: 3, invoke: () => S_OK },
    // ClearState unbinds everything, as the device does.
    69: {
      argc: 1,
      invoke(_r, _a, o) {
        const fresh = deviceState(o.state.flags);
        for (const field of [
          'vs',
          'ps',
          'gs',
          'layout',
          'vertexBuffers',
          'indexBuffer',
          'topology',
          'renderTargets',
          'depthStencil',
          'viewports',
          'scissors',
          'blendState',
          'depthStencilState',
          'rasterizer',
          'predicate',
        ])
          o.state[field] = fresh[field];
        return undefined;
      },
    },
    70: { argc: 1, invoke: () => undefined },
    71: creator('buffer', 4, bufferParse, resourceMethods()),
    72: {
      argc: 4,
      invoke: (r, a) => {
        output(r, number(a(3)));
        return E_INVALIDARG;
      },
    },
    73: creator('texture2d', 4, texture2dParse, texture2dMethods(), (item, runtime) => {
      // A backend-owned texture is released before its guest storage is freed.
      runtime.graphics12?.destroyResource({ id: item.pointer });
      runtime.free(item.state.storage);
    }),
    74: {
      argc: 4,
      invoke: (r, a) => {
        output(r, number(a(3)));
        return E_INVALIDARG;
      },
    },
    75: creator('shaderResourceView', 4, viewParse, viewMethods(true)),
    76: creator('renderTargetView', 4, viewParse, viewMethods(true)),
    77: creator('depthStencilView', 4, viewParse, viewMethods(true)),
    78: creator('inputLayout', 6, inputLayoutParse, {}),
    79: creator('vertexShader', 4, shaderParse, {}),
    80: creator('geometryShader', 4, shaderParse, {}),
    81: {
      argc: 7,
      invoke: (r, a) => {
        output(r, number(a(6)));
        return E_INVALIDARG;
      },
    },
    82: creator('pixelShader', 4, shaderParse, {}),
    83: creator('blendState', 3, blendStateParse, blendStateMethods()),
    84: creator('depthStencilState', 3, depthStencilStateParse, depthStencilStateMethods()),
    85: creator('rasterizerState', 3, rasterizerStateParse, rasterizerStateMethods()),
    86: creator('samplerState', 3, samplerStateParse, samplerStateMethods()),
    87: creator('query', 3, queryParse, queryMethods(8)),
    88: creator('predicate', 3, queryParse, queryMethods(4)),
    89: creator('counter', 3, counterParse, queryMethods(4)),
    90: {
      argc: 3,
      invoke(r, a) {
        const out = number(a(2));
        if (out) {
          r.check(out, 4, true);
          r.write32(out, 0);
        }
        // Only the buffer and vertex/index formats the bounded path can feed a
        // pipeline report support; everything else is unsupported.
        return number(a(1)) === 0 ? E_INVALIDARG : S_OK;
      },
    },
    91: {
      argc: 4,
      invoke(r, a) {
        const out = number(a(3));
        if (out) {
          r.check(out, 4, true);
          r.write32(out, 0);
        }
        return S_OK;
      },
    },
    92: {
      argc: 2,
      invoke(r, a) {
        const out = number(a(1));
        if (out) {
          r.check(out, 28, true);
          r.data.fill(0, out, out + 28);
          r.write32(out, 0); // LastDeviceDependentCounter
          r.write32(out + 4, 0); // NumSimultaneousCounters
        }
        return undefined;
      },
    },
    93: { argc: 10, invoke: () => E_INVALIDARG },
    94: { argc: 1, invoke: (_r, _a, o) => o.state.flags },
    95: {
      argc: 4,
      invoke(r, a) {
        output(r, number(a(3)));
        return E_NOINTERFACE;
      },
    },
    96: { argc: 3, invoke: () => undefined },
    97: {
      argc: 3,
      invoke(r, a) {
        for (const offset of [number(a(1)), number(a(2))])
          if (offset) {
            r.check(offset, 4, true);
            r.write32(offset, 0);
          }
        return undefined;
      },
    },
  };
}

// Copies the bytes one resource shares with its source. Buffers are modelled in
// guest memory, so a copy is a memmove; textures are owned by the backend and
// have no modelled contents.
function copyResourceBytes(r, dst, src) {
  if (dst.state.kind !== 'buffer' || src.state.kind !== 'buffer')
    throw Error('Unsupported D3D10 CopyResource on a texture');
  if (dst.state.size !== src.state.size)
    throw Error('D3D10 CopyResource requires equal buffer sizes');
  r.data.copyWithin(dst.state.storage, src.state.storage, src.state.storage + src.state.size);
}

// Slots 39..62 are the paired getters. Each reports the objects most recently
// bound at that register range, adding a reference to every interface it hands
// back, exactly as the device does. A query for more registers than were bound
// reports the bound ones and leaves the rest null.
function getters() {
  const stage = (slot, field, length) => ({
    [slot]: {
      argc: 4,
      invoke(r, a, o) {
        const start = number(a(1)),
          count = number(a(2)),
          out = number(a(3));
        if (start + count > length) throw Error('D3D10 stage getter range is out of bounds');
        if (count) r.check(out, count * 4, true);
        const list = field.split('.').reduce((value, part) => value?.[part], o.state);
        if (!Array.isArray(list)) throw Error('D3D10 stage register array is missing');
        for (let i = 0; i < count; i++) {
          const item = list[start + i];
          if (item && item.refs < 0x7fffffff) item.refs++;
          r.write32(out + i * 4, item ? item.pointer : 0);
        }
        return undefined;
      },
    },
  });
  const single = (slot, key, name) => ({
    [slot]: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        if (out) r.check(out, 4, true);
        const item = key.split('.').reduce((value, part) => value?.[part], o.state);
        if (item && item.refs < 0x7fffffff) item.refs++;
        r.write32(out, item ? item.pointer : 0);
        void name;
        return undefined;
      },
    },
  });
  return {
    ...stage(39, 'vs.constantBuffers', CB_SLOTS),
    ...stage(40, 'ps.resources', SRV_SLOTS),
    ...single(41, 'ps.shader'),
    ...stage(42, 'ps.samplers', SAMPLER_SLOTS),
    ...single(43, 'vs.shader'),
    ...stage(44, 'ps.constantBuffers', CB_SLOTS),
    ...single(45, 'layout'),
    // IAGetVertexBuffers reports the buffers, strides and offsets together.
    46: {
      argc: 6,
      invoke(r, a, o) {
        const start = number(a(1)),
          count = number(a(2));
        if (start + count > VERTEX_SLOTS)
          throw Error('D3D10 vertex buffer getter range is out of bounds');
        const buffers = number(a(3)),
          strides = number(a(4)),
          offsets = number(a(5));
        if (count) {
          r.check(buffers, count * 4, true);
          if (strides) r.check(strides, count * 4, true);
          if (offsets) r.check(offsets, count * 4, true);
        }
        for (let i = 0; i < count; i++) {
          const view = o.state.vertexBuffers[start + i];
          if (view && view.buffer.refs < 0x7fffffff) view.buffer.refs++;
          r.write32(buffers + i * 4, view ? view.buffer.pointer : 0);
          if (strides) r.write32(strides + i * 4, view?.stride ?? 0);
          if (offsets) r.write32(offsets + i * 4, view?.offset ?? 0);
        }
        return undefined;
      },
    },
    47: {
      argc: 4,
      invoke(r, a, o) {
        const outBuffer = number(a(1)),
          outFormat = number(a(2)),
          outOffset = number(a(3));
        if (outBuffer) r.check(outBuffer, 4, true);
        if (outFormat) r.check(outFormat, 4, true);
        if (outOffset) r.check(outOffset, 4, true);
        const view = o.state.indexBuffer;
        if (view && view.buffer.refs < 0x7fffffff) view.buffer.refs++;
        if (outBuffer) r.write32(outBuffer, view ? view.buffer.pointer : 0);
        if (outFormat) r.write32(outFormat, view?.format ?? 0);
        if (outOffset) r.write32(outOffset, view?.offset ?? 0);
        return undefined;
      },
    },
    ...stage(48, 'gs.constantBuffers', CB_SLOTS),
    ...single(49, 'gs.shader'),
    50: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        if (out) {
          r.check(out, 4, true);
          r.write32(out, o.state.topology);
        }
        return undefined;
      },
    },
    ...stage(51, 'vs.resources', SRV_SLOTS),
    ...stage(52, 'vs.samplers', SAMPLER_SLOTS),
    53: {
      argc: 3,
      invoke(r, a, o) {
        output(r, number(a(1)));
        return S_OK;
      },
    },
    ...stage(54, 'gs.resources', SRV_SLOTS),
    ...stage(55, 'gs.samplers', SAMPLER_SLOTS),
    56: {
      argc: 4,
      invoke(r, a, o) {
        const count = number(a(1)),
          outTargets = number(a(2)),
          outDepth = number(a(3));
        if (count) r.check(outTargets, count * 4, true);
        if (outDepth) r.check(outDepth, 4, true);
        for (let i = 0; i < count; i++) {
          const item = o.state.renderTargets[i];
          if (item && item.refs < 0x7fffffff) item.refs++;
          r.write32(outTargets + i * 4, item ? item.pointer : 0);
        }
        const depth = o.state.depthStencil;
        if (depth && depth.refs < 0x7fffffff) depth.refs++;
        if (outDepth) r.write32(outDepth, depth ? depth.pointer : 0);
        return undefined;
      },
    },
    57: {
      argc: 4,
      invoke(r, a, o) {
        const outState = number(a(1)),
          outFactor = number(a(2)),
          outMask = number(a(3));
        if (outState) r.check(outState, 4, true);
        if (outFactor) r.check(outFactor, 16, true);
        if (outMask) r.check(outMask, 4, true);
        const item = o.state.blendState;
        if (item && item.refs < 0x7fffffff) item.refs++;
        if (outState) r.write32(outState, item ? item.pointer : 0);
        if (outFactor)
          for (let i = 0; i < 4; i++)
            r.view.setFloat32(outFactor + i * 4, o.state.blendFactor[i], true);
        if (outMask) r.write32(outMask, o.state.sampleMask);
        return undefined;
      },
    },
    58: {
      argc: 3,
      invoke(r, a, o) {
        const outState = number(a(1)),
          outRef = number(a(2));
        if (outState) r.check(outState, 4, true);
        if (outRef) r.check(outRef, 4, true);
        const item = o.state.depthStencilState;
        if (item && item.refs < 0x7fffffff) item.refs++;
        if (outState) r.write32(outState, item ? item.pointer : 0);
        if (outRef) r.write32(outRef, o.state.stencilRef);
        return undefined;
      },
    },
    59: {
      argc: 4,
      invoke(r, a) {
        const count = number(a(1)),
          outTargets = number(a(2)),
          outOffsets = number(a(3));
        if (count) r.check(outTargets, count * 4, true);
        if (count && outOffsets) r.check(outOffsets, count * 4, true);
        for (let i = 0; i < count; i++) {
          if (outTargets) r.write32(outTargets + i * 4, 0);
          if (outOffsets) r.write32(outOffsets + i * 4, 0);
        }
        return undefined;
      },
    },
    60: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        if (out) r.check(out, 4, true);
        const item = o.state.rasterizer;
        if (item && item.refs < 0x7fffffff) item.refs++;
        r.write32(out, item ? item.pointer : 0);
        return undefined;
      },
    },
    // RSGetViewports / RSGetScissorRects: *pCount carries the caller's capacity
    // in and the reported count out, and the device always has one viewport.
    61: {
      argc: 3,
      invoke(r, a, o) {
        const count = number(a(1)),
          out = number(a(2));
        r.check(count, 4, true);
        const capacity = u32(r, count);
        const list = o.state.viewports.length ? o.state.viewports : [DEFAULT_VIEWPORT];
        if (out && capacity) {
          r.check(out, capacity * 24, true);
          for (let i = 0; i < Math.min(capacity, list.length); i++) {
            const v = list[i];
            r.view.setInt32(out + i * 24, v.x, true);
            r.view.setInt32(out + i * 24 + 4, v.y, true);
            r.write32(out + i * 24 + 8, v.width);
            r.write32(out + i * 24 + 12, v.height);
            r.view.setFloat32(out + i * 24 + 16, v.minDepth, true);
            r.view.setFloat32(out + i * 24 + 20, v.maxDepth, true);
          }
        }
        r.write32(count, list.length);
        return undefined;
      },
    },
    62: {
      argc: 3,
      invoke(r, a, o) {
        const count = number(a(1)),
          out = number(a(2));
        r.check(count, 4, true);
        const capacity = u32(r, count);
        const list = o.state.scissors.length ? o.state.scissors : [DEFAULT_SCISSOR];
        if (out && capacity) {
          r.check(out, capacity * 16, true);
          for (let i = 0; i < Math.min(capacity, list.length); i++) {
            r.view.setInt32(out + i * 16, list[i].left, true);
            r.view.setInt32(out + i * 16 + 4, list[i].top, true);
            r.view.setInt32(out + i * 16 + 8, list[i].right, true);
            r.view.setInt32(out + i * 16 + 12, list[i].bottom, true);
          }
        }
        r.write32(count, list.length);
        return undefined;
      },
    },
  };
}

const DEFAULT_VIEWPORT = { x: 0, y: 0, width: 1, height: 1, minDepth: 0, maxDepth: 1 };
const DEFAULT_SCISSOR = { left: 0, top: 0, right: 1, bottom: 1 };
const S_FALSE = 0x00000001;

// --- DXGI swap chain -------------------------------------------------------

// A D3D10 device presents through an IDXGISwapChain. The chain model here is
// the DXGI one: GetBuffer hands back the back buffer as an ID3D10Texture2D
// whose bytes the backend owns, Present publishes the current image and, for
// the bit-block-transfer effects, the back buffer stays index 0 so an
// application that renders through one render-target view keeps drawing into
// the image that is presented.
function swapchainDesc(r, ptr) {
  r.check(ptr, 60);
  const width = u32(r, ptr),
    height = u32(r, ptr, 4),
    format = u32(r, ptr, 16);
  const bufferCount = u32(r, ptr, 40);
  const windowId = u32(r, ptr, 44);
  const win = r.windows?.windows?.get(windowId);
  if (
    !(format === 28 || format === 87) ||
    u32(r, ptr, 28) !== 1 ||
    u32(r, ptr, 32) ||
    !(u32(r, ptr, 36) & 0x20) ||
    u32(r, ptr, 36) & ~0x20 ||
    ![2, 3].includes(bufferCount) ||
    u32(r, ptr, 48) !== 1 ||
    u32(r, ptr, 52) > 4 ||
    u32(r, ptr, 52) === 2 ||
    u32(r, ptr, 52) === 3 ||
    u32(r, ptr, 56) & ~0x2
  )
    throw Error('Unsupported DXGI swap chain description');
  const resolvedWidth = width || win?.width,
    resolvedHeight = height || win?.height;
  if (!win || !resolvedWidth || !resolvedHeight || resolvedWidth > 2048 || resolvedHeight > 2048)
    throw Error('Unsupported DXGI swap chain size');
  return {
    windowId,
    width: resolvedWidth,
    height: resolvedHeight,
    format,
    bufferCount,
    // Only the flip effects rotate the current back buffer; DISCARD and
    // SEQUENTIAL present the image at index 0 every time.
    rotate: u32(r, ptr, 52) === 4,
  };
}

function swapchainMethods() {
  return {
    3: { argc: 4, invoke: () => S_OK },
    4: { argc: 3, invoke: () => S_OK },
    5: {
      argc: 4,
      invoke(r, a) {
        const size = number(a(2));
        if (size) output(r, size);
        return DXGI_ERROR_NOT_FOUND;
      },
    },
    // An internally created chain has no factory parent; DXGI reports
    // DXGI_ERROR_NOT_FOUND for an object whose parent was never set.
    6: {
      argc: 3,
      invoke(r, a) {
        output(r, number(a(2)));
        return DXGI_ERROR_NOT_FOUND;
      },
    },
    7: {
      argc: 3,
      invoke(r, a, o) {
        const out = number(a(2));
        if (out) r.check(out, 4, true);
        const device = o.state.device;
        if (device && device.refs < 0x7fffffff) device.refs++;
        if (out) r.write32(out, device ? device.pointer : 0);
        return S_OK;
      },
    },
    8: {
      argc: 3,
      invoke: (r, a, o) => presentSwapchain(r, a, o),
    },
    9: {
      argc: 4,
      invoke(r, a, o) {
        const out = number(a(3));
        output(r, out);
        const index = number(a(1));
        if (index >= o.state.buffers.length) return E_INVALIDARG;
        if (!iid(r, a(2), 'texture2d')) return E_NOINTERFACE;
        const buffer = o.state.buffers[index];
        if (buffer.refs >= 0x7fffffff) throw Error('DXGI back buffer reference limit exceeded');
        buffer.refs++;
        r.write32(out, buffer.pointer);
        return S_OK;
      },
    },
    10: {
      argc: 3,
      invoke(r, a) {
        if (number(a(1))) throw Error('Unsupported DXGI exclusive fullscreen');
        const target = number(a(2));
        if (target) {
          r.check(target, 4, true);
          r.write32(target, 0);
        }
        return S_OK;
      },
    },
    11: {
      argc: 3,
      invoke(r, a) {
        for (const offset of [number(a(1)), number(a(2))])
          if (offset) {
            r.check(offset, 4, true);
            r.write32(offset, 0);
          }
        return S_OK;
      },
    },
    12: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 60, true);
        r.data.fill(0, out, out + 60);
        r.write32(out, o.state.width);
        r.write32(out + 4, o.state.height);
        r.write32(out + 16, o.state.format);
        r.write32(out + 28, 1);
        r.write32(out + 36, 0x20);
        r.write32(out + 40, o.state.buffers.length);
        r.write32(out + 44, o.state.windowId);
        r.write32(out + 48, 1);
        r.write32(out + 52, o.state.effect);
        return undefined;
      },
    },
    13: {
      argc: 6,
      invoke(r, a, o) {
        const count = number(a(1)) || o.state.buffers.length;
        const width = number(a(2)) || o.state.width;
        const height = number(a(3)) || o.state.height;
        const format = number(a(4));
        if (number(a(5))) throw Error('Unsupported DXGI swap chain resize flags');
        if (![2, 3].includes(count) || width > 2048 || height > 2048)
          throw Error('Unsupported DXGI swap chain resize size or count');
        if (format && format !== 28 && format !== 87)
          throw Error('Unsupported DXGI swap chain resize format');
        return resizeSwapchain(r, o, { count, width, height, format });
      },
    },
    14: { argc: 2, invoke: () => S_OK },
    15: {
      argc: 2,
      invoke(r, a) {
        output(r, number(a(1)));
        return DXGI_ERROR_NOT_FOUND;
      },
    },
    16: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 32, true);
        r.data.fill(0, out, out + 32);
        const present = o.state.presentCount;
        r.write32(out, present);
        r.write32(out + 8, present);
        r.write32(out + 16, present);
        return S_OK;
      },
    },
    17: {
      argc: 2,
      invoke(r, a, o) {
        const out = number(a(1));
        r.check(out, 4, true);
        r.write32(out, o.state.presentCount);
        return S_OK;
      },
    },
  };
}

async function presentSwapchain(r, a, o) {
  if (number(a(1)) > 1 || number(a(2))) throw Error('Unsupported DXGI Present interval or flags');
  await requireBackend(r).present({ id: o.pointer, index: o.state.index, graphicsApi: 'd3d10' });
  if (o.state.rotate) o.state.index = (o.state.index + 1) % o.state.buffers.length;
  o.state.presentCount++;
  return S_OK;
}

// ResizeBuffers releases the old back buffers and creates new ones at the new
// size, reusing every interface the application already holds on the chain.
async function resizeSwapchain(r, o, { count, width, height, format }) {
  const s = o.state;
  const ids = [];
  for (let index = 0; index < count; index++) {
    const buffer = make(
      r,
      'texture2d',
      texture2dMethods(),
      backBufferState(s, index),
      s.device,
      () => {},
    );
    ids.push(buffer.pointer);
  }
  try {
    await requireBackend(r).resizeSwapChain({
      id: o.pointer,
      width,
      height,
      bufferIds: ids,
    });
  } catch (error) {
    for (const id of ids) {
      const item = r.comObjects.objects.get(id);
      if (item) {
        item.refs = 0;
        s.device.refs--;
      }
    }
    throw error;
  }
  for (const buffer of s.buffers) if (!--buffer.refs) s.device.refs--;
  s.buffers = ids.map((id) => r.comObjects.objects.get(id));
  s.width = width;
  s.height = height;
  s.index = 0;
  if (format) s.format = format;
  return S_OK;
}

function backBufferState(swapchain, index) {
  return {
    kind: 'texture2d',
    width: swapchain.width,
    height: swapchain.height,
    format: swapchain.format,
    usage: USAGE_DEFAULT,
    bindFlags: BIND.RT,
    cpuAccess: 0,
    storage: 0,
    evictionPriority: 0,
    swapchain,
    swapchainIndex: index,
  };
}

// Creates a swap chain the device presents through. The back buffers are real
// ID3D10Texture2D objects whose GPU images the shared backend owns under the
// same pointer the application renders into.
async function createSwapChainForDevice(r, device, desc) {
  const s = make(
    r,
    'swapchain',
    swapchainMethods(),
    {
      device,
      index: 0,
      buffers: [],
      width: desc.width,
      height: desc.height,
      format: desc.format,
      windowId: desc.windowId,
      rotate: desc.rotate,
      effect: desc.rotate ? 4 : 0,
      presentCount: 0,
    },
    null,
    async (item) => {
      await requireBackend(r).destroySwapChain({ id: item.pointer });
      for (const buffer of item.state.buffers) if (!--buffer.refs) device.refs--;
    },
  );
  for (let index = 0; index < desc.bufferCount; index++)
    s.state.buffers.push(
      make(r, 'texture2d', texture2dMethods(), backBufferState(s.state, index), device, () => {}),
    );

  try {
    await requireBackend(r).createSwapChain({
      id: s.pointer,
      windowId: desc.windowId,
      width: desc.width,
      height: desc.height,
      bufferIds: s.state.buffers.map((buffer) => buffer.pointer),
      format: desc.format === 87 ? 'bgra8unorm' : 'rgba8unorm',
    });
  } catch (error) {
    s.refs = 0;
    for (const buffer of s.state.buffers) {
      buffer.refs = 0;
      device.refs--;
    }
    throw error;
  }
  return s;
}

// --- entry points ----------------------------------------------------------

// D3D10CreateDevice(IDXGIAdapter *adapter, D3D10_DRIVER_TYPE driverType,
//                   HMODULE software, UINT flags, UINT sdkVersion,
//                   ID3D10Device **device).
//
// The device-and-swap-chain entry point takes the same six leading arguments
// and appends two outputs, so `outIndex` names the device output slot and one
// implementation serves both.
function createDevice(r, a, outIndex = 5) {
  const out = number(a(outIndex));
  output(r, out);
  const adapter = number(a(0));
  const driverType = number(a(1));
  const software = number(a(2));
  const flags = number(a(3));
  const sdkVersion = number(a(4));
  if (!DRIVER_TYPES.has(driverType)) return E_INVALIDARG;
  // Only the hardware and reference/WARP driver types have anything to present
  // through; a software module handle is a driver-supplied rasterizer.
  if (driverType === 3 && !software) return E_INVALIDARG;
  if (flags & ~CREATE_FLAGS) return E_INVALIDARG;
  if (sdkVersion !== D3D10_SDK_VERSION) return E_INVALIDARG;
  if (adapter) {
    // An adapter from the DXGI factory is accepted, so an application that
    // enumerates and then creates its device keeps working.
    const item = r.comObjects?.objects.get(adapter);
    if (!item || !item.refs || !/^IDXGIAdapter/.test(item.name)) return E_INVALIDARG;
  }
  requireBackend(r);
  // The COM object store must exist before the first object is created.
  state(r);
  const device = make(r, 'device', deviceMethods(), deviceState(flags), null, async (o) => {
    const backend = requireBackend(r);
    for (const id of o.state.pipelineIds) backend.destroyPipeline({ id });
    for (const chain of o.state.swapchains) {
      const item = r.comObjects.objects.get(chain);
      if (item?.refs) item.refs = 0;
    }
  });
  state(r).devices.add(device.pointer);
  r.write32(out, device.pointer);
  return S_OK;
}

// D3D10CreateDeviceAndSwapChain(adapter, driverType, software, flags,
//                               sdkVersion, DXGI_SWAP_CHAIN_DESC *desc,
//                               IDXGISwapChain **swapchain, ID3D10Device **device)
async function createDeviceAndSwapChain(r, a) {
  const swapOut = number(a(6));
  const deviceOut = number(a(7));
  if (swapOut) output(r, swapOut);
  if (deviceOut) output(r, deviceOut);
  if (!swapOut || !deviceOut) return E_INVALIDARG;
  const result = createDevice(r, a, 7);
  if (result !== S_OK) return result;
  const device = r.comObjects.objects.get(r.read32(deviceOut));
  let desc;
  try {
    desc = swapchainDesc(r, number(a(5)));
  } catch (error) {
    // The device was already created and handed out; release it so a rejected
    // swap chain does not leak and the caller sees one consistent failure.
    r.write32(deviceOut, 0);
    device.refs = 0;
    throw error;
  }
  const chain = await createSwapChainForDevice(r, device, desc);
  device.state.swapchains.add(chain.pointer);
  r.write32(swapOut, chain.pointer);
  return S_OK;
}

async function compileShader10(r, a) {
  return compileHlsl(r, a, COMPILE_SHADER_10_LAYOUT);
}

// D3D10GetInputSignatureBlob(const void *pShaderBytecode, SIZE_T BytecodeLength,
//                            ID3D10Blob **ppBlob) hands back a blob holding the
// DXBC container's ISGN chunk, which is what CreateInputLayout consumes.
function inputSignatureBlob(r, a) {
  const out = number(a(2));
  output(r, out);
  const bytecode = blobBytes(r, number(a(0)), number(a(1)), 'shader');
  let container;
  try {
    container = inputSignatureContainer(bytecode);
  } catch {
    return E_INVALIDARG;
  }
  r.write32(out, createBlob(r, container).pointer);
  return S_OK;
}

// D3D10ReflectShader(const void *pShaderBytecode, SIZE_T BytecodeLength,
//                    ID3D10ShaderReflection **ppReflection)
function reflectShader(r, a) {
  const out = number(a(2));
  output(r, out);
  const bytecode = blobBytes(r, number(a(0)), number(a(1)), 'shader');
  let description;
  try {
    // The container's own RDEF and signature chunks are the description, so
    // the object reports the shader the application actually compiled.
    description = reflectDxbc(bytecode);
  } catch {
    return E_INVALIDARG;
  }
  r.write32(out, makeReflection(r, description).pointer);
  return S_OK;
}

// An HRESULT-returning entry point reports the stack slots it consumed, so the
// guest's stdcall correction matches what the callee popped.
const hresult = (argc, implementation) => async (r, a) => ({
  result: await implementation(r, a),
  argc,
});

export const d3d10Apis = {
  'd3d10.dll!D3D10CreateDevice': hresult(6, (r, a) => createDevice(r, a)),
  'd3d10.dll!D3D10CreateDeviceAndSwapChain': hresult(8, (r, a) => createDeviceAndSwapChain(r, a)),
  'd3d10.dll!D3D10CompileShader': hresult(10, (r, a) => compileShader10(r, a)),
  'd3d10.dll!D3D10GetInputSignatureBlob': hresult(3, (r, a) => inputSignatureBlob(r, a)),
  'd3d10.dll!D3D10ReflectShader': hresult(3, (r, a) => reflectShader(r, a)),
  // The profile the device would compile against. The pointer is stable for the
  // process, as the real entry point's is, and the returned value is a string
  // pointer rather than an HRESULT.
  'd3d10.dll!D3D10GetVertexShaderProfile': (r) => ({
    result: profilePointer(r, PROFILE_STRINGS.vertex),
    argc: 1,
  }),
  'd3d10.dll!D3D10GetPixelShaderProfile': (r) => ({
    result: profilePointer(r, PROFILE_STRINGS.pixel),
    argc: 1,
  }),
  'd3d10.dll!D3D10GetGeometryShaderProfile': (r) => ({
    result: profilePointer(r, PROFILE_STRINGS.geometry),
    argc: 1,
  }),
  // D3D10CreateBlob(SIZE_T DataSize, ID3D10Blob **ppBlob) hands back an
  // uninitialised blob the caller fills, so a zeroed buffer is the right shape.
  'd3d10.dll!D3D10CreateBlob': hresult(2, (r, a) => {
    const size = number(a(0));
    const out = number(a(1));
    output(r, out);
    if (!size || size > MAX_BYTES) return E_INVALIDARG;
    r.write32(out, createBlob(r, new Uint8Array(size)).pointer);
    return S_OK;
  }),
};

// --- shader reflection objects ---------------------------------------------

// The reflection interfaces are not device children: they are created only by
// D3D10ReflectShader, answer IUnknown, and their GetConstantBuffer* and
// GetVariable* methods return an interface pointer directly rather than
// through an out parameter. Guest strings are interned once per reflection and
// freed with it.
function makeReflection(r, description) {
  const strings = new Map();
  const intern = (text) => {
    let pointer = strings.get(text);
    if (pointer === undefined) {
      const bytes = new TextEncoder().encode(text + '\0');
      pointer = r.allocate(bytes.length);
      r.data.set(bytes, pointer);
      strings.set(text, pointer);
    }
    return pointer;
  };
  const state = { description, strings, names: new Map() };
  const pointerFor = (map, key, build) => {
    let item = map.get(key);
    if (!item) {
      item = build();
      map.set(key, item);
    }
    return item;
  };
  return makeStandalone(
    r,
    'ID3D10ShaderReflection',
    iids.shaderReflection,
    [
      'QueryInterface',
      'AddRef',
      'Release',
      'GetDesc',
      'GetConstantBufferByIndex',
      'GetConstantBufferByName',
      'GetResourceBindingDesc',
      'GetInputParameterDesc',
      'GetOutputParameterDesc',
    ],
    {
      3: {
        argc: 2,
        invoke(runtime, a, o) {
          const out = number(a(1));
          runtime.check(out, 112, true);
          runtime.data.fill(0, out, out + 112);
          const d = o.state.description;
          runtime.write32(out, d.version);
          runtime.write32(out + 4, d.creator ? intern(d.creator) : 0);
          runtime.write32(out + 8, d.flags);
          runtime.write32(out + 12, d.constantBuffers.length);
          runtime.write32(out + 16, d.bindings.length);
          runtime.write32(out + 20, d.inputs.length);
          runtime.write32(out + 24, d.outputs.length);
          return undefined;
        },
      },
      4: {
        argc: 2,
        invoke(runtime, a, o) {
          const index = number(a(1));
          if (index >= o.state.description.constantBuffers.length) return 0;
          return constantBufferReflection(runtime, o, index).pointer;
        },
      },
      5: {
        argc: 2,
        invoke(runtime, a, o) {
          const name = runtime.string(number(a(1)));
          const index = o.state.description.constantBuffers.findIndex(
            (buffer) => buffer.name === name,
          );
          if (index < 0) return 0;
          return constantBufferReflection(runtime, o, index).pointer;
        },
      },
      6: {
        argc: 3,
        invoke(runtime, a, o) {
          const index = number(a(1));
          const out = number(a(2));
          const binding = o.state.description.bindings[index];
          if (!binding) return E_INVALIDARG;
          runtime.check(out, 32, true);
          runtime.data.fill(0, out, out + 32);
          runtime.write32(out, intern(binding.name));
          runtime.write32(out + 4, binding.type);
          runtime.write32(out + 8, binding.bindPoint);
          runtime.write32(out + 12, binding.bindCount);
          runtime.write32(out + 16, binding.flags);
          runtime.write32(out + 20, binding.returnType);
          runtime.write32(out + 24, binding.dimension);
          runtime.write32(out + 28, binding.numSamples);
          return S_OK;
        },
      },
      7: {
        argc: 3,
        invoke: (runtime, a, o) => writeSignature(runtime, o.state.description.inputs, intern, a),
      },
      8: {
        argc: 3,
        invoke: (runtime, a, o) => writeSignature(runtime, o.state.description.outputs, intern, a),
      },
    },
    state,
    (o) => {
      for (const pointer of o.state.strings.values()) r.free(pointer);
    },
  );
}

function writeSignature(r, list, intern, a) {
  const index = number(a(1));
  const out = number(a(2));
  const parameter = list[index];
  if (!parameter) return E_INVALIDARG;
  r.check(out, 24, true);
  r.data.fill(0, out, out + 24);
  r.write32(out, intern(parameter.name));
  r.write32(out + 4, parameter.semanticIndex);
  r.write32(out + 8, parameter.register);
  r.write32(out + 12, parameter.systemValue);
  r.write32(out + 16, parameter.componentType);
  r.data[out + 20] = parameter.mask;
  r.data[out + 21] = parameter.readWriteMask;
  return S_OK;
}

function constantBufferReflection(r, owner, index) {
  const key = `cb:${index}`;
  return owner.state.names.get(key)
    ? owner.state.names.get(key)
    : (() => {
        const buffer = owner.state.description.constantBuffers[index];
        const variables = owner.state.description.variables[index] ?? [];
        const item = makeStandalone(
          r,
          'ID3D10ShaderReflectionConstantBuffer',
          IUNKNOWN,
          [
            'QueryInterface',
            'AddRef',
            'Release',
            'GetDesc',
            'GetVariableByIndex',
            'GetVariableByName',
          ],
          {
            3: {
              argc: 2,
              invoke(runtime, a, o) {
                const out = number(a(1));
                runtime.check(out, 20, true);
                runtime.data.fill(0, out, out + 20);
                runtime.write32(out, ownerString(runtime, o, buffer.name));
                runtime.write32(out + 8, o.state.variables.length);
                runtime.write32(out + 12, buffer.size);
                return undefined;
              },
            },
            4: {
              argc: 2,
              invoke(runtime, a, o) {
                const at = number(a(1));
                if (at >= o.state.variables.length) return 0;
                return variableReflection(runtime, o, at).pointer;
              },
            },
            5: {
              argc: 2,
              invoke(runtime, a, o) {
                const name = runtime.string(number(a(1)));
                const at = o.state.variables.findIndex((variable) => variable.name === name);
                if (at < 0) return 0;
                return variableReflection(runtime, o, at).pointer;
              },
            },
          },
          { variables, owner },
        );
        owner.state.names.set(key, item);
        return item;
      })();
}

function variableReflection(r, owner, index) {
  const key = `var:${index}`;
  if (owner.state.names.has(key)) return owner.state.names.get(key);
  const variable = owner.state.variables[index];
  const item = makeStandalone(
    r,
    'ID3D10ShaderReflectionVariable',
    IUNKNOWN,
    ['QueryInterface', 'AddRef', 'Release', 'GetDesc', 'GetType'],
    {
      3: {
        argc: 2,
        invoke(runtime, a, o) {
          const out = number(a(1));
          runtime.check(out, 20, true);
          runtime.data.fill(0, out, out + 20);
          runtime.write32(out, ownerString(runtime, o, variable.name));
          runtime.write32(out + 4, variable.offset);
          runtime.write32(out + 8, variable.size);
          return undefined;
        },
      },
      4: {
        argc: 1,
        invoke: (runtime, _a, o) => typeReflection(runtime, o).pointer,
      },
    },
    { variable, owner },
  );
  owner.state.names.set(key, item);
  return item;
}

function typeReflection(r, owner) {
  if (owner.state.names.has('type')) return owner.state.names.get('type');
  const item = makeStandalone(
    r,
    'ID3D10ShaderReflectionType',
    IUNKNOWN,
    [
      'QueryInterface',
      'AddRef',
      'Release',
      'GetDesc',
      'GetMemberTypeByIndex',
      'GetMemberTypeByName',
      'GetMemberTypeName',
    ],
    {
      3: {
        argc: 2,
        invoke(runtime, a) {
          const out = number(a(1));
          runtime.check(out, 28, true);
          runtime.data.fill(0, out, out + 28);
          return undefined;
        },
      },
      // The bounded reflection describes no aggregate members, so a member
      // request is the documented null rather than an invented type.
      4: { argc: 2, invoke: () => 0 },
      5: { argc: 2, invoke: () => 0 },
      6: { argc: 2, invoke: () => 0 },
    },
    { owner },
  );
  owner.state.names.set('type', item);
  return item;
}

// A reflection object's strings live in the root object, so a nested
// descriptor reuses the same allocation.
function ownerString(r, o, text) {
  const root = o.state.owner ?? o;
  let pointer = root.state.strings.get(text);
  if (pointer === undefined) {
    const bytes = new TextEncoder().encode(text + '\0');
    pointer = r.allocate(bytes.length);
    r.data.set(bytes, pointer);
    root.state.strings.set(text, pointer);
  }
  return pointer;
}

// Reflection interfaces answer IUnknown and carry no device.
function makeStandalone(r, label, iidValue, methodNames, methods, state, onRelease) {
  return r.comObjects.create({
    name: label,
    iid: iidValue,
    iids: [],
    methodNames,
    methods,
    state: { ...state, device: state.device ?? null },
    onRelease,
  });
}

// --- the shared DXGI factory bridge ----------------------------------------

// A D3D10 application usually creates its device first and then asks the DXGI
// factory for a swap chain, passing the device's IDXGIDevice. The factory is
// shared with the D3D12 frontend, so D3D10 registers how to build a chain whose
// back buffers are ID3D10Texture2D objects and whose Present is the immediate
// one. The XIG device object carries the owning device, which is what the
// chain has to hold on to.
// A framework may hand the factory either its device or the IDXGIDevice it
// queried from it, so both names resolve here and the chain is built around the
// device that owns its back buffers.
registerSwapChainProvider(
  ['ID3D10Device', 'IDXGIDevice'],
  async (r, { item, descPointer, desc1, windowId, result }) => {
    const owner = item.name === name.device ? item : item.state.owner;
    if (!owner?.refs) throw Error('DXGI swap chain requires a live D3D10 device');
    output(r, result);
    // D3D10's own rules: the 1.0 description carries the effect and window, the
    // 1.1 description separates the window out and adds scaling and alpha mode.
    const desc = desc1 ? swapchainDesc1(r, descPointer, windowId) : swapchainDesc(r, descPointer);
    const chain = await createSwapChainForDevice(r, owner, desc);
    owner.state.swapchains.add(chain.pointer);
    r.write32(result, chain.pointer);
    return S_OK;
  },
);
