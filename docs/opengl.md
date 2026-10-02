# Browser-local Windows OpenGL

WineBrowser executes uploaded PE32 x86 OpenGL applications unchanged. Native
instructions compile to WebAssembly in the worker. WGL contexts use worker-owned
OffscreenCanvas WebGL2; desktop vertex/fragment GLSL is adapted to GLSL ES 300 and
compiled by the browser driver. Shader calculations, uniforms and geometry come
from the guest program. Packages stay local.

## Ready-to-run free tech demo

Choose **opengl-raymarch** in the hosted catalog, upload its EXE, or open
[the complete ZIP](https://evangit2.github.io/winebrowser/demos/opengl-raymarch.zip).
This MIT-licensed, source-built Windows OpenGL 3.3 demo renders a rotating torus,
bouncing sphere, rounded box, checker floor, soft shadows and ambient occlusion.
Left/right orbit the camera, Space pauses, and Escape exits. The ZIP includes all
source and rebuild instructions. `npm run build:opengl` rebuilds the native EXE
and deterministic archive. Native Windows driver execution remains unverified.

## Independent published Windows binary

Choose **humus-raytraced-shadows** in the hosted catalog or upload
[the original ZIP](https://evangit2.github.io/winebrowser/examples/humus-raytraced-shadows/RaytracedShadows.zip).
Emil Persson's (Humus) unchanged freeware **Raytraced Shadows** executable renders
seven bouncing spheres and a moving light in a textured, bump-mapped room. Its
three passes calculate ambient lighting, raytraced soft shadows and direct
lighting. Click the window, use W/S or up/down to move, and F1 to open its original
settings menu. Close the window to exit. Keep the ZIP's relative assets together;
the EXE alone does not include the textures and shaders.

The original archive, EXE, GLSL calculations, DDS/PNG textures and font assets are
retained byte for byte. Its readme permits redistribution and remains included.
[Provenance and hashes](../public/examples/humus-raytraced-shadows/PROVENANCE.md)
describe the pinned download. This is an older compatibility-profile OpenGL demo;
the source-built raymarch demo above supplies the OpenGL 3.3 example.

```sh
npm run package:raytraced-shadows # verifies and republishes the original archive
npm run test:raytraced-shadows
```

All 144 imports from its six DLLs resolve: kernel32 (59), user32 (31), gdi32 (3),
advapi32 (6), shell32 (1) and opengl32 (44). The browser supplies their bounded
Win32/OpenGL services. The executable statically includes its CRT, PNG/zlib image
decoder and graphics framework, which execute as guest x86. The earlier GLEW
example below additionally exercises a real separately uploaded native DLL.
Resolving all imported symbols establishes this demo's dependency closure;
it does not establish support for every export or every Windows application.

The unchanged **3DAnimation.exe**, published in
[Shruti Kulkarni's RTR2020 repository](https://github.com/ShrutiKulkarni03/RTR2020/tree/26f79accdd5758fa280d579502aedee702d45892/01-Windows/02-ProgrammablePipeline/09-3DAnimation),
renders a rotating colored pyramid and cube using its original GLSL 450
vertex/fragment shaders. Its genuine Win32 GLEW 2.3.1 DLL executes as guest x86,
queries extensions and resolves OpenGL pointers. Both CRTs exit normally.

```sh
npm run fetch:opengl
# Upload .cache/opengl-upstream/3DAnimation.zip, or select the EXE and DLL together.
npm run test:opengl-upstream
```

The fetch helper pins and verifies the upstream EXE and official GLEW archive
and DLL by SHA-256. It does not rebuild or patch either binary. The application
is freely downloadable but its repository has no declared redistribution
license, so the local package stays in ignored cache. Hosted examples are the
MIT raymarch demo and the original freeware Humus archive.

## Verified scope

`npm run test:opengl` tests ordinary EXE upload and hosted ZIP, 800 × 600 shaded
pixels, animation, pause, camera input, real browser shader compilation, clean
resource/window shutdown and Stop/reupload. `npm run test:opengl-upstream` checks
both multi-file and ZIP upload of the published executable, animated geometry,
GL dispatch, original generated log and clean CRT exit. The same tests accept
`WINEBROWSER_TEST_URL` for deployed-site verification. Results are recorded in
`evidence/opengl-browser-results.json` and
`evidence/opengl-upstream-browser-results.json`.

`npm run test:raytraced-shadows` verifies original ZIP/EXE hashes, every imported
DLL/symbol, ordinary ZIP upload and hosted catalog loading, richly textured
pixels and over 25 draws per frame, native animation, camera-matrix changes,
settings-menu glyphs, original shader compilation, clean native cleanup and
Stop/reupload. Evidence is in
`evidence/raytraced-shadows-browser-results.json`. It also runs in the static
GitHub Pages deployment gate and accepts `WINEBROWSER_TEST_URL` for live checks.

The bridge implements a bounded programmable vertex/fragment subset: pixel
formats, WGL contexts/procedure lookup, shader/program compilation, uniforms,
VAOs, vertex/index buffers, draw calls, viewport, depth/blend/cull state and
presentation. The compatibility subset adds ARB shader-object aliases, legacy
projection/model-view matrices, client-memory arrays, quad triangulation,
immediate-mode vertices/colors/texture coordinates, a unit-zero texture combiner,
unsigned-byte 2D textures and S3TC decoding. Framebuffer destination alpha stays
available to guest shadow/lighting passes while the displayed window is opaque.
Multipass legacy MVP shaders use invariant positions for consistent depth.
Numeric guest names refer to actual WebGL objects; uploads and
readbacks validate guest memory and enforce size limits. Supported GLSL source
versions include 110–460 when their syntax fits WebGL2. A GLSL 450 version line
does not imply full OpenGL 4.5 support. Compute/geometry/tessellation shaders,
full fixed-function lighting/multitexture, general texture/framebuffer APIs, and
arbitrary OpenGL applications remain outside this milestone. 1D textures fail
explicitly and WGL object sharing returns ERROR_NOT_SUPPORTED; both symbols
are imported but unexercised by Raytraced Shadows. x64 EXEs are still
unsupported. Unsupported APIs fail explicitly; driver compile/link errors reach
the guest through normal OpenGL status/log queries.
