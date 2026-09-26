# D3D8/9 framebuffer blending

Native PE32 D3D8/9 render states now control actual framebuffer blending in the
browser. The ordinary uploaded EXE/ZIP path snapshots the state for each draw;
no game-specific precompiled payload is used.

## Implemented scope

- SRCBLEND, DESTBLEND, ALPHABLENDENABLE, COLORWRITEENABLE and BLENDOP have native
  defaults, validation and query roundtrips. Source/destination color and alpha,
  inverses, zero/one and source-alpha saturation are supported. Legacy BOTH source
  factors override the destination factor; they are rejected as destination factors.
- ADD, SUBTRACT, REVSUBTRACT, MIN and MAX work, with MIN/MAX ignoring blend factors.
  RGBA write masks preserve disabled channels. Clear ignores blending and masks.
- D3D9 additionally supports BLENDFACTOR/inverse and separate alpha enable,
  source/destination factors and operation. The constant is uploaded per draw and
  does not create new pipeline variants. D3D8 does not expose D3D9-only states.
- XRGB/RGB565 destination alpha is logically one. A8R8G8B8 preserves and blends
  its actual attachment alpha; desktop window presentation is opaque.
- Both fixed-function and translated programmable draws use the same blend state.
  Texturing/lighting/specular produce the source RGBA before framebuffer blending.
  Shader discard and explicit depth outputs remain intact.
- Capability bits advertise these factors, operations and masks. Dual-source
  blending, MRT, multisampling, sRGB writes, alpha testing and fog remain separate
  work. This increment does not establish general D3D8/9 or DirectX 12 conformance.

The separate `d3d-inactive-effects.js` state handler accepts disabled alpha-test,
fog and stencil selection and preserves their native configuration defaults and
queries. This includes raw DWORD alpha references, fog color/float bits, and
stencil operations/comparisons/masks. Invalid enumerants fail before mutation.
Enabling alpha testing, fog or stencil still fails explicitly before drawing;
those features remain unadvertised. Configuring an inactive effect does not add
any rendering behavior or pipeline variants.

## Precision and performance

32-bit targets use WebGPU's hardware blend unit. WebGPU has no RGB565 render
attachment or portable framebuffer fetch. For enabled RGB565 RGB writes, the
renderer copies the current viewport to one reusable GPU texture before each
triangle, including triangles in the same draw. The fragment wrapper reconstructs
the exact 5/6-bit destination, blends in floating point and then quantizes/dithers
the result. It never rounds the source before blending or delays rounding until
the end of the draw/frame. Depth, culling, discard and masks operate in the same
pipeline; rejected fragments do not alter color or depth.

The extra texture stays on the GPU and is bounded by the existing surface limits.
It is independent of swap-chain rotation and is destroyed with the device. Empty
viewports need no copies. Disabled blending uses the existing direct RGB565 path.
This correctness path has a copy/pass cost per blended RGB565 triangle; high
throughput on large 16-bit scenes is not established and needs further optimization
and real-game measurement. There is no claim of arbitrary programs starting or
running in seconds.

## Evidence

`npm run test:blending-backend` and the same script with `--force-readback` verify
192 cases / 196,608 pixels per presentation mode. An independent CPU reference
checks factors, operations, all write masks, separate alpha, per-draw constants,
multiple overlapping primitives, dithering, viewports, sampled texture alpha,
partial clears, depth rejection and FLIP persistence. Raw attachment alpha is
also checked for A8R8G8B8. Controlled WGSL tests isolate programmable discard and
explicit depth from the separately tested shader compiler.
[Canvas evidence](../evidence/d3d-blending-backend.json) and
[readback evidence](../evidence/d3d-blending-backend-readback.json).

`npm run build:blending` builds fixtures against real D3D8/9 headers.
`npm run test:blending` drops each EXE and its ZIP into the normal UI, checks all
32,768 displayed pixels per run and exits on Escape with code zero. Each fixture
renders overlapping primitives into RGB565 with alpha/additive blending, dither,
write masks, state queries and COPY presentation.
[Native evidence](../evidence/blending-browser-results.json).

525 unit tests pass, along with the lighting GPU, native programmable D3D9 and
DirectX 12 cube regressions and the production build. Original Hamsterball now
passes SRCBLEND/DESTBLEND and disabled fog/stencil setup. It now stops at
NtCreateSection while mapping `shadow.png` (8,879,806 guest instructions).
It still presents zero frames. The probe uses the unchanged original EXE and
local Wine DLL/NLS closure; those assets are not distributed.

Semantics were checked against pinned Wine headers, reference renderer behavior
and Microsoft's [blend factors](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dblend),
[blend operations](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dblendop)
and [render states](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3drenderstatetype).
