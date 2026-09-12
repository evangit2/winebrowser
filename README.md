# WineBrowser

An experimental **browser-local Windows PE runtime**. Choose an `.exe` or a ZIP containing executables and assets; the runtime loads the PE image, translates supported x86 basic blocks directly to WebAssembly, and bridges a small Windows API subset to browser services. There is no server compiler and no full PC emulator.

**This first milestone runs four small native Windows test programs. It does not yet run general desktop applications or games, and does not include a Wine runtime.** The name describes the intended direction: reuse Wine compatibility code behind a browser host boundary, rather than grow a complete replacement Win32 implementation.

## Run

Requires Node.js 22.12+ or 24+, and modern Chromium.

```sh
npm ci
npm run dev
```

Open the loopback URL Vite prints. Choose Console, Files + assets, Dialog, or Audio, then **Run executable**. Alternatively, open a demo ZIP or its original EXE from `public/demos/`. The files demo requires its ZIP for the packaged asset. Stop terminates the worker; reopen a package to start again.

The server supplies COOP/COEP headers. For production, `npm run build` creates `dist/`; a static host must serve it over HTTPS with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Deployment is not configured. Package selection never sends file contents to a server. OPFS stores packages and generated outputs locally, subject to browser quota; output files also have download links. Persistent package reopening and saved-file overlays are not implemented yet.

## What works today

- Bounded ZIP extraction, CRC verification, path normalization, executable selection, and PE32 x86 import inspection.
- Preferred-base PE mapping, a limited 32-bit integer x86 instruction set, calls/returns, condition flags, and direct Wasm block generation in a terminable worker.
- Bootstrap API provider: standard output, synchronous file reads/writes, unowned `MessageBoxA(MB_OK)`, `Beep`, and a few process/time helpers. See `API_NAMES` in `src/win32.js` for the exact list.
- Real native PE fixtures for console, packaged assets and generated files, a dialog, and a tone. No application source is compiled to Wasm to produce these results.
- Explicit failure for unsupported imports, instructions, and memory accesses. No success stubs for unknown functions.

The CPU emitter implements a subset of x86; iced-x86's much broader **decoding** support is not execution support. Current exclusions include x64, 8/16-bit operations, floating point/SIMD, DLL loading, relocations away from the preferred base, TLS/SEH, threading, CRT startup, GDI, OpenGL, DirectX, networking, and drivers. Self-modifying code is rejected through executable-memory write checks. Limits include 64 MiB guest memory, 4,096 compiled blocks, and a one-million-dispatch run budget. Runtime wall time includes browser API waits; it is not a game-performance benchmark.

## Maintainable boundaries

| Module             | Responsibility                                     |
| ------------------ | -------------------------------------------------- |
| `src/package.js`   | ZIP validation, bounded expansion, virtual paths   |
| `src/pe.js`        | PE parsing, imports, image mapping                 |
| `src/wasm.js`      | Small binary Wasm module encoder                   |
| `src/cpu.js`       | x86 lowering, registers, flags, block cache        |
| `src/memory.js`    | Guest memory regions and checked accesses          |
| `src/win32.js`     | Replaceable bootstrap API provider                 |
| `src/runtime.js`   | Process construction, import thunks, dispatch loop |
| `src/worker.js`    | Package/run protocol and host requests             |
| `src/storage.js`   | OPFS package and output persistence                |
| `src/main.js`      | Browser UI, user gestures, dialog/audio bridge     |
| `demos/`, `tests/` | Native fixture sources and behavioral checks       |

Keep guest pointers as integer virtual addresses; never confuse them with host or Wasm-library pointers. New API families should get a provider with explicit ownership and unsupported behavior, rather than app-specific branches in the CPU. Tests should exercise observable guest behavior, including failure paths. See [architecture](docs/architecture.md), [reference study](docs/reference-study.md), and [test targets](docs/test-targets.md).

## Validate and develop

```sh
npm test
npm run build
npm run test:browser  # installed Google Chrome; BROWSER_CHANNEL selects another channel
npm run format:check
```

For Playwright's downloaded Chromium instead, install it with `npx playwright install chromium` and set `BROWSER_CHANNEL=chromium`. Browser checks exercise the production build, ZIP upload, all four original PE fixtures, OPFS output, and worker termination. Their machine-readable report is in `evidence/browser-results.json`; audio validation covers Web Audio scheduling and guest success, not physical speaker capture.

Rebuild native fixtures with `npm run build:demos` (MinGW i686 compiler and Python 3 required). The binaries and ZIPs have reproducible timestamps and SHA-256 manifests. `npm run inspect:targets` downloads official 7-Zip/PuTTY candidates to ignored `.cache/targets/` and records import-inspection blockers; it does not execute or redistribute them.

## Reuse and next steps

Studied [DirectWebGPU](https://github.com/evangit2/DirectWebGPU) and [Hamsterball](https://github.com/evangit2/Hamsterball). Their execution path translates x86 to Rust/Wasm ahead of time; Hamsterball decrypts a prebuilt payload using a supplied EXE. WineBrowser instead emits Wasm blocks in the browser. It reuses the MIT-licensed iced-x86 decoder and a small Hamsterball audio queue helper, and retains their worker/service separation as an architectural reference. Theseus runtime code and generated game payloads are not included. See [notices](THIRD_PARTY_NOTICES.md).

The next substantive milestone is a pinned Wine DLL/NT-host feasibility spike: load a simple Wine PE module, enumerate its dependencies, implement the minimum explicit host contract, and run a focused native test through it. Broader CPU semantics and PE loading must advance alongside that work. WineD3D/vkd3d-shader, GDI, OpenGL and audio need separate browser backends and acceptance tests; importing their source does not automatically make them portable or compatible.
