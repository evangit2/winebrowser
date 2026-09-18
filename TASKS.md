# WineBrowser task list

Development resumed on 2026-09-18. The remaining items below are the working
backlog. General Windows application and DirectX compatibility is **not complete**.

## Done and verified

- [x] Public repository and GitHub Pages EXE/ZIP test harness, with CI deployment.
- [x] Study DirectWebGPU and Hamsterball; document reuse choices and runtime architecture.
- [x] Load PE32 x86 images and translate supported machine-code blocks to WebAssembly in a worker.
- [x] Package validation, assets, process-local files, OPFS package/output storage and output downloads.
- [x] Native DLL imports, named/ordinal/forwarded exports, relocations, attach/detach, dynamic loading/unloading and one-thread static TLS.
- [x] Bounded guest heap, checked virtual memory, read-only section views and explicit failures for unsupported execution.
- [x] Execute Wine's unchanged command-line parser and formatter as guest DLL components.
- [x] Execute selected exports of an unchanged whole Wine ntdll, including real Wine heap operations.
- [x] Console, synchronous files, modal dialogs, Beep and packaged PCM playback checks using native fixtures and independent executables.
- [x] Virtual desktop with independent windows, input, focus, timers, move/resize/close, standard child buttons, labels and single-line edits.
- [x] Selected GDI drawing: brushes, cosmetic pens, lines, bitmaps, SRCCOPY, fonts/text and bounded glyph caching.
- [x] Process-local Unicode registry and keyboard accelerator support.
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
- [x] Initialize Wine-owned dynamic TLS bitmaps and verify 65 guest kernelbase slots, expansion, free and cleared-value reuse; implement one-thread `ThreadZeroTlsCell`.
- [x] Keep code split by runtime service, with tests and an intentionally plain test harness.

## Remaining, in suggested order

- [ ] **Wine startup:** finish the NT registry, locale and loader services reached by the real CRT closure. The optional [source-built loader probe](evidence/wine-loader-crt-results.json) passes version, dynamic TLS and C-locale setup, then reaches a CPU-feature query. The [unchanged-DLL probe](evidence/wine-crt-results.json) retains its separate startup boundary; neither is an application test.
- [ ] Unify host and Wine loader transactions for module load/unload, reference counts, attach order and static TLS. The optional one-shot loader bridge only registers an existing graph and supports read-only queries.
- [ ] Reproducibly build and package the larger Wine DLL closure with retained sources/notices for browser use; installed-DLL probes alone do not provide plug-and-play distribution.
- [ ] Audit NLS data redistribution notices before bundling system data publicly. Current NLS tests use synthetic bytes or explicitly supplied, hash-verified installed data.
- [ ] Expand CPU coverage for floating point, additional SIMD, exception handling and guest threads. x64 is a separate architectural task.
- [ ] Run more unchanged desktop targets, starting with Minesweeper (32 unresolved imports at the last inspection); implement reusable dialog/menu/common-control/GDI services where Wine reuse is feasible.
- [ ] Continue CRT-dependent application targets such as 7zr and PuTTY after Wine startup works. Passing import inspection alone is insufficient.
- [ ] Integrate broader Wine USER32/GDI/Win32u services; complete window styles, menus, custom child windows, controls, input methods and cursor/icon resources.
- [ ] Build tested graphics paths for OpenGL/WGL and DirectX/WineD3D/WebGPU. These APIs do not work generally today. First establish a Wine-derived D3D9 device/Clear/Present path with an independent unchanged EXE; then resources, shaders and draws. See [graphics handoff](docs/graphics-handoff.md).
- [ ] Treat D3D10/11 and DX12/DXGI/vkd3d as additional compatibility milestones. DX12 command lists, descriptors, barriers and x64 game execution are not delivered by a D3D9 renderer. No all-games or instant-startup claim is supported.
- [ ] Expand audio beyond synchronous PCM, and add networking and other OS services with explicit browser constraints.
- [ ] Persist registry and application-file overlays between runs; support reopening saved applications.
- [ ] Add wider compatibility/performance testing against native behavior. No claim that arbitrary EXEs run or can simply be compiled to Wasm.

## Evidence and commands

- [Live harness](https://evangit2.github.io/winebrowser/): Load tetris or Load breakout, then Run executable.
- [Tetris browser evidence](evidence/tetris-browser.json), [window evidence](evidence/windows-browser-results.json), [external executable evidence](evidence/external-browser-results.json).
- [Target catalog](tests/targets.json), [static blockers](evidence/target-blockers.json), [architecture](docs/architecture.md), [NLS scope](docs/wine-nls.md).
- `npm test`: 229 passing tests at the current verified milestone.
- `npm run test:browser`, `npm run test:controls`, `npm run test:external`.
- Pages server: `WINEBROWSER_BASE_PATH=/winebrowser/ npm run build`, then `npm run serve:pages`.
- Against that server: `npm run test:pages`, `npm run test:windows`, `npm run test:tetris`.
- Optional whole-Wine probe (expected to report blocked startup):
  `npm run probe:wine-crt -- /path/to/i386-windows /path/to/wine/nls`.

Commits use the repository-local `evangit2` identity. Future work should retain
unchanged target binaries, fix shared runtime behavior, and record what was
actually executed.
