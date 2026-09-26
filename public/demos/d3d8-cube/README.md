# Native D3D8 cube

This ordinary PE32 executable uses the D3D8 COM ABI and imports d3d8.dll.
It shares geometry, transforms, input and cleanup with the D3D9 cube source,
compiled using the real MinGW D3D8 header and import library. WineBrowser
translates its x86 instructions to Wasm in the browser and renders with WebGPU.

Rebuild with `sh scripts/build-d3d9-demo.sh 8`. This verifies the bounded
color/depth/FVF path, not full D3D8 or Hamsterball compatibility. D3D8 texture
resources, shaders, state blocks and the remaining device methods still need
adaptation to the shared renderer.
