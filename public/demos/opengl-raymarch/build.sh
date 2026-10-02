#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output="$1"
tmp_dir=$(mktemp -d /tmp/winebrowser-opengl.XXXXXX)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
python3 - "$source_dir" "$tmp_dir/shaders.h" <<'PY'
from pathlib import Path
import json,sys
source,target=map(Path,sys.argv[1:])
target.write_text('\n'.join('static const char *'+name+' = '+json.dumps((source / file).read_text())+';'
    for name,file in [('scene_vert','scene.vert'),('scene_frag','scene.frag')])+'\n')
PY
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -mfpmath=387 -mno-sse -mno-sse2 \
  -ffreestanding -fno-builtin -fno-tree-loop-distribute-patterns -fno-stack-protector \
  -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -I "$tmp_dir" \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat \
  -Wl,--image-base,0x400000 -Wl,--entry,_mainCRTStartup -Wl,--subsystem,windows \
  -o "$tmp_dir/demo.exe" "$source_dir/main.c" -lopengl32 -lgdi32 -luser32 -lkernel32
i686-w64-mingw32-strip --strip-all "$tmp_dir/demo.exe"
python3 - "$tmp_dir/demo.exe" "$output" <<'PY'
from pathlib import Path
import sys
data=bytearray(Path(sys.argv[1]).read_bytes())
offset=int.from_bytes(data[0x3c:0x40],'little')
data[offset+8:offset+12]=bytes(4)
data[offset+88:offset+92]=bytes(4)
Path(sys.argv[2]).write_bytes(data)
PY
