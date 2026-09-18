#!/usr/bin/env python3
"""Build the opt-in Wine browser-loader ntdll in .cache; publish no DLL."""

import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
REVISION = "db11d0fe6a169c457e23d007e20404643d067aa8"
ARCHIVE_SHA256 = "18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a"
ARCHIVE_URL = f"https://codeload.github.com/wine-mirror/wine/tar.gz/{REVISION}"
ARCHIVE = CACHE / "wine-db11d0fe-source.tar.gz"
PATCH = ROOT / "runtime/wine/browser-loader.patch"
TARGET = "dlls/ntdll/i386-windows/ntdll.dll"


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def tool_version(command):
    return subprocess.check_output(
        [*shlex.split(command), "--version"], text=True, stderr=subprocess.STDOUT
    ).splitlines()[0]


def find_bison():
    candidates = [os.environ["BISON"]] if os.environ.get("BISON") else []
    candidates.extend(
        candidate
        for candidate in [
            shutil.which("bison"),
            "/opt/homebrew/opt/bison/bin/bison",
            "/usr/local/opt/bison/bin/bison",
        ]
        if candidate
    )
    for candidate in candidates:
        if not pathlib.Path(candidate).exists():
            continue
        version = tool_version(candidate)
        match = re.search(r"\b(\d+)\.(\d+)(?:\.\d+)?\b", version)
        if match and tuple(map(int, match.groups())) >= (3, 0):
            return candidate, version
    raise RuntimeError("Wine requires Bison 3.0+; set BISON to an installed executable")


def run_logged(command, cwd, log, env=None):
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        tail = "\n".join(log.read_text(errors="replace").splitlines()[-25:])
        raise RuntimeError(f"{' '.join(map(str, command))} failed; see {log}\n{tail}")


def makefile_value(path, name):
    match = re.search(rf"^{re.escape(name)}\s*=\s*(.+)$", path.read_text(), re.MULTILINE)
    if not match:
        raise RuntimeError(f"Configured Makefile lacks {name}")
    return match.group(1).strip()


def verify_pe(path):
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise RuntimeError("ntdll build did not produce a PE image")
    offset = int.from_bytes(data[0x3C:0x40], "little")
    if data[offset : offset + 4] != b"PE\0\0" or data[offset + 4 : offset + 6] != b"\x4c\x01":
        raise RuntimeError("ntdll build did not produce an i386 PE image")
    objdump = shutil.which("i686-w64-mingw32-objdump")
    if not objdump:
        raise RuntimeError("i686-w64-mingw32-objdump is required to check bridge exports")
    exports = subprocess.check_output([objdump, "-p", str(path)], text=True)
    for symbol in ("__wine_syscall_dispatcher", "WineBrowserLoaderBootstrap"):
        if not re.search(rf"\b{re.escape(symbol)}\b", exports):
            raise RuntimeError(f"Patched ntdll is missing {symbol}")


def main():
    if not PATCH.is_file():
        raise FileNotFoundError(PATCH)
    patch_bytes = PATCH.read_bytes()
    patch_sha256 = hashlib.sha256(patch_bytes).hexdigest()
    if not shutil.which("i686-w64-mingw32-gcc"):
        raise RuntimeError("i686-w64-mingw32-gcc is required")
    bison, bison_version = find_bison()
    for tool in ("make", "tar", "patch"):
        if not shutil.which(tool):
            raise RuntimeError(f"{tool} is required")

    CACHE.mkdir(parents=True, exist_ok=True)
    if not ARCHIVE.exists():
        temporary = ARCHIVE.with_suffix(".download")
        with urllib.request.urlopen(ARCHIVE_URL) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        if digest(temporary) != ARCHIVE_SHA256:
            temporary.unlink()
            raise RuntimeError("Downloaded Wine archive failed SHA-256 verification")
        temporary.replace(ARCHIVE)
    if digest(ARCHIVE) != ARCHIVE_SHA256:
        raise RuntimeError(f"Pinned Wine archive SHA-256 mismatch: {ARCHIVE}")

    job = CACHE / "wine-loader" / patch_sha256
    source = job / "source"
    build = job / "build"
    state = job / "source-state.json"
    patch_copy = job / "browser-loader.patch"
    job.mkdir(parents=True, exist_ok=True)
    patch_copy.write_bytes(patch_bytes)
    if not state.exists():
        temporary_source = job / "source.tmp"
        if temporary_source.exists():
            shutil.rmtree(temporary_source)
        if source.exists():
            shutil.rmtree(source)
        temporary_source.mkdir()
        run_logged(
            ["tar", "-xzf", str(ARCHIVE), "--strip-components=1", "-C", str(temporary_source)],
            job,
            job / "extract.log",
        )
        run_logged(["patch", "--batch", "-p1", "-i", str(patch_copy)], temporary_source, job / "patch.log")
        temporary_source.rename(source)
        state.write_text(json.dumps({"revision": REVISION, "archiveSha256": ARCHIVE_SHA256, "patchSha256": patch_sha256}, indent=2) + "\n")
    else:
        expected = {"revision": REVISION, "archiveSha256": ARCHIVE_SHA256, "patchSha256": patch_sha256}
        if json.loads(state.read_text()) != expected or not source.is_dir():
            raise RuntimeError(f"Inconsistent Wine loader source cache: {job}")

    build.mkdir(exist_ok=True)
    env = os.environ.copy()
    env["BISON"] = bison
    env["SOURCE_DATE_EPOCH"] = "0"
    configure = [str(source / "configure"), "--enable-archs=i386", "--disable-tests"]
    if not (build / "Makefile").exists():
        run_logged(configure, build, job / "configure.log", env)
    makefile = build / "Makefile"
    if makefile_value(makefile, "PE_ARCHS").split() != ["i386"]:
        raise RuntimeError("Wine configure did not select only i386 PE output")
    make = ["make", "-j4", TARGET]
    run_logged(make, build, job / "build.log", env)
    output = build / TARGET
    verify_pe(output)
    native_cc = makefile_value(makefile, "CC")
    cross_cc = makefile_value(makefile, "i386_CC")
    manifest_root = CACHE / "wine-loader"
    manifest = {
        "sourceRevision": REVISION,
        "sourceUrl": ARCHIVE_URL,
        "sourceSha256": ARCHIVE_SHA256,
        "patch": "runtime/wine/browser-loader.patch",
        "patchSha256": patch_sha256,
        "configure": configure,
        "make": make,
        "compilers": {"native": tool_version(native_cc), "i386": tool_version(cross_cc)},
        "bison": bison_version,
        "artifactPathBase": "manifest-directory",
        "artifact": {
            "path": str(output.relative_to(manifest_root)),
            "sha256": digest(output),
            "bytes": output.stat().st_size,
        },
    }
    stable_manifest = manifest_root / "manifest.json"
    temporary_manifest = stable_manifest.with_suffix(".tmp")
    temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary_manifest.replace(stable_manifest)
    print(f"Built {output} ({manifest['artifact']['bytes']} bytes, SHA-256 {manifest['artifact']['sha256']})")
    print(f"Manifest: {stable_manifest}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"build-wine-loader: {error}", file=sys.stderr)
        sys.exit(1)
