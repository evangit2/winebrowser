# Direct3D 12 cube

This ordinary native Windows PE32 program renders a rotating, perspective
projected, depth tested colored cube in a 640×480 window. It calculates every
frame's transformed vertices at runtime with ordinary 32-bit x87 machine
instructions. It uses D3D12 and DXGI COM interfaces directly: a flip discard
swapchain, upload vertex and index buffers, a two element input layout, a D16
depth texture, RTV and DSV descriptors, resource barriers, a graphics
pipeline, and fence synchronization. It has no C runtime, pretranslated
WebAssembly, browser specific imports, or offline transformed animation data.

The executable retains 24 face colored model vertices and 36 `R16_UINT`
indices. Each frame advances two rotations with fixed incremental constants,
then applies rotation and perspective projection using x87 load, store, add,
subtract, multiply, and divide operations. After the preceding GPU fence
completes, it writes the calculated POSITION and COLOR float4 values to the
mapped vertex buffer and submits `DrawIndexedInstanced(36, 1, 0, 0, 0)`.
The included pass through HLSL shaders consume those values.

Install Python 3 and a 32-bit MinGW-w64 cross compiler, then run `./build.sh`
from the downloaded directory. The build regenerates temporary C arrays from
`shaders/cube.vs.dxbc` and `shaders/cube.ps.dxbc`.
The repository packaging command is `scripts/build-d3d12-cube.sh`.

The demo, HLSL, and shader build source use the MIT license in
`LICENSE`; the shader directory retains its own license and reproducibility
notes. `SHA256SUMS` pins the exact distributed executable.
