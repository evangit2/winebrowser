#!/usr/bin/env python3
"""Build a browser ES module from pinned vkd3d-shader 2.1."""

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE_URL = "https://dl.winehq.org/vkd3d/source/vkd3d-2.1.tar.xz"
SOURCE_SHA256 = "7510146aff2adfb4ae07ab890701a607e5ff7c66e57100cfc9f630ec92eeda6a"
SPIRV_REVISION = "04fd3caa1e8267e4d95c806cad901181728e1006"
VULKAN_REVISION = "ee2ec5fd83dafce291024683b50dc89219333076"
SPIRV_URL = "https://github.com/KhronosGroup/SPIRV-Headers.git"
VULKAN_URL = "https://github.com/KhronosGroup/Vulkan-Headers.git"
CACHE = ROOT / ".cache/vkd3d-dxbc"
PUBLIC = ROOT / "public/shaders"
BRIDGE = ROOT / "runtime/shaders/vkd3d/bridge.c"
BRIDGE_LICENSE = ROOT / "runtime/shaders/vkd3d/BRIDGE-LICENSE"
VKD3D_PATCH = ROOT / "runtime/shaders/vkd3d/webgpu-vertex-point-size.patch"
MANIFEST = ROOT / "runtime/shaders/vkd3d/manifest.json"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact(path):
    return {"bytes": path.stat().st_size, "sha256": digest(path)}


def git_revision(path):
    return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()


def run(label, command, cwd, env):
    log = CACHE / f"{label}.log"
    print(f"{label}: {' '.join(map(str, command))}", flush=True)
    with log.open("w") as output:
        result = subprocess.run(list(map(str, command)), cwd=cwd, env=env,
                                stdout=output, stderr=subprocess.STDOUT, check=False)
    if result.returncode:
        tail = "\n".join(log.read_text(errors="replace").splitlines()[-35:])
        raise RuntimeError(f"{label} failed ({result.returncode}); {log}\n{tail}")


def publish_sources(archive, spirv, vulkan):
    """Ship exact LGPL source and the original bridge/relink script with Wasm."""
    source_public = PUBLIC / "source"
    source_public.mkdir(parents=True, exist_ok=True)
    originals = {
        "vkd3d-2.1.tar.xz": archive,
        "bridge.c": BRIDGE,
        "build-shader-dxbc.py": pathlib.Path(__file__),
        "COPYING": PUBLIC / "vkd3d-COPYING",
        "LICENSE": PUBLIC / "vkd3d-LICENSE",
        "BRIDGE-LICENSE": BRIDGE_LICENSE,
        "webgpu-vertex-point-size.patch": VKD3D_PATCH,
        "SPIRV-Headers-LICENSE": spirv / "LICENSE",
        "Vulkan-Headers-LICENSE.md": vulkan / "LICENSE.md",
    }
    result = {}
    for name, original in originals.items():
        destination = source_public / name
        shutil.copyfile(original, destination)
        result[name] = {"path": str(destination.relative_to(ROOT)), **artifact(destination)}
    return result


def header_manifest(source_bundle):
    return {
        "spirvRevision": SPIRV_REVISION,
        "spirvURL": SPIRV_URL,
        "spirvLicense": source_bundle["SPIRV-Headers-LICENSE"],
        "vulkanRevision": VULKAN_REVISION,
        "vulkanURL": VULKAN_URL,
        "vulkanLicense": source_bundle["Vulkan-Headers-LICENSE.md"],
    }


def main():
    sibling = ROOT.parent / "directwebgpu-wined3d/vendor"
    emsdk_default = ROOT.parent / "directxbrowser/vendor/emsdk"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-archive", type=pathlib.Path,
                        help="Use a local copy of the pinned archive instead of downloading it")
    parser.add_argument("--source-only", action="store_true",
                        help="Publish source/relink materials and refresh manifest without rebuilding Wasm")
    parser.add_argument("--emsdk", type=pathlib.Path,
                        default=pathlib.Path(os.environ.get("EMSDK", emsdk_default)))
    parser.add_argument("--spirv-headers", type=pathlib.Path,
                        default=pathlib.Path(os.environ.get("SPIRV_HEADERS", sibling / "spirv-headers")))
    parser.add_argument("--vulkan-headers", type=pathlib.Path,
                        default=pathlib.Path(os.environ.get("VULKAN_HEADERS", sibling / "vulkan-headers")))
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    archive = CACHE / "vkd3d-2.1.tar.xz"
    if args.source_archive:
        supplied = args.source_archive.resolve()
        if supplied != archive.resolve():
            shutil.copyfile(supplied, archive)
    elif not archive.exists():
        print(f"Downloading {SOURCE_URL}", flush=True)
        urllib.request.urlretrieve(SOURCE_URL, archive)
    if digest(archive) != SOURCE_SHA256:
        raise RuntimeError(f"vkd3d archive SHA-256 mismatch: {archive}")

    spirv = args.spirv_headers.resolve()
    vulkan = args.vulkan_headers.resolve()
    for path, revision in [(spirv, SPIRV_REVISION), (vulkan, VULKAN_REVISION)]:
        if git_revision(path) != revision:
            raise RuntimeError(f"Header checkout at {path} is not pinned to {revision}")

    if args.source_only:
        if not MANIFEST.is_file():
            raise RuntimeError("Build the compiler before using --source-only")
        manifest = json.loads(MANIFEST.read_text())
        for name, expected in manifest["artifacts"].items():
            if artifact(PUBLIC / name) != expected:
                raise RuntimeError(f"Published artifact differs from manifest: {name}")
        manifest["buildScript"] = {"path": "scripts/build-shader-dxbc.py", **artifact(pathlib.Path(__file__))}
        manifest["sourceBundle"] = publish_sources(archive, spirv, vulkan)
        manifest["headers"] = header_manifest(manifest["sourceBundle"])
        manifest["sourceRetention"] = "public/shaders/source/vkd3d-2.1.tar.xz"
        manifest["cacheSourceArchive"] = ".cache/vkd3d-dxbc/vkd3d-2.1.tar.xz"
        MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"Published source/relink materials; manifest {MANIFEST}")
        return

    emsdk = args.emsdk.resolve()
    emcc = emsdk / "upstream/emscripten/emcc"
    emconfigure = emsdk / "upstream/emscripten/emconfigure"
    emmake = emsdk / "upstream/emscripten/emmake"
    for tool in [emcc, emconfigure, emmake]:
        if not tool.is_file():
            raise RuntimeError(f"Missing Emscripten tool: {tool}; pass --emsdk")
    version = subprocess.check_output([str(emcc), "--version"], text=True).splitlines()[0]

    source = CACHE / "source/vkd3d-2.1"
    if source.parent.exists():
        shutil.rmtree(source.parent)
    source.parent.mkdir()
    with tarfile.open(archive, "r:xz") as package:
        for member in package.getmembers():
            target = (source.parent / member.name).resolve()
            if not target.is_relative_to(source.parent.resolve()):
                raise RuntimeError("Pinned source archive has an unsafe path")
        if hasattr(tarfile, "data_filter"):
            package.extractall(source.parent, filter="data")
        else:
            # The exact SHA-256 has already been verified before extraction.
            package.extractall(source.parent)
    if not (source / "configure").is_file():
        raise RuntimeError("Pinned vkd3d archive has no configure script")
    run("patch", ["patch", "-p1", "-i", VKD3D_PATCH], source, dict(os.environ))
    build = CACHE / "build"
    if build.exists():
        shutil.rmtree(build)
    build.mkdir()
    # Autoconf executes Emscripten's extensionless Node conftest scripts. This
    # repository is ESM, so give only the ignored build directory CJS scope.
    (build / "package.json").write_text('{"type":"commonjs"}\n')
    env = dict(os.environ)
    extra_paths = [str(emsdk / "upstream/emscripten")]
    for candidate in ["/opt/homebrew/opt/bison/bin", "/opt/homebrew/opt/flex/bin"]:
        if pathlib.Path(candidate).is_dir():
            extra_paths.append(candidate)
    env["PATH"] = os.pathsep.join(extra_paths + [env.get("PATH", "")])
    env["EM_CONFIG"] = str(emsdk / ".emscripten")
    env["CPPFLAGS"] = f"-I{spirv / 'include'} -I{vulkan / 'include'}"
    env["PTHREAD_LIBS"] = "-pthread"
    env["SONAME_LIBVULKAN"] = "libvulkan.so"
    run("configure", [emconfigure, source / "configure", "--disable-demos", "--disable-tests",
                      "--without-opengl", "--without-ncurses", "--without-xcb",
                      "--without-spirv-tools", "WIDL=no"], build, env)
    run("version-header", [emmake, "make", "include/private/vkd3d_version.h"], build, env)
    run("library", [emmake, "make", "-j4", "libvkd3d-shader.la"], build, env)

    output = PUBLIC / "vkd3d-shader.js"
    exports = ["_malloc", "_free", "_wb_dxbc_compile", "_wb_result_ptr",
               "_wb_result_size", "_wb_messages_ptr", "_wb_clear",
               "_wb_root_signature_serialize", "_wb_root_signature_validate",
               "_wb_root_signature_flags", "_wb_d3dbc_compile_pair",
               "_wb_d3dbc_result_ptr", "_wb_d3dbc_result_size"]
    run("bundle", [emcc, "-O2", "-DNDEBUG", "-DVKD3D_NO_TRACE_MESSAGES",
                   "-DVKD3D_NO_DEBUG_MESSAGES", f"-I{source / 'include'}",
                   f"-I{source / 'include/private'}", f"-I{build / 'include'}", BRIDGE,
                   build / ".libs/libvkd3d-shader.a", build / ".libs/libvkd3d-common.a",
                   "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=web,worker,node",
                   "-sFILESYSTEM=0", "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=16777216",
                   "-sMAXIMUM_MEMORY=134217728", "-sSTACK_SIZE=1048576",
                   "-sEXPORTED_FUNCTIONS=" + json.dumps(exports, separators=(",", ":")),
                   "-sEXPORTED_RUNTIME_METHODS=[\"UTF8ToString\",\"HEAPU8\"]",
                   "-o", output], ROOT, env)
    wasm = PUBLIC / "vkd3d-shader.wasm"
    if not wasm.is_file():
        raise RuntimeError("Emscripten did not emit vkd3d-shader.wasm")
    license_files = {}
    for name in ["COPYING", "LICENSE"]:
        destination = PUBLIC / f"vkd3d-{name}"
        shutil.copyfile(source / name, destination)
        license_files[destination.name] = artifact(destination)
    source_bundle = publish_sources(archive, spirv, vulkan)
    MANIFEST.write_text(json.dumps({
        "source": {"url": SOURCE_URL, "archiveSha256": SOURCE_SHA256,
                   "archiveBytes": archive.stat().st_size, "version": "2.1",
                   "patches": [{"path": "runtime/shaders/vkd3d/webgpu-vertex-point-size.patch",
                                **artifact(VKD3D_PATCH)}]},
        "headers": header_manifest(source_bundle),
        "toolchain": {"emscripten": version},
        "bridge": {"path": "runtime/shaders/vkd3d/bridge.c", **artifact(BRIDGE)},
        "buildScript": {"path": "scripts/build-shader-dxbc.py", **artifact(pathlib.Path(__file__))},
        "artifacts": {"vkd3d-shader.js": artifact(output),
                      "vkd3d-shader.wasm": artifact(wasm), **license_files},
        "sourceBundle": source_bundle,
        "sourceRetention": "public/shaders/source/vkd3d-2.1.tar.xz",
        "cacheSourceArchive": ".cache/vkd3d-dxbc/vkd3d-2.1.tar.xz",
    }, indent=2) + "\n")
    print(f"Built {wasm} ({wasm.stat().st_size} bytes); manifest {MANIFEST}")


if __name__ == "__main__":
    main()
