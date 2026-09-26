# D3D8/9 display queries

Both factories use `src/d3d-display.js` for adapter mode queries. Adapter zero
reports USER32's existing fixed virtual display: 1024×768, 60 Hz, X8R8G8B8.
D3D8 enumerates the single mode without a format argument; D3D9 filters by
X8R8G8B8. No host monitor properties are read or changed. Creating a differently
sized window/backbuffer does not change the desktop query result.

Invalid adapters, mode indices and output buffers return D3DERR_INVALIDCALL.
The complete 16-byte D3DDISPLAYMODE buffer is validated before writing, so failed
queries leave guest memory unchanged. Invalid adapter/format mode counts are zero.

`CheckDepthStencilMatch` accepts the shared renderer's actual HAL/X8R8G8B8 adapter,
A8R8G8B8 or X8R8G8B8 color target, and D16 depth attachment. Other combinations
return D3DERR_NOTAVAILABLE; an invalid adapter returns D3DERR_INVALIDCALL.
D24S8 stencil, multisampling, fullscreen/flip presentation and additional display
modes are not implemented by this change. Other factory capability queries remain
explicitly unsupported.

The D3D8 and D3D9 cube sources now call these methods through their actual PE32
COM vtables before device creation. They verify the display against GetSystemMetrics,
check invalid cases, and test both D16 acceptance and D24S8 rejection. Browser
EXE/ZIP tests require those calls, actual animated color/depth rendering and clean
exit. Unit tests additionally check ABI argument counts, sentinel memory around
outputs, invalid pointers and color/depth/device combinations.

Original Hamsterball proceeds through these queries to CreateDevice. Its next
request is an 800×600 R5G6B5 fullscreen backbuffer, FLIP swap effect and presentation
interval ONE. It retries hardware, mixed and software vertex processing. Those
settings exceed the current windowed X8R8G8B8/A8R8G8B8, DISCARD-only renderer, and
its selected depth format is zero. The diagnostic records all creation arguments
and presentation fields in `evidence/hamsterball-startup{,-browser}.json`.
The game reports `Graphics::Initialize D3DERR_INVALIDCALL`; no game frames render.

ABI/reference sources: pinned Wine 11.0 `dlls/d3d8/directx.c`,
`dlls/d3d9/directx.c`, the MinGW D3D8/9 headers, and Microsoft's
[GetAdapterDisplayMode](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3d9-getadapterdisplaymode),
[EnumAdapterModes](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3d9-enumadaptermodes)
and [CheckDepthStencilMatch](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3d9-checkdepthstencilmatch)
contracts. The existing DirectWebGPU capability profile is broader than this
renderer; its unsupported features are not copied into the reported support.
