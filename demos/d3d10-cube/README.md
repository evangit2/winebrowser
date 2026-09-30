# Direct3D 10 animated cube

This native Windows PE32 application opens a 640×480 window and renders an
animated, depth-tested cube through the Direct3D 10 API. It is the D3D10
counterpart of the D3D12 cube fixture, and it exists to exercise the parts of
D3D10 that differ from D3D12 rather than to look impressive:

- **`D3D10CreateDeviceAndSwapChain`** — the device and its DXGI swap chain are
  created together, and the back buffer is obtained as an `ID3D10Texture2D`
  through `IDXGISwapChain::GetBuffer` rather than as a DXGI resource.
- **an explicit input layout** created from the vertex shader's compiled
  signature, with `D3D10_INPUT_PER_VERTEX_DATA` elements at fixed offsets.
- **direct shader-register binding**: constant buffers, shader resources and
  samplers are set per stage with `VSSetConstantBuffers`/`PSSetConstantBuffers`,
  so the two stages keep separate register files.
- **view objects**: separate render-target and depth-stencil views wrapping the
  swap-chain image and a `D3D10_BIND_DEPTH_STENCIL` texture.
- **per-stage state objects**: rasterizer, depth-stencil and blend state, each
  created once and applied with the `OM`/`RS` setters.
- a **dynamic constant buffer** the application maps with
  `D3D10_MAP_WRITE_DISCARD` and rewrites every frame.

No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository, `scripts/build-d3d10-cube.sh`
calls the same build script, verifies the PE format, imports and instructions,
then creates this package. The package's `SHA256SUMS` pins the exact
distributed EXE bytes.

The original demo program (`main.c`) and its build and packaging scripts use the
MIT license in `LICENSE`. The DXBC pair was produced with Wine's bundled
`d3dcompiler_47` from the sources in `shaders/`; see `shaders/LICENSE`.
