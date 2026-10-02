# WineBrowser task list

Development resumed on 2026-09-25. The remaining items below are the working
backlog. General Windows application and DirectX compatibility is **not complete**.

The active acceptance goal includes arbitrary EXEs, ZIPs, native third-party
DLLs, browser-time translation, the original Hamsterball, and DirectX through
version 12. Existing D3D12 triangle/cube tests must remain regression gates;
D3D10/11 and broader D3D12 support are still required.

## October 2 checkpoint

- [x] Unchanged Humus Water renders reflective landscape and ripple physics;
      ordinary Chromium static ZIP/catalog paths pass 120 frames and exit zero.
      Add actual RGBA16 attachments, precision-preserving float32 sampling,
      shared larger depth/stencil extents with exact outside-region preservation,
      native XLAT and ext80 FPREM/FPREM1. 422 independent remainder cases pass an
      unchanged native PE32 upload across twelve control-word configurations.
      See `docs/rgba16-targets.md` and `docs/x87-remainder.md`.

- [x] Verify Dynamic Branching and RollerCoaster in ordinary headed Chromium
      without unsafe GPU flags, both catalog and ZIP upload. Preserve SoftFloat
      ext80 while reducing scratch allocations and repeated mode setup. The
      vec3 hot-loop benchmark improves 34%; application startup still takes
      roughly 61 and 94–98 seconds. See `docs/startup-performance.md`.

- [x] Unchanged redistributable TransparentShadowMapping renders its stained-glass
      room through six original cubemap passes. Upload/catalog checks pass 48
      animated scene frames and clean exit; a sustained upload passes 7,021
      frames. The source-built shader/compiler/runtime path is selected normally.

- [x] D3D8/9 clears/draws now reach selected standalone, 2D and cube targets,
      preserve shared depth, and update native texture bytes before sampling.
      Native EXE/ZIP checks cover all six faces, exact displayed pixels,
      RGB565 partial/full clears and clean exit. Equal-size attachments only;
      GPU-only sampling, target uploads and broader formats remain open.
- [x] Publication builds check private Hamsterball asset hashes and archive
      contents, including renamed entries. Hamsterball/BASS/MO3 binaries and
      game assets remain outside the public repository and Pages output.

- [x] Unchanged Humus Instancing archive renders animated additive particle
      clouds through its own shader-constant, vertex-buffer and user-pointer
      paths. ZIP upload and catalog checks pass 48 frames, then exit zero.
      Its redistributable readme and source remain in the original archive.
      Unused multistream declarations retain their metadata; consumed nonzero
      streams and hardware stream-frequency instancing remain unsupported.

- [x] Ordinary uploads automatically obtain six source-built Wine DLLs and seven
      NLS tables when they resolve missing imports; supplied DLL imports are
      inspected before startup for later LoadLibrary calls. Bare EXE/native DLL
      ZIP checks run real native CRC code, stdout and unload, then exit zero.
      Hash-corrupted runtime DLLs are rejected. Corresponding source and LGPL
      notices ship with the base package.
- [x] D3D8/9 cube mip storage and programmable cube sampling; six exact face
      pixels pass. Surface LockRect now pops its four COM arguments correctly.
- [x] Eight fixed texture stages with sized independent coordinates and mixed
      cube/volume/2D views unblock the unchanged redistributable Humus
      RollerCoaster scene. ZIP upload and hosted catalog runs pass animated
      textured scene checks and clean exit; the Pages workflow runs both paths.
- [x] Nested D3D8 vertex/index buffer locks preserve the outer allocation and
      remove the original Hamsterball FEFE adjacency crash.
- [x] Capture the original Hamsterball's failing transition draw: valid XYZRHW
      positions and undefined UV fields after SetTexture(0, NULL). Normalize
      non-finite unused UVs without changing guest bytes; sampled UVs still fail.
      The original tournament, difficulty and warm-up race selection now render.
- [x] Align dynamic managed/system-memory buffers with Wine's D3D8/9 buffer path.
      Both native cube EXEs and hosted ZIPs alternate direct, managed and
      system-memory indexed draws; descriptors, locks, animation and exit pass.
- [x] Fresh unchanged original-game ZIP reaches a normal tournament warm-up race.
      ArrowDown/ArrowRight input moves the hamster, follows the camera and changes
      the score. More than 400 subsequent frames remain RUNNING; falling and
      recovery render. Race completion, further levels and audio remain unverified.

## Current original-Hamsterball gate

Latest verification (2026-10-02): ordinary ZIP upload into the built Pages harness
selects the source-built native Wine base automatically for BASS/CRT dependencies.
The unchanged EXE presents its loading screen, reaches “CLICK HERE TO PLAY!” and
responds to a mouse action with its original menu. See
[ordinary upload evidence](evidence/hamsterball-pages-startup-results.json).
A fresh run with the lighting correction now renders the normal tournament warm-up
race. Holding ArrowDown for 60 presented frames moves the hamster from the green
start toward a checkpoint, follows the camera and changes the score from 000000
to 000043. ArrowRight produces a fall, and the game recovers; more than 400
subsequent frames remain RUNNING. See [race evidence](evidence/hamsterball-race-gameplay.json).
No game or runtime patch is injected into this run. Startup and gameplay remain
slow. Race completion, subsequent levels, audio and arbitrary compatibility are
still open. The renderer retains regression coverage for the original rejected
matrix (`world[15]` one Float32 step below 1) and full projective transforms.

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
- [x] Implement bounded D3D8/9 2D texture resources, mip locks, COM binding lifetime,
      format conversion and one fixed-function stage with actual GPU sampling.
      Native EXE/ZIP fixtures check all displayed pixels; 47 canvas/readback
      cases cover filtering, mip LOD, color/alpha operations and revision ordering.
      See `docs/d3d-textures.md`; surface interfaces and shader sampling remain.
- [x] Implement D3D8/9 materials, light lifetimes/queries, material sources,
      optional-normal/color/UV FVF layouts and actual GPU vertex lighting.
      Directional/point/spot diffuse and specular pass 27 full-image cases on
      canvas/readback and native EXE/ZIP uploads. See `docs/d3d-lighting.md`.
- [x] Implement D3D8/9 framebuffer blend factors/operations, write masks and D3D9
      separate alpha/constants, including per-primitive post-blend RGB565 rounding.
      192 full-image cases pass in canvas/readback and native EXE/ZIP tests check
      every pixel. See `docs/d3d-blending.md` for the bounded scope and copy cost.
- [x] Preserve native disabled alpha-test/fog/stencil configuration and queries.
      Enabling these effects still fails explicitly; no rendering support is claimed.
- [x] Load named/numeric custom cursors from native EXEs/DLLs, preserving hotspots,
      shared handles and visibility/class overrides. Browser EXE/DLL and ZIP tests
      verify all pixels for five bitmap depths, blank/multiple-size/scaled images.
      See `docs/custom-cursors.md`. Resource-only DLLs now map with empty relocation
      tables when IMAGE_FILE_RELOCS_STRIPPED is clear.
- [x] Accept NT random/sequential cache hints for resident package files, with
      read/seek/EOF/access tests. The original texture file now opens successfully.
- [x] Implement CMPSB/W/D, REPE/REPNE, comparison flags and fault restart state
      across guest contexts; byte-pair exhaustive tests and native EXE/ZIP pass.
- [x] Implement byte/word implicit-register MUL/IMUL/DIV/IDIV, preserving upper
      registers and state on divide faults. Native EXE/ZIP and unit vectors pass.
- [x] Implement D3D8/9 GetDirect3D with parent COM ownership, including pending
      GPU creation, rollback and independent returned references. Native cubes pass.
- [x] Implement D3D8/9 device GetDisplayMode with the adapter's active display,
      complete output validation and the D3D9 implicit-swapchain index. Native
      cubes and fullscreen presentation tests pass; 552 unit tests pass.
- [x] Implement texture surface-level ownership and access. A texture level now
      exposes an `IDirect3DSurface8/9` that shares the level's storage, so
      surface `LockRect`/`UnlockRect` mutate the same bytes as texture
      `LockRect`; `GetDesc`, `GetContainer`, reference ownership and release are
      verified by unit tests. Also generalize module identity so a partial
      builtin guest DLL (the source-built shell32) delegates unimplemented
      exports to a host thunk instead of shadowing them, and map image modules
      after import resolution so newly discovered providers are covered.
      Original Hamsterball now passes GetSurfaceLevel and CopyRects
      (caller `0x476ecb`, 10,407,907 guest instructions), plus LODSB/LODSD in
      bass.dll and `LOCK CMPXCHG8B` in the Wine ntdll. It completes D3D8
      device creation (adapter modes, depth/stencil matching, CreateDevice),
      DirectInput acquisition, DirectSound creation, texture creation,
      surface copies and render-state setup, then reaches its window/timer
      loop with three live guest threads. No game frame renders yet.
      Two general throughput defects were found and fixed along the way: the
      dispatch loop yielded with a timer `setTimeout(0)` that browsers clamp
      to several milliseconds, and the translated-block cache evicted in
      insertion order so a working set beyond its 4096-entry cap recompiled
      its own hot blocks (measured 29555 compilations for 4096 entries).
      The guest address space was raised from 64 MiB to 256 MiB and the
      virtual-memory arena from 14 MiB to ~208 MiB, keeping the fixed
      TEB/PEB/heap/stack layout. This removed a real capacity failure: the
      unpacker exhausted the arena and NtAllocateVirtualMemory returned
      STATUS_NO_MEMORY (0xc0000017), which then produced a guest write fault
      at 0x0. With the larger arena Hamsterball now runs 767M guest
      instructions inside a five-minute budget with no allocator failure,
      and execution has moved out of the packed BASS DLL into the game's own
      image. See `evidence/hamsterball-startup-browser.json`.

- Performance work continued: clock (second-chance) block eviction, an
  index-validated region cache in the guest memory check (82 ns to 9.5 ns
  per access on a 31-region process), a dispatch path that skips the thunk
  lookup off the host address range and resolves each block once, and a
  writable-code rule that ends a block on a memory write rather than any
  memory operand. Together these raise the same 60-second startup from
  16.9M instructions to 155.9M (~9x). The main thread is still inside the
  packed BASS DLL's self-decrypting protector rather than game code, but
  it is making forward progress, not spinning: the dominant hot block
  differs between 15s (offset 0x590e3) and 60s (offset 0x1586c), earlier
  loops complete, and the distinct-block count keeps rising. No accepted
  game frame renders yet, so the original EXE remains an open target. See
  `evidence/hamsterball-startup-browser.json`.

- 2026-09-29: dropping the original game folder into the **interactive**
  harness (not the instrumented probe) runs 113-118M guest instructions in
  ~25s, opens its 800x600 window, creates the D3D8 device, loads its textures
  through LockRect/CopyRects and reaches its message loop, then stops with an
  unhandled read violation at `bass.dll+0x234e` reading one byte from
  `0x6dcaa38a`. The report for that stop now carries the faulting encoding, the
  register file and its operand windows snapshotted at fault time, the guest
  exception chain and the recent execution path, plus the last OS calls and all
  135 APIs the program reached (its protector drives
  `GlobalAlloc`/`GlobalFree`/`VirtualProtect`/`LoadLibraryA`/`GetProcAddress`
  and the heap family). The disassembly is a clean table lookup whose
  destination table still holds non-pointer cipher values, so the open question
  is whether the protector's own bulk decrypt or one of those emulated calls is
  wrong. Bulk `memcpy`/`memmove`/`memset` now apply the code-write rule (they
  write through the linear buffer and previously left stale translations); that
  fix does not clear this stop.
- [x] Compile original Microsoft HelloTriangle HLSL in a browser worker, verify
      rendered pixels, and expose D3DCompile/FromFile to native EXE/ZIP programs.
      See `docs/hlsl-compilation.md`; full upstream C++ execution remains open.
- [x] Integrate host-owned static TLS with the source-built Wine loader: native
      EXE/DLL templates, callback order, thread isolation and FLS cleanup pass
      in Node/Chromium. Real Microsoft HelloTriangle reaches its EXE entry and
      initially stopped at UCRT `__acrt_iob_func`.
- [x] Resolve fifteen UCRT API-set contracts to the actual guest ucrtbase DLL;
      native memory/string/stdio/module-identity checks pass in Node/Chromium.
- [x] Duplicate same-process thread/event handles with shared signal state,
      independent rights/lifetimes and current-thread conversion. Native tests
      join a worker through its alias and wait for the main thread after exit.
- [x] Implement counted native/Win32 semaphores, named and duplicated aliases,
      mixed waits and guest-thread release accounting. Microsoft HelloTriangle
      now passes both semaphore creations and reaches CommandLineToArgvW.
      See `docs/semaphores.md` for independent native EXE/ZIP validation.
- [x] Compile, load and render an independently maintained real D3D12 demo
      through the browser target path. The unchanged Microsoft HelloTriangle
      EXE (pinned revision `be8195fc324c97c6550b710ace15e18b560c07c8`, SHA-256
      `3551b94ac891f44d7194a05d4caf9ae5f6f71f738340a012204449333ac2f899`)
      now creates an IDXGIFactory4, enumerates the virtual adapter, passes the
      NULL-output D3D12CreateDevice capability probe, creates a device, queue,
      flip-model swap chain and window association, compiles its SM5 HLSL via
      D3DCompileFromFile, builds the pipeline state, records and executes
      command lists with resource barriers and clears, presents, and runs its
      fence wait loop. The browser probe captures 22,000+ presented frames with
      the sampled clear color `(0,51,102)` and rendered triangle pixels; see
      `evidence/microsoft-d3d12-startup-browser.json`. This remains one
      independent sample, not general D3D12 game compatibility.
- [ ] Continue from the original game entry through D3D8 resources, textures,
      input and audio, reusing the Hamsterball/DirectWebGPU implementation semantics.

- [x] Run the free MIT LearningDirectX12 animated 3D cube from unchanged upstream
      C++ and original release shaders. The source-built PE32 counterpart passes
      ZIP upload, EXE plus shader upload, and the hosted catalog; browser CPU/shader
      compilation, D32 depth, copy queues, pipeline streams, FPS logging and clean
      exit are covered by `npm run test:learning-dx12`. The upstream release is x64.
      See [acceptance and rebuild details](docs/learning-dx12-cube.md).

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
- [x] Implement unnamed read-only file sections and Win32/NT map/query/unmap APIs,
      independent handle/view lifetimes, aligned bounded views, alias updates,
      and backing-file truncation guards. Native and ordinary upload fixtures
      verify actual bytes and error paths. See `docs/file-sections.md`.
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
- [x] Render real frames from the original Hamsterball. The unchanged EXE
      now presents six frames with non-uniform pixels, 30 fixed-function
      draws and 5 presents.
- [ ] Hamsterball then faults reading reserved-but-uncommitted virtual memory.
      The allocator op log replays exactly to the observed state: the EXE
      reserves `0x4fd0000..0x5fa0000`, commits `0x5030000..0x5070000`,
      decommits `0x5040000..0x5070000`, re-commits only `0x5040000..0x5050000`,
      and then executes a 16-bit table load at
      `ecx + eax*4 = 0x503cd58 + 0xfefe*4 = 0x507c950` inside the pages it
      just decommitted.
      The faulting index is not a real index: the structure at `0x503ba70`
      is filled with the repeating dword `0xfffefefe`. A guest write
      watchpoint shows a memory-copy block starting at `hamsterball.exe`
      offset `0xad731` copying that poison into the structure from
      `[eax+0xdch]`. Native Wine 11.0 runs the same unchanged EXE for 90
      seconds with no access violation (it proceeds through wined3d), so
      this is an emulation divergence rather than an application fault.
      Next: watch the source buffer `[eax+0xdch]` to find where `0xfffefefe`
      is first produced, and compare that producing path (likely a buffer
      fill or lock) against native behaviour.
- [x] Resolve the whole host-API closure the unchanged EXE imports. It now
      reports 177 supported imports and the interactive harness enables Run.
      The work added the process/TLS/resource/console surface, the virtual
      filesystem's directory enumeration, Winsock 2 with Wine's ordinal table,
      D3D8/D3D9 fog, alpha test, stencil, block-compressed and L8 textures, the
      MSVCRT export surface with per-name calling conventions, and the CRT
      startup, sorting, floating-point and math entry points. Two ABI defects
      found this way were real: dynamic TLS wrote through the static image TLS
      vector, and double-valued CRT functions returned in eax:edx instead of
      ST(0). The unchanged EXE now runs its own CRT, creates its window, loads
      its cursors and icon, registers its class, creates DirectInput and
      DirectSound, opens its data files, spawns a worker thread, runs its timing
      loop (WaitForSingleObject and QueryPerformanceCounter) and reaches
      `bass.dll`'s packing loop.
- [ ] Hamsterball still stops with an unmapped read inside `bass.dll` at
      offset `0x234b` (guest `0x105234b`). The fault is unchanged after the
      DXGI/D3D12 breadth work: 118M guest instructions, the 800x600 window, the
      D3D8 device and its DXT textures, then the protector's table lookup.
      The code at `bass.dll+0x22ee` is _encrypted on disk_ (it differs from the
      file at every byte) and only the protector's own decrypt produces what
      runs, so the fault cannot be diagnosed from a static disassembly. The
      Node probe cannot reproduce it — `IDirect3D8.CreateDevice` fails first
      because Node has no WebGPU — so the reproduction has to stay in Chromium. The protector installs a real
      exception registration chain (three frames at `fs:[0]`, handlers in the
      EXE), and the instruction that faults is a table lookup whose index comes
      from the decrypted pointer the protector built, so the failure is an
      emulation divergence rather than an application fault. WineBrowser has no
      structured-exception delivery: a guest fault stops the run instead of
      being offered to the chain at `fs:[0]`. Next: implement SEH delivery with
      the documented EXCEPTION_RECORD/CONTEXT and handler calling convention,
      then compare the protector's decryption against native Wine.
- [ ] Finish host/Wine lifecycle integration beyond the passing load/unload, reference-count, attach and rollback callback tests. Native process shutdown now passes. Guest thread lifecycle and static TLS through the full Wine closure remain unfinished; the bridge is still optional.
- [ ] Reproducibly build and package the larger Wine DLL closure with retained sources/notices for browser use; installed-DLL probes alone do not provide plug-and-play distribution.
- [ ] Audit NLS data redistribution notices before bundling system data publicly. Current NLS tests use synthetic bytes or explicitly supplied, hash-verified installed data.
- [ ] Expand CPU coverage beyond the bounded x87 core: transcendental math, environment save/restore, additional SIMD, exception handling and broader thread semantics. x64 is a separate architectural task.
- [x] Run an unchanged classic desktop target: the pinned wesmar/minesweeper
      release now resolves every import, opens its `Minesweeper` window, runs
      its message loop and paints a 75-colour dialog face. Driving it to
      zero unresolved imports required real window-class extra data and class
      menus, standard MENU resource parsing, Wine's LoadString arithmetic, the
      full GetSystemMetrics table, menu-aware AdjustWindowRect and a CreateFont
      that accepts the charset/quality/pitch hints applications pass. Interactive
      play (menu commands, cell clicks) is not yet verified, so this is a
      window-and-paint result rather than a compatibility claim.
      See [the browser report](evidence/minesweeper-browser-results.json).
- [x] Resolve every import of the pinned PuTTY 0.85 release (144 -> 0) through
      the ordinary browser harness. Closing that list added the whole GDI
      surface PuTTY needed (CreateFontIndirect, CreateBitmap, ExtTextOut,
      the character-width queries, GetDIBits, the palette family,
      GetOutlineTextMetrics, GetCharacterPlacement, Rectangle, Polyline and
      the rectangular clip services), the caret/scroll-bar/placement/input-
      state services, dialog message handling (IsDialogMessage, DefDlgProc,
      MapDialogRect, SendDlgItemMessage), SystemParametersInfo with the real
      NONCLIENTMETRICS layouts, the registry enumeration and advapi32
      SID/security helpers, the imm32 IME context, the comdlg32 common
      dialogs, DrawIconEx/LoadImage, ToAsciiEx, serial-port and named-pipe
      answers, and the remaining console/time/text services. PuTTY is a
      socket client, so its remaining prerequisites are networking and its
      connection UI, not unresolved imports; execution is not yet verified.
- [x] Drive the unchanged PuTTY 0.85 executable into its own startup error
      handling. With every import resolved it reached a real, application-level
      message ("Unable to load any WinSock library") and 47k guest instructions
      before stopping. Reaching that point exposed four general defects, each
      of which would affect any application: - GetStartupInfoW wrote 104 bytes into the 68-byte STARTUPINFOW every
      i386 build uses, overflowing the caller's frame by 36 bytes and
      corrupting its saved return address. STARTUPINFOA and STARTUPINFOW are
      the same size on i386 because every member is a DWORD or a pointer. - OPENFILENAMEA (88), MSGBOXPARAMSA (40) and NONCLIENTMETRICSA/W (344/504)
      were likewise wrong; all sizes are now taken from the MinGW-w64 headers
      with the compiler reporting sizeof. - LoadLibraryEx rejected LOAD_LIBRARY_SEARCH_SYSTEM32 (0x800), which the
      UCRT passes on every loader call, and resolveApiSet did not map the core
      api-ms-win-core-* contracts, so a LoadLibrary of
      api-ms-win-core-synch-l1-2-0 failed and the following GetProcAddress
      returned a null the caller invoked. - A full system path (C:\Windows\System32\ws2_32.dll) did not resolve
      to the runtime provider for its basename, which is how PuTTY loads
      every optional WinSock, common-control and shell DLL.
      Remaining PuTTY work is networking and its connection UI, not the runtime.
- [ ] **Direct3D 10 and 11 frontends.** The Humus Inferno target imports only
      `d3d10.dll` now that every other import resolves, so this is the one
      remaining gap for it. The groundwork is in place and verified:
      `D3D12Renderer.planImplicitBindings` derives the canonical (group,
      binding) layout for a shader pair without a root signature, and
      `createPipeline` accepts an `implicitBindings` flag, which is exactly the
      D3D10 binding model (no signature; cb#/t#/s# bound directly). The
      identified work is a `src/d3d10.js` frontend that: - implements `D3D10CreateDevice`/`D3D10CreateDeviceAndSwapChain` and the
      98-slot `ID3D10Device` vtable (the exact i686 order is in d3d10.h and
      was read for this note); - models the view objects (`ID3D10Buffer`, `ID3D10Texture2D`,
      `ID3D10ShaderResourceView`, `ID3D10RenderTargetView`,
      `ID3D10DepthStencilView`, the four state objects) at the sizes the
      compiler reports: buffer desc 20, texture2d desc 44, subresource data 12,
      SRV desc 24, RTV/DSV desc 20, sampler 52, blend 68, rasterizer 40,
      depth-stencil 52, input element 28, mapped texture2d 8; - compiles its HLSL through the existing `D3D10CompileShader`
      (which the shared `d3dcompiler.js` already answers) and feeds the DXBC
      to the shared renderer.
      `vs_4_0`/`ps_4_0` now compile through the same vkd3d-shader path as SM5.
      No D3D10 code is in the tree yet: a frontend with no fixture to run it
      against would be unverifiable, so it is the next task rather than a
      committed stub.
- [ ] Broaden common-control coverage beyond the classes the browser desktop
      renders (list view, tree view, tab, status bar, trackbar, up-down,
      progress and animation controls), and add the OpenGL/WGL path the SGI
      sample needs (it imports opengl32 and the pixel-format calls).
- [x] Run a CRT-dependent console application end to end. The unchanged upstream **7zr** 26.03 archiver completes a full `add` in the ordinary harness: its CRT starts, it scans, creates `out.7z`, compresses the input, prints "Everything is Ok" and exits 0, and the output is a real 7z stream (`37 7a bc af 27 1c 00 04`). `npm run test:7zr` is the gate. PuTTY remains a separate blocked target with GUI/GDI/WGL needs.
- [ ] Integrate broader Wine USER32/GDI/Win32u services; complete window styles, menus, custom child windows, controls, input methods and cursor/icon resources.
- [x] Model private executable memory. `VirtualAlloc`/`VirtualProtect` now honour
      the full `PAGE_EXECUTE*` set for committed private pages instead of
      flattening it to read-write, and a protection change refreshes the
      decoder's ranges and drops the translated blocks overlapping the changed
      pages. Executable code a guest maps and writes — a packer's decrypted
      section, a JIT buffer, a loader's stub — therefore runs. Executable
      protections on PE image data pages stay refused (that needs the loader's
      section bookkeeping). `npm run test:exec-memory` runs a native PE32
      fixture that maps `PAGE_EXECUTE_READWRITE` private memory, emits a real
      x86 routine, drops to `PAGE_EXECUTE_READ`, calls it, rewrites the bytes
      and calls the new version on both the EXE and ZIP upload paths. 684 unit
      tests pass.
- [ ] Build tested graphics paths for OpenGL/WGL and DirectX/WineD3D/WebGPU. These APIs do not work generally today. The native D3D9 cube passes a bounded bootstrap frontend. The unchanged third-party Humus Dynamic Branching D3D9 demo now runs its own scene through the ordinary host-API path and is checked on both the published-example and dropped-ZIP routes by `npm run test:humus-d3d9`; it uses vertex and index buffers, DXT textures, its own VS 1.1/PS 2.0 shaders, sampler states and indexed draws. It still opens no menu or camera input, and broad API coverage (OpenGL, D3D10/11, more D3D9 state) remains. See [graphics handoff](docs/graphics-handoff.md).
- [x] Broaden the D3D12 path from the empty-root-signature bootstrap to the
      ordinary descriptor flow. A root signature is now inspected, not merely
      accepted, and its parameters, descriptor ranges and static samplers drive
      a canonical WebGPU layout: constant buffers in group 0, SRVs/UAVs in
      group 1, samplers in group 2, with the draw-parameter group left free.
      Shaders are scanned for the registers they declare and compiled against
      that layout, so a program's own signature reaches its pipeline unchanged.
      The command list records descriptor tables, root descriptors and inline
      32-bit constants; sampled 2D textures are committed resources uploaded
      through `GetCopyableFootprints` and `CopyTextureRegion` and bound from an
      SRV descriptor table. Draw counts and index counts are no longer capped at
      65,535 (they are UINTs in both D3D12 and WebGPU; the upload snapshot
      bounds a draw). Three new targets verify the breadth on the EXE-upload and
      hosted-ZIP browser paths: `d3d12-constants` (32-bit-constants root
      parameter), `d3d12-constbuffer` (CBV descriptor table) and
      `d3d12-texture` (upload + SRV table + static sampler), plus
      `d3d12-terrain` (a generated 32,768-triangle indexed mesh with 32-bit
      indices and a three-attribute input layout), `d3d12-blend` (three pipeline
      blend states verified against the arithmetic each factor pair computes),
      `d3d12-rootcbv` (a root CBV bound by GPU virtual address, no heap) and
      `d3d12-rendertexture` (an offscreen render-target texture transitioned and
      sampled back). Pipeline blend factors/operations, all eight depth
      comparisons and a disabled depth test are mapped from D3D12 to WebGPU.
      D3D10/11 frontends, compute, DXIL, bindless arrays, multisampling and
      resource formats beyond those modelled remain unfinished; no all-games
      claim is supported.
- [x] Deliver guest access faults to the structured-exception chain. A guest
      memory fault raises `GuestFault`; a translated block records the guest
      address of the instruction it is executing immediately before any checked
      access; and the dispatcher offers the fault to the registration chain at
      `fs:[0]`. The handler return value is `EXCEPTION_DISPOSITION`, the record
      and `I386_CONTEXT` follow the documented offsets, and `RtlUnwind` walks
      the chain with `EXCEPTION_UNWINDING` set. A fault with no chain, or one
      every handler declines, still stops the run. Verified by a native PE32
      fixture whose own filter observes the access-violation record and resumes
      past the fault, in Node and Chromium; see
      [structured exceptions](docs/structured-exceptions.md).
- [x] Widen the DXGI swap chain and the D3D12 object graph, and fix nine
      i386 stack-correction bugs found while doing it. The COM frontend declared
      `argc` values that disagreed with the real vtable signatures, so a call
      left the guest stack misaligned; the shared metadata block
      (`SetPrivateData`/`SetPrivateDataInterface`) was worst because every
      object calls it. `CheckFeatureSupport`, `ClearState`, `SetPredication`,
      `SetMarker`, `BeginEvent`, `WriteToSubresource`, `ReadToSubresource` and
      `CreatePlacedResource` were wrong the same way. A script derives each
      expected count from the MinGW-w64 headers and a regression test pins the
      corrected values (169 declared counts now match the ABI).
      The swap chain then gained ResizeBuffers/ResizeBuffers1, the descriptor
      and frame-statistics queries, Present1, background colour, rotation,
      source size, frame latency and matrix transform, GetFrameLatencyWaitableObject
      (a real auto-reset event), SetColorSpace1 and the IDXGIObject parent
      chain; the device gained CreateHeap, CreatePlacedResource with overlap
      accounting, CreateCommandSignature and ID3D12PipelineState.GetCachedBlob;
      the command list gained the compute root setters, Dispatch,
      ResolveSubresource, the UAV clears and explicit refusals for
      CopyTiles/ExecuteIndirect/tile mappings, and the queue gained a blocking
      Wait. A 2- or 3-buffer BGRA8 or RGBA8 flip-discard chain now presents
      correctly, including the readback channel swizzle.
- [x] Add an in-depth Direct3D 12 fixture beyond cube/triangle/parade/terrain:
      an animated trefoil torus knot (3,072 vertices, 18,432 indices) built with
      `CreateHeap` + `CreatePlacedResource` on a three-buffer BGRA8 flip-discard
      chain, exercising `GetDesc1`/`GetFrameStatistics`. `npm run test:d3d12-knot`
      runs it in Chromium from both EXE upload and hosted ZIP, checking lit
      geometry, shading variety and animation before a clean exit.
- [ ] Direct3D 10 and 11 frontends remain absent; no D3D10/11 application has a
      compatibility claim. (D3D9, D3D8 and D3D12 have native fixtures.)
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

- [x] **Direct3D 10 frontend.** `src/d3d10.js` implements `D3D10CreateDevice`,
      `D3D10CreateDeviceAndSwapChain`, `D3D10CompileShader`,
      `D3D10GetInputSignatureBlob`, `D3D10ReflectShader`, the three profile
      getters and `D3D10CreateBlob`, plus the 98-slot `ID3D10Device` vtable and
      every object it creates (buffers, textures, the three view kinds, the four
      state objects, shaders, input layouts, queries and the DXGI swap chain).
      Every vtable arity was derived by compiling a call against the MinGW-w64
      headers, so a mismatch with the guest's stack correction is a build error
      rather than silent corruption (`.cache/d3d10-argc.py`).
      D3D10 has no root signature and no command list, which is the whole point
      of the frontend: each stage owns its own register file, so
      `VSSetConstantBuffers(0, ...)` and `PSSetConstantBuffers(0, ...)` name two
      different resources that must stay distinct bindings.
      `src/d3d10-bindings.js` plans the two stages separately and merges them
      into one WebGPU layout; `D3D12Renderer.planD3D10Bindings` builds it, and
      `createPipeline` takes the placements it computed. Every draw executes
      immediately, in issue order, as D3D10's immediate device does.
      `src/d3d10-reflection.js` parses the DXBC RDEF/RD11 and ISGN/OSGN chunks
      (layouts from vkd3d-shader's own reflection), so `D3D10ReflectShader`
      reports the shader the application really compiled.
      The new `d3d10-cube` fixture is an in-depth lit cube: a per-pixel
      lighting pass with a view-dependent highlight, a procedural checker on the
      object-space position, three interleaved input elements, two separate
      dynamic constant buffers at each stage's `b0`, and a 16-bit index buffer.
      `npm run test:d3d10` drives the unchanged PE32 through both the EXE upload
      and the hosted ZIP and requires a lit, shaded, animating frame and a clean
      exit; `npm run test:d3d10-backend` compiles the real SM4 DXBC through the
      shared bridge.

## Vulkan upload milestone (2026-10-02)

- [x] Pin and build the free Apache-2.0 Khronos Vulkan-Tools cube for Windows
      x86, preserving its original scene, embedded texture and SPIR-V shaders.
- [x] Implement a reusable bounded Vulkan 1.0/Win32 frontend with shader
      compilation, memory, descriptors, pipelines, commands, swapchain
      presentation and native teardown through the worker WebGPU device.
- [x] Verify ordinary EXE and ZIP uploads, hosted catalog loading and the
      upstream staging-buffer path, with actual textured/animated cube pixels
      and native exit zero. Repeat through explicit readback presentation.
- [x] Add the demo source/license downloads and executable regression to the
      GitHub Pages build workflow.

Scope and reproduction: [Vulkan runtime](docs/vulkan-runtime.md).
Evidence: [native uploads](evidence/vulkan-browser-results.json) and
[readback presentation](evidence/vulkan-readback-results.json).
This does not establish x64 or arbitrary Vulkan-program compatibility.

- Added shared services for the imports reported by the ATI Treasure Chest installer. The authored native installer-service client passes in the browser; see [installer scope](docs/installer-runtime.md). Keep exact ATI installer installation/rendering acceptance open.
- Humus Dynamic Branching and RollerCoaster both rendered on the live Pages site in ordinary headed Chromium 153, with no unsafe WebGPU flags. Startup is still approximately 90–120 seconds. First x87 dispatch optimization removes repeated initialization awaits; few-second startup is not achieved.

## Microsoft DX12 city checkpoint (October 2)

The unchanged MIT D3D12Bundles scene now runs as a native x86 build: 30 BC1-textured
city meshes, 186,420 triangles/frame, two pixel shaders, D32 depth and three
reusable bundles. Ordinary Chrome verifies ZIP upload, EXE/assets upload and the
hosted example, camera movement/turn/reset and exit 0. The full 138-import EXE
closure and five native DLLs' 1,509 transitive import providers are audited.
See `docs/microsoft-dx12-city.md` and `npm run test:dx12-city`.

The runtime fixes include bundle state inheritance/replay, BC block footprints,
shared geometry snapshots, 64-bit root-handle x86 stack arities, APPEND descriptor
offsets, sampler tables/filter bits and unused shader input elements. Native
standalone source build reproduces the packaged EXE. General x64/compute/DXIL
programs and arbitrary library exports remain unverified.
