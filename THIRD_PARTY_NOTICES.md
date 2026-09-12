# Third-party notices

WineBrowser's original code is MIT licensed; see LICENSE. It is an independent project, not affiliated with WineHQ.

| Component   | Version / source                                                                        | Use                                                                                                                              | License                                                                          |
| ----------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| iced-x86    | npm 1.21.0; https://github.com/icedland/iced                                            | Existing Rust/Wasm x86 decoder. The build script adapts its published Node binding to browser ESM; the Wasm bytes are unchanged. | MIT; retained in `third_party/iced-x86-LICENSE.txt` and npm package.             |
| fflate      | npm 0.8.3; https://github.com/101arrowz/fflate                                          | Bounded streaming ZIP deflate decoding.                                                                                          | MIT; retained in `third_party/fflate-LICENSE.txt`.                               |
| Hamsterball | https://github.com/evangit2/Hamsterball/commit/71c6ad56acf585d719c520ff070f4c14827a2ab3 | `src/audio-scheduling.js`, copied from `audio-scheduling.js`; browser audio queue policy.                                        | MIT, copyright 2026 evangit2; retained in `third_party/Hamsterball-LICENSE.txt`. |

DirectWebGPU and Hamsterball inform the architectural study. No Theseus runtime code, generated translated game, Wine source, WineD3D binary, or proprietary game asset is distributed here. Theseus' inspected revision lacked a license declaration; its reuse is not assumed. The future Wine/WineD3D work must retain applicable LGPL source, modification and relinking materials. No Wine-derived runtime coverage is claimed by this release.

Vite, Playwright and Prettier are development dependencies with licenses in their pinned npm packages. `package-lock.json` pins the dependency graph. Re-run `scripts/prepare-decoder.mjs` after installation; do not hand-edit generated browser decoder files.
