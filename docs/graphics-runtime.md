# Graphics runtime and acceptance path

WineBrowser loads ordinary PE32 EXEs or ZIPs in the browser. Its x86 decoder
compiles encountered basic blocks to WebAssembly on demand; there is no
per-application offline translation or full PC emulator. The graphics
frontends accept bounded native Direct3D 9 and Direct3D 12 calls from that same
guest process.

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

## Current D3D12 boundary

`src/d3d12.js` owns PE32 DXGI/D3D12 COM objects, checked guest descriptors,
command recording, resource state transitions and fences. `src/d3d12-renderer.js`
consumes validated submission snapshots and shares the worker WebGPU device
with the D3D9 backend. The first native fixture creates a two-buffer RGBA8
swapchain, an RTV descriptor heap, empty root signature, pipeline state,
allocator, command list and fence. It submits a real shader draw, transitions
PRESENT/RENDER_TARGET states, presents alternating buffers, signals the queue
and reads the completed 64-bit fence value through the PE32 EDX:EAX ABI.

The [triangle fixture](../demos/d3d12-triangle/main.c) uses Wine's retained,
licensed SM5 DXBC bytecode. Its procedural full-screen triangle is clipped to
a moving viewport, producing a green rectangle on a dark background.
[Browser evidence](../evidence/d3d12-browser-results.json) verifies both the
original EXE upload and hosted ZIP, exact pixels, animation, native API traces,
browser-compiled machine-code blocks and clean window-close exit code 0.

The [D3D12 cube](../demos/d3d12-cube/main.c) adds committed upload buffers,
Map/Unmap and GPU virtual addresses, a POSITION/COLOR float4 vertex layout,
a D16 committed depth texture, DSV descriptors, depth clears and testing,
and `IDXGISwapChain3::GetCurrentBackBufferIndex`. Its original MIT HLSL is
compiled to ordinary SM5 DXBC when building the native fixture; those DXBC
bytes are then translated in the browser at runtime. The EXE computes yaw,
pitch and perspective projection each frame using native x87 arithmetic,
with 24 model vertices and 36 R16 indices. There are no stored animation frames.
The browser CPU emitter dispatches x87 operations to the separate Berkeley
SoftFloat ext80 Wasm library. WebGPU rasterizes the indexed triangles,
interpolates attributes and resolves depth each frame.

[Cube browser evidence](../evidence/d3d12-cube-browser-results.json) records
170 x86 blocks compiled in the browser, changed colored frames, native buffer
and depth/indexed-draw API calls, and exit code 0 for both EXE and ZIP. [Backend pixel tests](../evidence/d3d12-backend-results.json)
separately verify near geometry occludes far geometry, disabling depth changes
the visible color, nonzero vertex offsets work, depth clears affect subsequent
draws, and invalid or released resources fail. Indexed pixel cases exercise
R16 and R32 formats, a nonzero first index, positive and negative base vertices,
and the WebGPU padding required for a six-byte R16 triangle. The same checks pass the bounded
[readback presentation path](../evidence/d3d12-backend-readback-results.json)
used with software WebGPU adapters.

Upload buffers remain guest-owned. Command lists record their views; execution
validates live resources and captures bounded copies immediately before GPU
submission. Writes made after recording and before submission are visible.
Backbuffer transitions commit only after successful submission, and queue
signals follow completed GPU work. Limits include 256 commands and 8 MiB of
combined vertex/index snapshots per list/submission, with one 32-byte vertex buffer in slot 0
and one instance per draw. `IASetIndexBuffer` accepts R16_UINT/R32_UINT
upload views; `DrawIndexedInstanced` records counts and offsets. At execution,
shared validation scans only the drawn index range, applies the signed base
vertex without integer wrapping, and rejects out-of-range vertex references.
A null index view unbinds it. Unsupported API/state combinations fail explicitly.

`src/shader-compiler.js` lazily loads two replaceable Wasm libraries in the
worker: **libvkd3d-shader 2.1** compiles DXBC to SPIR-V; **Naga 30.0.1** validates
and translates that SPIR-V to WGSL. The browser then creates the WebGPU pipeline.
The guest's shaders are translated from their bytes; there are no application
hash substitutions or precompiled WGSL fixtures. This shader path is distinct
from the x86-to-Wasm compiler that executes the EXE. vkd3d also serializes and
parses real empty DXBC root signatures. Complete source and rebuild materials
ship with the compiler modules; see [notices](../THIRD_PARTY_NOTICES.md).

The backend reads the DXBC input signature and maps vertex attributes by
semantic name/index to the shader's declared registers. It does not assume
POSITION and COLOR always use a particular register order.

The SPIR-V bridge lowers BaseVertex/BaseInstance to a reserved 16-byte uniform
at group 3/binding 0 and preserves the shader's subtraction. It removes only
constant PointSize=1 output for triangle rendering. Other unsupported shader
forms fail. [Separate shader evidence](../evidence/dxbc-shader-browser-results.json)
checks the actual worker compilation/rendering path, nonzero draw offsets,
malformed bytecode and root-signature validation.

Current limits include PE32 x86, a direct queue, empty root signatures, bounded
command batches, triangle lists, RGBA8 backbuffers and no multisampling. DXIL,
compute, textures, descriptor tables, arbitrary root bindings, indirect draws,
x64 and general game compatibility remain unfinished. D3D10 and D3D11 need their
own frontends; a D3D12 draw does not provide them automatically.

The same compiler now accepts bounded shader-model 1–3 token pairs through
`compileLegacyPair`. It builds the varying map between vertex and pixel stages,
then translates both through libvkd3d and Naga. Licensed Wine VS 1.1/PS 2.0
fixtures compile in an isolated worker and produce WGSL accepted by WebGPU.
That check does not render Humus or add programmable D3D9 calls. Resource
binding details and the retained point-size portability patch are documented
in [the compiler ABI](../runtime/shaders/vkd3d/README.md).

## Broader DirectX work

The original bounded D3D9/D3D12 COM adapters are **not WineD3D**. Broader support
should preserve Wine-derived state/resource ownership behind a browser backend.
The pinned Wine source and shader compiler libraries provide licensed reusable
components; the cached DirectWebGPU renderer remains an architectural reference,
not integrated or assumed redistributable code. See [graphics handoff](graphics-handoff.md).

Independent acceptance targets keep API claims concrete:

| API   | Target and remaining gate                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D3D9  | Source-built cube passes; pinned Humus Dynamic Branching is the next unchanged EXE. Startup, further x87 operations, programmable shaders, buffers, textures and stencil remain.                                                                                                |
| D3D10 | Original [Humus Inferno target](../tests/targets.json): DXGI/D3D10 device/state, shaders, CRT and Win32 dependencies remain.                                                                                                                                                    |
| D3D11 | Microsoft's [Tutorial02](https://github.com/microsoft/DirectX-SDK-Samples/blob/main/C%2B%2B/Direct3D11/Tutorials/Tutorial02/Tutorial02.cpp), built as ordinary PE32: implement device/context/resources and validate a native draw.                                             |
| D3D12 | Native PE32 shader triangle and depth-tested cube pass. Microsoft's [HelloTriangle](https://github.com/microsoft/DirectX-Graphics-Samples/tree/213dd4fd4918ea009dd8f35adee1aff1f2ecaba4/Samples/Desktop/D3D12HelloWorld/src/HelloTriangle) remains a later x64/SM6 DXIL target. |

Neither narrow fixture establishes arbitrary application compatibility or instant
startup. The machine-code translator, CRT/OS services and graphics semantics all
need independent application tests.
