import { ComObjects } from './com.js';
import {
  bindObject,
  createDeclarationObject,
  createShaderObject,
  getBoundObject,
  getFloatConstants,
  programmableDraw,
  releaseComReference,
  setFloatConstants,
} from './d3d9-programmable.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const MAX_COMMANDS = 256;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_VERTICES = 65535;
const IDENTITY = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const floatBits = new DataView(new ArrayBuffer(4));
const floatFromBits = (bits) => {
  floatBits.setUint32(0, bits >>> 0, true);
  return floatBits.getFloat32(0, true);
};

// Slot order and argument counts follow MinGW's i686-w64-mingw32 d3d9.h.
const D3D9_METHODS =
  `QueryInterface AddRef Release RegisterSoftwareDevice GetAdapterCount GetAdapterIdentifier GetAdapterModeCount EnumAdapterModes GetAdapterDisplayMode CheckDeviceType CheckDeviceFormat CheckDeviceMultiSampleType CheckDepthStencilMatch CheckDeviceFormatConversion GetDeviceCaps GetAdapterMonitor CreateDevice`.split(
    ' ',
  );
const DEVICE_METHODS =
  `QueryInterface AddRef Release TestCooperativeLevel GetAvailableTextureMem EvictManagedResources GetDirect3D GetDeviceCaps GetDisplayMode GetCreationParameters SetCursorProperties SetCursorPosition ShowCursor CreateAdditionalSwapChain GetSwapChain GetNumberOfSwapChains Reset Present GetBackBuffer GetRasterStatus SetDialogBoxMode SetGammaRamp GetGammaRamp CreateTexture CreateVolumeTexture CreateCubeTexture CreateVertexBuffer CreateIndexBuffer CreateRenderTarget CreateDepthStencilSurface UpdateSurface UpdateTexture GetRenderTargetData GetFrontBufferData StretchRect ColorFill CreateOffscreenPlainSurface SetRenderTarget GetRenderTarget SetDepthStencilSurface GetDepthStencilSurface BeginScene EndScene Clear SetTransform GetTransform MultiplyTransform SetViewport GetViewport SetMaterial GetMaterial SetLight GetLight LightEnable GetLightEnable SetClipPlane GetClipPlane SetRenderState GetRenderState CreateStateBlock BeginStateBlock EndStateBlock SetClipStatus GetClipStatus GetTexture SetTexture GetTextureStageState SetTextureStageState GetSamplerState SetSamplerState ValidateDevice SetPaletteEntries GetPaletteEntries SetCurrentTexturePalette GetCurrentTexturePalette SetScissorRect GetScissorRect SetSoftwareVertexProcessing GetSoftwareVertexProcessing SetNPatchMode GetNPatchMode DrawPrimitive DrawIndexedPrimitive DrawPrimitiveUP DrawIndexedPrimitiveUP ProcessVertices CreateVertexDeclaration SetVertexDeclaration GetVertexDeclaration SetFVF GetFVF CreateVertexShader SetVertexShader GetVertexShader SetVertexShaderConstantF GetVertexShaderConstantF SetVertexShaderConstantI GetVertexShaderConstantI SetVertexShaderConstantB GetVertexShaderConstantB SetStreamSource GetStreamSource SetStreamSourceFreq GetStreamSourceFreq SetIndices GetIndices CreatePixelShader SetPixelShader GetPixelShader SetPixelShaderConstantF GetPixelShaderConstantF SetPixelShaderConstantI GetPixelShaderConstantI SetPixelShaderConstantB GetPixelShaderConstantB DrawRectPatch DrawTriPatch DeletePatch CreateQuery`.split(
    ' ',
  );

function requireGraphics(runtime) {
  if (
    !runtime.graphics?.createDevice ||
    !runtime.graphics?.present ||
    !runtime.graphics?.destroyDevice
  )
    throw Error('D3D9 graphics backend is unavailable');
  return runtime.graphics;
}

function queue(state, command, bytes = 0) {
  if (state.commands.length >= MAX_COMMANDS || state.frameBytes + bytes > MAX_FRAME_BYTES)
    throw Error('D3D9 frame command limit exceeded');
  state.commands.push(command);
  state.frameBytes += bytes;
}

function matrix(runtime, pointer) {
  runtime.check(pointer, 64);
  const value = new Float32Array(16);
  for (let i = 0; i < 16; i++) {
    value[i] = runtime.view.getFloat32(pointer + i * 4, true);
    if (!Number.isFinite(value[i])) throw Error('Unsupported D3D9 non-finite transform');
  }
  return value;
}

function deviceMethods() {
  return {
    17: {
      argc: 5,
      async invoke(runtime, argument, object) {
        if ([1, 2, 3, 4].some((index) => argument(index)))
          throw Error('Unsupported IDirect3DDevice9.Present rectangles or window override');
        const state = object.state;
        if (state.inScene) return D3DERR_INVALIDCALL;
        await requireGraphics(runtime).present({ id: state.id, commands: [...state.commands] });
        state.commands = [];
        state.frameBytes = 0;
        return D3D_OK;
      },
    },
    41: {
      argc: 1,
      invoke(_runtime, _argument, object) {
        if (object.state.inScene) return D3DERR_INVALIDCALL;
        object.state.inScene = true;
        return D3D_OK;
      },
    },
    42: {
      argc: 1,
      invoke(_runtime, _argument, object) {
        if (!object.state.inScene) return D3DERR_INVALIDCALL;
        object.state.inScene = false;
        return D3D_OK;
      },
    },
    43: {
      argc: 7,
      invoke(_runtime, argument, object) {
        const count = argument(1) >>> 0;
        const rects = argument(2) >>> 0;
        const flags = argument(3) >>> 0;
        const depth = floatFromBits(argument(5));
        if (
          count ||
          rects ||
          argument(6) ||
          !flags ||
          flags & ~3 ||
          !Number.isFinite(depth) ||
          depth < 0 ||
          depth > 1
        )
          throw Error('Unsupported IDirect3DDevice9.Clear parameters');
        if (flags & 2 && !object.state.hasDepth) return D3DERR_INVALIDCALL;
        queue(object.state, {
          type: 'clear',
          color: argument(4) >>> 0,
          depth,
          clearColor: !!(flags & 1),
          clearDepth: !!(flags & 2),
        });
        return D3D_OK;
      },
    },
    44: {
      argc: 3,
      invoke(runtime, argument, object) {
        const state = argument(1) >>> 0;
        const field =
          state === 256 ? 'world' : state === 2 ? 'view' : state === 3 ? 'projection' : null;
        if (!field) throw Error(`Unsupported IDirect3DDevice9.SetTransform state ${state}`);
        object.state[field] = matrix(runtime, argument(2) >>> 0);
        return D3D_OK;
      },
    },
    57: {
      argc: 3,
      invoke(_runtime, argument, object) {
        const state = argument(1) >>> 0;
        const value = argument(2) >>> 0;
        if (state === 22 && value === 1) object.state.cullMode = 'none';
        else if (state === 137 && value === 0) object.state.lighting = false;
        else if (state === 7 && value <= 1) {
          if (value && !object.state.hasDepth) return D3DERR_INVALIDCALL;
          object.state.depthTest = !!value;
        } else if (state === 14 && value <= 1) {
          if (value && !object.state.hasDepth) return D3DERR_INVALIDCALL;
          object.state.depthWrite = !!value;
        } else throw Error(`Unsupported IDirect3DDevice9.SetRenderState ${state}=${value}`);
        return D3D_OK;
      },
    },
    83: {
      argc: 5,
      invoke(runtime, argument, object) {
        const state = object.state;
        const primitive = argument(1) >>> 0;
        const primitiveCount = argument(2) >>> 0;
        const pointer = argument(3) >>> 0;
        const stride = argument(4) >>> 0;
        if (!state.inScene) return D3DERR_INVALIDCALL;
        if ((state.depthTest || state.depthWrite) && !state.hasDepth) return D3DERR_INVALIDCALL;
        if (!primitiveCount || primitiveCount * 3 > MAX_VERTICES)
          throw Error('D3D9 vertex count limit exceeded');
        const vertexCount = primitiveCount * 3;
        const programmable = programmableDraw(runtime, state, pointer, stride, vertexCount);
        if (programmable) {
          if (primitive !== 4 || state.cullMode !== 'none')
            throw Error('Unsupported programmable IDirect3DDevice9.DrawPrimitiveUP state');
          const { payloadBytes, ...command } = programmable;
          queue(state, command, payloadBytes);
          return D3D_OK;
        }
        if (
          primitive !== 4 ||
          stride !== 16 ||
          state.fvf !== 0x42 ||
          state.lighting ||
          state.cullMode !== 'none'
        )
          throw Error('Unsupported IDirect3DDevice9.DrawPrimitiveUP format or render state');
        const size = vertexCount * stride;
        if (state.frameBytes + size > MAX_FRAME_BYTES)
          throw Error('D3D9 frame vertex limit exceeded');
        runtime.check(pointer, size);
        const vertices = runtime.data.slice(pointer, pointer + size);
        const view = new DataView(vertices.buffer);
        for (let i = 0; i < vertexCount; i++)
          for (let coordinate = 0; coordinate < 3; coordinate++)
            if (!Number.isFinite(view.getFloat32(i * stride + coordinate * 4, true)))
              throw Error('Unsupported D3D9 non-finite vertex');
        queue(
          state,
          {
            type: 'draw',
            vertices,
            vertexCount,
            stride,
            world: state.world.slice(),
            view: state.view.slice(),
            projection: state.projection.slice(),
            depthTest: state.depthTest,
            depthWrite: state.depthWrite,
            cullMode: state.cullMode,
          },
          size,
        );
        return D3D_OK;
      },
    },
    89: {
      argc: 2,
      invoke(_runtime, argument, object) {
        const fvf = argument(1) >>> 0;
        if (fvf !== 0x42) throw Error(`Unsupported IDirect3DDevice9.SetFVF 0x${fvf.toString(16)}`);
        object.state.fvf = fvf;
        bindObject(_runtime, object, 'vertexDeclaration', 0, 'IDirect3DVertexDeclaration9');
        return D3D_OK;
      },
    },
    86: {
      argc: 3,
      invoke(runtime, argument, device) {
        const output = argument(2) >>> 0;
        runtime.check(output, 4, true);
        runtime.write32(output, 0);
        const declaration = createDeclarationObject(runtime, device, argument(1) >>> 0);
        runtime.write32(output, declaration.pointer);
        return D3D_OK;
      },
    },
    87: {
      argc: 2,
      invoke(runtime, argument, device) {
        const result = bindObject(
          runtime,
          device,
          'vertexDeclaration',
          argument(1) >>> 0,
          'IDirect3DVertexDeclaration9',
        );
        if (result === D3D_OK) device.state.fvf = 0;
        return result;
      },
    },
    88: { argc: 2, invoke: (r, a, d) => getBoundObject(r, d, 'vertexDeclaration', a(1)) },
    91: {
      argc: 3,
      invoke(runtime, argument, device) {
        const output = argument(2) >>> 0;
        runtime.check(output, 4, true);
        runtime.write32(output, 0);
        const shader = createShaderObject(runtime, device, argument(1) >>> 0, 'vertex');
        runtime.write32(output, shader.pointer);
        return D3D_OK;
      },
    },
    92: {
      argc: 2,
      invoke: (r, a, d) => bindObject(r, d, 'vertexShader', a(1) >>> 0, 'IDirect3DVertexShader9'),
    },
    93: { argc: 2, invoke: (r, a, d) => getBoundObject(r, d, 'vertexShader', a(1)) },
    94: {
      argc: 4,
      invoke: (r, a, d) => setFloatConstants(r, d.state.vertexConstants, a(1), a(2), a(3), 256),
    },
    95: {
      argc: 4,
      invoke: (r, a, d) => getFloatConstants(r, d.state.vertexConstants, a(1), a(2), a(3), 256),
    },
    106: {
      argc: 3,
      invoke(runtime, argument, device) {
        const output = argument(2) >>> 0;
        runtime.check(output, 4, true);
        runtime.write32(output, 0);
        const shader = createShaderObject(runtime, device, argument(1) >>> 0, 'pixel');
        runtime.write32(output, shader.pointer);
        return D3D_OK;
      },
    },
    107: {
      argc: 2,
      invoke: (r, a, d) => bindObject(r, d, 'pixelShader', a(1) >>> 0, 'IDirect3DPixelShader9'),
    },
    108: { argc: 2, invoke: (r, a, d) => getBoundObject(r, d, 'pixelShader', a(1)) },
    109: {
      argc: 4,
      invoke: (r, a, d) => setFloatConstants(r, d.state.pixelConstants, a(1), a(2), a(3), 224),
    },
    110: {
      argc: 4,
      invoke: (r, a, d) => getFloatConstants(r, d.state.pixelConstants, a(1), a(2), a(3), 224),
    },
  };
}

function createDevice(runtime, argument) {
  const adapter = argument(1) >>> 0;
  const deviceType = argument(2) >>> 0;
  const focus = argument(3) >>> 0;
  const behavior = argument(4) >>> 0;
  const params = argument(5) >>> 0;
  const output = argument(6) >>> 0;
  runtime.check(output, 4, true);
  runtime.write32(output, 0);
  runtime.check(params, 56);
  const read = (offset) => runtime.read32(params + offset);
  const windowId = read(28) || focus;
  const window = runtime.windows?.windows?.get(windowId);
  const width = read(0) || window?.width;
  const height = read(4) || window?.height;
  const format = read(8);
  const depth = !!read(36);
  if (
    adapter !== 0 ||
    deviceType !== 1 ||
    !window ||
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    behavior & ~0x22 ||
    !(behavior & 0x20) ||
    ![0, 21, 22].includes(format) ||
    read(12) > 1 ||
    read(16) ||
    read(20) ||
    read(24) !== 1 ||
    read(32) !== 1 ||
    // The first backend gate has a depth buffer but no stencil attachment.
    (depth ? read(40) !== 80 : read(40) !== 0) ||
    read(44) ||
    read(48) ||
    ![0, 0x80000000].includes(read(52))
  )
    return D3DERR_INVALIDCALL;
  return { windowId, width, height, depth };
}

function factoryMethods() {
  return {
    4: { argc: 1, invoke: () => 1 },
    16: {
      argc: 7,
      async invoke(runtime, argument, factory) {
        const options = createDevice(runtime, argument);
        if (typeof options === 'number') return options;
        const state = {
          id: 0,
          commands: [],
          frameBytes: 0,
          inScene: false,
          fvf: 0,
          lighting: true,
          cullMode: 'ccw',
          hasDepth: options.depth,
          depthTest: options.depth,
          depthWrite: options.depth,
          world: IDENTITY.slice(),
          view: IDENTITY.slice(),
          projection: IDENTITY.slice(),
          vertexDeclaration: null,
          vertexShader: null,
          pixelShader: null,
          vertexConstants: new Float32Array(256 * 4),
          pixelConstants: new Float32Array(224 * 4),
        };
        const object = runtime.comObjects.create({
          name: 'IDirect3DDevice9',
          iid: 'd0223b96-bf7a-43fd-92bd-a43b0d82b9eb',
          methodNames: DEVICE_METHODS,
          methods: deviceMethods(),
          state,
          onRelease: async () => {
            for (const field of ['vertexDeclaration', 'vertexShader', 'pixelShader']) {
              const bound = state[field];
              if (bound) bound.state.internalRefs--;
              state[field] = null;
            }
            await requireGraphics(runtime).destroyDevice({ id: state.id });
            await releaseComReference(factory);
          },
        });
        state.id = object.pointer;
        try {
          await requireGraphics(runtime).createDevice({ id: state.id, ...options });
        } catch (error) {
          object.refs = 0;
          throw error;
        }
        factory.refs++;
        runtime.write32(argument(6) >>> 0, object.pointer);
        return D3D_OK;
      },
    },
  };
}

export const d3d9Apis = {
  'd3d9.dll!Direct3DCreate9': (runtime, argument) => {
    if (argument(0) >>> 0 !== 32) return { result: 0, argc: 1 };
    requireGraphics(runtime);
    runtime.comObjects ??= new ComObjects(runtime);
    const object = runtime.comObjects.create({
      name: 'IDirect3D9',
      iid: '81bdcbca-64d4-426d-ae8d-ad0147f4275c',
      methodNames: D3D9_METHODS,
      methods: factoryMethods(),
    });
    return { result: object.pointer, argc: 1 };
  },
};
