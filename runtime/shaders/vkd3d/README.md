# DXBC shader compiler

This optional browser module compiles arbitrary Direct3D shader-model 4/5 DXBC
containers and validated shader-model 1–3 token streams to SPIR-V through
libvkd3d-shader 2.1. The original `bridge.c` bounds input/output, selects the
corresponding vkd3d source type and `VKD3D_SHADER_TARGET_SPIRV_BINARY`, and
exposes the result. It does not substitute shader bytecode by application or
hash.

The vkd3d source archive originated at
[`vkd3d-2.1.tar.xz`](https://dl.winehq.org/vkd3d/source/vkd3d-2.1.tar.xz),
SHA-256 `7510146aff2adfb4ae07ab890701a607e5ff7c66e57100cfc9f630ec92eeda6a`.
The exact archive is also distributed at
[`public/shaders/source/vkd3d-2.1.tar.xz`](../../../public/shaders/source/vkd3d-2.1.tar.xz),
alongside copies of `bridge.c`, `build-shader-dxbc.py`, and both upstream
license files. The build script retains the same archive in `.cache/vkd3d-dxbc`
and extracts a clean source tree there. It applies the retained LGPL
`webgpu-vertex-point-size.patch`, which makes vkd3d's existing point-size
option cover vertex shaders because WGSL has no PointSize builtin. The built
library is LGPL-2.1 or later; its original `COPYING` and `LICENSE` also ship
next to the JS and Wasm artifacts. The bridge is MIT-licensed; its full license
ships as `public/shaders/source/BRIDGE-LICENSE`. [manifest.json](manifest.json)
records the archive, source delivery files, bridge, compiler, header revisions,
and their hashes.

The pinned SPIRV-Headers and Vulkan-Headers repositories contribute headers to
the build. Their exact upstream `LICENSE` and `LICENSE.md` notices are retained
as `public/shaders/source/SPIRV-Headers-LICENSE` and
`public/shaders/source/Vulkan-Headers-LICENSE.md`; the manifest records their
repository URLs, revisions, notice paths and hashes.

Rebuild with Emscripten 4.0.7, pinned SPIRV-Headers
`04fd3caa1e8267e4d95c806cad901181728e1006`, and Vulkan-Headers
`ee2ec5fd83dafce291024683b50dc89219333076`:

```sh
python3 scripts/build-shader-dxbc.py \
  --emsdk /path/to/emsdk \
  --spirv-headers /path/to/SPIRV-Headers \
  --vulkan-headers /path/to/Vulkan-Headers
```

The script downloads the pinned archive if it is absent; `--source-archive`
uses a local copy after checking the same SHA-256. Its default tool paths
discover the neighboring development checkouts when available. It emits an ES
module factory at `public/shaders/vkd3d-shader.js` and adjacent Wasm. In a
browser worker, import the JS by a same-origin absolute URL and call its
default factory with `locateFile: name => baseURL + name` so Emscripten locates
the Wasm under the deployed base path.

After documentation or source-delivery changes, `python3
scripts/build-shader-dxbc.py --source-only` refreshes the public source copies
and manifest while verifying, and leaving intact, the compiled JS and Wasm.

`_wb_dxbc_compile(ptr, length)` returns 1 on success and 0 on failure;
`_wb_result_ptr()` and `_wb_result_size()` expose the current SPIR-V bytes,
and `_wb_messages_ptr()` exposes a NUL-terminated diagnostic. Call `_wb_clear()`
after copying output. The caller owns buffers allocated with `_malloc` and
releases them with `_free`. Input is capped at 1 MiB, output at 16 MiB, and
the Wasm heap at 128 MiB. The bridge is synchronous and holds one result at a
time, so callers must serialize compilation per module instance.

`_wb_d3dbc_compile_pair(vs_ptr, vs_length, ps_ptr, ps_length)` accepts a
validated vertex/pixel pair in the legacy DWORD token format and compiles both
through `VKD3D_SHADER_SOURCE_D3D_BYTECODE`. Vertex versions 1.1, 2.0 and 3.0
and pixel versions 1.0–1.4, 2.0 and 3.0 are admitted; malformed stages,
versions, alignment, missing END tokens, unsupported descriptors, or inputs
over 1 MiB fail with a diagnostic. Pair compilation builds vkd3d's varying map
before either stage is exposed. `_wb_d3dbc_result_ptr(stage)` and
`_wb_d3dbc_result_size(stage)` return the SPIR-V for stage 0 (vertex) or 1
(pixel).

Legacy resources have an explicit WebGPU layout. Vertex resources use group 0
and pixel resources group 1. Float, integer and boolean constant files use
bindings 0, 1 and 2 respectively. For sampler register `s`, its texture is
binding `16 + 2*s` and sampler is binding `17 + 2*s`; the current bridge
accepts `s0` through `s15`. The renderer must upload complete constant-file
buffers with the element types and minimum sizes reflected by the resulting
WGSL. The bridge disables vkd3d's synthetic fixed PointSize output through the
retained source patch; an application-written point-size output remains an
explicit unsupported WebGPU case.

The same bridge also exposes a narrow, real DXBC root-signature path:
`_wb_root_signature_serialize(flags)` emits an empty version 1.0 signature
through `vkd3d_shader_serialize_root_signature()`. It accepts only flags `0`
or `1` (`ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT`) and returns 1 on success.
`_wb_root_signature_validate(ptr, length)` parses a standalone DXBC root
signature through `vkd3d_shader_parse_root_signature()` and accepts only that
same empty version 1.0 shape. It returns 1 on success, and
`_wb_root_signature_flags()` then reports its flags. On failure, these calls
return 0 with a diagnostic at `_wb_messages_ptr()`. Serialization uses the
existing result pointer, size, and clear functions. Validation leaves that
result alive, so it can directly validate the just-serialized pointer. Input
is limited to 1 MiB; nonempty signatures and other versions or flags remain
explicitly unsupported.
