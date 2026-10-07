# Original 7-Zip Windows GUI in WineBrowser

The harness runs upstream **7-Zip 26.03 `7zG.exe`**, its original **`7z.dll`**,
and the automatically loaded native Wine base. These are the original PE32
Windows binaries, translated to Wasm in the browser. No rebuilt application,
host compression library or substitute GUI performs the native operations.

Choose **Load 7zip-gui**, then **Run executable** on
[the public harness](https://evangit2.github.io/winebrowser/). The native **Add
to archive** dialog opens with text and binary inputs. Change compression
settings, or enter and confirm a password and select AES-256. Outputs can be
downloaded from the harness after exit. The
[complete upload ZIP](https://evangit2.github.io/winebrowser/examples/7zip-gui/7zip-gui.zip)
contains the unchanged EXE, codec DLL, inputs and original notices.

To extract an uploaded archive with the native directory/password dialog,
set arguments to `["x", "-ad", "archive.zip"]`. Upload the archive with the
program package or its EXE/DLL. Choose an extraction directory under
`C:\winebrowser\`. The browser's isolated package filesystem receives the
files; guest paths never name host directories.

## Acceptance and provenance

`scripts/test-7zip-gui-browser.mjs` runs ordinary Chrome with no diagnostic API
replacements. It tests hosted selection, ZIP upload and loose EXE/DLL/input
upload, with real native controls and original process exit codes:

The runner closes native completion reports when the application waits for
**Close**, and records their messages before checking the actual process exit
code and every output byte. A progress dialog can also briefly publish **Close**
before automatic exit; that disappearance is accepted only after the process
has actually exited. The wrong-password and damaged-data cases exercise retained
completion reports and still require native error code 2.

| Operation                                               | Independent evidence                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Change archive format and compression level; create ZIP | fflate independently decodes both output files byte for byte                            |
| Choose extraction directory in native dialog            | Exact text and binary output bytes                                                      |
| Enter/confirm password; create AES-256 ZIP              | Node crypto independently derives keys, authenticates, decrypts and compares both files |
| Enter password in native extraction dialog              | Exact decrypted output bytes                                                            |
| Cancel native compression dialog                        | Original typed C++ catch, exit 255, no archive                                          |
| Select two codec threads; create/extract LZMA2 7z       | Real native thread/semaphore calls, exact extracted files                               |
| Wrong password or altered ciphertext                    | Native report-list errors, real selection/Copy interaction and exit 2                   |

Results record translated instructions, translation time, loaded DLL hashes,
API calls, outputs and browser version in
`evidence/7zip-gui-browser-results.json`. Local timing is observational and is
not a paired GUI performance claim.

On **October 4, 2026**, all nine cases also passed the built static site and the
public GitHub Pages deployment. The final
[Actions run](https://github.com/evangit2/winebrowser/actions/runs/37228373303)
passed **1,085 unit tests** and the complete browser gates, then deployed
`82cd38a8f36cdcafa0472a409344f6b6d42e6c18`. See
`evidence/7zip-gui-static-results.json`, `evidence/7zip-gui-live-results.json` and
`evidence/7zip-gui-live-deployment.json` for operation results, original asset
pins, deployment status and matching UI/worker bundles. The final commit
adjusts only browser assertion retries; its published assets match those used
by the live acceptance.

`scripts/package-7zip-gui.mjs` verifies the original installer and complete
source archive, audits the full static import closure and dynamically loaded
`7z.dll`, and creates deterministic ZIPs. SHA-256 pins:

| File                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| Original `7zG.exe`                  | `4e6d8e866a10746a44602ec2e31057d8a552efc837b726033d72fd7739546e22` |
| Original `7z.dll`                   | `d132e89038c802c5d5281e543a83dc407680effe0144f21b4fb431dd45fca61d` |
| Installer `7z2603.exe`              | `0f6ec2eda1f8c5dc4c267ee761c0dad8a9d5e8863e0c84b7ac026bc9625a1560` |
| Complete source `7z2603-src.tar.xz` | `9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4` |

The package preserves upstream LGPL/BSD licenses and its unRAR restriction.
Corresponding [complete source](https://evangit2.github.io/winebrowser/examples/7zip-gui/source.zip)
is published alongside the binaries. Original source URLs, file pins and DLL
closure appear in `public/examples/7zip-gui/PROVENANCE.json`.

## Shared compatibility changes and boundaries

Horizontal progress controls implement signed ranges/positions, native stepping,
colors and state. Bounded text report ListViews implement A/W columns and
subitems, selection, queued native notifications, keyboard notifications and
item queries. The native error list uses its original control logic for Copy.
Image lists, callback text, owner data, sorting and other ListView modes still
require implementation.

Shell file-info queries describe the actual package namespace and return
independently owned generic document/folder icons. COM task allocation shares
ownership with shell IMalloc. Registry file associations, PIDL file-info queries,
system image lists and overlays remain unsupported.

Native `FILE_RENAME_INFORMATION` enables atomic archive finalization and retains
file bytes, metadata, identities, live source handles and locks. Sharing,
replacement, access and mapped-file conflicts fail without changing contents.
Directory renames and replacement of an open target remain unsupported.

First-chance NT exceptions enter original Wine `KiUserExceptionDispatcher`;
native SEH/C++ code performs handler search and unwinding. `NtContinue` restores
the saved i386 context. A separate compiled fixture verifies native registration
frames and continuation. Unhandled exceptions stop execution; alertable APC
continuation and extended XSTATE contexts remain unsupported.

This acceptance covers **7zG's recorded operations**. The separate **7zFM.exe
File Manager**, other archive formats/options, overwrite dialogs, large archives,
PE32+ and arbitrary Windows DLL/API compatibility still need their own work and
acceptance. Programs must include their own companion application DLLs/assets.
The earlier measured CPU improvements are documented separately in
[startup-performance.md](startup-performance.md): paired developer VM median
time fell 4.8% for PuTTY Configuration population and 8.9% for full native
7-Zip AES ZIP creation, excluding browser rendering and downloads.

## Reproduce

```sh
npm run package:7zip-gui
npm run test:7zip-gui
sh scripts/build-native-exceptions-fixture.sh
node --test tests/report-controls.test.js tests/shell-file-info.test.js tests/file-rename.test.js tests/wine-exceptions.test.js
WINEBROWSER_TEST_URL=https://evangit2.github.io/winebrowser/ \
  WINEBROWSER_7ZIP_GUI_EVIDENCE=evidence/7zip-gui-live-results.json \
  npm run test:7zip-gui
```

Packaging uses Node 22+, `7zz`, retained cached original downloads, and the
source-built Wine assets already in this repository. Native fixture rebuilding
uses i686 MinGW. GitHub Actions gates the built Pages artifact with the same
browser acceptance before deployment.
