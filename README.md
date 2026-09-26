# WineBrowser

[Completed work and remaining task list](TASKS.md). Development resumed on 2026-09-18; the task list records verified capabilities and remaining compatibility work.

An experimental **browser-local Windows PE runtime**. Choose one or more EXEs, ZIPs and supporting files, or a complete program folder; the runtime loads the PE image, translates supported x86 basic blocks directly to WebAssembly, and bridges a small Windows API subset to browser services. There is no server compiler and no full PC emulator.

**The test harness runs the unchanged wesmar/Tetris Windows release in a virtual desktop, alongside native D3D9 and D3D12 graphics fixtures rendered with WebGPU, native fixtures and independent winapiexec and pts-tinype executables across console, files, dialogs, PCM audio and GDI drawing. General Windows compatibility remains incomplete.** Wine's unchanged CommandLineToArgvW and wsprintf implementations now run as guest DLLs; additional Wine compatibility modules remain the direction for broad API support.

**Try the [live WineBrowser test harness](https://evangit2.github.io/winebrowser/).** It runs locally in your browser. Use a modern Chromium browser such as Chrome or Edge.

The hosted PE32 x86 examples below have passed the browser suite. Open a ZIP in the harness when the program needs packaged assets or a DLL; the ZIP contains the executable and its working directory.

| Example    | Download                                                                                                                                           | What it exercises and expected result                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Console    | [EXE](https://evangit2.github.io/winebrowser/demos/console/console.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/console.zip)          | `WriteFile`; prints `console demo: hello from WriteFile` and exits with code 0.                                 |
| Files      | [ZIP with required asset](https://evangit2.github.io/winebrowser/demos/files.zip)                                                                  | Reads `assets/message.txt`, writes the same bytes to stdout, creates `output.txt`, and exits with code 0.       |
| Dialog     | [EXE](https://evangit2.github.io/winebrowser/demos/messagebox/messagebox.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/messagebox.zip) | `MessageBoxA`; shows “MessageBoxA ran successfully.” with the title “WineBrowser demo”, then exits with code 0. |
| Beep       | [EXE](https://evangit2.github.io/winebrowser/demos/beep/beep.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/beep.zip)                   | `Beep`; requests a 440 Hz tone for 180 ms and exits with code 0. Audio is scheduled through Web Audio.          |
| Static TLS | [ZIP with required DLL](https://evangit2.github.io/winebrowser/demos/tls.zip)                                                                      | Loads `tls.dll`, runs static TLS callbacks and prints `TLS events:12349678`.                                    |

These examples demonstrate specific tested behavior, not broad Windows compatibility. WineBrowser is an experimental PE32 x86 runtime with a small supported instruction and Windows API subset; it is not Wine, a Windows emulator, or a general desktop-app/game runner. See [test target details](docs/test-targets.md) and [architecture notes](docs/architecture.md).

## Run

**Native 3D demo:** choose **Load d3d9-cube**, then **Run executable** in the live harness. [Cube EXE](https://evangit2.github.io/winebrowser/demos/d3d9-cube/d3d9-cube.exe) · [ZIP](https://evangit2.github.io/winebrowser/demos/d3d9-cube.zip) · [source](demos/d3d9-cube/main.c). The Windows PE32 program rotates a colored cube using D3D9 transforms, depth testing and `DrawPrimitiveUP`; its x86 code compiles to Wasm during browser execution and a worker submits graphics to WebGPU. Close its window to exit. This is an original API fixture using a narrow bootstrap frontend; WineD3D and D3D10/11 are not implemented yet. See [graphics scope and acceptance path](docs/graphics-runtime.md).

**Native D3D9 shader demo:** choose **Load d3d9-shader-cube**, then **Run executable**. [EXE](https://evangit2.github.io/winebrowser/demos/d3d9-shader-cube/d3d9-shader-cube.exe) · [ZIP with source](https://evangit2.github.io/winebrowser/demos/d3d9-shader-cube.zip) · [source](demos/d3d9-shader-cube/main.c). The EXE calculates its rotating 3D geometry using x87 and supplies original VS 1.1 / PS 2.0 shaders, vertex declarations, changing constants and depth-tested triangle lists. Its machine-code blocks and shaders compile locally in the browser. Both upload and ZIP paths pass animation and clean-exit checks.

**Native D3D12 3D demo:** choose **Load d3d12-cube**, then **Run executable**. [Cube EXE](https://evangit2.github.io/winebrowser/demos/d3d12-cube/d3d12-cube.exe) · [ZIP with source](https://evangit2.github.io/winebrowser/demos/d3d12-cube.zip) · [source](demos/d3d12-cube/main.c). This Windows program calculates rotation and perspective with native x87 math each frame, uploads vertices and R16 indices, runs its DXBC vertex/pixel shaders through the browser compiler, and uses a D16 depth buffer, indexed draws, command lists and fences. Its CPU blocks compile to Wasm during execution; Berkeley SoftFloat supplies extended-precision arithmetic. There are no precomputed animation frames or application-specific runtime branches. The EXE and ZIP both pass animation, pixel and clean-exit checks. Close the virtual window to exit.

**Native D3D12 shader demo:** choose **Load d3d12-triangle**, then **Run executable**. [EXE](https://evangit2.github.io/winebrowser/demos/d3d12-triangle/d3d12-triangle.exe) · [ZIP with source](https://evangit2.github.io/winebrowser/demos/d3d12-triangle.zip). The PE32 program creates DXGI backbuffers, a root signature and pipeline, records command lists with resource barriers, draws through its own SM5 shaders, presents, and waits on a fence. Its full-screen triangle fills a moving viewport. Both the x86 machine code and the DXBC shaders compile locally during browser execution; libvkd3d-shader and Naga provide the shader translation. This bounded path does not provide general DX12 game compatibility, DXIL or x64 support.

**Interactive native game:** [Breakout EXE](https://evangit2.github.io/winebrowser/demos/breakout/breakout.exe) or [ZIP](https://evangit2.github.io/winebrowser/demos/breakout.zip). In the live harness, choose **Load breakout**, then **Run executable**. Use the arrow keys or mouse to move the paddle, Space to pause, and R to restart. The game opens two independent guest windows; drag their title bars, resize their corners, and close both to exit. This is an original MIT-licensed Win32 C program compiled to PE32, with [source](demos/breakout/main.c) and a reproducible build. Minesweeper remains a blocked follow-on target.

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

The local harness now also includes a native **D3D8 cube**. Its 32-bit EXE uses
the actual D3D8 COM ABI and translates in the browser through the shared graphics
backend; `npm run test:d3d8` checks EXE/ZIP animation and clean exit. This is the
first D3D8 path, not full Hamsterball compatibility. The original Hamsterball EXE
has been recovered byte-for-byte from retained PE sections and is now an actual
translation target. Its packed native BASS DLL now loads dependencies through the
experimental Wine/browser loader callback, resolves the virtual WinMM mixer and
native ACM/UCRT and OLE32 exports, executes x87 logarithms, trigonometry and
classification, scalar SSE arithmetic, double-width integer shifts and `FISTTP`.
Native Wine character conversion, legacy registry calls and WinMM native-driver
loading now pass. Hamsterball completes DLL attachment and reaches its original
EXE entry. Its native clock reads now pass through the read-only Windows shared
data mapping. Predefined cursor loading and x87 integer-operand arithmetic now
pass, as do COM GUID conversion, window lookup and 24-bit icon decoding.
Native window metadata/positioning and DirectInput 8 pass independent native
browser tests, including keyboard/mouse formats, immediate/buffered input and
focus-loss recovery. NT/Win32 event synchronization now passes native fixtures
through both ordinary uploads and real Wine DLLs. The TEB now provides Wine's
activation-context stack and Unicode scratch buffer. Package file and directory
metadata now passes through Win32 and native NT queries, including Hamsterball's
`C:\winebrowser\DATA` lookup. Guest threads now pass ordinary and native Wine lifecycle tests. Current startup
initializes two workers, creates the 800×600 Hamsterball window, and reaches
`IDirect3D8.GetAdapterDisplayMode` after about 8.85 million guest instructions in
Node and Chromium; no game frame renders yet. See [thread scope](docs/thread-runtime.md).
DirectSound PCM buffers also pass native EXE/ZIP tests for actual browser playback,
wrapped locks, shared duplicates, timed cursors and playback controls; see the
[audio fixture and limits](tests/fixtures/dsound/README.md).
Native process shutdown also passes a separate character-conversion fixture with the supplied Wine/NLS closure;
see [the active gate](TASKS.md#current-original-hamsterball-gate).
The overall scope remains DirectX through 12, including the unfinished D3D10/11
frontends and broader D3D12 resources/shaders.

- Multi-file and folder import, bounded ZIP extraction, CRC verification, path normalization, executable selection, and PE32 x86 import inspection. Top-level selected ZIPs expand into the package; ZIPs inside a selected folder remain application assets. Limits are 2,048 files, 64 MiB of selected bytes, 128 MiB expanded, and 64 directory levels. Conflicting paths are rejected. Choose the program and its supporting files together; a new selection replaces the current package.
- PE DLL imports/exports, ordinal and forwarded exports, HIGHLOW relocations, DllMain attach/detach, guest callbacks, scalar byte/word/dword x86 instructions, calls/returns, condition flags, and direct Wasm block generation in a terminable worker.
- Relative and sandboxed DOS DLL paths, same-basename plugins, `LoadLibraryExA/W` with flags 0 or `LOAD_WITH_ALTERED_SEARCH_PATH`, and full module filename queries. Other search/datafile flags remain unsupported.
- Browser-provided DLL handles point to mapped PE32 images with readable headers, sorted export names and executable API stubs. Imported and dynamically resolved addresses match their PE export tables. Unsupported exports still fail explicitly.
- Single-thread COM initialization and native in-process class activation from the package's registry. Real guest `DllGetClassObject`, class factories and objects execute through browser translation; native fixture tests cover reference counts, failure HRESULTs, server locks and unload/reload. Cross-apartment and external COM servers remain unsupported.
- Writable PE sections invalidate overlapping translated blocks; memory operations end writable-code blocks before following instructions are decoded. A 4,096-block cache evicts old translations instead of ending large programs. Executable private allocations and changing code-page protections remain separate unfinished work.
- Guest thread creation, scheduling, suspended start/resume, priorities, joins and exit. Static PE TLS provides separate templates and process/thread callbacks; new static TLS DLLs can currently load only before additional threads exist. The optional native Wine path owns dynamic TLS/FLS. See [thread scope](docs/thread-runtime.md).
- Selected x87 loads/stores, integer conversions, stack operations, arithmetic, comparisons, round-to-integer, classification and control/status instructions using an independently rebuildable SoftFloat ext80 Wasm library. `FYL2X`, `FSIN`, `FCOS` and `FSINCOS` use bounded extended-precision integer intervals, verified against independent Decimal vectors in native browser fixtures. Other transcendental instructions, environment save/restore and general floating-point exception delivery remain unsupported; see [numerical scope](docs/x87-transcendentals.md).
- Conservative CPUID identification and RDTSC using the same monotonic virtual nanosecond counter as Wine performance queries; no host CPU features are exposed.
- Selected SSE data moves, including scalar `MOVSD`/`MOVSS` with native upper-lane behavior, exact signed-int32 `CVTSI2SD`, integer lane unpack/shuffle/XOR, LOCK XADD, ROL/ROR, 16/32-bit SHLD/SHRD and bit scans (including legacy F3 encodings consistent with the virtual CPUID profile). Scalar SSE arithmetic/square roots, float/int32 conversions, COMI/UCOMI and MXCSR rounding/DAZ/FTZ now execute through direct SoftFloat binary32/binary64 operations; see [numerical scope](docs/simd-floating-point.md). Wine process-heap initialization uses the unmodified DLL and NT virtual-memory bridge.
- Bootstrap API provider: standard output, synchronous file reads/writes, owned/unowned `MessageBoxA/W(MB_OK)` with standard icons, `Beep`, and process/time helpers, a reusable heap, dynamic module lookup, and UTF-16 services. The Wine parser supplies CommandLineToArgvW as guest code. See `API_NAMES` in `src/win32.js` for the exact list.
- D3D9 COM device creation, fixed-function XYZ/diffuse triangle lists, world/view/projection transforms, D16 depth and WebGPU presentation. The [browser test](evidence/d3d9-browser-results.json) verifies real PE execution, animation, uploaded EXE/hosted ZIP and clean device/window release.
- D3D12 upload vertex/index buffers, R16/R32 indexed draws, signed vertex offsets, D16 depth, DXGI backbuffers, command lists and fences; guest DXBC shaders compile through libvkd3d-shader and Naga inside the browser. Programmable D3D9 triangle lists also use this browser compiler, with vertex declarations and float constants; licensed VS 1.1/PS 2.0 shader fixtures pass actual WebGPU pixel checks.
- PE resource icons: `LoadIconA/W` resolves named/numeric group resources, decodes bounded 4-bit/32-bit DIBs and supplies the actual pixels to virtual window titlebars. PNG and other icon formats remain unsupported.
- GDI desktop pixel/rectangle operations on a bounded RGBA surface, with brush/DC lifetime checks and canvas presentation. WinMM `PlaySoundA/W` supports synchronous packaged PCM WAV playback; aliases, asynchronous voices and waveOut remain unsupported.
- Real native PE fixtures for console, packaged assets and generated files, a dialog, and a tone. No application source is compiled to Wasm to produce these results.
- Offscreen compatible bitmaps and SRCCOPY BitBlt, process-local ANSI/Unicode registry storage, keyboard accelerators, and Wine guest formatting, with [independent executable evidence](docs/desktop-compatibility.md).
- Explicit failure for unsupported imports, instructions, and memory accesses. No success stubs for unknown functions.

The CPU emitter implements a subset of x86; iced-x86's much broader **decoding** support is not execution support. Current exclusions include x64, 16-bit address/stack modes, full x87/SIMD coverage, SEH, guest threading, dynamic TLS APIs, broad CRT startup, full windowing/GDI, OpenGL, broader DirectX including D3D10/11/12, networking, and drivers. Self-modifying code is rejected through executable-memory write checks. Limits include 64 MiB guest memory and 4,096 compiled blocks. Automated suites and direct Runtime consumers default to one million dispatches. Manual browser sessions continue until guest exit or Stop; the worker yields regularly to handle input. Runtime wall time includes browser API waits; it is not a game-performance benchmark.

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

The first Wine component integration is in [runtime/wine](runtime/wine/README.md), with retained LGPL source and rebuild instructions. An optional test also executes an entire unmodified installed Wine 11 i386 `ntdll.dll`, including its real DLL initialization, CRC32, string/memory comparison and NT-status conversion exports. The matching Chromium probe packages that DLL with unchanged winapiexec and verifies CRC32, NT services, zeroed heap bytes, freeing and private-heap destruction. Set `WINEBROWSER_NTDLL` to the installed DLL path and run `npm run test:wine` or `npm run test:external`. The probe pins one DLL build by SHA-256; that binary is not distributed in this repo. The Wine i386 dispatcher now supplies real NT clock and bounded virtual-memory services. `evidence/wine-ntdll-results.json` verifies page lifecycle/access behavior and native heap allocation/free/destruction; NT file, event and synchronization-handle services remain incomplete. The next milestone is more independent executables and larger Wine modules, driven by the recorded blockers in [the target catalog](tests/targets.json). Broader CPU semantics and PE loading must advance alongside that work. Broader WineD3D, GDI, OpenGL and audio need their own browser backends and acceptance tests; importing their source does not automatically make them portable or compatible.

The interface is a plain test bench: no landing page, visual branding or product presentation. Independent executable evidence is recorded in `evidence/external-browser-results.json`; the target catalog distinguishes source-built samples from downloaded original binaries.

The optional `npm run probe:wine-crt -- /path/to/Wine-i386-windows /path/to/wine/nls` loads a hash-pinned, unmodified Wine msvcrt/kernel32/kernelbase/ntdll closure with supplied NLS data. It passes PEB lock, process-parameter and environment initialization through Wine exports, then reaches additional NT services required by locale/CRT startup. Broader process initialization remains unfinished. The exact imports and guest failure state are recorded in `evidence/wine-crt-results.json`. This is a blocked startup probe, not a passing CRT/application test. The [graphics handoff](docs/graphics-handoff.md) records current DirectWebGPU/Wine reuse findings and the remaining DirectX work.

An [optional source-built loader experiment](docs/wine-loader-bridge.md) now initializes Wine's private module records and version subsystem through an explicit C interface. Its Node and Chromium-worker probes verify rollback, lookup and ownership guards against the same generic rebuilt DLL. It is separate from normal EXE/ZIP loading; broader module lifecycle remains unfinished. Its separate Node and Chromium-worker CRT probe now attaches real Wine msvcrt and verifies allocation, formatting, output and a binary file round trip through NT services. The file check creates, writes, measures, seeks, reads, closes and reopens the file through unchanged Wine CRT exports. It does not run an EXE entry point or enable the full Wine closure for normal uploads.

The [unchanged application startup diagnostic](docs/wine-loader-bridge.md#unchanged-application-startup-diagnostic) now enters Humus Dynamic Branching through real Wine base DLLs and records its next runtime failure. It remains a blocked independent target, separate from the passing public cube examples.
