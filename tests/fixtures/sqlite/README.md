# Native SQLite DLL client

The MIT-authored client imports only Kernel32 and loads the unchanged upstream
SQLite 3.50.4 PE32 DLL dynamically. It exercises in-memory SQL, transactions,
rollback, Unicode text and binary blobs, a file database, competing writer
connections, close/reopen, integrity_check and DLL unload.

Build: `sh scripts/build-sqlite-fixture.sh`.
Package the pinned upstream DLL and source: `python3 scripts/package-sqlite.py`.
Test ordinary uploads and the catalog: `npm run test:sqlite`.
The official upstream DLL is never rewritten or recompiled before execution.

SQLite is public domain. Its notice, source identity, upstream URLs and hashes
accompany the demo. The authored client uses no SQLite import library or SDK.
The generated database can be downloaded and opened in ordinary SQLite tools.
