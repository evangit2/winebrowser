# Direct3D 12 constant-buffer cube

This native Windows PE32 demo opens a 640×480 window and renders a rotating
cube whose transform is read from a constant buffer bound through a **CBV
descriptor table** — the `D3D12HelloConstBuffers` shape, and the binding style
most real D3D12 programs use for per-frame data.

It drives:

- a 256-byte upload-heap buffer created in `D3D12_RESOURCE_STATE_GENERIC_READ`
  and permanently mapped, so each frame writes the 4×4 matrix straight into it;
- `CreateConstantBufferView` recording the CBV in a shader-visible
  `CBV_SRV_UAV` descriptor heap;
- a root signature with one `D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE`
  parameter holding a `D3D12_DESCRIPTOR_RANGE_TYPE_CBV` range at `b0`;
- `SetDescriptorHeaps` plus `SetGraphicsRootDescriptorTable` binding the table.

The pipeline's shaders are compiled against the canonical bindings that root
parameter implies: the constant buffer lands in group 0 as a uniform, and the
draw-parameter group stays free.

It differs from the root-constants demo, which sends the same transform as
inline 32-bit constants instead of a view into a buffer.

It has no C runtime, pretranslated WebAssembly, or browser-specific imports.
Close the window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository, `scripts/build-d3d12-constbuffer.sh`
calls the same build script, verifies the PE format, imports and instructions,
then creates this package. The package's `SHA256SUMS` pins the exact
distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
