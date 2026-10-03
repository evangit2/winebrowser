#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
dll_search_build=.scratch/dll-search-build
mkdir -p "$dll_search_build" tests/fixtures/dll-search/app tests/fixtures/dll-search/plugins
for target in root app plugins; do
  case "$target" in root) identity=101; output=tests/fixtures/dll-search/helper.dll;;
    app) identity=202; output=tests/fixtures/dll-search/app/helper.dll;;
    plugins) identity=303; output=tests/fixtures/dll-search/plugins/helper.dll;; esac
  SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -DIDENTITY=$identity -m32 -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib -shared \
    -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
    -Wl,--entry,_DllMain@12 -Wl,--out-implib,"$dll_search_build/helper.a" \
    tests/fixtures/dll-search/helper.c -o "$output"
done
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib -shared \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_DllMain@12 \
  tests/fixtures/dll-search/plugin.c "$dll_search_build/helper.a" -o tests/fixtures/dll-search/plugins/plugin.dll
for profile in host native; do
  define=; libraries=-lkernel32
  if [ "$profile" = native ]; then define=-DNATIVE_BASE; libraries='-lkernel32 -lntdll'; fi
  SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $define -m32 -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib \
    -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
    -Wl,--entry,_start -Wl,--subsystem,console tests/fixtures/dll-search/client.c \
    $libraries -o "tests/fixtures/dll-search/app/$profile.exe"
done
i686-w64-mingw32-strip --strip-all tests/fixtures/dll-search/helper.dll \
  tests/fixtures/dll-search/app/*.dll tests/fixtures/dll-search/plugins/*.dll tests/fixtures/dll-search/app/*.exe
