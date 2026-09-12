#!/usr/bin/env python3
"""Build unchanged Wine CommandLineToArgvW as guest x86 code."""

import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
WINE_REVISION = "db11d0fe6a169c457e23d007e20404643d067aa8"
SOURCE_SHA256 = "e40345999415a7d83bc934087df93b79311831fdfebf52d816f45110df4f6ffb"


def main():
    source = ROOT / "third_party/wine/shcore-main.c"
    source_bytes = source.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != SOURCE_SHA256:
        raise ValueError("Wine source differs from the pinned revision")
    text = source_bytes.decode()
    start = text.index("WCHAR** WINAPI CommandLineToArgvW(")
    end = text.index("\nstruct shstream", start)
    header = text[:text.index("#include")]
    # Retain the complete function body and original copyright/license header.
    unit = (
        header
        + "\n/* WineBrowser extraction: only build CommandLineToArgvW; use MinGW Windows declarations. */\n"
        + "#include <windows.h>\n"
        + text[start:end]
    )
    output = ROOT / "runtime/wine"
    output.mkdir(exist_ok=True, parents=True)
    public = ROOT / "public/runtime"
    public.mkdir(exist_ok=True, parents=True)
    (output / "command-line.c").write_text(unit)
    (output / "shell32.def").write_text(
        "LIBRARY shell32\nEXPORTS\nCommandLineToArgvW=CommandLineToArgvW@8\n"
    )
    subprocess.run(
        [
            "i686-w64-mingw32-gcc", "-shared", "-nostdlib", "-O1",
            "-fno-builtin", "-fno-ident", "-fno-stack-protector", "-mno-sse",
            "-Wl,--no-insert-timestamp", "-Wl,--entry,0",
            "-Wl,--image-base,0x10000000", "-o", str(public / "shell32.dll"),
            str(output / "command-line.c"), str(output / "shell32.def"), "-lkernel32",
        ],
        check=True,
    )
    manifest = {
        "wineRevision": WINE_REVISION,
        "wineVersion": "11.0",
        "source": "third_party/wine/shcore-main.c",
        "sourceSha256": SOURCE_SHA256,
        "scope": "Unchanged CommandLineToArgvW function only; not full shell32 or Wine",
        "dllSha256": hashlib.sha256((public / "shell32.dll").read_bytes()).hexdigest(),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (public / "COPYING.LIB").write_bytes((source.parent / "COPYING.LIB").read_bytes())


if __name__ == "__main__":
    main()
