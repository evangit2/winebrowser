# WineBrowser

An experimental **browser-local Windows PE runtime**. Choose an `.exe` or a ZIP containing executables and assets; the runtime loads the PE image, translates supported x86 basic blocks directly to WebAssembly, and bridges a small Windows API subset to browser services. There is no server compiler and no full PC emulator.

**The test harness runs native fixtures and independent winapiexec and pts-tinype executables across console, files, dialogs, PCM audio and GDI drawing. It does not yet run general desktop applications or games.** Wine's unchanged CommandLineToArgvW implementation now runs as a guest DLL; additional Wine compatibility modules remain the direction for broad API support.

## Run

Requires Node.js 22.12+ or 24+, and modern Chromium.

```sh
npm ci
npm run dev
```

Open the loopback URL Vite prints. Use **Run suite** to check all bundled fixtures, or choose a fixture and run it manually. Enter arguments as a JSON array for uploaded programs. Alternatively, open a demo ZIP or its original EXE from `public/demos/`. The files demo requires its ZIP for the packaged asset. Stop terminates the worker; reopen a package to start again.

The server supplies COOP/COEP headers. For production, `npm run build` creates `dist/`; a static host must serve it over HTTPS with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Deployment is not configured. Package selection never sends file contents to a server. OPFS stores packages and generated outputs locally, subject to browser quota; output files also have download links. Persistent package reopening and saved-file overlays are not implemented yet.

## What works today

- Bounded ZIP extraction, CRC verification, path normalization, executable selection, and PE32 x86 import inspection.
- PE DLL imports/exports, ordinal and forwarded exports, HIGHLOW relocations, DllMain attach/detach, guest callbacks, scalar byte/word/dword x86 instructions, calls/returns, condition flags, and direct Wasm block generation in a terminable worker.
- Bootstrap API provider: standard output, synchronous file reads/writes, unowned `MessageBoxA(MB_OK)`, `Beep`, and process/time helpers, a reusable heap, dynamic module lookup, and UTF-16 services. The Wine parser supplies CommandLineToArgvW as guest code. See `API_NAMES` in `src/win32.js` for the exact list.
- GDI desktop pixel/rectangle operations on a bounded RGBA surface, with brush/DC lifetime checks and canvas presentation. WinMM `PlaySoundA/W` supports synchronous packaged PCM WAV playback; aliases, asynchronous voices and waveOut remain unsupported.
- Real native PE fixtures for console, packaged assets and generated files, a dialog, and a tone. No application source is compiled to Wasm to produce these results.
- Explicit failure for unsupported imports, instructions, and memory accesses. No success stubs for unknown functions.

The CPU emitter implements a subset of x86; iced-x86's much broader **decoding** support is not execution support. Current exclusions include x64, 16-bit address/stack modes, floating point/SIMD, TLS/SEH, threading, broad CRT startup, full windowing/GDI, OpenGL, DirectX, networking, and drivers. Self-modifying code is rejected through executable-memory write checks. Limits include 64 MiB guest memory, 4,096 compiled blocks, and a one-million-dispatch run budget. Runtime wall time includes browser API waits; it is not a game-performance benchmark.

## Maintainable boundaries

| Module                              | Responsibility                                        |
| ----------------------------------- | ----------------------------------------------------- |
| `src/package.js`                    | ZIP validation, bounded expansion, virtual paths      |
| `src/pe.js`                         | PE parsing, imports, image mapping                    |
| `src/wasm.js`                       | Small binary Wasm module encoder                      |
| `src/cpu.js`                        | x86 lowering, registers, flags, block cache           |
| `src/memory.js`                     | Guest memory regions and checked accesses             |
| `src/win32.js`                      | Replaceable bootstrap API provider                    |
| `src/modules.js`                    | DLL graph, export resolution, relocation and linking  |
| `src/wine-nt.js`                    | Validated Wine syscall ABI and NT host services       |
| `src/virtual-memory.js`             | Page reservations, commitment, protection and release |
| `src/heap.js`                       | Guest allocation, free and coalescing                 |
| `src/win32-process.js`              | Process, module and UTF-16 host services              |
| `src/win32-gdi.js`                  | Desktop DC, brush and raster host backend             |
| `src/win32-audio.js`, `src/wave.js` | WinMM adapter and bounded PCM decoding                |
| `src/runtime.js`                    | Process construction, import thunks, dispatch loop    |
| `src/worker.js`                     | Package/run protocol and host requests                |
| `src/storage.js`                    | OPFS package and output persistence                   |
| `src/main.js`                       | Browser UI, user gestures, dialog/audio bridge        |
| `demos/`, `tests/`                  | Native fixture sources and behavioral checks          |

Keep guest pointers as integer virtual addresses; never confuse them with host or Wasm-library pointers. New API families should get a provider with explicit ownership and unsupported behavior, rather than app-specific branches in the CPU. Tests should exercise observable guest behavior, including failure paths. See [architecture](docs/architecture.md), [reference study](docs/reference-study.md), and [test targets](docs/test-targets.md).

## Validate and develop

```sh
npm test
npm run build
npm run test:browser  # installed Google Chrome; BROWSER_CHANNEL selects another channel
npm run format:check
node scripts/fetch-targets.mjs
node scripts/test-external-browser.mjs
```

For Playwright's downloaded Chromium instead, install it with `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`. Browser checks exercise the production build, ZIP upload, all four original PE fixtures, OPFS output, and worker termination. Their machine-readable report is in `evidence/browser-results.json`; audio validation covers Web Audio scheduling and guest success, not physical speaker capture.

Rebuild native fixtures with `npm run build:demos` (MinGW i686 compiler and Python 3 required). The binaries and ZIPs have reproducible timestamps and SHA-256 manifests. `npm run fetch:targets` downloads the hash-pinned catalog into ignored `.cache/targets/`. `npm run inspect:targets` reads those files and records loader/import blockers without executing them. See [independent target results](docs/targets-progress.md). Rebuild the Wine component with `npm run build:wine` and DLL fixtures with `npm run build:modules`.

## Reuse and next steps

Studied [DirectWebGPU](https://github.com/evangit2/DirectWebGPU) and [Hamsterball](https://github.com/evangit2/Hamsterball). Their execution path translates x86 to Rust/Wasm ahead of time; Hamsterball decrypts a prebuilt payload using a supplied EXE. WineBrowser instead emits Wasm blocks in the browser. It reuses the MIT-licensed iced-x86 decoder and a small Hamsterball audio queue helper, and retains their worker/service separation as an architectural reference. Theseus runtime code and generated game payloads are not included. See [notices](THIRD_PARTY_NOTICES.md).

The first Wine component integration is in [runtime/wine](runtime/wine/README.md), with retained LGPL source and rebuild instructions. An optional test also executes an entire unmodified installed Wine 11 i386 `ntdll.dll`, including its real DLL initialization, CRC32, string/memory comparison and NT-status conversion exports. The matching Chromium probe packages that DLL with unchanged winapiexec and verifies its CRC32 return. Set `WINEBROWSER_NTDLL` to the installed DLL path and run `npm run test:wine` or `npm run test:external`. The probe pins one DLL build by SHA-256; that binary is not distributed in this repo. The Wine i386 dispatcher now supplies real NT clock and bounded virtual-memory services. `evidence/wine-ntdll-results.json` verifies page lifecycle/access behavior and records the remaining NT handle and SSE heap blockers. The next milestone is more independent executables and larger Wine modules, driven by the recorded blockers in [the target catalog](tests/targets.json). Broader CPU semantics and PE loading must advance alongside that work. WineD3D/vkd3d-shader, GDI, OpenGL and audio need separate browser backends and acceptance tests; importing their source does not automatically make them portable or compatible.

The interface is a plain test bench: no landing page, visual branding or product presentation. Independent executable evidence is recorded in `evidence/external-browser-results.json`; the target catalog distinguishes source-built samples from downloaded original binaries.
