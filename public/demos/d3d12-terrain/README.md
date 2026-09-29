# Direct3D 12 procedural terrain

This native Windows PE32 demo opens a 640×480 window and renders a
procedurally generated, lit terrain: **16,641 vertices and 32,768 triangles**
in one indexed draw, orbiting under a Lambert-plus-rim pixel shader.

Unlike the cube samples, the geometry is not a hard-coded shape. The guest
generates a 129×129 height field from four octaves of value noise (integer hash
plus smooth interpolation, no libm), derives a per-vertex normal from
neighbouring height samples, and colours each vertex by altitude from sand
through rock to snow. It then builds the index buffer and uploads the whole
~600 KB mesh through the canonical upload-heap path.

It exercises:

* **32-bit indices** (`DXGI_FORMAT_R32_UINT`), which the earlier samples did not;
* a **three-attribute input layout** (POSITION/NORMAL/COLOR, 36-byte stride)
  matched against the vertex shader's input signature;
* a **constant buffer view** bound through a CBV descriptor table, holding the
  per-frame orbit camera and perspective projection as four row vectors;
* a single `DrawIndexedInstanced` of **98,304 indices** — well past the 65,535
  the bounded path originally allowed;
* back-face culling and D16 depth testing over the full mesh.

No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository, `scripts/build-d3d12-terrain.sh`
calls the same build script, verifies the PE format, imports and instructions,
then creates this package. The package's `SHA256SUMS` pins the exact
distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
