# Graphics integration handoff — 2026-09-18

Development resumed on 2026-09-18. An original native D3D9 cube now passes
browser EXE/ZIP execution through a bounded COM frontend and worker WebGPU
renderer; see [current graphics scope](graphics-runtime.md). The broader Wine
and DirectX milestones below remain proposals.
See [the task list](../TASKS.md).

## Execution and reuse

The reviewed [DirectWebGPU revision](https://github.com/evangit2/DirectWebGPU/tree/2cb676dcefcfd486d06d2ad43d7754c3c7bdb9c8)
still translates each EXE offline through Theseus into Rust/Wasm. WineBrowser
should retain its existing PE loader and browser-time x86 block translation.
Small binaries do not remove missing CPU, DLL or OS semantics. Startup latency
must be measured against real applications before making any instant-start claim.

Useful graphics references are `web/vkd3d-shaders.js`, the C/Rust bridge under
`runtime/shaders`, and `web/gpu-worker.js` with its D3D9 resource/state/draw modules.
The shader bridge uses libvkd3d-shader and Naga for legacy shader bytecode through
SPIR-V to WGSL; its existing SM1–3 path is not a D3D10/11/12 frontend. Its shared
memory transport also needs adaptation to WineBrowser's unshared guest memory.
DirectWebGPU's WineD3D mode is not a complete port of the WineD3D core.

Keep license provenance explicit: Wine and libvkd3d-shader require their LGPL
source/rebuild obligations; Naga uses MIT/Apache-2.0. No blanket license is inferred
for DirectWebGPU's root or Theseus. No new upstream graphics code is copied into
this handoff, and the other project's renderer results are not WineBrowser tests.

## Proposed Wine path

Pin matching frontend/backend code to [Wine 11 source](https://github.com/wine-mirror/wine/tree/db11d0fe6a169c457e23d007e20404643d067aa8).
Retain Wine's D3D9 COM frontend as a guest PE DLL, with a source-derived WineD3D
core whose adapter/render backend sends commands to a browser WebGPU worker.
A generic compatibility DLL build can be reused across EXEs; it does not require
an offline build per application. This remains an integration proposal.

An installed `wined3d.dll` is not a ready browser backend. The inspected i386
`d3d9.dll` imports 175 WineD3D functions; WineD3D itself imports 221 functions
across seven DLLs, with a transitive PE closure of 13 DLLs. WineD3D's build also
uses Unix-side components and selects OpenGL/Vulkan adapters. Its frontend reads
internal WineD3D state structures directly, so replacing function names with JS
stubs would also require duplicating exact layouts and ownership semantics.
See Wine's [D3D9 device implementation](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/d3d9/device.c)
and [WineD3D build](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/wined3d/Makefile.in).

Suggested acceptance gates:

1. Finish Wine process/CRT startup and cdecl host imports; retain failures rather
   than inventing successful unsupported calls.
2. Build a generic Wine-derived guest frontend/backend bridge with adapter/caps,
   windowed CreateDevice, backbuffer/depth allocation, Clear and Present. Verify
   the actual COM sequence using an independent unchanged D3D9 executable.
3. Extend resources, state, shaders and draw behavior, testing cleanup and device
   reset. Keep guest Wine state/resource structures together and versions pinned.
4. Add other frontends and API families with their own tests. D3D8/10/11 can reuse
   parts of WineD3D; DX12 needs separate DXGI/vkd3d work, command lists, descriptors,
   root signatures, barriers and pipeline state. Many games also require x64,
   threads and exception support. OpenGL/WGL and broader audio remain separate.

The original D3D9 cube fixture now demonstrates device creation, transforms,
depth, drawing and presentation. This is a bootstrap adapter, not a WineD3D
port or independent application compatibility result. DX10/11/12 are not yet
demonstrated. GDI-based Tetris and Breakout remain separate playable examples.
