#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
  -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--entry,_mainCRTStartup \
  -Wl,--subsystem,console tests/fixtures/mmio/main.c \
  -o tests/fixtures/mmio/mmio.exe -lwinmm -luser32 -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/mmio/mmio.exe
python3 - <<'PY'
from pathlib import Path
import struct
def chunk(tag, data):
    return tag + struct.pack('<I', len(data)) + data + bytes(len(data) & 1)
fmt = struct.pack('<HHIIHH', 1, 1, 22050, 22050, 1, 8)
data = bytes(i & 255 for i in range(10001))
body = b'WAVE' + chunk(b'JUNK', b'odd') + chunk(b'fmt ', fmt)
body += chunk(b'LIST', b'INFO' + chunk(b'INAM', b'fixture\0'))
body += chunk(b'data', data)
Path('tests/fixtures/mmio/tone.wav').write_bytes(b'RIFF' + struct.pack('<I', len(body)) + body)
PY
