# SQLite native Windows DLL

This is SQLite 3.50.4's unchanged upstream x86 Windows DLL, used by an authored
MIT native Windows client. SQLite is public domain; its original dedication is
included in SQLite-LICENSE.txt. See <https://www.sqlite.org/copyright.html>.

- Original DLL archive: <https://www.sqlite.org/2025/sqlite-dll-win-x86-3500400.zip>
- Archive SHA-256: `c40a52de84bed8ca3b83eac80132c826bedfd702d19b156d2febdf046b3a049b`.
- DLL SHA-256: `24e612fd5b239aa6385d2c159b70155968b3f9ccdbf19ba7fd83a83b9255238a`.
- Source identity: `2025-07-30 19:33:53 4d8adfb30e03f9cf27f800a2c1ba3c48fb4ca1b08b0f5ed59a4d5ecbf45e20a3`.
- Original amalgamation SHA-256: `1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032`.
- Client executable SHA-256: `6dbf5e9c4e9013a0a6d95e89c3aefdfb4aa2789fd017e2e77f9ae01acd4217d6`.

Upload sqlite.zip, or select the client EXE and sqlite3.dll together. The client
loads SQLite through LoadLibrary/GetProcAddress and checks memory SQL, rollback,
Unicode text and blobs, disk transactions, writer contention, database reopen
and integrity_check. The database is available through the download link.
WineBrowser fetches its source-built native Wine base automatically; both the
client and original DLL compile from x86 to Wasm during browser execution.

source.zip contains the authored client and build recipe, upstream DLL export
definition and unchanged SQLite amalgamation. The official DLL was downloaded
unchanged, not rebuilt or patched. The client rebuild needs MinGW-w64 and no
SQLite SDK or runtime redistributable.

Validation covers these synchronous rollback-journal workloads. WAL mode,
background I/O, cross-process access and crash durability remain unverified.
File locks that require waiting and APC completion routines remain unsupported.
Browser storage receives generated outputs after the process finishes.
