/* The same native geometry, input and animation, compiled against the actual
 * D3D8 headers/import library. No pretranslated Wasm or game-specific API. */
#define COBJMACROS
#include <d3d8.h>
#define WINEBROWSER_D3D8
#define D3D_VERSION_TEXT "8"
#define D3DCAPS9 D3DCAPS8
#define IDirect3D9 IDirect3D8
#define IDirect3DDevice9 IDirect3DDevice8
#define Direct3DCreate9 Direct3DCreate8
#define IDirect3D9_CreateDevice IDirect3D8_CreateDevice
#define IDirect3D9_Release IDirect3D8_Release
#define IDirect3D9_GetDeviceCaps IDirect3D8_GetDeviceCaps
#define IDirect3DDevice9_GetDeviceCaps IDirect3DDevice8_GetDeviceCaps
#define IDirect3D9_GetAdapterDisplayMode IDirect3D8_GetAdapterDisplayMode
#define IDirect3D9_CheckDepthStencilMatch IDirect3D8_CheckDepthStencilMatch
#define IDirect3D9_GetAdapterModeCount(p, a, f) IDirect3D8_GetAdapterModeCount(p, a)
#define IDirect3D9_EnumAdapterModes(p, a, f, i, m) IDirect3D8_EnumAdapterModes(p, a, i, m)
#define IDirect3DDevice9_SetRenderState IDirect3DDevice8_SetRenderState
#define IDirect3DDevice9_SetFVF IDirect3DDevice8_SetVertexShader
#define IDirect3DDevice9_SetTransform IDirect3DDevice8_SetTransform
#define IDirect3DDevice9_Clear IDirect3DDevice8_Clear
#define IDirect3DDevice9_BeginScene IDirect3DDevice8_BeginScene
#define IDirect3DDevice9_DrawPrimitiveUP IDirect3DDevice8_DrawPrimitiveUP
#define IDirect3DDevice9_EndScene IDirect3DDevice8_EndScene
#define IDirect3DDevice9_Present IDirect3DDevice8_Present
#define IDirect3DDevice9_Release IDirect3DDevice8_Release
#define PresentationInterval FullScreen_PresentationInterval
#include "../d3d9-cube/main.c"
