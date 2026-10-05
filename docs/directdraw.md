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
Display mode getters share the virtual Win32 mode state. Fullscreen mode changes
resize maximized windows to the requested display. DD7 adapter identification
returns a bounded PE32 virtual adapter descriptor without claiming WHQL certification.
Texture-stage descriptors, managed level-zero textures and GUID-keyed byte private
data are supported. IUnknown/volatile private-data flags remain unsupported. Explicit clip lists,
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
lines, cube/volume textures, mip chains and stencil. Native vertex buffers support owned guest storage, validated Lock/Unlock,
descriptor queries, Optimize, and indexed/nonindexed drawing. Strided draws,
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

The unchanged launcher starts the real game child through native Wine WinExec.
The original startup dialog renders its bitmap logo and START/OPTIONS/QUIT controls.
START reaches the animated 3D menu and a textured first level. Arrow keys move the
ship, P pauses/resumes the level timer, Ctrl+Q returns to the menu, and selecting
Exit terminates both the game and launcher with exit code zero. The private-input
acceptance checks both process results, actual pixels, animation, input and the
native D3D7 vertex-buffer/Flip path; imports or launcher exit alone are insufficient.

Upload your **complete v1.36 ZIP**, select `airxonix/airxonix.exe`, click Run, then
START. Focus the game display, press Enter for New Game, wait for the difficulty
selection menu, then press Enter for Easy.
The first level currently takes about 17–20 seconds to load on the development Mac;
measured gameplay is about 5–9 FPS, so performance still needs work. Native C++
exception delivery, application activation notifications, bitmap static controls,
managed texture storage and vertex buffers are shared runtime implementations.
There are no game-specific runtime branches or patched game executables.

To reproduce with your own private archive:

```sh
AIRXONIX_ARCHIVE=/absolute/path/AirXonix_Win_EN_v136-Full.zip npm run test:airxonix
```

The test verifies the original archive and executable hashes. By default it tests
the launcher and direct `program.exe` selection. `WINEBROWSER_TEST_URL` targets a
static build or Pages; `AIRXONIX_EVIDENCE` selects a metadata report path.
`AIRXONIX_SCREENSHOTS=1` stores optional private captures only under ignored
`.scratch/airxonix-acceptance/`. No game binaries or screenshots are published.
The metadata report is `evidence/directdraw-airxonix-results.json`. This optional
acceptance requires private input; CI continues to use the independent MIT fixtures.

GPU readback combines pending rendering and pixel retrieval in one submission,
avoids a duplicate D3D9 CPU copy for DirectDraw, and caches channel conversion.
The independent fixtures still verify frontbuffer/backbuffer pixels and depth.

## Deployment verification

The full GitHub gate passed for `aaf9e2c56ecf81d7caec1f8623f71fe3a7304fcb`.
Live Pages uploads passed all six DD1/DD7/D3D7 acceptance runs, and the OpenGL
shader compilation, animation, camera/pause controls and shutdown regression
passed. Those reports describe the earlier DirectDraw milestone; current private
AirXonix gameplay acceptance is recorded separately. See `evidence/directdraw-live-deployment.json` and its linked
reports for the deployed revision, workflow and observed results.
