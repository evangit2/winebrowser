#!/usr/bin/env python3
"""Build and publish the pinned Berkeley SoftFloat ext80 browser module."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
REVISION = "a0c6494cdc11865811dec815d5c0049fba9d82a8"
SOURCE_URL = f"https://github.com/ucb-bar/berkeley-softfloat-3/archive/{REVISION}.tar.gz"
SOURCE_SHA256 = "1f719bcc8878be9627f6cfc44a0d6dbddf32bacc70ac81193bcbf2c62f97cbe9"
CACHE = ROOT / ".cache/softfloat"
RUNTIME = ROOT / "runtime/softfloat"
PUBLIC = ROOT / "public/runtime/softfloat"

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def artifact(path):
    return {"bytes": path.stat().st_size, "sha256": sha(path)}

def main():
    default_emsdk = ROOT.parent / "directxbrowser/vendor/emsdk"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emsdk", type=pathlib.Path,
                        default=pathlib.Path(os.environ.get("EMSDK", default_emsdk)))
    parser.add_argument("--source-archive", type=pathlib.Path)
    args = parser.parse_args()
    emcc = args.emsdk.resolve() / "upstream/emscripten/emcc"
    if not emcc.is_file():
        raise SystemExit(f"missing Emscripten compiler: {emcc}")

    CACHE.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    archive = CACHE / f"berkeley-softfloat-3-{REVISION[:7]}.tar.gz"
    if args.source_archive:
        supplied = args.source_archive.resolve()
        if supplied != archive.resolve(): shutil.copyfile(supplied, archive)
    elif not archive.exists():
        print(f"download: {SOURCE_URL}", flush=True)
        urllib.request.urlretrieve(SOURCE_URL, archive)
    if sha(archive) != SOURCE_SHA256:
        raise SystemExit(f"source archive SHA-256 mismatch: {archive}")

    source = CACHE / "source"
    if source.exists(): shutil.rmtree(source)
    source.mkdir()
    with tarfile.open(archive, "r:gz") as package:
        for member in package.getmembers():
            parts = pathlib.PurePosixPath(member.name).parts
            if len(parts) < 2 or ".." in parts:
                continue
            member.name = str(pathlib.PurePosixPath(*parts[1:]))
            package.extract(member, source, filter="data" if hasattr(tarfile, "data_filter") else None)

    # Follow the official 8086-SSE build's object lists. Some unused memory
    # implementations are intentionally incompatible with FAST_INT64.
    makefile = (source / "build/Linux-x86_64-GCC/Makefile").read_text()
    def object_names(variable):
        match = re.search(rf"{variable} = \\\n(.*?)(?=\n\n)", makefile, re.S)
        if not match: raise SystemExit(f"cannot parse upstream {variable}")
        return re.findall(r"([A-Za-z0-9_]+)\$\(OBJ\)", match.group(1))
    ordinary = object_names("OBJS_PRIMITIVES") + object_names("OBJS_OTHERS")
    specialized = object_names("OBJS_SPECIALIZE")
    sources = [source / "source" / f"{name}.c" for name in ordinary]
    sources += [source / "source/8086-SSE" / f"{name}.c" for name in specialized]
    exports = ["_malloc", "_free", "_wb_sf_init", "_wb_sf_binary", "_wb_sf_sqrt", "_wb_sf_round",
               "_wb_sf_from_f32", "_wb_sf_to_f32", "_wb_sf_from_f64", "_wb_sf_to_f64",
               "_wb_sf_from_i32", "_wb_sf_to_i32", "_wb_sf_from_i64", "_wb_sf_to_i64",
               "_wb_sf_compare", "_wb_sf_classify"]
    output = PUBLIC / "softfloat.js"
    env = dict(os.environ)
    env["EM_CONFIG"] = str(args.emsdk.resolve() / ".emscripten")
    command = [str(emcc), "-O3", "-DSOFTFLOAT_FAST_INT64", "-DSOFTFLOAT_ROUND_ODD",
               "-DINLINE_LEVEL=5", "-DSOFTFLOAT_FAST_DIV32TO16", "-DSOFTFLOAT_FAST_DIV64TO32",
               f"-I{source / 'build/Linux-x86_64-GCC'}", f"-I{source / 'source/8086-SSE'}",
               f"-I{source / 'source/include'}", str(RUNTIME / "adapter.c"),
               *map(str, sources), "-sMODULARIZE=1", "-sEXPORT_ES6=1",
               "-sENVIRONMENT=web,worker,node", "-sFILESYSTEM=0", "-sALLOW_MEMORY_GROWTH=1",
               "-sINITIAL_MEMORY=2097152", "-sSTACK_SIZE=65536", "-sMALLOC=emmalloc",
               "-sEXPORTED_FUNCTIONS=" + json.dumps(exports, separators=(",", ":")),
               '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', "-o", str(output)]
    log = CACHE / "build.log"
    print(f"build: {len(sources)} upstream C sources", flush=True)
    with log.open("w") as stream:
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=stream,
                                stderr=subprocess.STDOUT, check=False)
    if result.returncode:
        raise SystemExit("build failed:\n" + "\n".join(log.read_text().splitlines()[-40:]))

    source_public = PUBLIC / "source"
    source_public.mkdir(exist_ok=True)
    retained = {
        archive.name: archive,
        "COPYING.txt": source / "COPYING.txt",
        "README.md": source / "README.md",
        "adapter.c": RUNTIME / "adapter.c",
        "ADAPTER-LICENSE": RUNTIME / "ADAPTER-LICENSE",
        "test.mjs": RUNTIME / "test.mjs",
        "build-softfloat.py": pathlib.Path(__file__),
    }
    source_manifest = {}
    for name, path in retained.items():
        destination = source_public / name
        shutil.copyfile(path, destination)
        source_manifest[name] = {"path": str(destination.relative_to(ROOT)), **artifact(destination)}
    shutil.copyfile(source / "COPYING.txt", PUBLIC / "COPYING.txt")
    shutil.copyfile(RUNTIME / "ADAPTER-LICENSE", PUBLIC / "ADAPTER-LICENSE")
    shutil.copyfile(RUNTIME / "README.md", PUBLIC / "README.md")
    version = subprocess.check_output([str(emcc), "--version"], text=True).splitlines()[0]
    artifacts = {p.name: artifact(p) for p in [output, PUBLIC / "softfloat.wasm",
                 PUBLIC / "COPYING.txt", PUBLIC / "ADAPTER-LICENSE", PUBLIC / "README.md"]}
    manifest = {
        "source": {"name": "Berkeley SoftFloat Release 3e", "revision": REVISION,
                   "url": SOURCE_URL, "archiveSha256": SOURCE_SHA256, "patches": []},
        "toolchain": {"emscripten": version},
        "adapter": {"path": "runtime/softfloat/adapter.c", **artifact(RUNTIME / "adapter.c")},
        "buildScript": {"path": "scripts/build-softfloat.py", **artifact(pathlib.Path(__file__))},
        "artifacts": artifacts,
        "sourceBundle": source_manifest,
    }
    (RUNTIME / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copyfile(RUNTIME / "manifest.json", PUBLIC / "manifest.json")
    print(f"wasm: {artifact(PUBLIC / 'softfloat.wasm')}")
    print(f"js:   {artifact(output)}")

if __name__ == "__main__":
    main()
