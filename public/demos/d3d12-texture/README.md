# Direct3D 12 textured cube

This native Windows PE32 demo opens a 640×480 window and renders a rotating
cube sampling a procedurally generated 64×64 RGBA checkerboard. It drives the
full D3D12 resource-and-descriptor flow that an ordinary textured program uses:

* `GetCopyableFootprints` supplies the placed subresource footprint, so the
  upload row pitch comes from the API (256-byte aligned) rather than a
  hand-written constant;
* the pixels are generated in guest memory and written into an upload-heap
  buffer, then copied with `CopyTextureRegion` into a default-heap
  `R8G8B8A8_UNORM` texture and transitioned to `PIXEL_SHADER_RESOURCE` with a
  resource barrier;
* `CreateShaderResourceView` records the texture's SRV in a shader-visible
  `CBV_SRV_UAV` descriptor heap;
* the root signature declares a 32-bit-constants parameter for the transform at
  `b0`, a descriptor table holding the SRV at `t0`, and a static sampler at `s0`;
* the command list binds the heap with `SetDescriptorHeaps`, points the table
  parameter at the heap with `SetGraphicsRootDescriptorTable`, and sends the
  per-frame transform with `SetGraphicsRoot32BitConstants`.

The pipeline's shaders are compiled against the canonical bindings those root
parameters imply: the transform lands in group 0, the sampled texture in group
1 and the static sampler in group 2, with the draw-parameter group left free.

It has no C runtime, pretranslated WebAssembly, or browser-specific imports.
Close the window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository,
`scripts/build-d3d12-texture.sh` calls the same build script, verifies the PE
format, imports and instructions, then creates this package. The package's
`SHA256SUMS` pins the exact distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
