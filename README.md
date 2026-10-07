# WineBrowser

[Completed work and remaining task list](TASKS.md). Development resumed on 2026-09-18; the task list records verified capabilities and remaining compatibility work.

An experimental **browser-local Windows PE runtime**. Choose one or more EXEs, ZIPs and supporting files, or a complete program folder; the runtime loads the PE image, translates supported x86 basic blocks directly to WebAssembly, and bridges a small Windows API subset to browser services. There is no server compiler and no full PC emulator.

**The test harness runs the unchanged wesmar/Tetris and wesmar Minesweeper Windows releases in a virtual desktop, alongside native D3D9 and D3D12 graphics fixtures rendered with WebGPU, native fixtures and independent winapiexec and pts-tinype executables across console, files, dialogs, PCM audio and GDI drawing. General Windows compatibility remains incomplete.** Wine's unchanged CommandLineToArgvW and wsprintf implementations now run as guest DLLs; additional Wine compatibility modules remain the direction for broad API support.

**Try the [live WineBrowser test harness](https://evangit2.github.io/winebrowser/).** It runs locally in your browser. Use a modern Chromium browser such as Chrome or Edge.

**[Download every demo's EXE and complete ZIP](docs/demo-downloads.md).** Compiled
binaries are committed under `public/demos/` and `public/examples/`; the root
`demos/` directory contains build sources. Use the full ZIP when a program needs
supporting assets or DLLs.

**Native Vulkan uploads run the free Sascha Willems glTF skinning demo.**
Choose **Load gltfskinning** or upload
[the complete Windows ZIP](https://evangit2.github.io/winebrowser/examples/gltfskinning/gltfskinning.zip).
Its [Windows EXE](public/examples/gltfskinning/bin/gltfskinning.exe)
is also available separately in `public/examples/gltfskinning/bin/`; running it
requires the model and shaders from the ZIP.
The original textured CesiumMan character, skeletal animation and native ImGui
controls execute through Vulkan → WebGPU. Its C++ libraries are linked into
the EXE, and the full native Wine/host DLL closure is verified. This is a pinned
Windows x86 source build. P pauses, drag rotates the camera, F1 toggles the
overlay; keep the unsupported optional wireframe checkbox unchecked.

The Khronos 3D cube remains available: download the
[Windows x86 EXE](https://evangit2.github.io/winebrowser/examples/vkcube/vkcube.exe)
or [ZIP with source and license](https://evangit2.github.io/winebrowser/examples/vkcube/vkcube.zip),
upload it and click Run, or use **Load vkcube** in the catalog. The original
textured cube executes through Vulkan → WebGPU, with x86 and SPIR-V compilation
inside the browser. This is a pinned Windows x86 build of the current upstream
Vulkan-Tools source. See [Vulkan scope and verification](docs/vulkan-runtime.md),
including the skinning source/license pins and DLL audit.

The free MIT [LearningDirectX12 cube](docs/learning-dx12-cube.md) now runs its
unchanged native C++ and original release shaders through browser CPU and shader
compilation. Choose **Load learning-dx12-cube** and **Run executable**, or upload
[the complete Windows ZIP](https://evangit2.github.io/winebrowser/examples/learning-dx12-cube/Tutorial2-x86.zip).
This is a source-built 32-bit counterpart of the upstream 64-bit release.

The freeware [Humus Water demo](public/examples/humus-water/PROVENANCE.md) also
runs its unchanged Windows EXE and original shaders. Choose **Load humus-water**
or upload [the complete Water ZIP](https://evangit2.github.io/winebrowser/examples/humus-water/Water.zip).
Its reflected landscape and ripple simulation use two RGBA16 render targets
with preserved 16-bit precision. See [texture/depth scope](docs/rgba16-targets.md).

The hosted PE32 x86 examples below have passed the browser suite. Open a ZIP in the harness when the program needs packaged assets or a DLL; the ZIP contains the executable and its working directory.

**Original 7-Zip GUI:** choose **Load 7zip-gui**, then **Run executable** to open
the native Add to archive dialog. Plain/AES ZIP and LZMA2 compression/extraction,
password entry, Cancel and native error lists are browser-tested with the
original `7zG.exe` and `7z.dll`. See [the tested scope, download and source](docs/7zip-gui.md).

| Example    | Download                                                                                                                                           | What it exercises and expected result                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Console    | [EXE](https://evangit2.github.io/winebrowser/demos/console/console.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/console.zip)          | `WriteFile`; prints `console demo: hello from WriteFile` and exits with code 0.                                 |
| Files      | [ZIP with required asset](https://evangit2.github.io/winebrowser/demos/files.zip)                                                                  | Reads `assets/message.txt`, writes the same bytes to stdout, creates `output.txt`, and exits with code 0.       |
| Dialog     | [EXE](https://evangit2.github.io/winebrowser/demos/messagebox/messagebox.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/messagebox.zip) | `MessageBoxA`; shows “MessageBoxA ran successfully.” with the title “WineBrowser demo”, then exits with code 0. |
| Beep       | [EXE](https://evangit2.github.io/winebrowser/demos/beep/beep.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/beep.zip)                   | `Beep`; requests a 440 Hz tone for 180 ms and exits with code 0. Audio is scheduled through Web Audio.          |
| Static TLS | [ZIP with required DLL](https://evangit2.github.io/winebrowser/demos/tls.zip)                                                                      | Loads `tls.dll`, runs static TLS callbacks and prints `TLS events:12349678`.                                    |

These examples demonstrate specific tested behavior, not broad Windows compatibility. WineBrowser is an experimental PE32 x86 runtime with a small supported instruction and Windows API subset; it is not Wine, a Windows emulator, or a general desktop-app/game runner. See [test target details](docs/test-targets.md) and [architecture notes](docs/architecture.md).

The worker can now supply source-built Wine 11 base DLLs and matching NLS when
they resolve missing imports, including imports in a supplied DLL reached later
through `LoadLibrary`. Package DLLs keep their search precedence. The native
code still translates in the browser. The package includes corresponding source,
licenses and rebuild instructions; see [the native loader scope](docs/wine-loader-bridge.md).
It also supplies native Wine VCRUNTIME140/MSVCP140/MSVCP140_1/ConCRT DLLs to C++
clients and uploaded plugins, with recursive unload/reload checks.

**Database demo:** choose **Load sqlite**, then **Run executable**. The unchanged
upstream SQLite 3.50.4 Windows DLL runs memory/disk SQL, rollback, Unicode text
and blobs, competing writers, database reopen and integrity checks. Download
its resulting `database.db`; the tests independently read it with native
SQLite. [ZIP](https://evangit2.github.io/winebrowser/examples/sqlite/sqlite.zip) ·
[source and provenance](public/examples/sqlite/PROVENANCE.md). Its original
x86 code compiles during browser execution. See [database scope](docs/sqlite.md).

**Unchanged FOSS tools:** choose **Load gnu-diff**, **Load optipng** or **Load 7zip**.
The examples fill in working arguments and include original Windows binaries,
companion DLLs, licenses and complete source archives. Browser acceptance checks
real file comparisons, lossless PNG pixels and a byte-for-byte archive round trip.
See [packages, DLL support and tests](docs/foss-tools.md).

## Run

**Native 3D demo:** choose **Load d3d9-cube**, then **Run executable** in the live harness. [Cube EXE](https://evangit2.github.io/winebrowser/demos/d3d9-cube/d3d9-cube.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/d3d9-cube.zip) · [source](demos/d3d9-cube/main.c). The Windows PE32 program rotates a colored cube using D3D9 transforms, depth testing and `DrawPrimitiveUP`; its x86 code compiles to Wasm during browser execution and a worker submits graphics to WebGPU. Close its window to exit. This is an original API fixture using a narrow bootstrap frontend; WineD3D and D3D10/11 are not implemented yet. See [graphics scope and acceptance path](docs/graphics-runtime.md).

**Native D3D9 shader demo:** choose **Load d3d9-shader-cube**, then **Run executable**. [EXE](https://evangit2.github.io/winebrowser/demos/d3d9-shader-cube/d3d9-shader-cube.exe) · [ZIP with source](https://evangit2.github.io/winebrowser/demos/d3d9-shader-cube.zip) · [source](demos/d3d9-shader-cube/main.c). The EXE calculates its rotating 3D geometry using x87 and supplies original VS 1.1 / PS 2.0 shaders, vertex declarations, changing constants and depth-tested triangle lists. Its machine-code blocks and shaders compile locally in the browser. Both upload and ZIP paths pass animation and clean-exit checks.

**Native D3D12 3D demo:** choose **Load d3d12-cube**, then **Run executable**. [Cube EXE](https://evangit2.github.io/winebrowser/demos/d3d12-cube/d3d12-cube.exe) · [ZIP with source](https://evangit2.github.io/winebrowser/demos/d3d12-cube.zip) · [source](demos/d3d12-cube/main.c). This Windows program calculates rotation and perspective with native x87 math each frame, uploads vertices and R16 indices, runs its DXBC vertex/pixel shaders through the browser compiler, and uses a D16 depth buffer, indexed draws, command lists and fences. Its CPU blocks compile to Wasm during execution; Berkeley SoftFloat supplies extended-precision arithmetic. There are no precomputed animation frames or application-specific runtime branches. The EXE and ZIP both pass animation, pixel and clean-exit checks. Close the virtual window to exit.

**Runtime HLSL compiler:** native programs can now call `D3DCompile` and `D3DCompileFromFile` for bounded SM5 vertex/pixel shaders. Original Microsoft HelloTriangle HLSL compiles and renders in browser tests; the full upstream C++ executable still has loader/API gaps. See [HLSL compilation](docs/hlsl-compilation.md).

**Native D3D12 shader demo:** choose **Load d3d12-triangle**, then **Run executable**. [EXE](https://evangit2.github.io/winebrowser/demos/d3d12-triangle/d3d12-triangle.exe) · [ZIP with source](https://evangit2.github.io/winebrowser/demos/d3d12-triangle.zip). The PE32 program creates DXGI backbuffers, a root signature and pipeline, records command lists with resource barriers, draws through its own SM5 shaders, presents, and waits on a fence. Its full-screen triangle fills a moving viewport. Both the x86 machine code and the DXBC shaders compile locally during browser execution; libvkd3d-shader and Naga provide the shader translation. This bounded path does not provide general DX12 game compatibility, DXIL or x64 support.

**Independent roller-coaster demo:** choose **Load humus-rollercoaster**, then
**Run executable**. The unchanged 911 KB Humus _RollerCoaster_ archive includes
large indexed terrain, a moving reflective track, cube maps, 3D procedural noise,
water, lava and particles. [ZIP](https://evangit2.github.io/winebrowser/examples/humus-rollercoaster/RollerCoaster.zip)
· [provenance](public/examples/humus-rollercoaster/PROVENANCE.md). The original x86
code and Direct3D shaders compile in the browser. `npm run test:rollercoaster`
checks ordinary ZIP upload and the hosted example for animated textured scenes,
32 frames with over 19,000 draws, and clean exit. Startup is CPU intensive.

**Animated stained-glass shadow demo:** choose **Load humus-transparent-shadows**,
then **Run executable**. The unchanged 1.2 MB original archive renders a textured
room with animated light and six cubemap shadow passes. Its readme permits
redistribution and remains in the archive. [ZIP](https://evangit2.github.io/winebrowser/examples/humus-transparent-shadows/TransparentShadowMapping.zip)
· [provenance](public/examples/humus-transparent-shadows/PROVENANCE.md).
Upload/catalog checks pass scene animation and window-close exit zero; x86
blocks and original D3D9 shaders compile during browser execution.

**Independent third-party Direct3D 9 demo:** choose **Load humus-dynamic-branching** in the harness, then **Run executable**. This is the unchanged Humus 3D _Dynamic Branching_ demo by Emil Persson ([ZIP](https://evangit2.github.io/winebrowser/examples/humus-dynamic-branching/DynamicBranching.zip) · [EXE](https://evangit2.github.io/winebrowser/examples/humus-dynamic-branching/DynamicBranching.exe) · [pinned provenance](public/examples/humus-dynamic-branching/PROVENANCE.md)). WineBrowser does not patch it: the guest's own x86 blocks, DXT textures, HMDL pillar-room model and VS 1.1 / PS 2.0 shaders are translated during browser execution, and the stencil-shadow room renders in a virtual window at the demo's own 798×570 size. `npm run test:humus-d3d9` checks the published example and the unchanged upstream ZIP for a large, richly shaded, animated image and the demo's Direct3D 9 call surface. Camera and menu input are not wired up, and this is one independent application, not broad D3D9 game compatibility.

**Interactive native game:** [Breakout EXE](https://evangit2.github.io/winebrowser/demos/breakout/breakout.exe) or [ZIP](https://evangit2.github.io/winebrowser/demos/breakout.zip). In the live harness, choose **Load breakout**, then **Run executable**. Use the arrow keys or mouse to move the paddle, Space to pause, and R to restart. The game opens two independent guest windows; drag their title bars, resize their corners, and close both to exit. This is an original MIT-licensed Win32 C program compiled to PE32, with [source](demos/breakout/main.c) and a reproducible build.

**Independent Windows GUI game:** choose **Load minesweeper**, then **Run executable**. [Minesweeper EXE](https://evangit2.github.io/winebrowser/examples/minesweeper/minesweeper.exe) · [ZIP](https://evangit2.github.io/winebrowser/examples/minesweeper/minesweeper.zip) · [upstream source](https://evangit2.github.io/winebrowser/examples/minesweeper/source.zip). This is the unchanged MIT [wesmar/minesweeper](https://github.com/wesmar/minesweeper) release, with [pinned provenance](third_party/minesweeper/PROVENANCE.md). Left-click reveals, right-click flags, and F2 restarts. Its menu bar, board sizes, editable Custom Field dialog, scores, About and Exit pass `npm run test:minesweeper`. Guest x86 is compiled to Wasm inside Chromium; see [GUI scope](docs/window-runtime.md).

**Independent Windows game:** choose **Load tetris** in the harness, then **Run executable**. [Tetris EXE](https://evangit2.github.io/winebrowser/examples/tetris/tetris.exe) · [ZIP](https://evangit2.github.io/winebrowser/examples/tetris/tetris.zip) · [retained upstream sources](https://evangit2.github.io/winebrowser/examples/tetris/source.zip). This is the unchanged 16 KB MIT-licensed release from [wesmar/Tetris](https://github.com/wesmar/Tetris), with [pinned provenance](third_party/tetris/PROVENANCE.md). Arrows move/rotate, Space drops, P pauses/resumes, F2 restarts, and Esc exits. Player-name editing, Ghost, Pause/Resume, Clear Record, and its confirmation dialog are exercised by `npm run test:tetris`. Registry values reset between runs; font metrics may differ from Windows and the shell icon is absent.

Desktop compatibility also includes offscreen bitmap copies, process-local ANSI/Unicode registry storage, keyboard accelerator tables, and Wine guest formatting. See [the tested scope and remaining dependencies](docs/desktop-compatibility.md).

The virtual desktop currently hosts one guest process with up to eight top-level windows, independent client framebuffers, up to 256 standard child buttons/labels/single-line edits, a guest message queue, timers, and keyboard/mouse events. A new package replaces the previous process. See [window runtime scope and tests](docs/window-runtime.md).

For local development, requires Node.js 22.12+ or 24+, and modern Chromium.

```sh
npm ci
npm run dev
```

Open the loopback URL Vite prints. Use **Run suite** to check all bundled fixtures, or choose a fixture and run it manually. Enter arguments as a JSON array for uploaded programs. Alternatively, open a demo ZIP or its original EXE from `public/demos/`. The files demo requires its ZIP for the packaged asset. Stop terminates the worker; reopen a package to start again.

The development server supplies COOP/COEP headers. `npm run build` creates `dist/`; serve it over HTTPS (or localhost for development). On GitHub Pages, the bundled isolation service worker supplies these headers and automatically reloads the first visit. Other hosts can supply `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` directly. Package selection never sends file contents to a server. OPFS stores packages and generated outputs locally, subject to browser quota; output files also have download links. Persistent package reopening and saved-file overlays are not implemented yet.

Pushes to `main` deploy the harness to GitHub Pages after the runtime and browser checks pass. To reproduce the Pages build and test its project path without server isolation headers:

```sh
WINEBROWSER_BASE_PATH=/winebrowser/ npm run build
npm run serve:pages
# In another terminal:
npm run test:pages
npm run test:d3d9 # uploaded EXE and hosted ZIP render with worker WebGPU
```

Set `WINEBROWSER_TEST_URL=https://evangit2.github.io/winebrowser/` to run the same browser checks against the deployed site.

## What works today

Native Windows OpenGL uploads compile and render locally through WGL and worker
WebGL2. Choose **Load humus-raytraced-shadows** for the unchanged freeware Humus
demo: seven bouncing spheres, moving light, a bump-mapped room and three lighting/
shadow passes. [Original ZIP](https://evangit2.github.io/winebrowser/examples/humus-raytraced-shadows/RaytracedShadows.zip).
Its 144 imports across six Windows DLLs resolve; textures, native physics,
camera controls, F1 settings, browser shader compilation and clean exit pass
upload/catalog checks. The free **opengl-raymarch** OpenGL 3.3 demo and a published
GLSL 450 pyramid/cube EXE with its genuine native GLEW DLL also run. See
[tested OpenGL and DLL scope](docs/opengl.md); this is bounded compatibility.

The local harness now also includes a native **D3D8 cube**. Its 32-bit EXE uses
the actual D3D8 COM ABI and translates in the browser through the shared graphics
backend; `npm run test:d3d8` checks EXE/ZIP animation and clean exit. This is
a bounded D3D8 path, not full Hamsterball compatibility. Native D3D8/9 texture
EXEs and ZIPs also pass pixel and resource-lifetime checks; see the
[texture scope and evidence](docs/d3d-textures.md). Native GPU lighting, materials
and point/directional/spot lights also pass EXE/ZIP and pixel tests; see
[lighting scope](docs/d3d-lighting.md). Selected D3D8/9 standalone, 2D and cube targets now
receive real offscreen draws and native surface readback; see the
[offscreen scope and limits](docs/d3d-render-targets.md). [Framebuffer blending](docs/d3d-blending.md)
now includes RGB565 rounding after each overlapping primitive. The unchanged original Hamsterball EXE and its native BASS/CRT dependencies now
load through ordinary ZIP upload with an automatically selected source-built
Wine base. The browser translates their x86 code to Wasm during execution.
Hamsterball presents its loading screen, reaches “CLICK HERE TO PLAY!” and
responds to mouse input with its original menu, then renders a normal tournament
warm-up race. Arrow-key input moves the hamster, follows the camera and changes
the score; falling and recovery also render. Startup and gameplay are slow; race
completion, further levels and audio remain unverified. See [the current gate](TASKS.md#current-original-hamsterball-gate)
records the remaining work. No Theseus-translated game executable is used.
DirectSound PCM buffers also pass native EXE/ZIP tests for actual browser playback,
wrapped locks, shared duplicates, timed cursors and playback controls; see the
[audio fixture and limits](tests/fixtures/dsound/README.md).
Native process shutdown also passes a separate character-conversion fixture with the supplied Wine/NLS closure;
see [the active gate](TASKS.md#current-original-hamsterball-gate).
The overall scope remains DirectX through 12, including the unfinished D3D10/11
frontends and broader D3D12 resources/shaders.

- Read-only file mappings through Win32 and native Wine NT calls, with offset views, protected pages, independent handle/view lifetimes, and coherent package-file updates. See [file section scope](docs/file-sections.md).
- Multi-file and folder import, bounded ZIP extraction, CRC verification, path normalization, executable selection, and PE32 x86 import inspection. Top-level selected ZIPs expand into the package; ZIPs inside a selected folder remain application assets. Limits are 2,048 files, 64 MiB of selected bytes, 128 MiB expanded, and 64 directory levels. Conflicting paths are rejected. Choose the program and its supporting files together; a new selection replaces the current package.
- PE DLL imports/exports, ordinal and forwarded exports, HIGHLOW relocations, DllMain attach/detach, guest callbacks, scalar byte/word/dword x86 instructions, calls/returns, condition flags, and direct Wasm block generation in a terminable worker.
- Relative and sandboxed DOS DLL paths, same-basename plugins, `LoadLibraryExA/W` with flags 0 or `LOAD_WITH_ALTERED_SEARCH_PATH`, and full module filename queries. Other search/datafile flags remain unsupported.
- Browser-provided DLL handles point to mapped PE32 images with readable headers, sorted export names and executable API stubs. Imported and dynamically resolved addresses match their PE export tables. Unsupported exports still fail explicitly.
- Single-thread COM initialization and native in-process class activation from the package's registry. Real guest `DllGetClassObject`, class factories and objects execute through browser translation; native fixture tests cover reference counts, failure HRESULTs, server locks and unload/reload. Cross-apartment and external COM servers remain unsupported.
- Writable PE sections and executable private memory invalidate overlapping translations. Ordinary data/stack writes keep executing within a Wasm block; writes that change its own code return before stale instructions execute. A 16,384-block cache evicts old translations instead of ending large programs. Native executable allocation/protection/rewrite fixtures pass.
- Guest thread creation, scheduling, suspended start/resume, priorities, joins and exit. Static PE TLS provides separate templates and process/thread callbacks; new static TLS DLLs can currently load only before additional threads exist. The optional native Wine path owns dynamic TLS/FLS. See [thread scope](docs/thread-runtime.md).
- Byte/word/dword CMPS string comparisons, REPE/REPNE termination and per-thread fault restart flags, alongside existing MOVS/STOS/SCAS support. See [comparison scope](docs/string-comparisons.md).
- Implicit-register MUL/IMUL/DIV/IDIV at byte, word and dword widths, with full-width results and pre-mutation divide errors. See [integer arithmetic scope](docs/wide-integer-arithmetic.md).
- Selected x87 loads/stores, integer conversions, stack operations, arithmetic, comparisons, round-to-integer, classification and control/status instructions using an independently rebuildable SoftFloat ext80 Wasm library. `FYL2X`, `FSIN`, `FCOS` and `FSINCOS` use bounded extended-precision integer intervals, verified against independent Decimal vectors in native browser fixtures. Other transcendental instructions, environment save/restore and general floating-point exception delivery remain unsupported; see [numerical scope](docs/x87-transcendentals.md).
- Conservative CPUID identification and RDTSC using the same monotonic virtual nanosecond counter as Wine performance queries; no host CPU features are exposed.
- Selected SSE data moves, including scalar `MOVSD`/`MOVSS` with native upper-lane behavior, exact signed-int32 `CVTSI2SD`, integer lane unpack/shuffle/XOR, LOCK XADD, ROL/ROR, 16/32-bit SHLD/SHRD and bit scans (including legacy F3 encodings consistent with the virtual CPUID profile). Scalar and packed SSE/SSE2 arithmetic/square roots, float/int32 conversions, COMI/UCOMI and MXCSR rounding/DAZ/FTZ now execute through direct SoftFloat binary32/binary64 operations; see [numerical scope](docs/simd-floating-point.md). Wine process-heap initialization uses the unmodified DLL and NT virtual-memory bridge.
- Bootstrap API provider: standard output, synchronous file reads/writes, owned/unowned `MessageBoxA/W(MB_OK)` with standard icons, `Beep`, and process/time helpers, a reusable heap, dynamic module lookup, and UTF-16 services. The Wine parser supplies CommandLineToArgvW as guest code. See `API_NAMES` in `src/win32.js` for the exact list.
- D3D9 COM device creation, fixed-function XYZ/diffuse triangle lists, world/view/projection transforms, D16 depth and WebGPU presentation. The [browser test](evidence/d3d9-browser-results.json) verifies real PE execution, animation, uploaded EXE/hosted ZIP and clean device/window release.
- D3D12 upload vertex/index buffers, R16/R32 indexed draws, signed vertex offsets, D16 depth, DXGI backbuffers, command lists and fences; guest DXBC shaders compile through libvkd3d-shader and Naga inside the browser. Programmable D3D9 triangle lists also use this browser compiler, with vertex declarations and float constants; licensed VS 1.1/PS 2.0 shader fixtures pass actual WebGPU pixel checks.
- PE resource icons: `LoadIconA/W` resolves named/numeric group resources, decodes bounded 4-bit/32-bit DIBs and supplies the actual pixels to virtual window titlebars. PNG and other icon formats remain unsupported.
- GDI desktop pixel/rectangle operations on a bounded RGBA surface, with brush/DC lifetime checks and canvas presentation. WinMM `PlaySoundA/W` supports synchronous packaged PCM WAV playback; aliases, asynchronous voices and waveOut remain unsupported.
- [WinMM multimedia file streams](docs/multimedia-files.md) support packaged and memory RIFF/WAV reads, buffered byte access, chunk traversal and seek/EOF. A native PE32 fixture verifies those bytes, virtual cursor clipping and real browser minimize/restore. This supplies the APIs reported missing by Feeding Frenzy; its gameplay remains unverified.
- Real native PE fixtures for console, packaged assets and generated files, a dialog, and a tone. No application source is compiled to Wasm to produce these results.
- Offscreen compatible bitmaps and SRCCOPY BitBlt, process-local ANSI/Unicode registry storage, keyboard accelerators, and Wine guest formatting, with [independent executable evidence](docs/desktop-compatibility.md).
- Explicit failure for unsupported imports, instructions, and memory accesses. No success stubs for unknown functions.

The CPU emitter implements a subset of x86; iced-x86's much broader **decoding** support is not execution support. Current exclusions include x64, 16-bit address/stack modes, full x87/SIMD coverage, complete exception/thread/TLS semantics, broader CRT startup, full windowing/GDI, broader OpenGL, broader DirectX including D3D10/11/12, networking, and drivers. Self-modifying code runs through checked write invalidation. Limits include 256 MiB guest address space and 16,384 compiled blocks. Automated suites and direct Runtime consumers default to one million dispatches. Manual browser sessions continue until guest exit or Stop; the worker yields regularly to handle input. Runtime wall time includes browser API waits; it is not a game-performance benchmark.

## Maintainable boundaries

| Module                                                  | Responsibility                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/import-files.js`                                   | Multi-file/folder collection, merging and limits                   |
| `src/package.js`                                        | ZIP validation, bounded expansion, virtual paths                   |
| `src/pe.js`                                             | PE parsing, imports, image mapping                                 |
| `src/wasm.js`                                           | Small binary Wasm module encoder                                   |
| `src/x87.js`                                            | x87 stack/control state, checked operands and SoftFloat arithmetic |
| `src/cpu.js`                                            | x86 lowering, registers, flags, block cache                        |
| `src/simd.js`                                           | Bounded XMM operations and vector memory checks                    |
| `src/wine-parameters.js`                                | Wine-owned process lock, parameters and environment                |
| `src/process-layout.js`                                 | TEB, Wine debug storage and PEB address layout                     |
| `src/wine-process.js`                                   | Native Wine process heap bootstrap and routing                     |
| `src/tls.js`                                            | Static TLS storage, callbacks and failed-load cleanup              |
| `src/memory.js`                                         | Guest memory regions and checked accesses                          |
| `src/win32.js`                                          | Replaceable bootstrap API provider                                 |
| `src/modules.js`                                        | DLL graph, export resolution, relocation and linking               |
| `src/wine-nt.js`                                        | Validated Wine syscall ABI and NT host services                    |
| `src/virtual-memory.js`                                 | Page reservations, commitment, protection and release              |
| `src/heap.js`                                           | Guest allocation, free and coalescing                              |
| `src/win32-process.js`                                  | Process, module and UTF-16 host services                           |
| `src/win32-gdi.js`                                      | Window/memory DCs, bitmaps, brushes and raster drawing             |
| `src/win32-audio.js`, `src/wave.js`                     | WinMM adapter and bounded PCM decoding                             |
| `src/runtime.js`                                        | Process construction, import thunks, dispatch loop                 |
| `src/com.js`, `src/d3d9.js`, `src/d3d9-programmable.js` | Guest COM lifetimes and bounded D3D9 frontend                      |
| `src/d3d12.js`, `src/d3d12-renderer.js`                 | DXGI/D3D12 objects, commands, resources and WebGPU submission      |
| `src/shader-compiler.js`, `runtime/shaders/`            | Browser DXBC → SPIR-V → WGSL libraries and reproducible sources    |
| `src/webgpu-renderer.js`                                | Worker graphics surfaces, transforms, depth and draw submission    |
| `src/worker.js`                                         | Package/run protocol and host requests                             |
| `src/storage.js`                                        | OPFS package and output persistence                                |
| `src/main.js`                                           | Browser UI, user gestures, dialog/audio bridge                     |
| `src/isolation.js`                                      | Static-host service worker activation and reload                   |
| `src/win32-windows.js`                                  | Guest window lifecycle, messages, input and timers                 |
| `src/win32-controls.js`                                 | Standard child control messages and notifications                  |
| `src/gdi-raster.js`, `src/gdi-text.js`                  | Pixel drawing, font matching and bounded glyph cache               |
| `src/desktop.js`                                        | Browser window frames and input forwarding                         |
| `demos/`, `tests/`                                      | Native fixture sources and behavioral checks                       |

Keep guest pointers as integer virtual addresses; never confuse them with host or Wasm-library pointers. New API families should get a provider with explicit ownership and unsupported behavior, rather than app-specific branches in the CPU. Tests should exercise observable guest behavior, including failure paths. See [architecture](docs/architecture.md), [reference study](docs/reference-study.md), and [test targets](docs/test-targets.md).

## Validate and develop

```sh
npm test
npm run build
npm run test:d3d12-backend # translated shaders, vertex input and depth occlusion
npm run test:shaders # actual browser-worker DXBC compilation and pixel checks
npm run test:webgpu  # geometry, depth and transforms on an actual GPU backend
npm run test:controls # DOM control behavior
npm run test:browser  # installed Google Chrome; BROWSER_CHANNEL selects another channel
npm run format:check
node scripts/fetch-targets.mjs
node scripts/test-external-browser.mjs
```

For Playwright's downloaded Chromium instead, install it with `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`. Browser checks exercise the production build, ZIP upload, five native PE fixtures (including EXE/DLL TLS), OPFS output, and worker termination. Their machine-readable report is in `evidence/browser-results.json`; audio validation covers Web Audio scheduling and guest success, not physical speaker capture.

Rebuild the native D3D9 cubes with `npm run build:d3d9` / `npm run build:d3d9-shader-cube` and D3D12 fixtures with `npm run build:d3d12` / `npm run build:d3d12-cube`. Shader compiler rebuilds use `npm run build:shader-dxbc` (Emscripten) and `npm run build:shader-wgsl` (Rust/wasm-bindgen); pinned toolchains and source delivery are documented under `runtime/shaders/`. Rebuild other native fixtures with `npm run build:demos` (MinGW i686 compiler and Python 3 required). The binaries and ZIPs have reproducible timestamps and SHA-256 manifests. `npm run fetch:targets` downloads the hash-pinned catalog into ignored `.cache/targets/`. `npm run inspect:targets` reads those files and records loader/import blockers without executing them. See [independent target results](docs/targets-progress.md). Rebuild the Wine parser with `npm run build:wine`, the formatter with `npm run build:wine-format` and DLL fixtures with `npm run build:modules`.

## Reuse and next steps

Studied [DirectWebGPU](https://github.com/evangit2/DirectWebGPU) and [Hamsterball](https://github.com/evangit2/Hamsterball). Their execution path translates x86 to Rust/Wasm ahead of time; Hamsterball decrypts a prebuilt payload using a supplied EXE. WineBrowser instead emits Wasm blocks in the browser. It reuses the MIT-licensed iced-x86 decoder and a small Hamsterball audio queue helper, and retains their worker/service separation as an architectural reference. Theseus runtime code and generated game payloads are not included. See [notices](THIRD_PARTY_NOTICES.md).

The first Wine component integration is in [runtime/wine](runtime/wine/README.md), with retained LGPL source and rebuild instructions. An optional test also executes an entire unmodified installed Wine 11 i386 `ntdll.dll`, including its real DLL initialization, CRC32, string/memory comparison and NT-status conversion exports. The matching Chromium probe packages that DLL with unchanged winapiexec and verifies CRC32, NT services, zeroed heap bytes, freeing and private-heap destruction. Set `WINEBROWSER_NTDLL` to the installed DLL path and run `npm run test:wine` or `npm run test:external`. The probe pins one DLL build by SHA-256; that binary is not distributed in this repo. The Wine i386 dispatcher now supplies real NT clock and bounded virtual-memory services. `evidence/wine-ntdll-results.json` verifies page lifecycle/access behavior and native heap allocation/free/destruction; NT file, event and synchronization-handle services remain incomplete. The next milestone is more independent executables and larger Wine modules, driven by the recorded blockers in [the target catalog](tests/targets.json). Broader CPU semantics and PE loading must advance alongside that work. Broader WineD3D, GDI, OpenGL and audio coverage needs additional browser backends and acceptance tests; importing their source does not automatically make them portable or compatible.

The interface is a plain test bench: no landing page, visual branding or product presentation. Independent executable evidence is recorded in `evidence/external-browser-results.json`; the target catalog distinguishes source-built samples from downloaded original binaries.

The optional `npm run probe:wine-crt -- /path/to/Wine-i386-windows /path/to/wine/nls` loads a hash-pinned, unmodified Wine msvcrt/kernel32/kernelbase/ntdll closure with supplied NLS data. It passes PEB lock, process-parameter and environment initialization through Wine exports, then reaches additional NT services required by locale/CRT startup. Broader process initialization remains unfinished. The exact imports and guest failure state are recorded in `evidence/wine-crt-results.json`. This is a blocked startup probe, not a passing CRT/application test. The [graphics handoff](docs/graphics-handoff.md) records current DirectWebGPU/Wine reuse findings and the remaining DirectX work.

An [optional source-built loader experiment](docs/wine-loader-bridge.md) now initializes Wine's private module records and version subsystem through an explicit C interface. Its Node and Chromium-worker probes verify rollback, lookup and ownership guards against the same generic rebuilt DLL. It is separate from normal EXE/ZIP loading; broader module lifecycle remains unfinished. Its separate Node and Chromium-worker CRT probe now attaches real Wine msvcrt and verifies allocation, formatting, output and a binary file round trip through NT services. The file check creates, writes, measures, seeks, reads, closes and reopens the file through unchanged Wine CRT exports. It does not run an EXE entry point or enable the full Wine closure for normal uploads.

The [unchanged application startup diagnostic](docs/wine-loader-bridge.md#unchanged-application-startup-diagnostic) now enters Humus Dynamic Branching through real Wine base DLLs and records its next runtime failure. It remains a blocked independent target, separate from the passing public cube examples.

**Legacy installers:** the shared User32/GDI/Shell32/LZ32 services cover modeless dialog templates, ownership/tab navigation, DIB palettes, font callbacks, package-folder selection and SZDD file expansion. [Supported behavior and limits](docs/installer-runtime.md). The authored installer-service upload passes; the ATI Treasure Chest installer itself is not yet verified.

The bounded [DirectDraw1/7 and Direct3D7 profile](docs/directdraw.md) now supplies
DDRAW.DLL for ordinary uploads, with independent native EXE/ZIP rendering tests.
The [uploaded launcher milestone](docs/processes.md) supports native Wine child
process creation, suspended resume, exit waits and children that outlive their
parents. The unchanged private AirXonix v1.36 ZIP now reaches its native startup
dialog, animated menu and playable first level, with movement, pause/resume and
clean exit checked. Upload the complete game ZIP and select `airxonix/airxonix.exe`;
[reproduction and current performance](docs/directdraw.md#airxonix-v136-probe).

**Native drive GUI:** choose **Load guest-drive** to write, resize and delete a real guest file while free-space figures update. **Open file…** imports and reads a selected file through native Wine. Disk-space A/W APIs, native drive enumeration and CRT disk information share the guest's 128 MiB content budget (`npm run test:guest-drive`). This is an authored MIT native EXE compiled to Wasm inside the browser; the [complete source build](https://evangit2.github.io/winebrowser/examples/guest-drive/source.zip) is included. Full Windows filesystem compatibility remains unfinished.

**Native layout GUI:** choose **Load window-defer** to arrange two independently painted native child windows side by side or stacked and resize the root. Native deferred-position APIs stage and merge layout requests, then run actual window procedures. `npm run test:window-defer` checks native geometry, callback order, GDI pixels and ordinary button input. The MIT Windows EXE is translated to Wasm inside the browser; its [complete source build](https://evangit2.github.io/winebrowser/examples/window-defer/source.zip) is included.

**Native region GUI:** choose **Load gdi-region**, then use **Difference**, **Union**, **Xor** or **Intersection** to combine two shapes. Native GDI fills and frames the actual result. Guest SDK assertions and browser pixel checks cover geometry, copied clips and ownership (`npm run test:gdi-region`). This MIT Windows EXE is translated to Wasm inside the browser; its [complete source build](https://evangit2.github.io/winebrowser/examples/gdi-region/source.zip) is included. Nonidentity transforms and window regions remain unfinished.

**Native shape GUI:** choose **Load gdi-shapes** to switch between alternate/winding polygons, holes, rounded rectangles, ellipses and a copied clip. An unchanged Windows EXE draws via GDI; the browser checks 96,000 pixels per stage against desktop Wine 11 geometry (`npm run test:gdi-shapes`). Its complete MIT source build is included.

**Native polygon and line GUI:** choose **Load gdi-paths** to compare alternate/winding stars, nested contours, independent line groups, complex clipping and saved fill modes. Its original MIT Windows EXE compiles inside the browser and matches actual Wine pixels (`npm run test:gdi-paths`).

**Native owned cursor GUI:** choose **Load owned-cursors** to try bitmap-created alpha and monochrome mouse images, copying, scaling, visibility and offset hotspots. **Retire** destroys the selected grown cursor; **Reset** recreates it. Native mask/XOR inversion is drawn in the browser. Its unchanged MIT Windows EXE compiles into Wasm during execution (`npm run test:owned-cursors`), and its complete source build is included.

**Native classic control GUI:** choose **Load frame-controls** to try push buttons, checkboxes, three-state controls, scroll/combo arrows, size grips and menu marks. Switch native states, inspect tiny controls, clip holes, or mark adjusted rectangles. The unchanged MIT Windows SDK EXE compiles into Wasm in the browser (`npm run test:frame-controls`). The separate Wine-derived geometry adapter retains its LGPL source and notices.

**Native interactive scrollbars:** choose **Load scroll-controls** to click arrows and track, drag thumbs, use arrow/page/Home/End keys, and try large ranges or disabled arrows. The unchanged MIT Windows EXE compiles into Wasm in the browser (`npm run test:scroll-controls`). Native parent callbacks read full track positions above 65535. Standalone horizontal/vertical controls are covered; nonclient bars, alignment/size-box styles, mouse auto-repeat and complete Windows/DLL support remain unfinished.

**Native scrollbar state inspector:** choose **Load scroll-state** to inspect range and page clamping, signed limits, legacy structures, and compiled custom-control callbacks. The unchanged MIT Windows SDK EXE compiles into Wasm in the browser (`npm run test:scroll-state`). This verifies API state and message forwarding; the separate **scroll-controls** example exercises standalone scrollbar widgets and thumb tracking.

**Native brush raster GUI:** choose **Load gdi-brush-rop** to mix solid, color and monochrome brushes with sixteen paint rules. Try transparent hatches, elliptical clip holes and reversed bounds. The unchanged MIT Windows SDK EXE compiles into Wasm in the browser (`npm run test:gdi-brush-rop`); its complete native source build and independent Wine pixel captures are included.

**Native bitmap color GUI:** choose **Load gdi-pixel-colors** to compare seven bitmap formats side by side. Try RGB and palette colors, direct bitmap indices, out-of-range indices and clipping. Its unchanged MIT Windows EXE checks 217 captured native results and raw bytes, then compiles into Wasm inside the browser (`npm run test:gdi-pixel-colors`). Its complete reproducible source build is included.

**Native bitmap scaling GUI:** choose **Load gdi-stretch** to compare four scaling modes, mirrored images, source crops, region clips and raster operations. **Shrink** shows AND/OR and nearest/smooth sampling differences. This original MIT Windows EXE compiles inside the browser (`npm run test:gdi-stretch`).

**Native bitmap transfer GUI:** choose **Load gdi-transfer** to compare partial scanline buffers, row offsets, crops and clips across bottom-up/top-down 32-bit, 24-bit RGB and 16-bit 565 images (`npm run test:gdi-transfer`).

**Native alpha GUI:** choose **Load gdi-alpha** to compare constant and per-pixel opacity, low-alpha rounding, complex clipping and zero/full opacity. Both msimg32 and GDI paths draw real pixels matching desktop Wine. The original MIT Windows EXE compiles inside the browser (`npm run test:gdi-alpha`).

**Native bitmap icon GUI:** choose **Load icon-bitmap** to compare color/alpha/monochrome icons, independent copies and bitmap-plane roundtrips. Normal, Mask and Image channels match actual desktop Wine snapshots. The original MIT native EXE compiles inside the browser (`npm run test:icon-bitmap`).

**Native frame GUI:** choose **Load gdi-frames** to draw brush frames and XOR focus outlines, erase an outline by drawing it twice, and try hatch/pattern frames and clipping. The original MIT Windows EXE compiles inside the browser; its pixels are checked against desktop Wine (`npm run test:gdi-frames`).

**Native tile GUI:** choose **Load gdi-pattern** to compare color and monochrome tiles, shifted brush origins, native hatches and patterned ellipse clipping. A standard label also receives the copied native brush. Pixels match desktop Wine 11 output; the original MIT Windows EXE and complete source build are included (`npm run test:gdi-pattern`).

**GUI image loading:** LoadImage A/W load bitmap resources and BMP files, requested sizes, theme palette changes and native writable DIB sections. The public **Load load-images** GUI edits a file-loaded bitmap through its native pointer (`npm run test:load-images`). HALFTONE filtering, compressed images and sized/file icons/cursors remain unfinished.

**Shared GUI bitmaps:** CreateDIBSection gives native EXEs, DLLs and GDI coherent packed/BGR pixel memory, with color tables, descriptors and bitmap format inheritance. The public **Load gdi-section** GUI cycles DLL writes, GDI paint and CRT clearing (`npm run test:gdi-section`). File-mapping-backed DIB sections remain unfinished.

**GUI bitmap transfers:** [GetDIBits/SetDIBits](docs/gdi-display.md) support uncompressed RGB, palettes, bitfields and partial scanline updates. The authored native GUI fixture checks six pixel depths and independently verified keyboard-driven bitmap repaints in Chromium (`npm run test:gdi-dib`). Compressed DIBs and full GDI conformance remain unfinished.

Named events, semaphores and owned recursive mutexes support uploaded parent/child processes in a shared, per-run namespace. Recursive acquisition, thread/process abandonment, child handle lifetime and Stop/reupload are verified through native Wine calls. See [process synchronization](docs/process-synchronization.md) for acceptance and remaining IPC limits.
