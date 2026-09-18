# Graphics runtime and acceptance path

WineBrowser loads ordinary PE32 EXEs or ZIPs in the browser. Its x86 decoder
compiles encountered basic blocks to WebAssembly on demand; there is no
per-application offline translation or full PC emulator. The first graphics
path targets native Direct3D 9 calls from that same guest process.

## Current D3D9 boundary

`src/d3d9.js` owns the initial D3D9 import and COM behavior. `Direct3DCreate9`
returns a guest pointer to an `IDirect3D9` vtable; `CreateDevice` returns an
`IDirect3DDevice9` vtable. `src/com.js` dispatches guest indirect stdcall
through checked thunks and tracks object references. Unsupported methods fail
explicitly. The guest owns its Win32 window; the frontend checks the window
handle and presentation parameters before creating a renderer surface.

This bootstrap accepts one windowed X8R8G8B8 backbuffer, no multisampling,
optional D16 depth, and the fixed-function `D3DFVF_XYZ | D3DFVF_DIFFUSE`
triangle-list path. It implements the subset needed for device creation,
`Clear` of the full color/depth target, world/view/projection `SetTransform`,
lighting off, cull none, depth enable/write, `SetFVF`, `BeginScene`,
`DrawPrimitiveUP`, `EndScene`, `Present`, and COM release. Draws copy bounded
16-byte XYZ/color vertices and their transform state from guest memory before
queuing a frame. Textures, programmable D3D shaders, other FVF layouts, reset,
stencil, and the rest of D3D9 remain outside this initial scope.

`src/webgpu-renderer.js` owns the browser backend inside the runtime worker.
It receives those bounded frame snapshots, creates an `OffscreenCanvas` WebGPU
target, renders with a small fixed-function WGSL shader and `depth16unorm`,
then sends an `ImageBitmap` to the desktop. `Present` awaits GPU completion
before reporting success. [Backend geometry/depth evidence](../evidence/webgpu-backend-results.json)
tests the renderer separately from guest execution.

The first executable is [our source-built cube fixture](../demos/d3d9-cube/main.c),
built once as a freestanding x86 PE by `scripts/build-d3d9-demo.sh`. It imports
only D3D9, USER32 and KERNEL32, rotates a depth-tested cube using precomputed
matrices, and is packaged at `public/demos/d3d9-cube.zip`.
[Full-browser evidence](../evidence/d3d9-browser-results.json) records the
unchanged PE working via both EXE upload and hosted ZIP: 640×480 frames with
changing colored cube faces, 63 browser-compiled Wasm blocks, and clean guest
window-close exit code 0. COM creation, draw, present and release were traced.
This establishes the narrow native API fixture, not compatibility with an
independent upstream D3D9 application.

## Broader DirectX work

The present D3D9 frontend and shader are a small bootstrap, **not WineD3D**.
Broader D3D8/9 should use a pinned, licensed Wine frontend and WineD3D-derived
state/resource core with a browser WebGPU backend, maintaining one owner for
guest COM objects, resources, and lifetimes. Wine's [D3D9 source at the pinned
revision](https://github.com/wine-mirror/wine/tree/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/d3d9)
is LGPL-2.1-or-later. Legacy programmable shader work can reuse
[libvkd3d-shader](https://gitlab.winehq.org/wine/vkd3d) under LGPL-2.1-or-later
and [Naga](https://github.com/gfx-rs/wgpu/tree/trunk/naga) under MIT/Apache-2.0
for a validated bytecode-to-WGSL path. The cached DirectWebGPU renderer is a
reference, not integrated or assumed redistributable code.

Independent acceptance targets keep each API claim concrete:

| API   | Target and gate                                                                                                                                                                                                                    | Additional boundary                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| D3D9  | Packaged source-built cube above passes; next gate is an independently sourced D3D9 PE32 application rendering unchanged                                                                                                           | Expand Wine semantics and resources beyond the fixture's narrow call set.                                                             |
| D3D10 | Existing [Humus Inferno target](../tests/targets.json): original PE32 EXE and assets render a scene                                                                                                                                | DXGI, D3D10 device/state, shader bytecode, and its CRT/Win32 imports.                                                                 |
| D3D11 | Microsoft's [Direct3D 11 Tutorial02 triangle](https://github.com/microsoft/DirectX-SDK-Samples/blob/main/C%2B%2B/Direct3D11/Tutorials/Tutorial02/Tutorial02.cpp), built once as an ordinary PE32 fixture, renders its own triangle | DXGI swap chain, D3D11 device/context/resources, input layout and shaders.                                                            |
| D3D12 | Microsoft's [D3D12 HelloTriangle](https://github.com/microsoft/DirectX-Graphics-Samples/tree/213dd4fd4918ea009dd8f35adee1aff1f2ecaba4/Samples/Desktop/D3D12HelloWorld/src/HelloTriangle) is a later x64 acceptance target          | x64 execution, DXGI, root signature, descriptors, pipeline state, shader model, command allocators/lists, barriers, queue and fences. |

Before that x64 target, a smaller native PE32 D3D12 triangle can use licensed
[Wine D3D12 test DXBC vertex/pixel blobs](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/d3d12/tests/d3d12.c)
and `SV_VertexID`, avoiding a separate vertex upload while still exercising
DXGI backbuffers, root signature, pipeline state, command recording, barriers,
queue submission and fences. This is a proposed gate, not implemented support.
The Microsoft project currently has x64/ARM64 configurations and builds its
SM6 DXIL `.cso` files with DXC; it supplies no checked-in DXBC blobs, so the
current SM1–3 shader bridge cannot run that sample as-is.

Shared WebGPU surface, resource, shader and submission services may support
those frontends, but API-specific ownership and validation cannot be inferred
from the D3D9 subset. DX10/11/12 rendering has not been demonstrated here.
