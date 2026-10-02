#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
cpp_runtime_build=.scratch/cpp-runtime-build
mkdir -p "$cpp_runtime_build"
import_library() {
  library=$1
  shift
  definition="$cpp_runtime_build/$library.def"
  { printf 'LIBRARY %s.dll\nEXPORTS\n' "$library"; printf '  %s\n' "$@"; } > "$definition"
  i686-w64-mingw32-dlltool -d "$definition" -l "$cpp_runtime_build/$library.a"
}
import_library msvcp140 _Mtx_init _Mtx_lock _Mtx_trylock _Mtx_current_owns _Mtx_unlock _Mtx_destroy
import_library vcruntime140 __std_exception_copy __std_exception_destroy
import_library msvcp140_1 _Aligned_new_delete_resource
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/cpp-runtime/cpp-runtime.c -o tests/fixtures/cpp-runtime/cpp-runtime.exe \
  "$cpp_runtime_build/msvcp140.a" "$cpp_runtime_build/vcruntime140.a" \
  "$cpp_runtime_build/msvcp140_1.a" -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/cpp-runtime/cpp-runtime.exe
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -DCPP_RUNTIME_DLL -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -shared -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_DllMain@12 -Wl,--kill-at \
  tests/fixtures/cpp-runtime/cpp-runtime.c -o tests/fixtures/cpp-runtime/cpp-client.dll \
  "$cpp_runtime_build/msvcp140.a" "$cpp_runtime_build/vcruntime140.a" \
  "$cpp_runtime_build/msvcp140_1.a" -lkernel32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/cpp-runtime/plugin-host.c -o tests/fixtures/cpp-runtime/plugin-host.exe -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/cpp-runtime/cpp-client.dll tests/fixtures/cpp-runtime/plugin-host.exe
