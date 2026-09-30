# Direct3D 12 trefoil torus knot

This native Windows PE32 demo opens a 640×480 window and renders an animated
**trefoil knot swept as a tube**: 256 cross-sections of 13 vertices build a
3,072-vertex, 18,432-index mesh that a single `DrawIndexedInstanced` submits
each frame under an orbiting camera.

The geometry is generated, not hard-coded. The knot's centre line is the
standard trefoil parametrisation, evaluated from a running sine/cosine pair
through the double- and triple-angle identities (no libm); each ring's frame is
built by crossing the finite-difference tangent with a fixed up vector, and the
vertex colours are driven by the same angles so the tube's twist is visible.

It exercises runtime paths the simpler samples do not:

- **`ID3D12Device.CreateHeap` and `CreatePlacedResource`** — both vertex and
  index buffers are placed at fixed offsets inside one guest-owned upload heap,
  rather than created as committed resources;
- a **three-buffer BGRA8 flip-discard swap chain**, so the present-time channel
  conversion and the current-back-buffer rotation over three images both run;
- the **swap chain descriptor and statistics queries** (`GetDesc1`,
  `GetFrameStatistics`, `GetLastPresentCount`) a real renderer polls;
- a **guest-side x87 perspective transform** of every vertex each frame.

No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository, `scripts/build-d3d12-knot.sh`
calls the same build script, verifies the PE format, imports and instructions,
then creates this package. The package's `SHA256SUMS` pins the exact distributed
EXE bytes.

The original demo program (`main.c`) and its build and packaging scripts use the
MIT license in `LICENSE`. The DXBC pair was extracted byte-for-byte from the
`vs_code` and `ps_code` arrays in Wine 11.0's `dlls/d3d12/tests/d3d12.c` at
commit `db11d0fe6a169c457e23d007e20404643d067aa8`; those derived shader bytes
remain under Wine's LGPL-2.1-or-later license in `shaders/LICENSE`.
