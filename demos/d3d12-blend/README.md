# Direct3D 12 pipeline blend states

This native Windows PE32 demo opens a 640×480 window and draws the same
clip-space region through **three pipeline states that differ only in their
blend state**. The final image is the proof: an unblended foreground would
replace the background entirely, whereas the observed pixels are exactly what
each blend factor pair computes.

| Pass | Blend state | Expected result on a `0.10,0.14,0.38` background |
|---|---|---|
| 0 | disabled (write mask only) | the background `26,36,97` |
| 1 | `SRC_ALPHA` / `INV_SRC_ALPHA`, ADD | 50 % red over it → `128,33,61` |
| 2 | `ONE` / `ONE`, ADD | additive green → `154,250,125` |

It exercises:

* `D3D12_BLEND_DESC` with an enabled render target, separate colour and alpha
  factor pairs, `D3D12_BLEND_OP_ADD`, and a full `D3D12_COLOR_WRITE_ENABLE_ALL`
  write mask;
* three distinct `ID3D12PipelineState` objects created from one root signature
  and switched within a single command list with `SetPipelineState`;
* an upload-heap vertex buffer with three layers selected by `firstVertex`.

The runtime maps D3D12 blend factors and operations onto WebGPU's, and refuses
the ones with no single-source equivalent (dual-source `SRC1_*`, alpha factor)
rather than silently substituting something else. `MIN`/`MAX` operations are
accepted with their required `ONE` factors, and a non-NOOP logic operation is
rejected.

No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
window to exit.

Install a 32-bit MinGW-w64 cross compiler, then rebuild from the downloaded
directory with `./build.sh`. In the repository, `scripts/build-d3d12-blend.sh`
calls the same build script, verifies the PE format, imports and instructions,
then creates this package. The package's `SHA256SUMS` pins the exact
distributed EXE bytes.

The original demo program (`main.c`), its HLSL and its build and packaging
scripts use the MIT license in `LICENSE`.
