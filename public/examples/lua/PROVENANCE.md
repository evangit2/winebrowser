# Lua 5.4.2 native Windows DLL

The unchanged LuaBinaries Windows x86 DLL executes the supplied main.lua script
through an MIT-authored native Windows client. Both the upstream DLL and Lua
source use the MIT license retained in Lua-LICENSE.txt.

- Original Windows DLL archive: <https://downloads.sourceforge.net/project/luabinaries/5.4.2/Windows%20Libraries/Dynamic/lua-5.4.2_Win32_dllw6_lib.zip>
- Archive SHA-256: `cff34d8074fca1ad54bb7cd7e34d8f01b0d685ef95377d372e22c81fa530fa3f`.
- Original DLL SHA-256: `cfc3f1d4a6e8922d16d71a4c12c1b731bc9e7edab82d5282f15c3aaa86a388e3`.
- Original Lua 5.4.2 source: <https://www.lua.org/ftp/lua-5.4.2.tar.gz>
- Source SHA-256: `11570d97e9d7303c0a59567ed1ac7c648340cd0db10d5fd594c09223ef2f524f`.
- Authored client SHA-256: `8651cd01f5803949d53a84050bfe65a3087a2c2c5380b16b3b318dcc748f602d`.

Upload lua.zip or select lua-client.exe, lua54.dll and main.lua together. Modify
main.lua to run another script with the same original library. WineBrowser loads
its native Wine base before startup and translates the original EXE/DLL x86 code
to Wasm inside the browser. Lua itself parses and executes the script as it would
on Windows; the script is not replaced by browser JavaScript.

The example checks 64-bit integers, floating-point math, a guest C callback, Unicode, table sorting,
coroutines, caught errors, garbage collection, packed binary data and file
write/read round trips. Download lua-output.bin after clean process exit. The
browser test independently decodes its 64-bit values and float.

source.zip contains the complete original Lua source archive, original DLL
archive, license, authored client and script, and client build recipe. The
upstream DLL is unmodified; rebuilding the client requires only MinGW-w64.
This is a bounded scripting workload, not proof of every Lua module, networking,
external processes or arbitrary Windows application compatibility.
