// D3D8's PE32 COM slot order, checked against the pinned Wine d3d8.h.
// Like DirectWebGPU's D3D8 frontend, this adapts calls to shared D3D9 state
// and rendering. Shader handles and resource descriptors have different ABIs;
// they must be translated explicitly as those paths are implemented.
import { copyRectsMethod } from './d3d9.js';
import { setTarget, validatedTarget } from './d3d9-targets.js';

export const D3D8_METHODS =
  `QueryInterface AddRef Release RegisterSoftwareDevice GetAdapterCount GetAdapterIdentifier GetAdapterModeCount EnumAdapterModes GetAdapterDisplayMode CheckDeviceType CheckDeviceFormat CheckDeviceMultiSampleType CheckDepthStencilMatch GetDeviceCaps GetAdapterMonitor CreateDevice`.split(
    ' ',
  );
export const DEVICE8_METHODS =
  `QueryInterface AddRef Release TestCooperativeLevel GetAvailableTextureMem ResourceManagerDiscardBytes GetDirect3D GetDeviceCaps GetDisplayMode GetCreationParameters SetCursorProperties SetCursorPosition ShowCursor CreateAdditionalSwapChain Reset Present GetBackBuffer GetRasterStatus SetGammaRamp GetGammaRamp CreateTexture CreateVolumeTexture CreateCubeTexture CreateVertexBuffer CreateIndexBuffer CreateRenderTarget CreateDepthStencilSurface CreateImageSurface CopyRects UpdateTexture GetFrontBuffer SetRenderTarget GetRenderTarget GetDepthStencilSurface BeginScene EndScene Clear SetTransform GetTransform MultiplyTransform SetViewport GetViewport SetMaterial GetMaterial SetLight GetLight LightEnable GetLightEnable SetClipPlane GetClipPlane SetRenderState GetRenderState BeginStateBlock EndStateBlock ApplyStateBlock CaptureStateBlock DeleteStateBlock CreateStateBlock SetClipStatus GetClipStatus GetTexture SetTexture GetTextureStageState SetTextureStageState ValidateDevice GetInfo SetPaletteEntries GetPaletteEntries SetCurrentTexturePalette GetCurrentTexturePalette DrawPrimitive DrawIndexedPrimitive DrawPrimitiveUP DrawIndexedPrimitiveUP ProcessVertices CreateVertexShader SetVertexShader GetVertexShader DeleteVertexShader SetVertexShaderConstant GetVertexShaderConstant GetVertexShaderDeclaration GetVertexShaderFunction SetStreamSource GetStreamSource SetIndices GetIndices CreatePixelShader SetPixelShader GetPixelShader DeletePixelShader SetPixelShaderConstant GetPixelShaderConstant GetPixelShaderFunction DrawRectPatch DrawTriPatch DeletePatch`.split(
    ' ',
  );

export function device8Methods(methods9, names9) {
  const methods = {};
  for (const name of [
    'GetDirect3D',
    'GetDisplayMode',
    'GetDeviceCaps',
    'SetMaterial',
    'GetMaterial',
    'SetLight',
    'GetLight',
    'LightEnable',
    'GetLightEnable',
    'CreateTexture',
    'CreateVolumeTexture',
    'CreateCubeTexture',
    'SetTexture',
    'GetTexture',
    'SetTextureStageState',
    'GetTextureStageState',
    'Present',
    'BeginScene',
    'EndScene',
    'Clear',
    'SetTransform',
    'GetTransform',
    'SetViewport',
    'GetViewport',
    'SetRenderState',
    'GetRenderState',
    'DrawPrimitiveUP',
    'DrawIndexedPrimitiveUP',
    'CreateVertexBuffer',
    'CreateIndexBuffer',
    'DrawPrimitive',
    'DrawIndexedPrimitive',
    'SetStreamSource',
    'GetStreamSource',
    'SetIndices',
    'GetIndices',
  ])
    methods[DEVICE8_METHODS.indexOf(name)] = methods9[names9.indexOf(name)];
  // D3D8-only device methods that have no D3D9 vtable slot.
  methods[DEVICE8_METHODS.indexOf('CopyRects')] = copyRectsMethod;
  const adapt = (name, argc, translate) => {
    methods[DEVICE8_METHODS.indexOf(name)] = {
      argc,
      invoke: (r, a, d) => methods9[names9.indexOf(name)].invoke(r, translate(a), d),
    };
  };
  adapt('GetBackBuffer', 4, (a) => (i) => [a(0), 0, a(1), a(2), a(3)][i]);
  adapt('CreateRenderTarget', 7, (a) => (i) => [a(0), a(1), a(2), a(3), a(4), 0, a(5), a(6), 0][i]);
  adapt(
    'CreateDepthStencilSurface',
    6,
    (a) => (i) => [a(0), a(1), a(2), a(3), a(4), 0, 0, a(5), 0][i],
  );
  methods[DEVICE8_METHODS.indexOf('CreateImageSurface')] = {
    argc: 5,
    invoke: (r, a, d) => methods9[36].invoke(r, (i) => [a(0), a(1), a(2), a(3), 2, a(4), 0][i], d),
  };
  methods[DEVICE8_METHODS.indexOf('SetRenderTarget')] = {
    argc: 3,
    async invoke(r, a, d) {
      const color = a(1) >>> 0 || d.state.backBuffer.pointer,
        depth = a(2) >>> 0;
      if (
        validatedTarget(r, d, color) === undefined ||
        validatedTarget(r, d, depth, true) === undefined
      )
        return 0x8876086c;
      const result = await setTarget(r, d, color);
      if (result) return result;
      return setTarget(r, d, depth, true);
    },
  };
  adapt('GetRenderTarget', 2, (a) => (i) => [a(0), 0, a(1)][i]);
  adapt('GetDepthStencilSurface', 2, (a) => a);
  // GetInfo reports driver resource/vertex statistics. This runtime keeps none,
  // so every query fills an all-zero structure of the requested bounded size.
  methods[DEVICE8_METHODS.indexOf('GetInfo')] = {
    argc: 4,
    invoke(r, a) {
      const out = a(2) >>> 0,
        size = a(3) >>> 0;
      if (!out || size < 4 || size > 4096) return 0x8876086c;
      r.check(out, size, true);
      r.data.fill(0, out, out + size);
      return 0;
    },
  };
  // In D3D8, a vertex shader value can be an FVF instead of a shader handle.
  // The shared SetFVF validator rejects unsupported layouts/handles.
  methods[76] = methods9[89];
  methods[77] = {
    argc: 2,
    invoke(runtime, argument, object) {
      runtime.write32(argument(1), object.state.fvf);
      return 0;
    },
  };
  return methods;
}
