# DirectDraw and Direct3D7 compatibility milestone

WineBrowser supplies `ddraw.dll` exports to arbitrary PE32 uploads through its
normal module provider. There are no executable names, checksums or scene-specific
branches in the runtime. Installing Microsoft's native DirectX package in the
browser is not required for the implemented API profile.

## Implemented profile

`DirectDrawCreate`, `DirectDrawCreateEx`, `DirectDrawCreateClipper` and A/W display
adapter enumeration expose actual guest COM objects. IDirectDraw1/7 and
IDirect3D7 share one IUnknown identity and reference count. Surfaces expose distinct
IDirectDrawSurface1/7 views: their descriptor and caps sizes differ, and writing a
DD7 structure through a DD1 call is rejected. Old DD2/4 and D3D1/2/3 interfaces
remain unavailable.

RGB16/24/32 surfaces support validated contiguous channel masks, pitch-aligned
storage, locking/unlocking, color fills, nearest stretching, format conversion,
overlap-safe copies, source color keys, attached surfaces and a single backbuffer.
Allocations are bounded to 2048 pixels per dimension and 32 MiB in aggregate;
releasing surfaces returns that storage budget. Attachment cycles are rejected.
A HWND clipper clips blits to that window's client rectangle. Primary presentation
uses virtual-screen coordinates in windowed mode and emits actual surface pixels.
Display mode getters share the virtual Win32 mode state. Explicit clip lists,
palettes, overlay surfaces, GDI surface DCs and mipmap chains are unsupported.

IDirect3D7 creates a HAL device over the existing D3D9/WebGPU renderer. Supported
calls include triangle lists/strips/fans with FVF data, indexed drawing, transforms,
viewports, fixed-function materials/lights/render states, RGB/alpha texture
conversion and level-zero point/linear sampling. A matching attached D16 surface
enables depth. GPU target readback reaches DirectDraw read-only locks and CPU blits;
CPU writes to an active GPU target are explicitly rejected. Flip presents the GPU
result and snapshots the frontbuffer. Device/texture/target references are released
through normal COM lifetime handling.

Unsupported methods return E_NOTIMPL and emit the method name. The caps exclude
lines, cube/volume textures, mip chains and stencil. Vertex buffers, strided draws,
state blocks, clip planes and render-target changes need further work. The adapter
establishes a tested subset, not general DirectX conformance.

## Independent acceptance

`npm run build:directdraw` compiles project-owned MIT fixtures against the public
MinGW DirectX headers. `npm run test:directdraw` uploads the DD1, DD7 and D3D7
executables both directly and in ZIPs. Set `WINEBROWSER_TEST_URL` to test the same
uploads on the Pages build or deployed site.

The native code checks callbacks, descriptor/caps layouts, overlapping blits,
source keys, busy lock behavior, reference releases, nearest texture sampling,
indexed and nonindexed geometry, D16 occlusion, texture updates without rebinding,
and backbuffer/frontbuffer readback. The browser checks
all 307,200 pixels in two frames per run, animation for CPU and GPU surfaces, normal guest
window-close handling, a PASS marker, exit zero and no page errors. The evidence
is in `evidence/directdraw-browser-results.json`. Unit tests cover masks, budgets,
24-bit row pitch, format conversion, cross-interface identity, clipping and cycles.
The ordinary static-hosting acceptance is also part of the deployment CI gate.

## AirXonix v1.36 probe

The supplied ZIP was used locally, unchanged, through the ordinary upload UI.
SHA256: `d4f77c84a6f798bf856aca296cf2cb1948267df18241bb0bc797b93f1b710df7`.
The 36,864-byte `AirXonix.exe` is a launcher; the 761,856-byte `program.exe` is the
actual D3D7 game. The ZIP and game binaries are not redistributed by this project.

The original launcher now passes its dynamic DDRAW/DirectDrawCreateEx lookup.
The [launcher milestone](processes.md) now implements native Wine
`NtCreateUserProcess`, and the unchanged launcher starts the game child through
WinExec. No successful WinExec result is fabricated.
Selecting `program.exe` manually exercises the game directly. It resolves all
133 static imports, passes the added process-local NT UTC time query, and currently
stops at `NtRaiseException` with native C++ exception code `0xe06d7363`.
SystemPerformanceInformation reports STATUS_NOT_IMPLEMENTED so Wine can take its
failure path; scheduler and I/O telemetry are not invented.

AirXonix is **not yet verified playable**: no game frame or gameplay acceptance
has passed. Native NT exception dispatch is the next shared runtime milestone. More D3D7 methods may be needed after those startup
gaps are implemented. The local probe metadata is in `evidence/directdraw-airxonix-results.json`.
A supported-import count alone does not prove compatibility.

## Deployment verification

The full GitHub gate passed for `aaf9e2c56ecf81d7caec1f8623f71fe3a7304fcb`.
Live Pages uploads passed all six DD1/DD7/D3D7 acceptance runs, and the OpenGL
shader compilation, animation, camera/pause controls and shutdown regression
passed. The unchanged AirXonix ZIP reaches the same documented startup blockers
on the live site. See `evidence/directdraw-live-deployment.json` and its linked
reports for the deployed revision, workflow and observed results.
