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
license, so the local package stays in ignored cache. The hosted example is the
MIT raymarch demo.

## Verified scope

`npm run test:opengl` tests ordinary EXE upload and hosted ZIP, 800 × 600 shaded
pixels, animation, pause, camera input, real browser shader compilation, clean
resource/window shutdown and Stop/reupload. `npm run test:opengl-upstream` checks
both multi-file and ZIP upload of the published executable, animated geometry,
GL dispatch, original generated log and clean CRT exit. The same tests accept
`WINEBROWSER_TEST_URL` for deployed-site verification. Results are recorded in
`evidence/opengl-browser-results.json` and
`evidence/opengl-upstream-browser-results.json`.

The bridge implements a bounded programmable vertex/fragment subset: pixel
formats, WGL contexts/procedure lookup, shader/program compilation, uniforms,
VAOs, vertex/index buffers, draw calls, viewport, depth/blend/cull state and
presentation. Numeric guest names refer to actual WebGL objects; uploads and
readbacks validate guest memory and enforce size limits. Supported GLSL source
versions include 110–460 when their syntax fits WebGL2. A GLSL 450 version line
does not imply full OpenGL 4.5 support. Compute/geometry/tessellation shaders,
fixed-function immediate-mode drawing, general texture/framebuffer APIs, and
arbitrary OpenGL applications remain outside this milestone. x64 EXEs are still
unsupported. Unsupported APIs fail explicitly; driver compile/link errors reach
the guest through normal OpenGL status/log queries.
