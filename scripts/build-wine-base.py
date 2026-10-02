#!/usr/bin/env python3
"""Build and inventory the cache-only i386 Wine base DLL closure."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
LOADER_BUILDER = ROOT / "scripts/build-wine-loader.py"
LOADER_MANIFEST = ROOT / ".cache/wine-loader/manifest.json"
OUTPUT = ROOT / ".cache/wine-base/manifest.json"
NLS_MANIFEST = ROOT / "runtime/wine/nls-probe-manifest.json"
TARGETS = {
    "ntdll.dll": "dlls/ntdll/i386-windows/ntdll.dll",
    "kernelbase.dll": "dlls/kernelbase/i386-windows/kernelbase.dll",
    "kernel32.dll": "dlls/kernel32/i386-windows/kernel32.dll",
    "msvcrt.dll": "dlls/msvcrt/i386-windows/msvcrt.dll",
    "msacm32.dll": "dlls/msacm32/i386-windows/msacm32.dll",
    "ucrtbase.dll": "dlls/ucrtbase/i386-windows/ucrtbase.dll",
}


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def version(command):
    return subprocess.check_output(
        [command, "--version"], text=True, stderr=subprocess.STDOUT
    ).splitlines()[0]


def pe_details(path, objdump):
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise RuntimeError(f"not a PE image: {path}")
    offset = int.from_bytes(data[0x3C:0x40], "little")
    if data[offset : offset + 4] != b"PE\0\0" or data[offset + 4 : offset + 6] != b"\x4c\x01":
        raise RuntimeError(f"not an i386 PE image: {path}")
    output = subprocess.check_output([objdump, "-p", str(path)], text=True)
    imports = sorted(
        {match.lower() for match in re.findall(r"DLL Name: (\S+)", output)},
        key=str.lower,
    )
    if any(name not in TARGETS and name not in {"winmm.dll", "user32.dll", "advapi32.dll"} for name in imports):
        raise RuntimeError(f"{path.name} imports outside the base closure: {imports}")
    return {
        "path": str(path.relative_to(ROOT)),
        "sha256": digest(path),
        "bytes": path.stat().st_size,
        "machine": "i386-pe32",
        "imports": imports,
    }


def main():
    objdump = shutil.which("i686-w64-mingw32-objdump")
    make = shutil.which("make")
    if not objdump or not make:
        raise RuntimeError("make and i686-w64-mingw32-objdump are required")

    # This owns source download, hash verification, patching, configuration and
    # the browser-loader ntdll. Reusing it keeps one canonical Wine source cache.
    subprocess.run([sys.executable, str(LOADER_BUILDER)], cwd=ROOT, check=True)
    loader = json.loads(LOADER_MANIFEST.read_text())
    ntdll = (LOADER_MANIFEST.parent / loader["artifact"]["path"]).resolve()
    build = ntdll.parents[3]
    job = build.parent
    source = job / "source"
    if not build.is_relative_to(ROOT / ".cache/wine-loader") or not source.is_dir():
        raise RuntimeError("loader manifest points outside the verified Wine cache")

    command = [make, "-j4", *TARGETS.values()]
    env = os.environ.copy()
    env["SOURCE_DATE_EPOCH"] = "0"
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    log = OUTPUT.parent / "build.log"
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=build, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        tail = "\n".join(log.read_text(errors="replace").splitlines()[-25:])
        raise RuntimeError(f"Wine base build failed; see {log}\n{tail}")

    artifacts = {}
    for name, relative in TARGETS.items():
        path = build / relative
        if not path.is_file():
            raise RuntimeError(f"Wine build omitted {path}")
        artifacts[name] = pe_details(path, objdump)
    if artifacts["ntdll.dll"]["sha256"] != loader["artifact"]["sha256"]:
        raise RuntimeError("closure ntdll differs from the verified loader artifact")

    expected_nls = json.loads(NLS_MANIFEST.read_text())
    if expected_nls["wineCommit"] != loader["sourceRevision"]:
        raise RuntimeError("NLS and Wine source revisions differ")
    nls = {}
    for name, expected in expected_nls["files"].items():
        path = source / "nls" / name
        actual = {"bytes": path.stat().st_size, "sha256": digest(path)}
        if actual != expected:
            raise RuntimeError(f"pinned source NLS mismatch: {name}")
        nls[name] = {"path": str(path.relative_to(ROOT)), **actual}

    strip = shutil.which("i686-w64-mingw32-strip")
    if not strip:
        raise RuntimeError("i686-w64-mingw32-strip is required")
    runtime_dlls = []
    runtime_nls = []
    for name, target in TARGETS.items():
        destination = OUTPUT.parent / name
        temporary = destination.with_suffix(".tmp")
        subprocess.run([strip, "--strip-debug", "-o", str(temporary), str(build / target)], check=True)
        details = pe_details(temporary, objdump)
        temporary.replace(destination)
        runtime_dlls.append({"name": name, "path": name, "bytes": details["bytes"], "sha256": details["sha256"]})
    for name, info in nls.items():
        shutil.copyfile(ROOT / info["path"], OUTPUT.parent / name)
        runtime_nls.append({"name": name, "path": name, "bytes": info["bytes"], "sha256": info["sha256"]})
    runtime_manifest = {
        "sourceRevision": loader["sourceRevision"],
        "sourceUrl": loader["sourceUrl"],
        "sourceSha256": loader["sourceSha256"],
        "patchSha256": loader["patchSha256"],
        "artifactPathBase": "manifest-directory",
        "strip": version(strip),
        "dlls": runtime_dlls,
        "nls": runtime_nls,
        "scope": "Cache-only source-built base closure; not enabled in normal uploads or published.",
    }
    (OUTPUT.parent / "runtime.json").write_text(json.dumps(runtime_manifest, indent=2) + "\n")

    licenses = {}
    for name in ("LICENSE", "COPYING.LIB"):
        path = source / name
        licenses[name] = {
            "path": str(path.relative_to(ROOT)),
            "sha256": digest(path),
            "bytes": path.stat().st_size,
        }
    generator = source / "tools/make_unicode"
    manifest = {
        "scope": "Cache-only build inventory; no DLL or NLS file is published.",
        "sourceRevision": loader["sourceRevision"],
        "sourceUrl": loader["sourceUrl"],
        "sourceArchive": {
            "path": str((ROOT / ".cache/wine-db11d0fe-source.tar.gz").relative_to(ROOT)),
            "sha256": loader["sourceSha256"],
        },
        "patch": {"path": loader["patch"], "sha256": loader["patchSha256"]},
        "configure": loader["configure"],
        "make": ["make", "-j4", *TARGETS.values()],
        "toolchain": {
            **loader["compilers"],
            "bison": loader["bison"],
            "make": version(make),
            "objdump": version(objdump),
        },
        "artifacts": artifacts,
        "runtimeManifest": ".cache/wine-base/runtime.json",
        "licenses": licenses,
        "nls": {
            "published": False,
            "generator": {
                "path": str(generator.relative_to(ROOT)),
                "sha256": digest(generator),
            },
            "files": nls,
        },
    }
    temporary = OUTPUT.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary.replace(OUTPUT)
    print(f"Built cache-only Wine base closure: {OUTPUT}")
    for name, artifact in artifacts.items():
        print(f"{artifact['sha256']}  {artifact['bytes']:>8}  {name}  imports={','.join(artifact['imports']) or '-'}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"build-wine-base: {error}", file=sys.stderr)
        sys.exit(1)
