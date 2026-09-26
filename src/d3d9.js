import { ComObjects } from './com.js';
import { writeDeviceCaps } from './d3d-caps.js';
import { CULL_MODE, DEPTH_COMPARE } from './d3d-render-state.js';
import { defaultViewport, setViewport, getViewport, clearRegions } from './d3d-viewport.js';
import { displayMethods, displayFormat } from './d3d-display.js';
import { VIRTUAL_DISPLAY_MODES, currentDisplayMode } from './win32-display.js';
import { enterFullscreen, leaveFullscreen } from './d3d-fullscreen.js';
import { D3D8_METHODS, DEVICE8_METHODS, device8Methods } from './d3d8-abi.js';
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
  // SetTransform stores application state even when it contains NaNs. The
  // renderer validates matrices when a draw actually consumes them.
  const bits = new Uint32Array(value.buffer);
  for (let i = 0; i < 16; i++) bits[i] = runtime.read32(pointer + i * 4);
  return value;
}

function deviceMethods(version = 9) {
  const methods = {
    7: { argc: 2, invoke: (r, a) => writeDeviceCaps(r, a(1), version) },
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
      invoke(runtime, argument, object) {
        const count = argument(1) >>> 0;
        const rects = argument(2) >>> 0;
        const flags = argument(3) >>> 0;
        const depth = floatFromBits(argument(5));
        if (
          argument(6) ||
          !flags ||
          flags & ~3 ||
          !Number.isFinite(depth) ||
          depth < 0 ||
          depth > 1
        )
          throw Error('Unsupported IDirect3DDevice9.Clear parameters');
        if (flags & 2 && !object.state.hasDepth) return D3DERR_INVALIDCALL;
        const regions = clearRegions(runtime, rects, count, object.state.viewport);
        if (!regions) return D3DERR_INVALIDCALL;
        queue(
          object.state,
          {
            type: 'clear',
            color: argument(4) >>> 0,
            depth,
            clearColor: !!(flags & 1),
            clearDepth: !!(flags & 2),
            regions,
          },
          regions.length * 16,
        );
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
    45: {
      argc: 3,
      invoke(r, a, object) {
        const field =
          a(1) === 256 ? 'world' : a(1) === 2 ? 'view' : a(1) === 3 ? 'projection' : null;
        if (!field) throw Error(`Unsupported IDirect3DDevice9.GetTransform state ${a(1)}`);
        r.check(a(2), 64, true);
        const bits = new Uint32Array(object.state[field].buffer);
        for (let i = 0; i < 16; i++) r.write32(a(2) + i * 4, bits[i]);
        return 0;
      },
    },
    47: { argc: 2, invoke: (r, a, o) => setViewport(r, a(1), o.state) },
    48: { argc: 2, invoke: (r, a, o) => getViewport(r, a(1), o.state) },
    57: {
      argc: 3,
      invoke(_runtime, argument, object) {
        const state = argument(1) >>> 0;
        const value = argument(2) >>> 0;
        // The current fixed-function path already uses perspective Gouraud
        // interpolation; other shade modes need their own interpolation path.
        if (state === 9 && value === 2) object.state.shadeMode = value;
        else if (state === 8 && value === 3) object.state.fillMode = value;
        else if (state === 136 && value === 1) object.state.clipping = true;
        else if (state === 22 && CULL_MODE[value]) object.state.cullMode = CULL_MODE[value];
        else if (state === 23 && DEPTH_COMPARE[value])
          object.state.depthCompare = DEPTH_COMPARE[value];
        else if (state === 26 && value <= 1) object.state.dither = !!value;
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
    58: {
      argc: 3,
      invoke(r, a, object) {
        const s = object.state;
        const value = {
          7: Number(s.depthTest),
          8: s.fillMode,
          9: s.shadeMode,
          14: Number(s.depthWrite),
          22: CULL_MODE.indexOf(s.cullMode),
          23: DEPTH_COMPARE.indexOf(s.depthCompare),
          26: Number(s.dither),
          137: Number(s.lighting),
          136: Number(s.clipping),
        }[a(1)];
        if (value === undefined) throw Error(`Unsupported IDirect3DDevice9.GetRenderState ${a(1)}`);
        r.write32(a(2), value);
        return 0;
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
          if (primitive !== 4)
            throw Error('Unsupported programmable IDirect3DDevice9.DrawPrimitiveUP state');
          const { payloadBytes, ...command } = programmable;
          queue(state, command, payloadBytes);
          return D3D_OK;
        }
        if (primitive !== 4 || stride !== 16 || state.fvf !== 0x42 || state.lighting)
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
            viewport: { ...state.viewport },
            depthTest: state.depthTest,
            depthWrite: state.depthWrite,
            depthCompare: state.depthCompare,
            dither: state.dither,
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
  return version === 8 ? device8Methods(methods, DEVICE_METHODS) : methods;
}

function createDevice(runtime, argument, version) {
  const adapter = argument(1) >>> 0;
  const deviceType = argument(2) >>> 0;
  const focus = argument(3) >>> 0;
  const behavior = argument(4) >>> 0;
  const params = argument(5) >>> 0;
  const output = argument(6) >>> 0;
  runtime.check(output, 4, true);
  runtime.write32(output, 0);
  runtime.check(params, version === 8 ? 52 : 56);
  // D3D8 omits MultiSampleQuality; subsequent fields move back one DWORD.
  const read = (offset) =>
    version === 8 && offset === 20
      ? 0
      : runtime.read32(params + offset - (version === 8 && offset >= 24 ? 4 : 0));
  const windowId = read(28) || focus;
  const window = runtime.windows?.windows?.get(windowId);
  const width = read(0) || window?.width;
  const height = read(4) || window?.height;
  const format = read(8);
  const depth = !!read(36);
  const windowed = !!read(32);
  const fullscreenMode = VIRTUAL_DISPLAY_MODES.find(
    (mode) => mode.width === width && mode.height === height && displayFormat(mode) === format,
  );
  const processing = behavior & 0xe0;
  if (
    adapter !== 0 ||
    deviceType !== 1 ||
    !window ||
    !width ||
    !height ||
    width > 2048 ||
    height > 2048 ||
    behavior & ~0x62 ||
    ![0x20, 0x40].includes(processing) ||
    ![0, 21, 22, 23].includes(format) ||
    read(12) > 1 ||
    read(16) ||
    read(20) ||
    ![1, 2, 3].includes(read(24)) ||
    read(32) > 1 ||
    (!windowed &&
      (!read(0) || !read(4) || !fullscreenMode || runtime.d3dFullscreen || window?.parentId)) ||
    // The first backend gate has a depth buffer but no stencil attachment.
    (depth ? read(40) !== 80 : read(40) !== 0) ||
    read(44) ||
    (windowed ? read(48) !== 0 : ![0, 60].includes(read(48))) ||
    ![0, 1, 0x80000000].includes(read(52))
  )
    return D3DERR_INVALIDCALL;
  return {
    windowId,
    width,
    height,
    depth,
    windowed,
    colorFormat: format || displayFormat(currentDisplayMode(runtime)),
    swapEffect: read(24),
    interval: read(52),
  };
}

function factoryMethods(version = 9) {
  return {
    ...displayMethods(version),
    [version === 8 ? 13 : 14]: {
      argc: 4,
      invoke: (r, a) => writeDeviceCaps(r, a(3), version, a(1), a(2)),
    },
    4: { argc: 1, invoke: () => 1 },
    [version === 8 ? 15 : 16]: {
      argc: 7,
      async invoke(runtime, argument, factory) {
        const options = createDevice(runtime, argument, version);
        if (typeof options === 'number') return options;
        const state = {
          id: 0,
          commands: [],
          frameBytes: 0,
          inScene: false,
          fvf: 0,
          lighting: true,
          shadeMode: 2,
          fillMode: 3,
          clipping: true,
          cullMode: 'ccw',
          hasDepth: options.depth,
          depthTest: options.depth,
          depthWrite: options.depth,
          depthCompare: 'less-equal',
          dither: false,
          world: IDENTITY.slice(),
          view: IDENTITY.slice(),
          projection: IDENTITY.slice(),
          width: options.width,
          height: options.height,
          viewport: defaultViewport(options.width, options.height),
          vertexDeclaration: null,
          vertexShader: null,
          pixelShader: null,
          vertexConstants: new Float32Array(256 * 4),
          pixelConstants: new Float32Array(224 * 4),
        };
        const object = runtime.comObjects.create({
          name: `IDirect3DDevice${version}`,
          iid:
            version === 8
              ? '7385e5df-8fe8-41d5-86b6-d7b48547b6cf'
              : 'd0223b96-bf7a-43fd-92bd-a43b0d82b9eb',
          methodNames: version === 8 ? DEVICE8_METHODS : DEVICE_METHODS,
          methods: deviceMethods(version),
          state,
          onRelease: async () => {
            for (const field of ['vertexDeclaration', 'vertexShader', 'pixelShader']) {
              const bound = state[field];
              if (bound) bound.state.internalRefs--;
              state[field] = null;
            }
            try {
              await leaveFullscreen(runtime, state);
            } finally {
              try {
                await requireGraphics(runtime).destroyDevice({ id: state.id });
              } finally {
                await releaseComReference(factory);
              }
            }
          },
        });
        state.id = object.pointer;
        try {
          await requireGraphics(runtime).createDevice({ id: state.id, ...options });
          if (!options.windowed) await enterFullscreen(runtime, state, options);
        } catch (error) {
          await requireGraphics(runtime).destroyDevice({ id: state.id });
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

function createFactory(runtime, argument, version) {
  // SDK 31 (older D3D9 applications) uses the same IDirect3D9/device ABI.
  if (!(version === 8 ? [120, 220] : [31, 32]).includes(argument(0) >>> 0))
    return { result: 0, argc: 1 };
  requireGraphics(runtime);
  runtime.comObjects ??= new ComObjects(runtime);
  const object = runtime.comObjects.create({
    name: `IDirect3D${version}`,
    iid:
      version === 8
        ? '1dd9e8da-1c77-4d40-b0cf-98fefdff9512'
        : '81bdcbca-64d4-426d-ae8d-ad0147f4275c',
    methodNames: version === 8 ? D3D8_METHODS : D3D9_METHODS,
    methods: factoryMethods(version),
  });
  return { result: object.pointer, argc: 1 };
}

export const d3d9Apis = {
  'd3d9.dll!Direct3DCreate9': (runtime, argument) => createFactory(runtime, argument, 9),
  'd3d8.dll!Direct3DCreate8': (runtime, argument) => createFactory(runtime, argument, 8),
};
