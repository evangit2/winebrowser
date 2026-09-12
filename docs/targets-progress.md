# Independent PE targets

The manifest records exact target versions, SHA-256 values, test arguments, and evidence-backed status. `passed` applies only to the recorded case and arguments; `partial` means some cases on the same executable passed while other probes remain blocked. Downloaded binaries and reference files stay in ignored `.cache/targets/` unless already part of a separately licensed runtime component.

On Chrome 152.0.7977.84 (2026-09-12), the unchanged upstream 3,584-byte **winapiexec 1.2** binary passed these browser cases: exact console output, creating/writing a virtual file, a `MessageBoxW` dialog, a measured 440 Hz/20 ms `Beep`, synchronous `PlaySoundW` with an 80-frame packaged PCM WAV, and GDI `PatBlt` plus `SetPixel` over a 640×480 RGBA canvas. The GDI test checked all pixels and matched its recorded SHA-256 exactly. The PCM WAV and ZIP are generated test data; the executable bytes remain unchanged upstream. The audio check observes WebAudio decode and scheduling, not physical speaker output. The target remains `partial`: the `SystemAsterisk` alias probe requests unsupported asynchronous alias playback, and the separate `TextOutA` probe is blocked because that API is not implemented.

The independent **pts-tinype hh4t** GUI binary passed with exit code 0, the expected `Hello,\nWorld!` / `World!` dialog, and a `LoadLibraryA` → `GetProcAddress` → `MessageBoxA` → `ExitProcess` trace. Its upstream repository has no license file, so it remains cache-only. The 402-byte hh2 console binary runs under native Wine 11.0, but the browser loader rejects its nonstandard raw section pointer that overlaps PE headers; its import directory also exceeds `SizeOfImage`.

The other independent targets are blocked at known prerequisites, before any compatibility claim: 7zr has unresolved OLEAUT32/ADVAPI32/MSVCRT modules and a large unsupported kernel/user API closure; PuTTY and the source-built SGI OpenGL sample first require PE TLS callback support; the SGI build also has API-set CRT and WGL/OpenGL requirements; Humus Inferno lacks ADVAPI32/MSVCR80/DXGI/D3D10, imports an absent SHELL32 export, and needs unsupported window/thread/clipboard calls. These are static import/loader findings, not run failures.

The SGI sample is a local build of independently sourced OpenGL tutorial code, not a checked-in project fixture. Its archived source page has no separate license notice; keep its build and executable in the ignored cache. The pts-tinype executables likewise have no repository license file. Humus' included readme permits redistribution if retained; PuTTY is under its MIT-style license, 7zr under LGPL-2.1-or-later with the upstream unRAR restriction, and winapiexec under GPL-3.0. Check each upstream license before redistributing a binary.

Generic runtime work now exercised by independent code includes PE32 section-tail mapping, guest DLL mapping and relocation, named/ordinal/forwarded export linking, dynamic loading and function lookup, console/file/dialog/audio/GDI API paths, and execution of Wine's unchanged `CommandLineToArgvW` body as guest x86. These improvements reuse the same loader, CPU translator, and API providers across targets; they do not supply broad CRT startup, general windowing, OpenGL, or Direct3D drivers.

Run the test and target workflow from the repository root:

```sh
npm ci
npm test
npm run build
npm run test:browser
npm run test:external
npm run fetch:targets
npm run inspect:targets
npm run build:modules
npm run build:wine
```

`test:external` writes browser observations to [`evidence/external-browser-results.json`](../evidence/external-browser-results.json). `fetch:targets` downloads and hash-checks assets into `.cache/targets/`; `inspect:targets` records static loader/import blockers without executing binaries. DLL fixture and Wine component rebuilds are optional; they need the documented i686 MinGW toolchain and Python where applicable.

The optional `WINEBROWSER_NTDLL` experiment uploads the unchanged winapiexec executable with a whole hash-pinned installed Wine 11 i386 `ntdll.dll`. Chromium verifies real DLL initialization/relocation and CRC32 `0xcbf43926` for `123456789`. Node verifies additional fixed pure-export vectors; `NtQuerySystemTime` remains blocked at the absent Unix dispatcher. This is separate from the default CI cases because the installed DLL is not redistributed. See `evidence/wine-ntdll-results.json` and the optional case in the external browser report.
