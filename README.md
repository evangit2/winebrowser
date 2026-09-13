# WineBrowser

An experimental **browser-local Windows PE runtime**. Choose an `.exe` or a ZIP containing executables and assets; the runtime loads the PE image, translates supported x86 basic blocks directly to WebAssembly, and bridges a small Windows API subset to browser services. There is no server compiler and no full PC emulator.

**The test harness runs the unchanged wesmar/Tetris Windows release in a virtual desktop, alongside native fixtures and independent winapiexec and pts-tinype executables across console, files, dialogs, PCM audio and GDI drawing. General Windows compatibility remains incomplete.** Wine's unchanged CommandLineToArgvW and wsprintf implementations now run as guest DLLs; additional Wine compatibility modules remain the direction for broad API support.

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

**Interactive native game:** [Breakout EXE](https://evangit2.github.io/winebrowser/demos/breakout/breakout.exe) or [ZIP](https://evangit2.github.io/winebrowser/demos/breakout.zip). In the live harness, choose **Load breakout**, then **Run executable**. Use the arrow keys or mouse to move the paddle, Space to pause, and R to restart. The game opens two independent guest windows; drag their title bars, resize their corners, and close both to exit. This is an original MIT-licensed Win32 C program compiled to PE32, with [source](demos/breakout/main.c) and a reproducible build. Minesweeper remains a blocked follow-on target.

**Independent Windows game:** choose **Load tetris** in the harness, then **Run executable**. [Tetris EXE](https://evangit2.github.io/winebrowser/examples/tetris/tetris.exe) · [ZIP](https://evangit2.github.io/winebrowser/examples/tetris/tetris.zip) · [retained upstream sources](https://evangit2.github.io/winebrowser/examples/tetris/source.zip). This is the unchanged 16 KB MIT-licensed release from [wesmar/Tetris](https://github.com/wesmar/Tetris), with [pinned provenance](third_party/tetris/PROVENANCE.md). Arrows move/rotate, Space drops, P pauses/resumes, F2 restarts, and Esc exits. Player-name editing, Ghost, Pause/Resume, Clear Record, and its confirmation dialog are exercised by `npm run test:tetris`. Registry values reset between runs; font metrics may differ from Windows and the shell icon is absent.

Desktop compatibility also includes offscreen bitmap copies, process-local Unicode registry storage, keyboard accelerator tables, and Wine guest formatting. See [the tested scope and remaining dependencies](docs/desktop-compatibility.md).

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
```

Set `WINEBROWSER_TEST_URL=https://evangit2.github.io/winebrowser/` to run the same browser checks against the deployed site.

## What works today

- Bounded ZIP extraction, CRC verification, path normalization, executable selection, and PE32 x86 import inspection.
- PE DLL imports/exports, ordinal and forwarded exports, HIGHLOW relocations, DllMain attach/detach, guest callbacks, scalar byte/word/dword x86 instructions, calls/returns, condition flags, and direct Wasm block generation in a terminable worker.
- Static PE TLS for one guest thread: initialized templates, zero-fill, aligned per-module storage, and process callbacks, including dynamic DLL loading.
- Selected SSE data moves, integer lane unpack/shuffle/XOR, and bit scans. Wine process-heap initialization uses the unmodified DLL and NT virtual-memory bridge.
- Bootstrap API provider: standard output, synchronous file reads/writes, owned/unowned `MessageBoxA/W(MB_OK)` with standard icons, `Beep`, and process/time helpers, a reusable heap, dynamic module lookup, and UTF-16 services. The Wine parser supplies CommandLineToArgvW as guest code. See `API_NAMES` in `src/win32.js` for the exact list.
- GDI desktop pixel/rectangle operations on a bounded RGBA surface, with brush/DC lifetime checks and canvas presentation. WinMM `PlaySoundA/W` supports synchronous packaged PCM WAV playback; aliases, asynchronous voices and waveOut remain unsupported.
- Real native PE fixtures for console, packaged assets and generated files, a dialog, and a tone. No application source is compiled to Wasm to produce these results.
- Offscreen compatible bitmaps and SRCCOPY BitBlt, process-local Unicode registry storage, keyboard accelerators, and Wine guest formatting, with [independent executable evidence](docs/desktop-compatibility.md).
- Explicit failure for unsupported imports, instructions, and memory accesses. No success stubs for unknown functions.

The CPU emitter implements a subset of x86; iced-x86's much broader **decoding** support is not execution support. Current exclusions include x64, 16-bit address/stack modes, floating-point arithmetic, most SIMD operations, SEH, guest threading, dynamic TLS APIs, broad CRT startup, full windowing/GDI, OpenGL, DirectX, networking, and drivers. Self-modifying code is rejected through executable-memory write checks. Limits include 64 MiB guest memory and 4,096 compiled blocks. Automated suites and direct Runtime consumers default to one million dispatches. Manual browser sessions continue until guest exit or Stop; the worker yields regularly to handle input. Runtime wall time includes browser API waits; it is not a game-performance benchmark.

## Maintainable boundaries

| Module                                 | Responsibility                                         |
| -------------------------------------- | ------------------------------------------------------ |
| `src/package.js`                       | ZIP validation, bounded expansion, virtual paths       |
| `src/pe.js`                            | PE parsing, imports, image mapping                     |
| `src/wasm.js`                          | Small binary Wasm module encoder                       |
| `src/cpu.js`                           | x86 lowering, registers, flags, block cache            |
| `src/simd.js`                          | Bounded XMM operations and vector memory checks        |
| `src/wine-process.js`                  | Native Wine process heap bootstrap and routing         |
| `src/tls.js`                           | Static TLS storage, callbacks and failed-load cleanup  |
| `src/memory.js`                        | Guest memory regions and checked accesses              |
| `src/win32.js`                         | Replaceable bootstrap API provider                     |
| `src/modules.js`                       | DLL graph, export resolution, relocation and linking   |
| `src/wine-nt.js`                       | Validated Wine syscall ABI and NT host services        |
| `src/virtual-memory.js`                | Page reservations, commitment, protection and release  |
| `src/heap.js`                          | Guest allocation, free and coalescing                  |
| `src/win32-process.js`                 | Process, module and UTF-16 host services               |
| `src/win32-gdi.js`                     | Window/memory DCs, bitmaps, brushes and raster drawing |
| `src/win32-audio.js`, `src/wave.js`    | WinMM adapter and bounded PCM decoding                 |
| `src/runtime.js`                       | Process construction, import thunks, dispatch loop     |
| `src/worker.js`                        | Package/run protocol and host requests                 |
| `src/storage.js`                       | OPFS package and output persistence                    |
| `src/main.js`                          | Browser UI, user gestures, dialog/audio bridge         |
| `src/isolation.js`                     | Static-host service worker activation and reload       |
| `src/win32-windows.js`                 | Guest window lifecycle, messages, input and timers     |
| `src/win32-controls.js`                | Standard child control messages and notifications      |
| `src/gdi-raster.js`, `src/gdi-text.js` | Pixel drawing, font matching and bounded glyph cache   |
| `src/desktop.js`                       | Browser window frames and input forwarding             |
| `demos/`, `tests/`                     | Native fixture sources and behavioral checks           |

Keep guest pointers as integer virtual addresses; never confuse them with host or Wasm-library pointers. New API families should get a provider with explicit ownership and unsupported behavior, rather than app-specific branches in the CPU. Tests should exercise observable guest behavior, including failure paths. See [architecture](docs/architecture.md), [reference study](docs/reference-study.md), and [test targets](docs/test-targets.md).

## Validate and develop

```sh
npm test
npm run build
npm run test:controls # DOM control behavior
npm run test:browser  # installed Google Chrome; BROWSER_CHANNEL selects another channel
npm run format:check
node scripts/fetch-targets.mjs
node scripts/test-external-browser.mjs
```

For Playwright's downloaded Chromium instead, install it with `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`. Browser checks exercise the production build, ZIP upload, five native PE fixtures (including EXE/DLL TLS), OPFS output, and worker termination. Their machine-readable report is in `evidence/browser-results.json`; audio validation covers Web Audio scheduling and guest success, not physical speaker capture.

Rebuild native fixtures with `npm run build:demos` (MinGW i686 compiler and Python 3 required). The binaries and ZIPs have reproducible timestamps and SHA-256 manifests. `npm run fetch:targets` downloads the hash-pinned catalog into ignored `.cache/targets/`. `npm run inspect:targets` reads those files and records loader/import blockers without executing them. See [independent target results](docs/targets-progress.md). Rebuild the Wine parser with `npm run build:wine`, the formatter with `npm run build:wine-format` and DLL fixtures with `npm run build:modules`.

## Reuse and next steps

Studied [DirectWebGPU](https://github.com/evangit2/DirectWebGPU) and [Hamsterball](https://github.com/evangit2/Hamsterball). Their execution path translates x86 to Rust/Wasm ahead of time; Hamsterball decrypts a prebuilt payload using a supplied EXE. WineBrowser instead emits Wasm blocks in the browser. It reuses the MIT-licensed iced-x86 decoder and a small Hamsterball audio queue helper, and retains their worker/service separation as an architectural reference. Theseus runtime code and generated game payloads are not included. See [notices](THIRD_PARTY_NOTICES.md).

The first Wine component integration is in [runtime/wine](runtime/wine/README.md), with retained LGPL source and rebuild instructions. An optional test also executes an entire unmodified installed Wine 11 i386 `ntdll.dll`, including its real DLL initialization, CRC32, string/memory comparison and NT-status conversion exports. The matching Chromium probe packages that DLL with unchanged winapiexec and verifies CRC32, NT services, zeroed heap bytes, freeing and private-heap destruction. Set `WINEBROWSER_NTDLL` to the installed DLL path and run `npm run test:wine` or `npm run test:external`. The probe pins one DLL build by SHA-256; that binary is not distributed in this repo. The Wine i386 dispatcher now supplies real NT clock and bounded virtual-memory services. `evidence/wine-ntdll-results.json` verifies page lifecycle/access behavior and native heap allocation/free/destruction; NT handle services remain unsupported. The next milestone is more independent executables and larger Wine modules, driven by the recorded blockers in [the target catalog](tests/targets.json). Broader CPU semantics and PE loading must advance alongside that work. WineD3D/vkd3d-shader, GDI, OpenGL and audio need separate browser backends and acceptance tests; importing their source does not automatically make them portable or compatible.

The interface is a plain test bench: no landing page, visual branding or product presentation. Independent executable evidence is recorded in `evidence/external-browser-results.json`; the target catalog distinguishes source-built samples from downloaded original binaries.

The optional `npm run probe:wine-crt -- /path/to/Wine-i386-windows` loads a hash-pinned, unmodified Wine msvcrt/kernel32/kernelbase/ntdll closure. It currently exits 1 at `NtInitializeNlsFiles`; the exact imports and startup state are recorded in `evidence/wine-crt-results.json`. This identifies the next locale-data dependency, not a passing CRT/application test.
