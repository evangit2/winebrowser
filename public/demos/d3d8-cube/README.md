# Native D3D8 cube

This ordinary PE32 executable uses the D3D8 COM ABI and imports d3d8.dll.
It shares geometry, transforms, input and cleanup with the D3D9 cube source,
compiled using the real MinGW D3D8 header and import library. WineBrowser
translates its x86 instructions to Wasm in the browser and renders with WebGPU.

Rebuild with `sh scripts/build-d3d9-demo.sh 8`. This verifies the bounded
color/depth/FVF path, not full D3D8 or Hamsterball compatibility. General D3D8
shaders, state blocks and the remaining device methods still need adaptation
to the shared renderer.

The rotating cube alternates ordinary user-memory draws with indexed draws from
dynamic managed and system-memory vertex/index buffers. The native program checks
the descriptors and lock results before rendering; EXE and ZIP browser runs must
exercise all three paths and exit cleanly.

Before creating the device, the native program verifies adapter display mode and
enumeration against USER32 screen dimensions, invalid adapter/index results,
D16/D24S8 depth and stencil capabilities and rejection of unsupported formats. The browser
regression requires these calls and subsequent real animated WebGPU frames.
