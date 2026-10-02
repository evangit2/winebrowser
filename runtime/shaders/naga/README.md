# SPIR-V to WGSL browser library

This independent Rust wrapper uses Naga 30.0.1 to parse and validate a complete
SPIR-V module, emit WGSL, then parse and validate the emitted WGSL. Its Direct3D
export is `spirv_to_wgsl(Uint8Array): string`; invalid inputs throw a descriptive
JavaScript error. It does not compile HLSL or DXBC and does not assign shader
bindings. WebGPU pipeline creation remains a separate validation gate.

SPIR-V `BaseVertex` and `BaseInstance` inputs are lowered to a 16-byte signed
integer uniform at group 3, binding 0: `[baseVertex, baseInstance, 0, 0]`.
The shader's original subtraction from `VertexIndex` or `InstanceIndex` is
preserved. The caller must bind the draw offsets, including nonzero values.
Other draw-parameter forms, including `DrawIndex`, fail explicitly. The Wasm
memory is capped at 128 MiB by the build script.

Wine's tested vertex shader also emits a fixed `PointSize = 1.0` output. The
normalizer drops only this fixed point-size write, which WebGPU cannot express;
other point-size values or uses fail. This is for triangle rendering, where
point size has no effect.

The build is pinned by `Cargo.lock` and `scripts/build-shader-wgsl.sh`. Build
outputs and notices are published under `public/shaders/naga/`. The wrapper is
MIT-licensed; Naga is licensed under MIT OR Apache-2.0. The Vulkan combined-sampler normalizer derives from the same author-owned
DirectWebGPU project.

The additional `vulkan_spirv_to_wgsl` export validates native Vulkan SPIR-V,
converts Vulkan clip-space orientation, and assigns deterministic bindings:
original binding N becomes 2*N; a combined sampler becomes texture 2*N and
sampler 2*N+1, keeping the original descriptor set. Bindings above 31 and
unsupported combined sampler arrays/access chains fail. The Vulkan renderer
must create matching bind groups; no guest shader is replaced.
