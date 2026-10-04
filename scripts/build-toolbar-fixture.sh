#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
import struct
width,height=48,16
row=b''.join(bytes(color)*16 for color in [(30,40,220),(40,200,30),(210,40,30)])
bits=row*height
header=struct.pack('<2sIHHI',b'BM',54+len(bits),0,0,54)+struct.pack('<IiiHHIIiiII',40,width,height,1,24,0,len(bits),0,0,0,0)
Path('tests/fixtures/toolbar/strip.bmp').write_bytes(header+bits)
PY
toolbar_build_dir=$(mktemp -d)
trap 'rm -rf "$toolbar_build_dir"' EXIT
i686-w64-mingw32-windres -I tests/fixtures/toolbar -i tests/fixtures/toolbar/resources.rc -O coff -o "$toolbar_build_dir/resources.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-ident -fno-stack-protector -Wall -Wextra -Werror -nostdlib -shared -Wl,--no-insert-timestamp -Wl,--dynamicbase -Wl,--entry,_DllMain@12 -Wl,--kill-at tests/fixtures/toolbar/library.c "$toolbar_build_dir/resources.o" -o tests/fixtures/toolbar/toolbar-resources.dll -lkernel32 -luser32 -lcomctl32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-ident -fno-stack-protector -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console tests/fixtures/toolbar/client.c -o tests/fixtures/toolbar/toolbar.exe -lkernel32 -luser32

i686-w64-mingw32-strip --strip-all tests/fixtures/toolbar/toolbar.exe tests/fixtures/toolbar/toolbar-resources.dll
python3 - <<'PY'
from pathlib import Path
for name in ['toolbar.exe','toolbar-resources.dll']:
 p=Path('tests/fixtures/toolbar')/name
 data=bytearray(p.read_bytes());pe=int.from_bytes(data[0x3c:0x40],'little')
 data[pe+8:pe+12]=bytes(4);data[pe+88:pe+92]=bytes(4);p.write_bytes(data)
PY
