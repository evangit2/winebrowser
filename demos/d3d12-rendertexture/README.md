# Direct3D 12 render to texture

This native Windows PE32 demo opens a 640×480 window and draws each frame in
**two passes**, the structure post-processing, shadow maps and deferred shading
all build on:

1. **Offscreen pass.** A full-screen quad renders a colour gradient into a
   256×256 `R8G8B8A8_UNORM` texture created with
   `D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET`. The texture is created in
   `RENDER_TARGET` state and cleared to magenta, so an unrendered texture would
   be unmistakable.
2. **Barrier.** The texture transitions to `PIXEL_SHADER_RESOURCE`, the state a
   sampler requires.
3. **Composite pass.** A second quad samples that texture through an SRV
   descriptor table and multiplies it by 0.5, presenting to the swapchain.

The visible image is therefore the offscreen result — not a colour the
composite shader computed. The gradient runs from `(0,0,128)` to `(127,127,0)`,
which is exactly the offscreen `(0,0,255)→(255,255,0)` gradient halved.

It exercises render-target texture creation with its mandatory clear value, RTV
and SRV descriptors over the same resource, the `RENDER_TARGET ↔
PIXEL_SHADER_RESOURCE` transitions in both directions, two pipeline states
sharing one root signature, and per-pass viewport and render-target changes.

No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository,
`scripts/build-d3d12-rendertexture.sh` calls the same build script, verifies the
PE format, imports and instructions, then creates this package. The package's
`SHA256SUMS` pins the exact distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
