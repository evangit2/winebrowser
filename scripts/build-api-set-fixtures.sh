#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
api_set_build=.scratch/api-set-build
mkdir -p "$api_set_build"
import_library() {
  contract=$1
  shift
  definition="$api_set_build/$contract.def"
  { printf 'LIBRARY %s.dll\nEXPORTS\n' "$contract"; printf '  %s\n' "$@"; } > "$definition"
  i686-w64-mingw32-dlltool -k -d "$definition" -l "$api_set_build/$contract.a"
}
import_library api-ms-win-core-heap-l1-1-0 GetProcessHeap@0 HeapAlloc@12 HeapReAlloc@16 HeapFree@12
import_library api-ms-win-core-file-l1-2-0 CreateFileA@28 ReadFile@20 WriteFile@20 CloseHandle@4
import_library api-ms-win-core-processenvironment-l1-1-0 GetStdHandle@4
import_library api-ms-win-core-processthreads-l1-1-0 ExitProcess@4
import_library api-ms-win-core-libraryloader-l1-1-0 LoadLibraryA@4 GetModuleHandleW@4 GetProcAddress@8 FreeLibrary@4
import_library api-ms-win-core-registry-l1-1-0 RegCreateKeyExW@36 RegSetValueExW@24 RegQueryValueExW@24 RegCloseKey@4
import_library ext-ms-win-ntuser-chartranslation-l1-1-0 CharNextA@4
for profile in host native; do
  define=
  native_library=
  if [ "$profile" = native ]; then define=-DTEST_NATIVE_SCHEMA; native_library=-lntdll; fi
  SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $define -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
    -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
    -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
    tests/fixtures/api-sets/api-sets.c "$api_set_build"/*.a $native_library \
    -o "tests/fixtures/api-sets/$profile.exe"
  i686-w64-mingw32-strip --strip-all "tests/fixtures/api-sets/$profile.exe"
done
