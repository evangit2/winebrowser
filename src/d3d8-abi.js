// D3D8's PE32 COM slot order, checked against the pinned Wine d3d8.h.
// Like DirectWebGPU's D3D8 frontend, this adapts calls to shared D3D9 state
// and rendering. Shader handles and resource descriptors have different ABIs;
// they must be translated explicitly as those paths are implemented.
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
    'GetDeviceCaps',
    'Present',
    'BeginScene',
    'EndScene',
    'Clear',
    'SetTransform',
    'GetTransform',
    'SetRenderState',
    'GetRenderState',
    'DrawPrimitiveUP',
  ])
    methods[DEVICE8_METHODS.indexOf(name)] = methods9[names9.indexOf(name)];
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
