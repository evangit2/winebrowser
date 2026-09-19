# Direct3D 12 shader triangle

This native Windows PE32 demo opens a 640×480 window and renders a moving
green inset through the ordinary D3D12 and DXGI COM interfaces. The vertex
shader generates a full-screen triangle from `SV_VertexID`; the pixel shader
returns opaque green. The viewport clips the triangle to an inset rectangle,
making the draw visible against a blue clear color. The demo uses a two-buffer
flip-discard swapchain, RTV descriptors, an empty root signature, a graphics
pipeline state, resource barriers, and a fence after each frame. It has no
C runtime, pretranslated WebAssembly, or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. You can modify `main.c` or replace either `.dxbc`
file; `build.sh` regenerates the temporary C shader arrays before compiling.
In the repository, `scripts/build-d3d12-demo.sh` calls the same build script,
verifies the PE format, imports, and instructions, then creates this package.
The package's `SHA256SUMS` pins the exact distributed EXE bytes.

The original demo program (`main.c`) and its build and packaging scripts use
the MIT license in `LICENSE`. The DXBC pair was extracted byte-for-byte from
the `vs_code` and `ps_code` arrays in Wine 11.0's `dlls/d3d12/tests/d3d12.c`
at commit `db11d0fe6a169c457e23d007e20404643d067aa8`. The complete retained
Wine test file is `Wine-d3d12-tests.c`; that file and the derived shader bytes
remain under Wine's LGPL-2.1-or-later license in `SHADERS-LICENSE`.

The renderer requires D3D12 and DXGI support from its Windows environment.
