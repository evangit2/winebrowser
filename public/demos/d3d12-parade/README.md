# Direct3D 12 "parade"

This native Windows PE32 demo opens a 640×480 window and renders a 3×3×3 field
of independently rotating, depth-tested solids — alternating cubes and
octahedra, each with its own tint. Unlike the single-cube fixture it performs
27 indexed draws per frame against shared vertex and index buffers, with every
vertex transformed, rotated and Gouraud-lit on the guest CPU through native x87
math before upload. It uses a two-buffer flip-discard swapchain, RTV/DSV
descriptors, an empty root signature, a graphics pipeline state with D16 depth
testing, resource barriers, and a fence after each frame. It has no C runtime,
pretranslated WebAssembly, or browser-specific imports. Close the window to
exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. You can modify `main.c`; `build.sh` regenerates the
temporary C shader arrays from the checked-in `.dxbc` files before compiling. In
the repository, `scripts/build-d3d12-parade.sh` calls the same build script,
verifies the PE format, imports and instructions, then creates this package. The
package's `SHA256SUMS` pins the exact distributed EXE bytes.

The original demo program (`main.c`) and its build and packaging scripts use the
MIT license in `LICENSE`. The DXBC pair was extracted byte-for-byte from the
`vs_code` and `ps_code` arrays in Wine 11.0's `dlls/d3d12/tests/d3d12.c` at
commit `db11d0fe6a169c457e23d007e20404643d067aa8`; those derived shader bytes
remain under Wine's LGPL-2.1-or-later license in `shaders/LICENSE`.

The renderer requires D3D12 and DXGI support from its Windows environment.
