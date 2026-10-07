# Native clipboard editor

Original WineBrowser contributors, MIT. This Windows SDK PE32 program opens
ANSI and Unicode editors. Select text and use Ctrl+C/Ctrl+V/Ctrl+X, or the
buttons. It also runs startup checks for persistent clipboard memory, native
format enumeration, ANSI/Unicode/OEM conversion and delayed-render callbacks.
Close its window to exit.

`sh scripts/build-clipboard-fixture.sh` rebuilds the unchanged native EXE with
i686 MinGW. The browser translates this EXE to Wasm when it runs. The public
source archive contains the client, build script, license and independently
captured native desktop Wine reference. No third-party application is included.

`oracle.c` calls the actual clipboard APIs under desktop Wine. Reproduce with
`i686-w64-mingw32-gcc -O1 -Wl,--no-insert-timestamp oracle.c -o oracle.exe -luser32`
and `wine oracle.exe`. It empties the native clipboard during the probe.
`wine-reference.json` records its exact output and source/EXE hashes.
