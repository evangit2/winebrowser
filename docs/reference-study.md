# Reference study: Wine and offline game ports

This study records architectural lessons from two nearby projects. They demonstrate different
ways to execute Windows software and should not be conflated with WineBrowser's implementation.

## DirectWebGPU and WineD3D

The [DirectWebGPU WineD3D
study](https://github.com/evangit2/DirectWebGPU/blob/2cb676dcefcfd486d06d2ad43d7754c3c7bdb9c8/docs/wined3d-feasibility.md)
recommends retaining an existing execution runtime and adding a WineD3D-derived D3D8/9 mode
beside it. Its target is a browser D3D renderer: D3D8/9 frontends feed shared state/resource
semantics and ordered command batches to a separate WebGPU worker. It audits the pinned Wine
source revision
[`bd0f453b7bb4`](https://github.com/wine-mirror/wine/tree/bd0f453b7bb4e16c3b4ef271b3df499c34fbe848)
and the distinct standalone vkd3d revision
[`84a77b438f0b`](https://gitlab.winehq.org/wine/vkd3d/-/tree/84a77b438f0b7a45441db20d390a240a8580f3bc).
The study treats WineD3D's adapter, resource and shader interfaces as candidates for extraction
and warns that they are coupled to Unix libraries, graphics backends and resource machinery.

That is not a complete Wine port, and it does not solve instruction decoding, arbitrary DLL
loading, TLS, SEH or Windows threading for this runner. Its shader compiler pilot and renderer
acceptance evidence belong to that other codebase. WineBrowser may learn from the source audit
or reuse a suitably licensed, pinned portable component after an integration review; it does not
import the study's runtime or claim its test results.

## Hamsterball browser harness and Theseus

The [Hamsterball
README](https://github.com/evangit2/Hamsterball/blob/71c6ad56acf585d719c520ff070f4c14827a2ab3/README.md)
describes a different execution model: Theseus translates one original 32-bit x86 executable
ahead of time into Rust/WebAssembly and supplies its DOS/Win32 environment. The published
harness stores a translated payload encrypted and keyed from the exact supported executable; in
the browser it hashes the user's selected executable, decrypts the payload in memory, verifies
it and then runs the prebuilt translation. Its game files and browser integration target a
specific supported title.

These details matter for reuse boundaries. An offline pretranslated payload is neither original
PE code nor a general PE loader. Decrypting that payload does not dynamically translate
arbitrary user executables. A build of the Theseus runtime is also not an interchangeable Win32
subsystem: its guest CPU, API surface, packaging and game-specific integration are coupled to
its own project. WineBrowser currently does not include or depend on Theseus, consume a
Hamsterball payload, or reuse that harness's encrypted translation. It maps the uploaded PE32
and translates decoded basic blocks in the browser using its own JavaScript runtime and Wasm
emitter.

The pinned [Hamsterball third-party
notices](https://github.com/evangit2/Hamsterball/blob/71c6ad56acf585d719c520ff070f4c14827a2ab3/THIRD_PARTY_NOTICES.md)
identify Theseus revision `f8c1a2351b8b605812076d2dc34e84d20d95de4b` and state that its checkout
contains no license file or declaration; no license is inferred. WineBrowser does not use that
runtime or its output. Any future reuse would first require resolving the license and reviewing
exact source/build inputs. No Theseus runtime component or translated game payload is copied into this
repository. The small MIT-licensed Hamsterball audio queue helper is reused independently; see
[third-party notices](../THIRD_PARTY_NOTICES.md).

## Consequences for this project

| Question                        | WineBrowser direction                                                                        | What the references do not establish                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| How does the EXE run?           | Load a PE32 image and dynamically translate x86 blocks through this project's CPU.           | No Theseus translation or precomputed game payload is involved.                                   |
| How should PE DLLs run?         | As guest PE modules on the same x86 CPU, once module loading and callback ABI support exist. | A native Wasm helper library is not a guest DLL and cannot be substituted transparently.          |
| Where do browser services live? | Behind explicit imports/protocols for files, UI, graphics and audio.                         | A Unix library interface cannot be called as though a browser had Wine's Unix host process.       |
| What can Wine code contribute?  | Audited semantics or a small portable C module after source/license/build review.            | WineD3D's internal interfaces are not a ready-made browser D3D core or a general Windows runtime. |
| What does a demo pass mean?     | It verifies only the listed instructions, imports, paths and output for that PE.             | Four tiny fixtures do not demonstrate arbitrary application or game support.                      |

The practical sequence is to grow PE and CPU support with executable-level tests, specify the
guest/host contract, and then add loader and operating-system features with bounded test
programs. Treat renderer, audio, and broad application compatibility as separate tracks with
their own evidence. There is no defensible quick conversion milestone for universal Windows
program support.
