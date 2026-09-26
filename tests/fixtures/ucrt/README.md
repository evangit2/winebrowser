# Native UCRT API-set fixture

Original WineBrowser fixture under the repository license.
`sh scripts/build-ucrt-fixture.sh` builds a freestanding PE32 entry with actual
UCRT API-set imports from MinGW's `libucrt.a`. No replacement CRT is linked.
`node scripts/test-ucrt-native.mjs <pinned-wine-i386-dir> <nls-dir> [--browser]`
executes the imports against the real pinned Wine ucrtbase.dll via loader
redirection, checks memory/string/conversion/stdio functions and dynamic module
identity/lifetimes, and records input hashes. Wine/NLS bytes stay diagnostic-only.
