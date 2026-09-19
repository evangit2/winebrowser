# Direct3D 12 cube

This ordinary native Windows PE32 program renders a rotating, perspective
projected, depth tested colored cube in a 640×480 window. It uses D3D12 and
DXGI COM interfaces directly: a flip discard swapchain, an upload vertex
buffer, an input layout, a D16 depth texture, RTV and DSV descriptors,
resource barriers, a graphics pipeline, and fence synchronization. It has no
C runtime, pretranslated WebAssembly, or browser specific imports.

The executable performs no floating point transforms. `generate_vertices.py`
deterministically generates 32 animation frames as POSITION and COLOR float4
vertices at build time. Each frame is copied into the mapped upload buffer
after the preceding GPU fence completes. The included pass through HLSL
shaders consume those clip space positions and colors.

Install Python 3 and a 32-bit MinGW-w64 cross compiler, then run `./build.sh`
from the downloaded directory. The build regenerates both the vertex data and
temporary C arrays from `shaders/cube.vs.dxbc` and `shaders/cube.ps.dxbc`.
The repository packaging command is `scripts/build-d3d12-cube.sh`.

The demo, generator, HLSL, and shader build source use the MIT license in
`LICENSE`; the shader directory retains its own license and reproducibility
notes. `SHA256SUMS` pins the exact distributed executable.
