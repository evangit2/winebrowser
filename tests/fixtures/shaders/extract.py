"""Recreate the two DXBC blobs embedded in pinned Wine's D3D12 test."""

from hashlib import sha256
import json
from pathlib import Path
import re
import struct

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "d3d12.c"
REVISION = "db11d0fe6a169c457e23d007e20404643d067aa8"
SOURCE_SHA256 = "052ac26aa54e7122df25e1fde05f9f6ad227f67ffa4a540a1c5bf75c583e92c8"


def extract_array(source: str, name: str) -> bytes:
    expression = rf"static const DWORD {name}\[\]\s*=\s*\{{(.*?)\n\s*\}};"
    match = re.search(expression, source, flags=re.DOTALL)
    if not match:
        raise ValueError(f"missing Wine shader array {name}")
    body = re.sub(r"#if 0\b.*?#endif", "", match.group(1), flags=re.DOTALL)
    words = [int(value, 16) for value in re.findall(r"0x[0-9a-fA-F]+", body)]
    data = struct.pack(f"<{len(words)}I", *words)
    if data[:4] != b"DXBC" or int.from_bytes(data[24:28], "little") != len(data):
        raise ValueError(f"Wine {name} is not a complete DXBC container")
    return data


def main() -> None:
    original = SOURCE.read_bytes()
    if sha256(original).hexdigest() != SOURCE_SHA256:
        raise ValueError("retained Wine d3d12.c differs from pinned source")
    text = original.decode("utf-8")
    shaders = []
    for array, path, stage, profile in (
        ("vs_code", "fullscreen.vs.dxbc", "vertex", "vs_5_0"),
        ("ps_code", "green.ps.dxbc", "pixel", "ps_5_0"),
    ):
        data = extract_array(text, array)
        (HERE / path).write_bytes(data)
        shaders.append({
            "array": array,
            "path": path,
            "stage": stage,
            "profile": profile,
            "bytes": len(data),
            "sha256": sha256(data).hexdigest(),
        })
    manifest = {
        "format": 1,
        "upstream": "Wine 11.0 d3d12/tests/d3d12.c",
        "wineRevision": REVISION,
        "sourceSha256": SOURCE_SHA256,
        "license": "LGPL-2.1-or-later; see COPYING.LIB and retained d3d12.c",
        "shaderBlobs": shaders,
        "spirvEntryPointWhenCompiled": "main",
        "expected": {
            "geometry": "SV_VertexID full-screen triangle; no vertex buffer",
            "pixelColorRGBA8": [0, 255, 0, 255],
            "viewportTest": "green inside inset viewport, unchanged background outside",
        },
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(json.dumps(shaders, indent=2))


if __name__ == "__main__":
    main()
