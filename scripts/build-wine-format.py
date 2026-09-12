#!/usr/bin/env python3
"""Build Wine's unchanged wsprintf functions as a small guest x86 DLL."""

import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
WINE_REVISION = "db11d0fe6a169c457e23d007e20404643d067aa8"
SOURCE = ROOT / "third_party/wine/user32-wsprintf.c"
SOURCE_SHA256 = "e00663b26d1f8290afc1e6ad01a2c6e7d7d58170159701b0f8fea0916ed4d421"
COPYING = ROOT / "third_party/wine/COPYING.LIB"
COPYING_SHA256 = "e237fa56668030e928551ddd60f05df5fe957f75eab874bbd017e085ed722e7c"
GCC_LICENSES = {
    "COPYING3": "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
    "COPYING.RUNTIME": "9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74",
}
RUNTIME = ROOT / "runtime/wine-format"
PUBLIC = ROOT / "public/runtime"
EXPECTED_IMPORTS = [
    "IsDBCSLeadByte",
    "MultiByteToWideChar",
    "WideCharToMultiByte",
]
EXPECTED_EXPORTS = ["wsprintfA", "wsprintfW", "wvsprintfA", "wvsprintfW"]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def normalize_pe(path):
    data = bytearray(path.read_bytes())
    if data[:2] != b"MZ":
        raise ValueError("MinGW did not emit a PE image")
    pe_offset = int.from_bytes(data[0x3C:0x40], "little")
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise ValueError("Invalid PE signature")
    coff = pe_offset + 4
    optional = coff + 20
    if int.from_bytes(data[coff : coff + 2], "little") != 0x14C:
        raise ValueError("Expected an i386 PE image")
    # COFF timestamp and OptionalHeader.CheckSum are build-dependent metadata.
    data[coff + 4 : coff + 8] = bytes(4)
    data[optional + 64 : optional + 68] = bytes(4)
    path.write_bytes(data)


def main():
    source_bytes = SOURCE.read_bytes()
    if sha256(source_bytes) != SOURCE_SHA256:
        raise ValueError("Wine formatter source differs from its pinned revision")
    copying_bytes = COPYING.read_bytes()
    if sha256(copying_bytes) != COPYING_SHA256:
        raise ValueError("Wine LGPL text differs from the pinned revision")
    for name, expected in GCC_LICENSES.items():
        if sha256((ROOT / "third_party/gcc" / name).read_bytes()) != expected:
            raise ValueError(f"GCC license notice {name} differs from its pinned version")

    compiler = os.environ.get("CC", "i686-w64-mingw32-gcc")
    strip = os.environ.get("STRIP", "i686-w64-mingw32-strip")
    objdump = os.environ.get("OBJDUMP", "i686-w64-mingw32-objdump")
    RUNTIME.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    def_file = RUNTIME / "wine-format.def"
    compile_header = RUNTIME / "include/wine/debug.h"
    support = RUNTIME / "freestanding.c"
    license_dest = RUNTIME / "COPYING.LIB"
    if not def_file.exists() or not compile_header.exists() or not support.exists():
        raise FileNotFoundError("Wine formatter compatibility/build files are missing")
    shutil.copyfile(COPYING, license_dest)
    for name in GCC_LICENSES:
        notice = ROOT / "third_party/gcc" / name
        shutil.copyfile(notice, RUNTIME / name)
        shutil.copyfile(notice, PUBLIC / name)

    with tempfile.TemporaryDirectory(prefix="winebrowser-wine-format-") as temporary:
        dll = pathlib.Path(temporary) / "wine-format.dll"
        linker_map = pathlib.Path(temporary) / "wine-format.map"
        env = os.environ.copy()
        env["SOURCE_DATE_EPOCH"] = "0"
        compiler_version = subprocess.check_output(
            [compiler, "--version"], text=True, env=env
        ).splitlines()[0]
        command = [
            compiler,
            "-shared",
            "-nostdlib",
            "-O1",
            "-fno-builtin",
            "-fno-ident",
            "-fno-stack-protector",
            "-mno-sse",
            "-DWINUSERAPI=",
            f"-I{RUNTIME / 'include'}",
            "-Wl,--kill-at",
            "-Wl,--no-insert-timestamp",
            "-Wl,--enable-reloc-section",
            "-Wl,--dynamicbase",
            "-Wl,--entry,0",
            "-Wl,--image-base,0x10000000",
            "-Wl,--subsystem,windows",
            f"-Wl,-Map,{linker_map}",
            "-o",
            str(dll),
            str(SOURCE),
            str(support),
            str(def_file),
            "-lkernel32",
            "-lgcc",
        ]
        subprocess.run(command, check=True, cwd=ROOT, env=env)
        map_text = linker_map.read_text()
        for runtime_object, symbol in [
            ("_udivdi3.o", "__udivdi3"),
            ("_umoddi3.o", "__umoddi3"),
        ]:
            if f"libgcc.a({runtime_object})" not in map_text or symbol not in map_text:
                raise ValueError(f"Expected statically linked libgcc object {runtime_object}")
        subprocess.run([strip, "--strip-all", str(dll)], check=True, env=env)
        normalize_pe(dll)

        details = subprocess.check_output([objdump, "-p", str(dll)], text=True)
        imported_dlls = re.findall(r"^\s*DLL Name: (.+)$", details, re.MULTILINE)
        if imported_dlls != ["KERNEL32.dll"]:
            raise ValueError(f"Unexpected formatter DLL import set: {imported_dlls}")
        for symbol in EXPECTED_IMPORTS + EXPECTED_EXPORTS:
            if not re.search(rf"\b{re.escape(symbol)}\b", details):
                raise ValueError(f"Missing expected DLL symbol: {symbol}")
        if re.search(r"DLL Name: (?:msvcrt|ucrtbase|vcruntime)", details, re.IGNORECASE):
            raise ValueError("Formatter DLL unexpectedly imports a CRT")
        if "Subsystem\t\t00000002\t(Windows GUI)" not in details:
            raise ValueError("Formatter DLL should use the Windows GUI subsystem")

        output = PUBLIC / "wine-format.dll"
        shutil.copyfile(dll, output)
        manifest = {
            "wineVersion": "11.0",
            "wineRevision": WINE_REVISION,
            "source": "third_party/wine/user32-wsprintf.c",
            "sourceUrl": f"https://github.com/wine-mirror/wine/blob/{WINE_REVISION}/dlls/user32/wsprintf.c",
            "sourceSha256": SOURCE_SHA256,
            "license": "LGPL-2.1-or-later",
            "licenseFile": "third_party/wine/COPYING.LIB",
            "licenseSha256": COPYING_SHA256,
            "scope": "Unchanged wsprintfA/W and wvsprintfA/W function bodies only; not full user32 or Wine.",
            "compiler": compiler_version,
            "libgccRuntime": {
                "gccRelease": "16.1.0",
                "objects": ["__udivdi3", "__umoddi3"],
                "license": "GPL-3.0-or-later WITH GCC-exception-3.1",
                "notices": {
                    name: {
                        "path": f"third_party/gcc/{name}",
                        "sha256": digest,
                        "url": f"https://github.com/gcc-mirror/gcc/blob/releases/gcc-16.1.0/{name}",
                    }
                    for name, digest in GCC_LICENSES.items()
                },
            },
            "exports": EXPECTED_EXPORTS,
            "imports": [f"KERNEL32.dll!{name}" for name in EXPECTED_IMPORTS],
            "crtImports": [],
            "dllSha256": sha256(output.read_bytes()),
            "dllBytes": output.stat().st_size,
        }
        (RUNTIME / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"Built {output} ({manifest['dllBytes']} bytes, SHA-256 {manifest['dllSha256']})")


if __name__ == "__main__":
    main()
