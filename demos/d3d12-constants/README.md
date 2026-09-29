# Direct3D 12 root-constants cube

This native Windows PE32 demo opens a 640×480 window and renders a rotating
unit cube whose transform is delivered to the vertex shader as **D3D12 root
constants** — a `D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS` root parameter
covering HLSL `cbuffer` register `b0`. The vertex shader multiplies the 4×4
transform by each position on the GPU, so the frame loop writes only 16 DWORDs
of constants through `SetGraphicsRoot32BitConstants` and never re-uploads
geometry or a constant buffer.

It exercises a different path from the other D3D12 samples in this repository,
which all use an empty root signature and transform on the guest CPU:

- a real `D3D12_ROOT_SIGNATURE_DESC` with one parameter, serialized by
  `D3D12SerializeRootSignature` and created through `CreateRootSignature`;
- `SetGraphicsRoot32BitConstants` staged per constant register;
- the pipeline's shaders compiled against the canonical bindings that root
  parameter implies (the transform arrives as a uniform in group 0);
- the same command-list, descriptor-heap, fence and swapchain sequence the
  other samples use.

It has no C runtime, pretranslated WebAssembly, or browser-specific imports.
Close the window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository,
`scripts/build-d3d12-constants.sh` calls the same build script, verifies the PE
format, imports and instructions, then creates this package. The package's
`SHA256SUMS` pins the exact distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
