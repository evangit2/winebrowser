# Native standard output aliases

Original WineBrowser contributors, MIT. `oracle.c` captures cascading native
output-handle duplicates, inherited attributes, reduced rights and independent
closes. It also records Wine's console-mode ioctl failure on a redirected,
write-only standard output handle: access denied with untouched buffers.

Build with `i686-w64-mingw32-gcc -m32 oracle.c -o oracle.exe`, then run on Wine
with stdout redirected to a file. The resulting `native-output.json` and
`native-device.json` are the captured references; stdout is exactly `AB`.

The runtime tests cover host and native NT writes to output aliases. Ordinary
file/pipe duplication, input streams and cross-process handle duplication remain
outside this implementation.
