#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
from pathlib import Path
import json
vectors=json.loads(Path('tests/fixtures/x87-remainder-vectors.json').read_text())['vectors']
array=lambda x:'{'+','.join(str(b) for b in bytes.fromhex(x))+'}'
text='// Generated from the independent rational oracle. SPDX-License-Identifier: MIT\nstruct vector { unsigned char a[10],b[10],result[10],nearest,quotient; unsigned short status; };\nstatic const struct vector vectors[]={\n'
for v in vectors:
 exponent=int.from_bytes(bytes.fromhex(v['a'])[8:],'little')&0x7fff
 quotient=int(not(v['status']&1) and exponent!=0x7fff)
 text+='{'+','.join([array(v['a']),array(v['b']),array(v['result']),str(int(v['nearest'])),str(quotient),str(v['status'])])+'},\n'
text+='};\n'
Path('tests/fixtures/x87-remainder/vectors.h').write_text(text)
PY
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/x87-remainder/main.c -o tests/fixtures/x87-remainder/remainder.exe -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/x87-remainder/remainder.exe
python3 - <<'PY'
from pathlib import Path
p=Path('tests/fixtures/x87-remainder/remainder.exe')
b=bytearray(p.read_bytes());pe=int.from_bytes(b[0x3c:0x40],'little')
b[pe+8:pe+12]=bytes(4);b[pe+88:pe+92]=bytes(4);p.write_bytes(b)
PY
