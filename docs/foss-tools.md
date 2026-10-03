# Unchanged FOSS Windows releases

The public [WineBrowser harness](https://evangit2.github.io/winebrowser/) offers GNU diff/cmp, OptiPNG and 7-Zip packages. These are upstream-compiled PE32 releases. Their EXEs and companion DLLs are neither rebuilt nor patched. Each example sets a working command line; click Run, then download files produced by the guest. Uploading the ZIP or selecting its loose EXE, DLLs and input files exercises the same loader.

| Package       | Original release                                                 | Functional acceptance                                                                                                    |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GNU diffutils | GnuWin32 2.8.7: diff.exe, cmp.exe, libintl3.dll, libiconv2.dll   | Unified patch; different and identical byte comparisons; missing-file failure                                            |
| OptiPNG       | 0.7.8 Windows release, original libpng/zlib code linked upstream | Lossless optimization of a four-colour PNG, every decoded RGBA pixel compared independently; malformed-image rejection   |
| 7-Zip         | 26.03 upstream 7zr.exe                                           | Text and binary compression, archive CRC test, LZMA extraction with byte-for-byte comparisons; corrupt-archive rejection |

GNU diff returns **1 when files differ**, 0 when identical and 2 on an application error. Those are ordinary successful process exits for this test. Each package includes its licenses, a complete source download, SHA-256 pins, original download URLs and a `PROVENANCE.json` dependency audit. The full import graph must resolve before packaging. Runtime evidence also records modules actually loaded and APIs exercised.

The separate [full 7-Zip package](7zip-full.md) adds the original `7z.exe` and
its dynamically loaded `7z.dll` codec library. Its acceptance covers deflate ZIP,
LZMA2 round trips and AES-256 ZIP encryption/decryption, including independent
cryptographic validation, wrong-password failures and damaged-data rejection.

GNU's supplied libintl and libiconv are real native DLLs. The harness automatically supplies source-built Wine MSVCP60, MSVCRT, kernel32, kernelbase and ntdll; it preserves original binary relocation and library initialization. The Wine source and rebuild scripts remain under `public/runtime/wine-base/`. MSVCP60 is a full Wine-built DLL, including its multibyte/locale exports, rather than host aliases for the few names diff imports.

The shared fixes cover standard-output handle closure during CRT shutdown, process error-mode state, guest-owned Windows environment defaults (including PATHEXT), OLE STA initialization, FileStatInformation and virtual-volume metadata. They also correct Win32 enumeration/file-information sizes and timestamps, created-directory lookup and extracted-file timestamps. These affect 7-Zip's browser-provided Win32/CRT services; its compressor and decompressor execute unchanged native code. Read-control probes on write-only stdout/stderr return NT failure statuses; they never fabricate pipe input or report an unsupported operation as successful.

## Reproduce

```sh
npm run package:foss-tools
npm run test:foss-tools -- --ordinary
WINEBROWSER_BASE_PATH=/winebrowser/ npm run build
PORT=4217 node scripts/serve-pages.mjs
WINEBROWSER_TEST_URL=http://127.0.0.1:4217/winebrowser/ npm run test:foss-tools -- --ordinary
```

Run the same acceptance against the public deployment in ordinary Chrome:

```sh
WINEBROWSER_TEST_URL=https://evangit2.github.io/winebrowser/ \
WINEBROWSER_FOSS_EVIDENCE=evidence/foss-tools-live-results.json \
WINEBROWSER_FOSS_SCREENSHOT=evidence/foss-tools-live.png \
npm run test:foss-tools -- --ordinary
```

The packager verifies every downloaded upstream archive before extraction, preserves the licensed binaries, and builds deterministic ZIPs. The browser gate checks the hosted package pins and normal example selection as well as loose-file uploads. GitHub Actions repeats acceptance against the static Pages build without isolation headers. Its service worker establishes the same isolation used on GitHub Pages.

All ten functional checks passed on the public Pages URL in ordinary Chrome on 2026-10-03 UTC, against deployed commit `3fb8c5ae21e63b49a925b3da680998236fedb77d`. See the [live results](../evidence/foss-tools-live-results.json) for actual modules, APIs, output hashes and process exits, and the [deployment record](../evidence/foss-tools-live-deployment.json) for the successful Actions run and asset hashes observed before and after acceptance. OptiPNG reduced the input from 12,420 to 121 bytes with every decoded pixel preserved; 7-Zip recovered both the 17-byte text and 4,096-byte binary exactly. The preceding FOSS release CI also passed all 939 unit tests and the complete static-hosted browser acceptance suite.

This validates the tested PE32 programs and exercised operations. BusyBox-w32 FRP-6075 was also inspected: its unchanged PE32 release still has unresolved security/crypto and networking imports. It is deliberately absent from the published working catalog. PE32+ x64 programs, general arbitrary DLLs, networking, subprocesses and unexercised APIs are not established by these results. A successful import audit alone is insufficient evidence of application compatibility.
