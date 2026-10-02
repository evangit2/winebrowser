import { supportsGuestFormat, colorTargetFormats } from './d3d-pixel-format.js';
import {
  flushTargets,
  depthDescription,
  setTarget,
  initializeTargetBindings,
  releaseTargetBindings,
  returnTargetSurface,
  getRenderTargetData,
  readTargetPixels,
} from './d3d9-targets.js';
import { INACTIVE_EFFECT_DEFAULTS, setInactiveEffect } from './d3d-inactive-effects.js';
import {
  defaultStencil,
  defaultAlphaTest,
  setStencilState,
  setAlphaTestState,
} from './d3d-stencil.js';
import { blendDefaults, setBlendState } from './d3d-blending.js';
import { FOG_STATES, validFogValue, fogSnapshot } from './d3d-fog.js';
import { fvfLayout } from './d3d-fvf.js';
import { fixedDeclarationVertices } from './d3d9-fixed-declaration.js';
import {
  MAX_DRAW_VERTICES as MAX_VERTICES,
  MAX_FRAME_BYTES,
  MAX_FRAME_COMMANDS as MAX_COMMANDS,
} from './d3d-limits.js';
import {
  initLighting,
  setLightingState,
  lightingMethods,
  lightingSnapshot,
} from './d3d-lighting.js';
import {
  initTextures,
  copyRects,
  createTextureMethod,
  bindTexture,
  getTexture,
  unbindTextures,
  fixedTextureDraw,
  textureBytesPerPixel,
  createDeviceSurface,
  releaseDeviceSurface,
  deviceSurface,
} from './d3d9-textures.js';
import { createVolumeTextureMethod } from './d3d9-volumes.js';
import { textureStateMethod } from './d3d-texture-state.js';
import { ComObjects } from './com.js';
import { writeDeviceCaps } from './d3d-caps.js';
import { CULL_MODE, DEPTH_COMPARE } from './d3d-render-state.js';
import { defaultViewport, setViewport, getViewport, clearRegions } from './d3d-viewport.js';
import { displayMethods, displayFormat, deviceDisplayModeMethod } from './d3d-display.js';
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
  programmableDrawFromVertices,
  releaseComReference,
  setFloatConstants,
} from './d3d9-programmable.js';
import {
  bufferedVertices,
  createIndexBufferMethod,
  createVertexBufferMethod,
  getIndices,
  getStreamSource,
  indexedVertices,
  releaseBufferBindings,
  setIndices,
  setStreamSource,
} from './d3d9-buffers.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const number = (value) => value >>> 0;
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

// Row-major, row-vector screen->clip matrix for pre-transformed (XYZRHW)
// vertices: x,y pixels map to NDC within the viewport, y flipped as D3D does.
function screenToClip(viewport) {
  const { x, y, width, height, minZ, maxZ } = viewport;
  return Float32Array.from([
    2 / width,
    0,
    0,
    0,
    0,
    -2 / height,
    0,
    0,
    0,
    0,
    maxZ - minZ,
    0,
    -1 - (2 * x) / width,
    1 + (2 * y) / height,
    minZ,
    1,
  ]);
}

// D3D primitive types. The renderer consumes triangle lists, so strips and
// fans are expanded with their correct relative winding before submission.
const D3DPT = {
  POINTLIST: 1,
  LINELIST: 2,
  LINESTRIP: 3,
  TRIANGLELIST: 4,
  TRIANGLESTRIP: 5,
  TRIANGLEFAN: 6,
};

// Vertices needed for a primitive count, or null when the type is unsupported.
function primitiveVertexCount(primitive, primitiveCount) {
  if (primitive === D3DPT.TRIANGLELIST) return primitiveCount * 3;
  if (primitive === D3DPT.TRIANGLESTRIP || primitive === D3DPT.TRIANGLEFAN)
    return primitiveCount + 2;
  return null;
}

// Expand a triangle strip or fan into an explicit triangle list. Strip winding
// alternates, so odd triangles swap their first two vertices to preserve the
// facing the D3D rasterizer would compute.
function expandTriangles(primitive, primitiveCount, stride, vertices) {
  if (primitiveCount * 3 > MAX_VERTICES || primitiveCount * 3 * stride > MAX_FRAME_BYTES)
    throw Error('D3D9 expanded draw limit exceeded');
  if (primitive === D3DPT.TRIANGLELIST) return { vertices, vertexCount: primitiveCount * 3 };
  const sourceCount = primitiveCount + 2;
  if (vertices.length < sourceCount * stride) throw Error('D3D9 draw exceeds the vertex buffer');
  const out = new Uint8Array(primitiveCount * 3 * stride);
  const emit = (slot, index) => {
    out.set(vertices.subarray(index * stride, index * stride + stride), slot * stride);
  };
  for (let t = 0; t < primitiveCount; t++) {
    const [a, b, c] =
      primitive === D3DPT.TRIANGLEFAN
        ? [0, t + 1, t + 2]
        : t % 2 === 0
          ? [t, t + 1, t + 2]
          : [t + 1, t, t + 2];
    emit(t * 3, a);
    emit(t * 3 + 1, b);
    emit(t * 3 + 2, c);
  }
  return { vertices: out, vertexCount: primitiveCount * 3 };
}

// Shared by DrawPrimitiveUP, buffered and indexed draws. Vertices are always an
// immutable contiguous snapshot by the time a command reaches the renderer.
function fixedFunctionDraw(runtime, state, vertices, stride, vertexCount) {
  const frameState = state;
  ({ state, vertices, stride } = fixedDeclarationVertices(state, vertices, stride, vertexCount));
  const layout = fvfLayout(state.fvf);
  if (!layout || stride < layout.size || stride > 256 || stride % 4)
    throw Error('Unsupported D3D9 draw format or render state');
  const texturing = fixedTextureDraw(runtime, state);
  const textures = new Set(
    (texturing?.stages ?? (texturing ? [texturing] : []))
      .map((stage) => stage.texture)
      .filter((texture) => texture && !state.textureSnapshots.has(texture)),
  );
  const textureBytes = [...textures].reduce(
    (bytes, texture) => bytes + texture.levels.reduce((n, level) => n + level.rgba.length, 0),
    0,
  );
  const size = vertexCount * stride;
  if (state.frameBytes + size > MAX_FRAME_BYTES) throw Error('D3D9 frame vertex limit exceeded');
  if (state.frameTextureBytes + textureBytes > 32 * 1024 * 1024)
    throw Error('D3D9 frame texture limit exceeded');
  const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  const floatOffsets = [0, 4, 8];
  // XYZRHW stores (x, y, z, rhw) in the first 16 bytes.
  if (layout.rhw) floatOffsets.push(12);
  if (layout.normal !== null)
    floatOffsets.push(layout.normal, layout.normal + 4, layout.normal + 8);
  const sampledCoordinates = new Map();
  for (const stage of texturing?.stages ?? (texturing ? [texturing] : [])) {
    if (!stage.texture) continue;
    const index = stage.stage[11];
    const components = (stage.texture.dimension ?? '2d') === '2d' ? 2 : 3;
    sampledCoordinates.set(index, Math.max(sampledCoordinates.get(index) ?? 0, components));
  }
  const unusedFloats = new Set();
  for (const [index, coordinate] of layout.texcoords.entries())
    for (let i = 0; i < coordinate.components; i++) {
      const offset = coordinate.offset + i * 4;
      floatOffsets.push(offset);
      if (i >= (sampledCoordinates.get(index) ?? 0)) unusedFloats.add(offset);
    }
  // D3D disables depth writes whenever depth testing is off, so the depth
  // component is unused then and pre-transformed overlays may leave it
  // undefined (commonly NaN). Unselected texture coordinates are likewise
  // unused, including all coordinates on an untextured draw. Normalize only
  // these non-finite slots in the immutable draw snapshot; consumed fields
  // still fail validation and guest memory remains unchanged.
  const unusedDepth = layout.rhw && !state.depthTest;
  if (unusedDepth) unusedFloats.add(8);
  for (let i = 0; i < vertexCount; i++)
    for (const offset of floatOffsets)
      if (!Number.isFinite(view.getFloat32(i * stride + offset, true))) {
        if (unusedFloats.has(offset)) view.setFloat32(i * stride + offset, 0, true);
        else throw Error('Unsupported D3D9 non-finite vertex');
      }
  // Pre-transformed (XYZRHW) vertices bypass world/view/projection and lighting;
  // an equivalent screen->clip matrix keeps the shared shader unchanged.
  const transforms = layout.rhw
    ? {
        world: IDENTITY.slice(),
        view: IDENTITY.slice(),
        projection: screenToClip(state.viewport),
      }
    : {
        world: state.world.slice(),
        view: state.view.slice(),
        projection: state.projection.slice(),
      };
  queue(
    frameState,
    {
      type: 'draw',
      fvf: state.fvf,
      lighting: layout.rhw ? null : lightingSnapshot(state),
      specularEnable: !layout.rhw && !!state.lightState[29],
      texturing,
      vertices,
      vertexCount,
      stride,
      ...transforms,
      viewport: { ...state.viewport },
      depthTest: state.depthTest,
      depthWrite: state.depthTest && state.depthWrite,
      depthCompare: state.depthCompare,
      dither: state.dither,
      blend: { ...state.blendState },
      stencil: { ...state.stencil },
      alphaTest: { ...state.alphaTest },
      fog: fogSnapshot(state),
      cullMode: state.cullMode,
    },
    size,
  );
  for (const texture of textures) frameState.textureSnapshots.add(texture);
  frameState.frameTextureBytes += textureBytes;
  return D3D_OK;
}

// Draws queued from a buffer gather vertices host-side; programmable draws use
// the same snapshot. Returns null when no programmable pipeline is bound.
function bufferedDraw(runtime, state, source, primitive, primitiveCount) {
  const { stride } = source;
  // Fixed-function strips/fans become an explicit triangle list. Programmable
  // draws stay list-only, matching that path's existing scope.
  const expanded = expandTriangles(primitive, primitiveCount, stride, source.vertices);
  const programmable = programmableDrawFromVertices(
    state,
    expanded.vertices,
    stride,
    expanded.vertexCount,
    runtime,
  );
  if (programmable) {
    const { payloadBytes, ...command } = programmable;
    queue(state, command, payloadBytes);
    return D3D_OK;
  }
  return fixedFunctionDraw(runtime, state, expanded.vertices, stride, expanded.vertexCount);
}

// Hand a device-owned surface back to the guest with a fresh reference count.
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
    ...lightingMethods,
    6: {
      argc: 2,
      invoke(runtime, argument, object) {
        const output = argument(1) >>> 0;
        if (!output) return D3DERR_INVALIDCALL;
        runtime.check(output, 4, true);
        const factory = object.state.factory;
        if (!factory.refs) throw Error('Released D3D factory');
        if (factory.refs >= 0x7fffffff) throw Error('D3D factory reference count limit exceeded');
        factory.refs++;
        runtime.write32(output, factory.pointer);
        return D3D_OK;
      },
    },
    23: createTextureMethod(version),
    24: createVolumeTextureMethod(version),
    25: createTextureMethod(version, true),
    64: { argc: 3, invoke: (r, a, d) => getTexture(r, d, a(1) >>> 0, a(2) >>> 0) },
    65: { argc: 3, invoke: (r, a, d) => bindTexture(r, d, a(1) >>> 0, a(2) >>> 0) },
    66: textureStateMethod({ version, get: true }),
    67: textureStateMethod({ version }),
    68: textureStateMethod({ version, sampler: true, get: true }),
    69: textureStateMethod({ version, sampler: true }),
    7: { argc: 2, invoke: (r, a) => writeDeviceCaps(r, a(1), version) },
    8: deviceDisplayModeMethod(version),
    17: {
      argc: 5,
      async invoke(runtime, argument, object) {
        if ([1, 2, 3, 4].some((index) => argument(index)))
          throw Error('Unsupported IDirect3DDevice9.Present rectangles or window override');
        const state = object.state;
        if (state.inScene) return D3DERR_INVALIDCALL;
        if (state.renderTarget !== state.backBuffer) await flushTargets(runtime, object);
        await requireGraphics(runtime).present({
          id: state.id,
          commands: [...state.commands],
          depth: state.renderTarget === state.backBuffer ? depthDescription(runtime, object) : null,
        });
        state.commands = [];
        state.frameBytes = 0;
        state.textureSnapshots.clear();
        state.frameTextureBytes = 0;
        return D3D_OK;
      },
    },
    // GetBackBuffer(iSwapChain, iBackBuffer, Type, ppBackBuffer). Only the
    // implicit swap chain and its single mono back buffer exist.
    18: {
      argc: 5,
      invoke(r, a, device) {
        const out = number(a(4));
        if (!out) return D3DERR_INVALIDCALL;
        const state = device.state;
        if (number(a(1)) !== 0 || number(a(2)) !== 0 || number(a(3)) !== 0)
          return D3DERR_INVALIDCALL;
        return returnTargetSurface(r, state.backBuffer, out);
      },
    },
    // CreateRenderTarget(Width, Height, Format, MultiSample, MultisampleQuality,
    //                     Lockable, ppSurface, pSharedHandle)
    28: {
      argc: 9,
      invoke(r, a, device) {
        const out = number(a(7));
        if (!out) return D3DERR_INVALIDCALL;
        r.check(out, 4, true);
        r.write32(out, 0);
        const width = number(a(1)),
          height = number(a(2)),
          format = number(a(3));
        const bpp = textureBytesPerPixel(format);
        if (
          !width ||
          !height ||
          width > 2048 ||
          height > 2048 ||
          !colorTargetFormats.includes(format) ||
          !supportsGuestFormat(r, format) ||
          number(a(4)) ||
          number(a(5)) ||
          number(a(6)) ||
          number(a(8))
        )
          return D3DERR_INVALIDCALL;
        const surface = createDeviceSurface(r, device, {
          width,
          height,
          format,
          pool: 0,
          usage: 1,
          bpp,
        });
        if (!surface) return D3DERR_INVALIDCALL;
        r.write32(out, surface.pointer);
        return D3D_OK;
      },
    },
    // CreateDepthStencilSurface(Width, Height, Format, MultiSample,
    //                           MultisampleQuality, Discard, ppSurface, pShared)
    29: {
      argc: 9,
      invoke(r, a, device) {
        const out = number(a(7));
        if (!out) return D3DERR_INVALIDCALL;
        r.check(out, 4, true);
        r.write32(out, 0);
        const width = number(a(1)),
          height = number(a(2)),
          format = number(a(3));
        if (
          !width ||
          !height ||
          width > 2048 ||
          height > 2048 ||
          ![75, 77, 80].includes(format) ||
          number(a(4)) ||
          number(a(5)) ||
          number(a(6)) > 1 ||
          number(a(8))
        )
          return D3DERR_INVALIDCALL;
        const surface = createDeviceSurface(r, device, {
          width,
          height,
          format,
          pool: 0,
          usage: 2,
          bpp: format === 80 ? 2 : 4,
        });
        if (!surface) return D3DERR_INVALIDCALL;
        r.write32(out, surface.pointer);
        return D3D_OK;
      },
    },
    // CreateOffscreenPlainSurface(Width, Height, Format, Pool, ppSurface,
    //                             pSharedHandle)
    36: {
      argc: 7,
      invoke(r, a, device) {
        const out = number(a(5));
        if (!out) return D3DERR_INVALIDCALL;
        r.check(out, 4, true);
        r.write32(out, 0);
        const width = number(a(1)),
          height = number(a(2)),
          format = number(a(3)),
          pool = number(a(4));
        const bpp = textureBytesPerPixel(format);
        if (
          !width ||
          !height ||
          width > 2048 ||
          height > 2048 ||
          !bpp ||
          !supportsGuestFormat(r, format) ||
          ![0, 1, 2].includes(pool) ||
          number(a(6))
        )
          return D3DERR_INVALIDCALL;
        const surface = createDeviceSurface(r, device, { width, height, format, pool, bpp });
        if (!surface) return D3DERR_INVALIDCALL;
        r.write32(out, surface.pointer);
        return D3D_OK;
      },
    },
    // SetRenderTarget(RenderTargetIndex, pRenderTarget): slot zero is mandatory.
    37: {
      argc: 3,
      invoke: (r, a, device) =>
        number(a(1)) === 0 ? setTarget(r, device, number(a(2))) : D3DERR_INVALIDCALL,
    },
    // GetRenderTarget(RenderTargetIndex, ppRenderTarget)
    38: {
      argc: 3,
      invoke(r, a, device) {
        const out = number(a(2));
        if (!out) return D3DERR_INVALIDCALL;
        if (number(a(1)) !== 0) return D3DERR_INVALIDCALL;
        return returnTargetSurface(r, device.state.renderTarget, out);
      },
    },
    // NULL detaches depth/stencil; it does not restore the automatic surface.
    39: { argc: 2, invoke: (r, a, device) => setTarget(r, device, number(a(1)), true) },
    32: {
      argc: 3,
      invoke: (r, a, device) => getRenderTargetData(r, device, number(a(1)), number(a(2))),
    },
    // GetDepthStencilSurface(ppZStencilSurface)
    40: {
      argc: 2,
      invoke(r, a, device) {
        const out = number(a(1));
        if (!out) return D3DERR_INVALIDCALL;
        return returnTargetSurface(r, device.state.depthStencil, out);
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
        const stencil = argument(6) >>> 0;
        // D3D ignores pRects for a stencil clear, so requiring a zero rectangle
        // keeps the code honest rather than silently partial-clearing.
        if (
          !flags ||
          flags & ~7 ||
          !Number.isFinite(depth) ||
          depth < 0 ||
          depth > 1 ||
          stencil > 0xff ||
          (flags & 4 && count)
        )
          throw Error('Unsupported IDirect3DDevice9.Clear parameters');
        if (flags & 2 && !object.state.hasDepth) return D3DERR_INVALIDCALL;
        if (flags & 4 && !object.state.hasStencil) return D3DERR_INVALIDCALL;
        const regions = clearRegions(runtime, rects, count, object.state.viewport);
        if (!regions) return D3DERR_INVALIDCALL;
        queue(
          object.state,
          {
            type: 'clear',
            color: argument(4) >>> 0,
            depth,
            stencil,
            clearColor: !!(flags & 1),
            clearDepth: !!(flags & 2),
            clearStencil: !!(flags & 4),
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
    47: {
      argc: 2,
      invoke: (r, a, o) =>
        setViewport(r, a(1), {
          ...o.state,
          width: o.state.renderTarget.state.level.width,
          height: o.state.renderTarget.state.level.height,
          set viewport(value) {
            o.state.viewport = value;
          },
        }),
    },
    48: { argc: 2, invoke: (r, a, o) => getViewport(r, a(1), o.state) },
    57: {
      argc: 3,
      invoke(_runtime, argument, object) {
        const state = argument(1) >>> 0;
        const value = argument(2) >>> 0;
        // The current fixed-function path already uses perspective Gouraud
        // interpolation; other shade modes need their own interpolation path.
        if (state in object.state.stencil) return setStencilState(object.state, state, value);
        if (state in object.state.alphaTest) return setAlphaTestState(object.state, state, value);
        if (state in object.state.fog) {
          if (!validFogValue(state, value)) return D3DERR_INVALIDCALL;
          object.state.fog[state] = value;
          return D3D_OK;
        }
        if (state in object.state.inactiveEffects)
          return setInactiveEffect(object.state, state, value, version);
        if (state in object.state.blendState)
          return setBlendState(object.state, state, value, version);
        if (state in object.state.lightState) return setLightingState(object.state, state, value);
        if (state === 9 && value === 2) object.state.shadeMode = value;
        else if (state === 8 && value === 3) object.state.fillMode = value;
        else if (state === 136 && value === 1) object.state.clipping = true;
        else if (state === 22 && CULL_MODE[value]) object.state.cullMode = CULL_MODE[value];
        else if (state === 23 && DEPTH_COMPARE[value])
          object.state.depthCompare = DEPTH_COMPARE[value];
        else if (state === 26 && value <= 1) object.state.dither = !!value;
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
          ...s.stencil,
          ...s.alphaTest,
          ...s.fog,
          ...s.inactiveEffects,
          ...s.lightState,
          ...s.blendState,
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
        if (state.depthTest && !state.hasDepth) return D3DERR_INVALIDCALL;
        const vertexCount = primitiveVertexCount(primitive, primitiveCount);
        if (!vertexCount || vertexCount > MAX_VERTICES)
          throw Error('Unsupported D3D9 primitive type or vertex count limit');
        const size = vertexCount * stride;
        if (stride < 4 || stride > 256 || stride % 4 || size > MAX_FRAME_BYTES)
          throw Error('D3D9 draw byte limit or stride exceeded');
        runtime.check(pointer, size);
        const expanded = expandTriangles(
          primitive,
          primitiveCount,
          stride,
          runtime.data.slice(pointer, pointer + size),
        );
        const programmable = programmableDrawFromVertices(
          state,
          expanded.vertices,
          stride,
          expanded.vertexCount,
          runtime,
        );
        if (programmable) {
          const { payloadBytes, ...command } = programmable;
          queue(state, command, payloadBytes);
          return D3D_OK;
        }
        return fixedFunctionDraw(runtime, state, expanded.vertices, stride, expanded.vertexCount);
      },
    },
    84: {
      // DrawIndexedPrimitiveUP(type, minIndex, numVertices, primitiveCount,
      //                        indices, indexFormat, vertices, stride).
      argc: 9,
      invoke(runtime, argument, object) {
        const state = object.state;
        if (!state.inScene || (state.depthTest && !state.hasDepth)) return D3DERR_INVALIDCALL;
        const primitive = number(argument(1)),
          minIndex = number(argument(2)),
          numVertices = number(argument(3)),
          primitiveCount = number(argument(4)),
          indices = number(argument(5)),
          format = number(argument(6)),
          pointer = number(argument(7)),
          stride = number(argument(8));
        const count = primitiveVertexCount(primitive, primitiveCount);
        const width = format === 101 ? 2 : format === 102 ? 4 : 0;
        if (
          !width ||
          !count ||
          !numVertices ||
          count > MAX_VERTICES ||
          numVertices > MAX_VERTICES ||
          minIndex + numVertices > MAX_VERTICES ||
          stride < 4 ||
          stride > 256 ||
          stride % 4
        )
          return D3DERR_INVALIDCALL;
        runtime.check(indices, count * width);
        runtime.check(pointer + minIndex * stride, numVertices * stride);
        if (count * stride > MAX_FRAME_BYTES) return D3DERR_INVALIDCALL;
        const gathered = new Uint8Array(count * stride);
        for (let i = 0; i < count; i++) {
          const index =
            width === 2
              ? runtime.view.getUint16(indices + i * 2, true)
              : runtime.read32(indices + i * 4);
          if (index < minIndex || index >= minIndex + numVertices) return D3DERR_INVALIDCALL;
          const begin = pointer + index * stride;
          gathered.set(runtime.data.subarray(begin, begin + stride), i * stride);
        }
        const result = bufferedDraw(
          runtime,
          state,
          { vertices: gathered, stride, vertexCount: count },
          primitive,
          primitiveCount,
        );
        releaseBufferBindings(state);
        return result;
      },
    },
    26: createVertexBufferMethod(version),
    27: createIndexBufferMethod(version),
    81: {
      // DrawPrimitive(PrimitiveType, StartVertex, PrimitiveCount)
      argc: 4,
      invoke(runtime, argument, object) {
        const state = object.state;
        const primitive = argument(1) >>> 0;
        const startVertex = argument(2) >>> 0;
        const primitiveCount = argument(3) >>> 0;
        if (!state.inScene) return D3DERR_INVALIDCALL;
        if (state.depthTest && !state.hasDepth) return D3DERR_INVALIDCALL;
        return bufferedDraw(
          runtime,
          state,
          bufferedVertices(runtime, object, startVertex, primitive, primitiveCount),
          primitive,
          primitiveCount,
        );
      },
    },
    82: {
      // D3D9: (PrimitiveType, BaseVertexIndex, MinVertexIndex, NumVertices,
      //        StartIndex, PrimitiveCount). D3D8 omits BaseVertexIndex, which
      // SetIndices stores per buffer instead.
      argc: version === 8 ? 6 : 7,
      invoke(runtime, argument, object) {
        const state = object.state;
        const params =
          version === 8
            ? {
                primitive: argument(1) >>> 0,
                baseVertex: 0,
                minVertexIndex: argument(2) >>> 0,
                numVertices: argument(3) >>> 0,
                startIndex: argument(4) >>> 0,
                primitiveCount: argument(5) >>> 0,
              }
            : {
                primitive: argument(1) >>> 0,
                baseVertex: argument(2) | 0,
                minVertexIndex: argument(3) >>> 0,
                numVertices: argument(4) >>> 0,
                startIndex: argument(5) >>> 0,
                primitiveCount: argument(6) >>> 0,
              };
        if (!state.inScene) return D3DERR_INVALIDCALL;
        if (state.depthTest && !state.hasDepth) return D3DERR_INVALIDCALL;
        return bufferedDraw(
          runtime,
          state,
          indexedVertices(runtime, object, params.primitive, params.primitiveCount, params),
          params.primitive,
          params.primitiveCount,
        );
      },
    },
    100: { argc: version === 8 ? 4 : 5, invoke: (r, a, d) => setStreamSource(r, d, version, a) },
    101: { argc: version === 8 ? 4 : 5, invoke: (r, a, d) => getStreamSource(r, d, version, a) },
    104: { argc: version === 8 ? 3 : 2, invoke: (r, a, d) => setIndices(r, d, version, a) },
    105: { argc: version === 8 ? 3 : 2, invoke: (r, a, d) => getIndices(r, d, version, a) },
    89: {
      argc: 2,
      invoke(_runtime, argument, object) {
        const fvf = argument(1) >>> 0;
        if (!fvfLayout(fvf))
          throw Error(`Unsupported IDirect3DDevice9.SetFVF 0x${fvf.toString(16)}`);
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
  const autoDepthFormat = read(40);
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
    // The shared renderer supplies the attachments the guest asked for: D16
    // maps to depth16unorm, D24X8 to depth24plus and D24S8 to a combined
    // depth24plus-stencil8 attachment that carries the guest stencil buffer.
    (depth ? ![75, 77, 80].includes(autoDepthFormat) : autoDepthFormat !== 0) ||
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
    depthFormat: depth
      ? { 75: 'depth24plus-stencil8', 77: 'depth24plus', 80: 'depth16unorm' }[autoDepthFormat]
      : null,
    autoDepthFormat,
    stencil: depth && autoDepthFormat === 75,
    windowed,
    colorFormat: format || displayFormat(currentDisplayMode(runtime)),
    swapEffect: read(24),
    interval: read(52),
  };
}

function factoryMethods(version = 9) {
  return {
    ...displayMethods(version),
    10: {
      argc: 7,
      async invoke(r, a) {
        if (a(1) !== 0) return D3DERR_INVALIDCALL;
        if (a(2) !== 1 || ![22, 23].includes(a(3))) return 0x8876086a;
        if (a(6) === 36) await r.graphics?.initialize?.();
        const usage = a(4),
          type = a(5),
          format = a(6);
        return [1, 3, 4, 5].includes(type) &&
          ([0, 0x200].includes(usage) ||
            (usage === 1 && type !== 4 && colorTargetFormats.includes(format))) &&
          textureBytesPerPixel(a(6)) &&
          supportsGuestFormat(r, format) &&
          (a(5) !== 4 || a(6) < 0x100)
          ? 0
          : 0x8876086a;
      },
    },
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
        if (factory.refs >= 0x7fffffff) throw Error('D3D factory reference count limit exceeded');
        const state = {
          factory,
          version,
          id: 0,
          commands: [],
          frameBytes: 0,
          inScene: false,
          fvf: 0,
          ...initTextures(),
          ...initLighting(),
          blendState: blendDefaults(version),
          inactiveEffects: { ...INACTIVE_EFFECT_DEFAULTS },
          stencil: defaultStencil(),
          alphaTest: defaultAlphaTest(),
          fog: { ...FOG_STATES },
          shadeMode: 2,
          fillMode: 3,
          clipping: true,
          cullMode: 'ccw',
          hasDepth: options.depth,
          hasStencil: options.stencil,
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
          streamSource: null,
          indexBuffer: null,
          indexBaseVertex: 0,
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
            unbindTextures(runtime, object);
            if (state.targetBindingsInitialized) releaseTargetBindings(runtime, object);
            for (const field of ['backBuffer', 'depthSurface']) {
              const surface = state[field];
              if (surface && surface.refs) {
                surface.refs = 0;
                releaseDeviceSurface(runtime, surface);
                runtime.comObjects.liveObjects--;
              }
              state[field] = null;
            }
            releaseBufferBindings(state);
            state.commands = [];
            state.textureSnapshots.clear();
            state.frameBytes = state.frameTextureBytes = 0;
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
        factory.refs++;
        try {
          await requireGraphics(runtime).createDevice({ id: state.id, ...options });
          if (!options.windowed) await enterFullscreen(runtime, state, options);
          // The implicit swap chain exposes one mono back buffer and, when the
          // device was created with one, an automatic depth-stencil surface.
          const colorBpp = textureBytesPerPixel(options.colorFormat);
          state.backBuffer = createDeviceSurface(runtime, object, {
            width: options.width,
            height: options.height,
            format: options.colorFormat,
            pool: 0,
            usage: 1,
            bpp: colorBpp,
            implicit: true,
          });
          if (!state.backBuffer) throw Error('D3D backbuffer allocation failed');
          state.renderTarget = state.backBuffer;
          if (options.depth) {
            state.depthSurface = createDeviceSurface(runtime, object, {
              width: options.width,
              height: options.height,
              format: options.autoDepthFormat,
              pool: 0,
              usage: 2,
              bpp: options.autoDepthFormat === 80 ? 2 : 4,
              implicit: true,
            });
            if (!state.depthSurface) throw Error('D3D depth-stencil allocation failed');
            state.depthStencil = state.depthSurface;
          }
          initializeTargetBindings(object);
          state.targetBindingsInitialized = true;
        } catch (error) {
          for (const field of ['backBuffer', 'depthSurface']) {
            const surface = state[field];
            if (surface && surface.refs) {
              surface.refs = 0;
              releaseDeviceSurface(runtime, surface);
              runtime.comObjects.liveObjects--;
            }
            state[field] = null;
          }
          object.refs = 0;
          try {
            await requireGraphics(runtime).destroyDevice({ id: state.id });
          } finally {
            await releaseComReference(factory);
          }
          throw error;
        }
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

// D3D8-only device methods that have no D3D9 equivalent.
export const copyRectsMethod = {
  // CopyRects(src, srcRects, rectCount, dst, dstPoints)
  argc: 6,
  async invoke(r, a, d) {
    const source = deviceSurface(r, a(1) >>> 0, d);
    const usage = source?.state.texture?.state.usage ?? source?.state.usage ?? 0;
    if (usage & 1) await readTargetPixels(r, d, source);
    return copyRects(r, d, a(1) >>> 0, a(2) >>> 0, a(3) >>> 0, a(4) >>> 0, a(5) >>> 0);
  },
};

export const d3d9Apis = {
  'd3d9.dll!Direct3DCreate9': (runtime, argument) => createFactory(runtime, argument, 9),
  'd3d8.dll!Direct3DCreate8': (runtime, argument) => createFactory(runtime, argument, 8),
};
