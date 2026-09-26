#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for mode in threads threads-native worker-exit main-exit thread-fault static-tls duplicate duplicate-main-exit; do
  source=threads
  case_flag=""
  case "$mode" in
    threads-native) case_flag="-DNATIVE_TEST" ;;
    static-tls) source=static-tls ;;
    duplicate) source=duplicate ;;
    duplicate-main-exit) source=duplicate; case_flag="-DMAIN_EXIT" ;;
    worker-exit) source=lifecycle; case_flag="-DCASE=0" ;;
    main-exit) source=lifecycle; case_flag="-DCASE=1" ;;
    thread-fault) source=lifecycle; case_flag="-DCASE=2" ;;
  esac
  SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
    -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
    -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
    $case_flag "tests/fixtures/threads/$source.c" -o "tests/fixtures/threads/$mode.exe" -lkernel32
  i686-w64-mingw32-strip --strip-all "tests/fixtures/threads/$mode.exe"
done
python3 - <<'PY'
from pathlib import Path
for name in ('threads', 'threads-native', 'worker-exit', 'main-exit', 'thread-fault', 'static-tls', 'duplicate', 'duplicate-main-exit'):
    path = Path(f'tests/fixtures/threads/{name}.exe')
    data = bytearray(path.read_bytes())
    pe = int.from_bytes(data[0x3c:0x40], 'little')
    data[pe + 8:pe + 12] = bytes(4)
    data[pe + 88:pe + 92] = bytes(4)
    path.write_bytes(data)
PY

SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -shared -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_DllMain@12 -Wl,--image-base,0x10000000 \
  tests/fixtures/threads/tls-dll.c -o tests/fixtures/threads/thread-tls.dll -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/threads/thread-tls.dll
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/threads/thread-tls.dll')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
