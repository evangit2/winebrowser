# Direct3D 12 root constant buffer view

This native Windows PE32 demo opens a 640×480 window and renders the same
rotating cube as the descriptor-table samples, but binds its per-frame
transform through a **root** constant buffer view — the third and simplest
D3D12 root-binding style.

The differences matter: a root descriptor is bound with a GPU virtual address
directly, so the program creates **no descriptor heap, no descriptor range and
no CBV object**. The root signature declares one
`D3D12_ROOT_PARAMETER_TYPE_CBV` parameter at `b0`, and each frame calls
`SetGraphicsRootConstantBufferView` with `GetGPUVirtualAddress` of a permanently
mapped upload buffer.

Together with the other D3D12 samples this covers every root-parameter binding
form D3D12 offers:

| Demo                | Binding style                                 |
| ------------------- | --------------------------------------------- |
| `d3d12-constants`   | `D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS`   |
| `d3d12-rootcbv`     | `D3D12_ROOT_PARAMETER_TYPE_CBV` (this demo)   |
| `d3d12-constbuffer` | a CBV descriptor range in a descriptor table  |
| `d3d12-texture`     | an SRV descriptor table plus a static sampler |

The runtime resolves a root descriptor to the buffer its address names, starting
the view at that address so a program may bind into the middle of a buffer.

No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository, `scripts/build-d3d12-rootcbv.sh`
calls the same build script, verifies the PE format, imports and instructions,
then creates this package. The package's `SHA256SUMS` pins the exact
distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
