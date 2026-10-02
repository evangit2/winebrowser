# Automatic source-built Wine base fixtures

These small repository-owned PE32 inputs need no application Wasm build.
`native-base.exe` imports NTDLL's CRC32 function, computes `cbf43926` for
`123456789`, prints through native Kernel32/NT stdout and exits zero.
`dynamic-base.exe` imports only Kernel32, later loads the supplied `helper.dll`,
looks up its checksum export, calls into native NTDLL, unloads and exits zero.
The nested ZIP therefore also exercises preflight of later-loaded DLL imports.

`dynamic-crt.exe` loads a supplied `helper-crt.dll` as `helper.dll`. That DLL
imports only host-covered CRT names (`strlen` and `strtoul`), yet the worker
selects the native source-built CRT before startup. The EXE retains a CRT
reference so the final module inventory verifies its native provenance.

`npm run build:wine-base-auto` rebuilds the native inputs with MinGW.
`npm run test:wine-base-upload` uploads the original files through the actual
worker and requires automatic fetches of the source DLL closure and seven NLS
tables, native mapped modules, real output and exit zero. Its dev gate rejects
a modified runtime NTDLL. Set WINEBROWSER_TEST_URL to a built project URL to
verify the same uploads through the Pages isolation service worker. These
fixtures establish their tested loader behavior, not arbitrary compatibility.
