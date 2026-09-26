# WineBrowser task list

Development resumed on 2026-09-25. The remaining items below are the working
backlog. General Windows application and DirectX compatibility is **not complete**.

The active acceptance goal includes arbitrary EXEs, ZIPs, native third-party
DLLs, browser-time translation, the original Hamsterball, and DirectX through
version 12. Existing D3D12 triangle/cube tests must remain regression gates;
D3D10/11 and broader D3D12 support are still required.

## Current original-Hamsterball gate

- [x] Recover the exact original EXE from the retained Theseus PE sections and
      original import lookup table; verify SHA-256
      `3379e9041c7ab83abd07da1bcf974529280aeff36b3c52e7a3d3bbb93e2da94d`.
      The local input is `.cache/hamsterball-original/Hamsterball.exe`, with assets
      and the native BASS DLL from `../hamsterball-browser/assets`. No translated
      Hamsterball Rust/Wasm is loaded by WineBrowser.
- [x] Native DLL path identity, relative/full DOS paths, same-basename plugins,
      `LoadLibraryExA/W` flags 0/8, module path queries, independent unload and rollback.
- [x] D3D8 COM/presentation/FVF adaptation to the shared D3D9 renderer; original
      native cube EXE/ZIP pass browser translation, animated pixels and clean exit.
- [x] PUSHF/POPF, PUSHAD/POPAD and 16-bit variants; writable PE code invalidation
      and bounded block-cache eviction; committed zero-filled PE page padding.
- [x] Connect the experimental source-built Wine loader to the runtime graph:
      native load/lookup/forwarders/refcounts/pinning/unload now use host transactions.
      Node and Chromium pass 15 loader cases, including same-name DLLs, rejected
      DllMain rollback, three injected metadata allocation failures and retry.
- [x] Give host-backed OS modules real mapped PE headers and executable export
      tables in the normal runtime; mirror mapped modules in Wine's loader indexes
      when the experimental callback bridge is enabled.
- [x] Implement a virtual WinMM PCM-output mixer with ANSI/Unicode discovery,
      real volume/mute sample scaling, and multimedia clock/period queries.
      A native PE fixture verifies exact PCM samples in Node and Chromium.
      Capture, mixer callbacks and multimedia callback timers remain unsupported.
- [x] Supply hash-checked native Wine ACM/UCRT DLLs to the optional application
      diagnostic; BASS resolves their exports and proceeds to OLE32. This proves
      import/startup progress, not ACM conversion or BASS playback.
- [x] Implement single-thread COM initialization and native in-process class
      activation through real DLL factories. A native client/server pair passes
      object calls, failure HRESULTs, reference counts, locks and unload/reload
      in Node and Chromium; no unknown CLSID receives a substitute object.
- [x] Execute `FYL2X` without narrowing ext80 operands. A native fixture passes
      204 independent high-precision vectors in Node and Chromium, including
      directed rounding, subnormals, overflow, status flags and stack behavior.
- [x] Execute `FSIN`, `FCOS` and `FSINCOS` with ext80 rounding and range/stack
      behavior; all 224 independent sine/cosine vector cases pass in a native
      browser fixture. Implement non-destructive `FXAM` classification.
- [x] Distinguish scalar SSE `MOVSD` from the string-copy encoding, implement
      scalar `MOVSD`/`MOVSS` register/memory semantics and exact signed-int32
      `CVTSI2SD`. A native fixture passes in Node and Chromium; memory-fault
      tests verify destination preservation.
- [x] Execute scalar SSE add/subtract/multiply/divide/square root directly in
      SoftFloat binary32/binary64, with int32/float-width conversions, COMI/UCOMI,
      MXCSR rounding/status/DAZ/FTZ and callback context preservation. Native
      fixture passes in Node/Chromium. MOVAPD/MOVUPD reuse checked 128-bit moves.
      Packed float, AVX and guest #XM delivery remain unsupported.
- [x] Execute 16/32-bit `SHLD`/`SHRD` with register/memory destinations,
      immediate/CL counts, zero-count flags and checked stores. Unit tests use
      an independent bit-string oracle and cover aliases and fault atomicity.
- [x] Execute x87 `FISTTP` for int16/int32/int64 with truncation independent of
      control-word rounding, preserved ext80 low bits, pop/C1 behavior and
      checked stores. Narrow integer overflow takes priority over precision.
- [x] Forward all eight User32 character-case APIs to real guest KernelBase/NLS.
      Native fixtures pass ANSI, BMP/surrogate, counted-buffer and sentinel checks
      in Node and Chromium with the optional Wine closure. Add legacy A/W registry
      create/open aliases backed by the same process-local and NT key storage.
- [x] Delegate native Wine process shutdown to the runtime's single detach pass;
      verify reverse TLS/DllMain order, recursion, repeated shutdown and termination.
      Native ExitProcess completes in Node and Chromium without duplicate cleanup.
- [x] Load packaged installable-driver DLLs and call their real DriverProc through
      WinMM. Native fixtures verify instances, messages, registry aliases, hidden
      sessions, failure cleanup and unload in Node and Chromium. Native ACM now
      completes driver discovery and BASS DLL attachment.
- [x] Supply read-only shared-user-data clock and processor fields at their real
      high guest addresses without enlarging linear memory. Native Kernel32
      GetTickCount/GetTickCount64 and direct reads pass in Node and Chromium;
      scalar/SIMD/x87/copy reads, rollover and access restrictions are tested.
- [x] Load predefined system cursors, including IDC_HAND, and render their browser
      equivalents. Native fixture and UI checks verify Set/GetCursor, nested
      ShowCursor counts, class cursors, parent overrides and mouse capture.
- [x] Execute signed int16/int32 x87 FIADD/FIMUL/FISUB/FISUBR/FIDIV/FIDIVR and
      FICOM/FICOMP. Tests cover exact conversion, ext80 low bits, all precision/
      rounding modes, C1, compare/pop behavior and faults; native fixtures pass
      in Node and Chromium.
- [x] Parse and format COM GUIDs, including malformed-field partial output and
      direct guest registry ProgID lookup. Native COM activation uses the resolved
      CLSID in Node and Chromium.
- [x] Find actual guest windows by class name/atom and caption, including direct
      child lookup and activation order. Native EXE and ZIP upload checks pass.
      Nested controls now render with independent client layers and preserve
      focus, geometry, ancestor visibility/enabling and destruction.
- [x] Decode 24-bit icon DIBs with BGR ordering, DWORD row padding and separate
      transparency masks. A native PE resource renders correctly in the upload UI;
      all 1,024 browser canvas pixels match independently expected RGBA values.
- [x] Honor topmost ordering and popup border/caption geometry in the window
      manager and browser desktop. Native UI checks verify lookup order, stacking
      after focus changes and exact client dimensions; DirectX 8/12 regressions pass.
- [x] Read and write native window metadata and per-window extra bytes, including
      A/W access, byte offsets, control IDs and creation/destruction callbacks.
      Original Hamsterball creates its 800×600 window with its native icon.
- [x] Position and resize native windows with mutable WINDOWPOS callbacks,
      default MOVE/SIZE delivery, client pixel preservation, and sibling/topmost
      ordering. EXE/ZIP browser tests verify geometry, child hit ordering and
      activation without overriding the requested sibling placement.
- [x] Initialize DirectInput 8, create keyboard/mouse objects and enumerate their
      capabilities with native A/W callbacks, shared COM identity and lifetime.
      Node and EXE/ZIP browser fixtures pass.
- [x] Read browser keyboard/mouse input through native DirectInput layouts,
      acquisition and immediate/buffered APIs, including custom offsets, relative
      axes, button/wheel events, overflow, focus loss and reacquisition. Native
      EXE/ZIP tests verify actual browser keyboard and mouse actions.
- [x] Preserve published DirectSound ordinal/name export identity and implement
      PCM8/16 mono/stereo buffers with shared duplicates, wrapped locks, timed
      cursors, looping/one-shot playback and volume/pan/frequency controls.
      Ordinary native EXE/ZIP tests verify real Web Audio PCM and Stop/exit cleanup.
      Capture, effects, 3D and notification events remain unfinished.
- [x] Implement shared NT/Win32 event objects, named Local/Global aliases,
      access masks, signaling/reset/pulse, asynchronous single/multiple waits,
      deadlines and handle lifetime. Ordinary EXE/ZIP and real Wine DLL fixtures
      pass in Chromium; native Wine also passes in Node.
- [x] Initialize the TEB activation-context stack and Unicode scratch storage.
      Native Wine module-name conversion and empty activation-context queries
      pass; filename APIs now use their intended native paths.
- [x] Query package file/directory metadata through Win32 A/W and NT path/handle
      APIs. Shared timestamps track guest creation, reads, writes and truncation.
      Ordinary EXE/ZIP and real Wine DLL fixtures pass in Chromium; native Wine
      also passes in Node. Missing leaves and parents return distinct errors.
- [x] Capture/restore CPU context and make compiled FS accesses follow the active
      TEB without recompilation. Alternating contexts execute shared blocks with
      independent stacks, flags, SIMD/x87 state and string-copy directions. Add
      separate TEB/debug initialization that preserves the PEB and main thread.
      See `docs/thread-runtime.md` for scheduler integration and remaining limits.
- [x] Execute guest threads with separate contexts/stacks/TEBs, suspended creation,
      priorities, waits, return/exit codes and cancellation cleanup. Native Wine
      TLS/FLS and DLL lifecycle pass Node/Chromium fixtures; ordinary uploads pass
      EXE/ZIP tests and separate static TLS/DLL callback tests.
- [x] Implement shared D3D8/9 virtual-display queries and D16 depth matching.
      Native EXE/ZIP cubes verify both COM ABIs, invalid queries and real rendering.
- [x] Add virtual fullscreen mode switching/restoration, persistent FLIP/COPY
      buffers, RGB565 GPU conversion and virtual 60 Hz presentation pacing.
      Native EXE/ZIP and canvas/readback pixel tests pass.
- [x] Implement D3D8/9 factory/device capabilities with their exact structure sizes,
      all eight depth comparisons and all three culling modes. Native EXE/ZIP
      cubes query both interfaces; fixed/shader pixel tests pass in canvas/readback.
      Set/GetTransform preserves raw matrix bits; invalid matrices still fail at draw.
- [x] Implement x87 FFREE with logical-stack tag addressing, unchanged TOP/data,
      reusable push slots and pending-exception checks. Tests cover all registers
      and TOP values; the original game passes its matrix routine in Chromium.
- [x] Implement D3D8/9 viewport queries/updates, draw depth ranges and rectangular
      clears clipped to the viewport. Native cubes round-trip the COM structures;
      fixed/shader pixel tests cover every pixel in 18 canvas/readback cases.
- [x] Quantize RGB565 per draw/clear and implement optional 4×4 ordered dithering,
      including shader discard/depth preservation and immutable queued state.
      Thirty-six full-image cases pass on canvas/readback. Native cubes set the
      implemented Gouraud/solid/clipping defaults and query the DITHER cap.
- [ ] Continue Hamsterball through `IDirect3DDevice8.SetTextureStageState` at EXE offset `0x546cf`.
      Chromium passes capabilities, viewport setup and a finite projection after creating
      its 800×600 RGB565/FLIP device, then stops at 8,861,208 guest instructions.
      Node stops at device creation without WebGPU. See `docs/d3d-display.md` and
      `evidence/hamsterball-startup{,-browser}.json`; no game frame renders yet.
- [ ] Continue from the original game entry through D3D8 resources, textures,
      input and audio, reusing the Hamsterball/DirectWebGPU implementation semantics.

## Done and verified

- [x] Public repository and GitHub Pages EXE/ZIP test harness, with CI deployment.
- [x] Study DirectWebGPU and Hamsterball; document reuse choices and runtime architecture.
- [x] Load PE32 x86 images and translate supported machine-code blocks to WebAssembly in a worker.
- [x] Package validation, assets, process-local files, OPFS package/output storage and output downloads.
- [x] Native DLL imports, named/ordinal/forwarded exports, relocations, attach/detach, dynamic loading/unloading and per-thread static TLS (new TLS modules require no additional live threads).
- [x] Bounded guest heap, checked virtual memory, read-only section views and explicit failures for unsupported execution.
- [x] Execute Wine's unchanged command-line parser and formatter as guest DLL components.
- [x] Execute selected exports of an unchanged whole Wine ntdll, including real Wine heap operations.
- [x] Console, synchronous files, modal dialogs, Beep and packaged PCM playback checks using native fixtures and independent executables.
- [x] Virtual desktop with independent windows, input, focus, timers, move/resize/close, standard child buttons, labels and single-line edits.
- [x] Selected GDI drawing: brushes, cosmetic pens, lines, bitmaps, SRCCOPY, fonts/text and bounded glyph caching.
- [x] Process-local ANSI/Unicode registry with shared NT storage, and keyboard accelerator support.
- [x] Play the unchanged MIT-licensed wesmar/Tetris release in Chromium; verify controls, gameplay, dialogs, sustained execution and clean exit.
- [x] Two-window native Breakout example with browser tests for animation, input and window management.
- [x] Pin independent target binaries and retain provenance; document unresolved imports without claiming those applications run.
- [x] Finish the current Wine NLS mapping boundary: supplied real data, read-only sections, unmap, locale queries and missing-data errors. The optional installed-Wine probe passes the former missing NLS calls and records the next failure.
- [x] Fix the Wine i386 debug-buffer/PEB overlap; retain guest state in CRT failure evidence before module rollback.
- [x] Recheck current DirectWebGPU graphics reuse and document the WineD3D integration path, licensing boundaries and separate DX12 requirements in [graphics handoff](docs/graphics-handoff.md).
- [x] Bootstrap the PEB lock, normalized process parameters and a separately owned environment using unchanged Wine exports; verify recursive locks, quoting, environment resize/query/delete and failed-load rollback.
- [x] Support explicit cdecl host imports, BSWAP and SSE2 PEXTRW/PADDW used by Wine startup.
- [x] Share native NT registry keys/values with Advapi32, enforce native parent/handle semantics, and map Wine current-user queries to the same isolated HKCU node.
- [x] Initialize Wine code-page and Unicode-case tables from supplied real NLS files through guest exports; verify CP1252/CP437 conversions and rollback ownership.
- [x] Report guest-sized basic system information and a stable UTC timezone through the NT information-query boundary.
- [x] Build a pinned generic Wine ntdll with an explicit source-level loader bootstrap; verify module indexes, native version initialization, allocation-failure rollback and ownership guards in Node and a Chromium worker. See [the experiment](docs/wine-loader-bridge.md).
- [x] Change committed private VM and non-executable image-data page protections through the native NT boundary; verify read-only enforcement, rollback on invalid requests and Wine export-table updates.
- [x] Initialize Wine-owned dynamic TLS bitmaps and verify 65 guest kernelbase slots, expansion, free and cleared-value reuse; implement `ThreadZeroTlsCell` across all live TEBs.
- [x] Run an original native D3D9 cube EXE and ZIP with browser x86-to-Wasm compilation, guest COM calls, worker WebGPU transforms/D16 depth and clean window/device release. Record backend pixel checks and full browser acceptance separately.
- [x] Run a native PE32 D3D12 shader fixture through real DXGI backbuffers, empty root signatures, pipeline state, command lists, resource barriers, queue submission and completed 64-bit fences; verify both EXE upload and hosted ZIP.
- [x] Run the native D3D12 cube with upload vertex buffers, D16 depth, DSV/RTV descriptors, swapchain buffer indexes, completed fences, browser shader compilation and clean release; test depth/vertex rendering independently on both GPU presentation paths.
- [x] Compile guest SM5 DXBC to SPIR-V with libvkd3d-shader and then WGSL with Naga inside the browser worker; retain complete licensed compiler source/rebuild materials and verify shader pixels, nonzero draw offsets and invalid input rejection.
- [x] Execute native x87 load/store, conversion, stack, arithmetic and comparison/control instructions through Berkeley SoftFloat ext80; the D3D12 cube now computes rotation/projection in its EXE each frame instead of using precomputed geometry.
- [x] Support 16/32-bit D3D12 index buffers and indexed draws with first-index/signed-base-vertex offsets, submission-time snapshots, shared bounds checks and pixel tests on both presentation paths.
- [x] Compile licensed Wine VS 1.1/PS 2.0 token streams in a Chromium worker using the reusable legacy shader-model 1–3 compiler interface; verify WebGPU accepts their WGSL. Connect the compiler to D3D9 shader/declaration COM objects, float constants and programmable triangle lists; verify nonidentity shader constants with exact pixels on both WebGPU presentation paths.
- [x] Initialize the real Wine CRT through the optional loader bridge and execute guest `calloc`, `sprintf`, `strlen`, `_write` and `free` in Node and an isolated Chromium worker. NT file services share the runtime's bounded files and output streams.
- [x] Share a conservative CPUID/Windows processor profile; partial SIMD support does not advertise complete instruction families. RDTSC and NT performance queries use one monotonic virtual 1 GHz clock, with tested 64-bit register splitting.
- [x] Run an original native D3D9 shader cube with browser-compiled VS 1.1 / PS 2.0 shaders, changing constants, x87 geometry and D16 depth; verify EXE upload, hosted ZIP, animation and clean release.
- [x] Load real named/numeric PE icon resources with bounded 4-bit/32-bit DIB decoding, immutable shared handles and virtual titlebar pixels.
- [x] Execute rotate-through-carry and bounded forward/backward SCAS with repeat/termination semantics, preserving unrelated state and checking memory access.
- [x] Add x87 FRNDINT/FABS/FCHS/FTST, pending-exception WAIT, and integer SAHF/LAHF with arithmetic auxiliary-carry tracking.
- [x] Accept legacy non-NX PE images through the optional Wine loader while keeping browser DEP permanent; verify the native query/set boundary and loader/CRT regressions in Node and Chromium.
- [x] Supply a consistent virtual display mode for screen metrics, display enumeration/test/restore, and client-to-screen coordinates.
- [x] Keep code split by runtime service, with tests and an intentionally plain test harness.

## Verified in the September 25 continuation

- [x] Select or drop multiple EXEs, ZIPs and loose files together, or import a complete folder. Preserve subdirectories, expand only top-level ZIP uploads, drain all browser directory-entry batches, and reject path collisions/traversal and aggregate size limits. Read and unpack file bytes in the worker; Stop cancels loading. Cache combined packages with a content-derived identity.
- [x] Execute the original file fixture from mixed EXE/asset-ZIP/loose-file inputs and a folder in Chromium, with exact asset reads, generated downloads and OPFS persistence. Timings in `evidence/browser-results.json` are small-fixture observations, not arbitrary-application or game benchmarks.
- [x] Verify the existing LOCK XADD implementation; add 8/16/32-bit ROL/ROR with count masking, carry/overflow and memory-fault tests. Decode F3 bit scans as BSF/BSR consistently with the guest CPU's absent BMI1/LZCNT features.
- [x] Implement bounded synchronous NT file create/open, sharing, position/size queries, seek, append-only writes and truncation. Host Win32 and Wine share path resolution and sharing checks; parent paths can reach sibling package assets without escaping the package volume.
- [x] Execute real Wine CRT `_open`, `_write`, `_filelength`, `_lseek`, `_read`, `_close` and reopen in Node and Chromium, verifying binary bytes and EOF. This remains an optional supplied-Wine probe, separate from ordinary uploads.
- [x] Accept D3D9 SDK 31 with the existing COM ABI. Prior unchanged Humus probes reached `IDirect3D9.GetDeviceCaps`; that method is now implemented. Fresh startup diagnostics hit their execution deadline earlier in application model preprocessing, with no frames. Retain that startup performance boundary for investigation.

## Remaining, in suggested order

- [ ] **Wine application startup:** finish initialization after the optional [CRT service probe](evidence/wine-loader-crt-browser-results.json). Fresh unchanged Humus EXE diagnostics pass Wine DLL attach but reach the 45-second execution deadline in application model preprocessing before graphics setup. [Node](evidence/wine-target-startup.json) and [browser](evidence/wine-target-startup-browser.json) retain the actual guest location and recent calls. Profile this startup work and then extend the bounded capabilities/resources; zero frames, no independent Humus compatibility claim. The [unchanged-DLL probe](evidence/wine-crt-results.json) retains its separate startup boundary.
- [ ] Finish host/Wine lifecycle integration beyond the passing load/unload, reference-count, attach and rollback callback tests. Native process shutdown now passes. Guest thread lifecycle and static TLS through the full Wine closure remain unfinished; the bridge is still optional.
- [ ] Reproducibly build and package the larger Wine DLL closure with retained sources/notices for browser use; installed-DLL probes alone do not provide plug-and-play distribution.
- [ ] Audit NLS data redistribution notices before bundling system data publicly. Current NLS tests use synthetic bytes or explicitly supplied, hash-verified installed data.
- [ ] Expand CPU coverage beyond the bounded x87 core: transcendental math, environment save/restore, additional SIMD, exception handling and broader thread semantics. x64 is a separate architectural task.
- [ ] Run more unchanged desktop targets, starting with Minesweeper (32 unresolved imports at the last inspection); implement reusable dialog/menu/common-control/GDI services where Wine reuse is feasible.
- [ ] Continue CRT-dependent application targets such as 7zr and PuTTY after Wine startup works. Passing import inspection alone is insufficient.
- [ ] Integrate broader Wine USER32/GDI/Win32u services; complete window styles, menus, custom child windows, controls, input methods and cursor/icon resources.
- [ ] Build tested graphics paths for OpenGL/WGL and DirectX/WineD3D/WebGPU. These APIs do not work generally today. The native D3D9 cube passes a bounded bootstrap frontend. Next establish Wine-derived state/resources and programmable rendering with the pinned Humus Dynamic Branching D3D9 EXE. Programmable shader draws and float constants pass backend pixel checks; the application still needs more Win32 startup, CPU coverage, buffers, textures, stencil and indexed D3D9 draws. See [graphics handoff](docs/graphics-handoff.md).
- [ ] Implement D3D10/11 frontends and expand the bounded D3D12 path: root bindings, textures, resource formats, shaders, compute and DXIL. The passing native DX12 fixture does not establish independent game compatibility or x64 execution. No all-games or instant-startup claim is supported.
- [ ] Expand audio beyond synchronous PCM, and add networking and other OS services with explicit browser constraints.
- [ ] Persist registry and application-file overlays between runs; support reopening saved applications.
- [ ] Add wider compatibility/performance testing against native behavior. No claim that arbitrary EXEs run or can simply be compiled to Wasm.

## Evidence and commands

- [Live harness](https://evangit2.github.io/winebrowser/): Load d3d9-cube, Load d3d9-shader-cube, Load d3d12-cube, Load d3d12-triangle, Load tetris or Load breakout, then Run executable.
- [Tetris browser evidence](evidence/tetris-browser.json), [window evidence](evidence/windows-browser-results.json), [external executable evidence](evidence/external-browser-results.json).
- [Target catalog](tests/targets.json), [static blockers](evidence/target-blockers.json), [architecture](docs/architecture.md), [NLS scope](docs/wine-nls.md).
- `npm test`: runtime, native ABI, resource ownership and failure-path tests.
- `npm run test:browser`, `npm run test:controls`, `npm run test:external`.
- Pages server: `WINEBROWSER_BASE_PATH=/winebrowser/ npm run build`, then `npm run serve:pages`.
- Against that server: `npm run test:pages`, `npm run test:windows`, `npm run test:tetris`, `npm run test:d3d9`, `npm run test:d3d9-shader-cube`, `npm run test:d3d12`, `npm run test:d3d12-cube`.
- `npm run test:webgpu`: isolated backend pixel tests; [native D3D9 browser evidence](evidence/d3d9-browser-results.json) verifies the complete EXE path.
- `npm run test:shaders`: worker shader compiler pixels/validation; [D3D12 browser evidence](evidence/d3d12-browser-results.json) verifies the separate native EXE path.
- `npm run test:d3d12-backend`: compiled shader geometry/depth pixels; [native cube evidence](evidence/d3d12-cube-browser-results.json) covers uploads, animation and clean exit.
- Optional passing CRT-services probe with the rebuilt loader: `npm run probe:wine-loader-crt -- /path/to/i386-windows /path/to/wine/nls --browser`.
- Optional whole-Wine probe (expected to report blocked startup):
  `npm run probe:wine-crt -- /path/to/i386-windows /path/to/wine/nls`.

Commits use the repository-local `evangit2` identity. Future work should retain
unchanged target binaries, fix shared runtime behavior, and record what was
actually executed.
