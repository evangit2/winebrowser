# Third-party notices

WineBrowser's original code is MIT licensed; see LICENSE. It is an independent project, not affiliated with WineHQ.

| Component   | Version / source                                                                        | Use                                                                                                                              | License                                                                          |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| iced-x86    | npm 1.21.0; https://github.com/icedland/iced                                            | Existing Rust/Wasm x86 decoder. The build script adapts its published Node binding to browser ESM; the Wasm bytes are unchanged. | MIT; retained in `third_party/iced-x86-LICENSE.txt` and npm package.             |
| fflate      | npm 0.8.3; https://github.com/101arrowz/fflate                                          | Bounded streaming ZIP deflate decoding.                                                                                          | MIT; retained in `third_party/fflate-LICENSE.txt`.                               |
| Hamsterball | https://github.com/evangit2/Hamsterball/commit/71c6ad56acf585d719c520ff070f4c14827a2ab3 | `src/audio-scheduling.js`, copied from `audio-scheduling.js`; browser audio queue policy.                                        | MIT, copyright 2026 evangit2; retained in `third_party/Hamsterball-LICENSE.txt`. |

DirectWebGPU and Hamsterball inform the architectural study. No Theseus runtime code, generated translated game, WineD3D binary, or proprietary game asset is distributed here. Theseus' inspected revision lacked a license declaration; its reuse is not assumed. The future Wine/WineD3D work must retain applicable LGPL source, modification and relinking materials. The included Wine-derived code comprises the parser and formatter guest components, shader libraries/test bytecode described below, and an optional loader source patch; this is not a full Wine runtime.

Vite, Playwright and Prettier are development dependencies with licenses in their pinned npm packages. `package-lock.json` pins the dependency graph. Re-run `scripts/prepare-decoder.mjs` after installation; do not hand-edit generated browser decoder files.

## Wine CommandLineToArgvW guest library

The guest library in `public/runtime/shell32.dll` and `runtime/wine/command-line.c` derives from Wine 11.0 `dlls/shcore/main.c` (commit `db11d0fe6a169c457e23d007e20404643d067aa8`), copyright 2002 Jon Griffiths and 2016 Sebastian Lackner, LGPL-2.1-or-later. The function body is unchanged; it is extracted into a standalone guest x86 library using MinGW headers and exports. The original complete source is retained at `third_party/wine/shcore-main.c`, the license at `third_party/wine/COPYING.LIB`, and the complete extraction/rebuild command at `scripts/build-wine-library.py`. See `runtime/wine/README.md` for replacement/relink instructions. The MIT license for original host code does not replace Wine's LGPL terms.

## GitHub Pages isolation service worker

`public/coi-serviceworker.js` is the unchanged MIT-licensed coi-serviceworker v0.1.7 by Guido Zuidhof and contributors, pinned to [commit 7b1d2a092d0d2dd2b7270b6f12f13605de26f214](https://github.com/gzuidhof/coi-serviceworker/tree/7b1d2a092d0d2dd2b7270b6f12f13605de26f214). Its full license is distributed beside it in `public/coi-serviceworker-LICENSE.txt`. It supplies COOP/COEP headers through a service worker on static hosts. Our `src/isolation.js` registers its worker branch and waits for control before reloading once on first use; the upstream window-side bootstrap is not loaded. Its scope is the deployed project directory. It fetches resources from the network without caching application uploads.

## Wine formatter and GCC runtime helpers

`public/runtime/wine-format.dll` contains the unchanged Wine 11.0 USER32 formatter bodies. The complete pinned source is `third_party/wine/user32-wsprintf.c`, with LGPL-2.1-or-later terms in `third_party/wine/COPYING.LIB`. See `runtime/wine-format/manifest.json` and its README for source hashes, portability adapters, exact imports and rebuild instructions.

The DLL links GCC 16.1.0 libgcc integer division/remainder helpers under GPLv3 with the GCC Runtime Library Exception 3.1. Both texts are retained in `third_party/gcc/` and copied beside the hosted DLL. The Wine formatter itself remains under its original LGPL terms.

## Experimental Wine loader patch

`runtime/wine/browser-loader.patch` modifies Wine 11.0 `dlls/ntdll/loader.c` and `ntdll.spec` at commit `db11d0fe6a169c457e23d007e20404643d067aa8`. The upstream loader is copyright 1995, 2003 Alexandre Julliard and 2002 Dmitry Timoshkov for CodeWeavers; browser-bridge changes are copyright 2026 evangit2. This derivative patch is LGPL-2.1-or-later, with the license retained at `third_party/wine/COPYING.LIB`. The repository MIT license does not replace these terms.

`scripts/build-wine-loader.py` downloads and verifies the complete pinned Wine source archive, retains the patched sources in `.cache/wine-loader/`, and records source, patch, compiler, and output hashes. The complete rebuilt DLL and NLS data are optional local test inputs and are not distributed in this repository or the Pages harness. See [the experiment and rebuild instructions](docs/wine-loader-bridge.md).

## Browser shader compilation

`public/shaders/vkd3d-shader.js` and `.wasm` link unmodified **libvkd3d-shader 2.1** under LGPL-2.1-or-later. The exact complete upstream source archive is distributed alongside the library at `public/shaders/source/vkd3d-2.1.tar.xz` (SHA-256 `7510146aff2adfb4ae07ab890701a607e5ff7c66e57100cfc9f630ec92eeda6a`), with upstream licenses, the original MIT adapter `bridge.c`, and its rebuild script. [Build instructions and manifest](runtime/shaders/vkd3d/README.md) identify the Emscripten toolchain and pinned headers. Users can rebuild/replace these separate modules without rebuilding a Windows application. This is a shader compiler and root-signature serializer/parser, not the full vkd3d graphics runtime.

`public/shaders/naga/` contains the original MIT Rust/Wasm wrapper and **Naga 30.0.1** (MIT OR Apache-2.0). It ships the wrapper source, Cargo lockfile, build script, dependency notices and license texts. [Build instructions](runtime/shaders/naga/README.md) document the generic SPIR-V draw-parameter normalization and validation. No DirectWebGPU shader bridge source was copied.

The DXBC shader fixtures in `tests/fixtures/shaders/` and `demos/d3d12-triangle/` derive from Wine 11's `dlls/d3d12/tests/d3d12.c`, pinned to `db11d0fe6a169c457e23d007e20404643d067aa8`, under LGPL-2.1-or-later. Their complete original source and license are retained in both locations and in the hosted triangle ZIP, with extraction provenance and rebuild materials. The original triangle application remains MIT; its license does not replace the shaders' terms.
