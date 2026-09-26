# D3D8/9 display and presentation

The virtual adapter offers 1024×768, 800×600 and 640×480 at 60 Hz, each in
X8R8G8B8 or R5G6B5. USER32 and D3D share this catalogue and process-local current
mode; the default remains 1024×768 X8R8G8B8. D3D8 enumerates all six modes, while
D3D9 filters by format. Windowed backbuffer sizes do not change the desktop.
No host monitor properties are read or changed.

Invalid adapters, mode indices and output buffers return D3DERR_INVALIDCALL.
The complete 16-byte D3DDISPLAYMODE buffer is validated before writing. Invalid
adapter/format mode counts are zero. `CheckDepthStencilMatch` accepts the current
HAL renderer's X8R8G8B8/R5G6B5 adapter formats, A8R8G8B8/X8R8G8B8/R5G6B5 color
targets and D16 depth. Other combinations return D3DERR_NOTAVAILABLE. `GetDeviceCaps` reports the bounded profile described below; other
factory capability queries remain explicitly unsupported.

Device creation accepts one backbuffer, DISCARD/FLIP/COPY, software or hardware
vertex processing, optional D16 depth and interval DEFAULT/ONE/IMMEDIATE.
Fullscreen creation requires an enumerated mode and exclusive ownership of this
runtime's virtual display. It positions a borderless topmost guest window at the
virtual origin through the normal window-position callback path. On device
release, the prior mode, window rectangle, style and topmost state are restored.
Display-change messages are queued. This does not enter browser fullscreen or
change the physical monitor. Device Reset, focus-loss/device-lost behavior, mixed
vertex processing, multiple backbuffers, stencil and multisampling remain unfinished.

The WebGPU renderer uses persistent color textures. FLIP rotates two textures,
including preserved front-buffer contents; COPY retains its single backing
texture. The canvas is a presentation destination rather than the sole storage
for guest pixels. Normal hardware presentation copies GPU-to-GPU. The existing
fallback/diagnostic readback path uses the same color-buffer rotation.

WebGPU has no RGB565 render attachment. `src/d3d-presentation.js` converts each
presented image on the GPU to 5/6/5 channel precision and stores expanded UNORM8
values back into the current color buffer. This preserves quantized pixels across
subsequent flips. The current supported draws have no blending or render-target
feedback. Those future paths need per-operation RGB565 conversion semantics;
this presentation pass alone will not establish them. Hardware dithering is not
emulated. Interval DEFAULT/ONE limits delivery to the virtual 60 Hz refresh;
physical vblank synchronization remains owned by the browser compositor.

`EnumDisplaySettingsA`, `GetSystemMetrics` and D3D queries reflect the active
virtual mode. `ChangeDisplaySettingsA` accepts catalogue modes, keeps CDS_TEST
read-only and restores the default on a null mode. Registry/default queries remain
unchanged by temporary mode switches. Competing USER32 mode changes while a D3D
fullscreen owner exists are rejected.

The native D3D8/9 cubes verify display queries and D16/D24S8 results before actual
rendering. The [fullscreen fixture](../tests/fixtures/presentation/README.md)
verifies an 800×600 RGB565 FLIP device, displayed geometry/animation, Escape and
native assertions for restoration. Backend pixel tests independently check retained
FLIP/COPY contents, RGB565 values, pacing and both canvas/readback paths.

Factory and device `GetDeviceCaps` write the complete D3DCAPS8 (212 bytes) or
D3DCAPS9 (304 bytes) structure after validating the entire destination. The HAL
profile reports implemented presentation, Gouraud color, depth and culling paths;
texture limits, stencil, lighting, indexed streams and general shader-model support
remain zero. The existing bounded shader pairs remain usable without claiming full
shader-model conformance. Native cubes compare factory and device results using
MinGW's structure layouts.

`SetRenderState`/`GetRenderState` support all eight depth comparison functions and
NONE/CW/CCW culling. Draw snapshots include these states, and both fixed-function
and programmable pipeline caches distinguish them. Sixty backend pixel cases
cover equal/less/greater depth relationships and both windings through each path,
in both canvas and readback modes. `SetTransform` stores all matrix bits, including
startup NaNs, like Wine; `GetTransform` returns them unchanged. Draw submission
still rejects a nonfinite matrix if the application actually consumes it.

Original Hamsterball creates its hardware-vertex-processing fullscreen D3D8
device with RGB565, FLIP, interval ONE and D16 depth. Chromium passes `Clear`,
`GetDeviceCaps` and initial `SetTransform`, then stops at unsupported x87
`FFREE ST(3)` (EXE offset `0x8c3e1`) at 8,857,132 guest instructions;
**no game frame is presented yet**. Node stops at actual device creation because
it has no WebGPU adapter. See `evidence/hamsterball-startup{,-browser}.json` for
arguments and exact boundaries.

Sources: pinned Wine 11.0 `dlls/d3d8/directx.c`, `dlls/d3d9/directx.c`, MinGW
D3D8/9 headers, the local DirectWebGPU/Hamsterball presentation implementations,
and Microsoft's [capability query](https://learn.microsoft.com/en-us/windows/win32/api/d3d9/nf-d3d9-idirect3d9-getdevicecaps),
[culling state](https://learn.microsoft.com/en-us/windows/win32/direct3d9/culling-state),
[presentation parameters](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dpresent-parameters)
and [swap effects](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dswapeffect)
contracts. The reference renderer's broader capabilities are not copied into
this runtime's reported support until implemented.
