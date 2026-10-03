# Full upstream 7-Zip and its native codec DLL

Choose **Load 7zip-full** in the [public harness](https://evangit2.github.io/winebrowser/),
then **Run executable**. The default command creates `out.zip` from a text file
and an 8 KiB binary input. Download the output after the process exits.

This package contains unchanged upstream **7z.exe and 7z.dll 26.03**, extracted
from the original Windows x86 installer. The codec library loads dynamically;
its native compression, decompression, password derivation, encryption and
authentication run as translated x86 inside the browser. Source-built Wine
Kernel32, KernelBase, NTDLL and MSVCRT are supplied automatically. Binary pins,
the complete dynamic import audit and upstream URLs are in
`public/examples/7zip-full/PROVENANCE.json`. The original license, readme and full
corresponding source archive accompany the distribution. The LGPL/BSD notices
and upstream unRAR restriction are retained.

The shared compatibility changes support binary BSTRs, their published OleAut32
ordinals, exact binary/embedded-NUL copies, scalar VARIANT properties and DOS
archive timestamp conversion. CharPrevExA calls the real Wine KernelBase body.
The run report now retains a bounded `loadedModules` history: the codec library
remains visible in diagnostics after the program legitimately unloads it.

## Acceptance

`node scripts/test-7zip-full-browser.mjs` checks hosted selection, package ZIP
upload and loose EXE/DLL/input upload in ordinary Chrome:

- Deflate ZIP output is decoded independently with fflate, and both files are
  compared byte-for-byte. The native codec also extracts the ZIP exactly.
- LZMA2 compression with `-mmt=2` exercises native thread creation, resume,
  semaphore signaling, waits and thread termination. 7z CRC/integrity checking
  and extraction preserve both files.
- AES-256 ZIP encryption is verified independently using Node PBKDF2,
  HMAC-SHA1, AES counter mode and zlib. Both salts differ, the stored password
  verifiers and authentication codes match, and every decrypted byte matches.
- The native library tests and decrypts the encrypted ZIP. Wrong passwords and
  modified encrypted payloads return the original application's error exit 2.
- The original EXE/DLL hashes and package hashes match before execution. Reports
  distinguish the native codec and Wine libraries from browser API providers.

Set `WINEBROWSER_TEST_URL` to a static Pages build or the public deployment.
`WINEBROWSER_7ZIP_FULL_EVIDENCE` and `WINEBROWSER_7ZIP_FULL_SCREENSHOT` select output
paths. CI repeats this acceptance on the static Pages build without isolation
headers.

## Uploading your own archives

Choose the EXE, codec DLL and inputs together, or upload their package ZIP.
For an input ZIP, put it inside the program folder or inside an outer package
ZIP. A top-level selected ZIP is expanded as a program package by the importer;
an inner ZIP remains application data. The output can be tested or extracted
with these command lines:

```json
["t", "input.zip"]
```

```json
["x", "input.zip", "-oextracted"]
```

For AES-256 ZIP creation:

```json
[
  "a",
  "encrypted.zip",
  "message.txt",
  "binary.bin",
  "-tzip",
  "-pYourPassword",
  "-mem=AES256",
  "-mmt=1"
]
```

The tested password is ASCII. This acceptance establishes the recorded codecs
and operations; it does not verify every format, every concurrency setting,
encrypted 7z headers or the separate 7-Zip GUI executables. Large compression
and password-derivation workloads remain CPU intensive. Compatibility remains
PE32 x86.

Rebuild the deterministic package with Node and a native `7zz`:

```sh
node scripts/package-7zip-full.mjs
```
