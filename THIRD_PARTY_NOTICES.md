# Third-party notices

WineBrowser's original code is MIT licensed; see LICENSE. It is an independent project, not affiliated with WineHQ.

| Component   | Version / source                                                                        | Use                                                                                                                              | License                                                                          |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| iced-x86    | npm 1.21.0; https://github.com/icedland/iced                                            | Existing Rust/Wasm x86 decoder. The build script adapts its published Node binding to browser ESM; the Wasm bytes are unchanged. | MIT; retained in `third_party/iced-x86-LICENSE.txt` and npm package.             |
| fflate      | npm 0.8.3; https://github.com/101arrowz/fflate                                          | Bounded streaming ZIP deflate decoding.                                                                                          | MIT; retained in `third_party/fflate-LICENSE.txt`.                               |
| Hamsterball | https://github.com/evangit2/Hamsterball/commit/71c6ad56acf585d719c520ff070f4c14827a2ab3 | `src/audio-scheduling.js`, copied from `audio-scheduling.js`; browser audio queue policy.                                        | MIT, copyright 2026 evangit2; retained in `third_party/Hamsterball-LICENSE.txt`. |

DirectWebGPU and Hamsterball inform the architectural study. No Theseus runtime code, generated translated game, WineD3D binary, or proprietary game asset is distributed here. Theseus' inspected revision lacked a license declaration; its reuse is not assumed. The future Wine/WineD3D work must retain applicable LGPL source, modification and relinking materials. The Wine-derived CommandLineToArgvW guest component below is the only Wine code included; this is not a full Wine runtime.

Vite, Playwright and Prettier are development dependencies with licenses in their pinned npm packages. `package-lock.json` pins the dependency graph. Re-run `scripts/prepare-decoder.mjs` after installation; do not hand-edit generated browser decoder files.

## Wine CommandLineToArgvW guest library

The guest library in `public/runtime/shell32.dll` and `runtime/wine/command-line.c` derives from Wine 11.0 `dlls/shcore/main.c` (commit `db11d0fe6a169c457e23d007e20404643d067aa8`), copyright 2002 Jon Griffiths and 2016 Sebastian Lackner, LGPL-2.1-or-later. The function body is unchanged; it is extracted into a standalone guest x86 library using MinGW headers and exports. The original complete source is retained at `third_party/wine/shcore-main.c`, the license at `third_party/wine/COPYING.LIB`, and the complete extraction/rebuild command at `scripts/build-wine-library.py`. See `runtime/wine/README.md` for replacement/relink instructions. The MIT license for original host code does not replace Wine's LGPL terms.

## GitHub Pages isolation service worker

`public/coi-serviceworker.js` is the unchanged MIT-licensed coi-serviceworker v0.1.7 by Guido Zuidhof and contributors, pinned to [commit 7b1d2a092d0d2dd2b7270b6f12f13605de26f214](https://github.com/gzuidhof/coi-serviceworker/tree/7b1d2a092d0d2dd2b7270b6f12f13605de26f214). Its full license is distributed beside it in `public/coi-serviceworker-LICENSE.txt`. It supplies COOP/COEP headers through a service worker on static hosts, reloading once on first use. Its scope is the deployed project directory. It fetches resources from the network without caching application uploads.
