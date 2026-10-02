# Microsoft DirectX 12 city demo

The MIT Microsoft **D3D12Bundles** sample runs through ordinary WineBrowser ZIP
upload, EXE plus assets upload, and the public example button. Its **30 textured
OCC city meshes** have 18,642 indices each: 186,420 triangles and 30 indexed draws
per frame. Two original shaders alternate grayscale and green cities. Rendering
uses a 1024×1024 BC1 texture, D32 depth, three frame resources, descriptor tables,
dynamic samplers and reusable command bundles. WASD moves, arrows turn, Escape
resets the camera, and closing the window exits with code 0.

## Native build and provenance

- [Microsoft source](https://github.com/microsoft/DirectX-Graphics-Samples/tree/be8195fc324c97c6550b710ace15e18b560c07c8/Samples/Desktop/D3D12Bundles/src)
- [Upload ZIP](https://evangit2.github.io/winebrowser/examples/microsoft-dx12-city/D3D12City-x86.zip)
- [Corresponding source](https://evangit2.github.io/winebrowser/examples/microsoft-dx12-city/source.zip)
- Source pin: `runtime/target-builds/microsoft-dx12-city.json`.
- EXE SHA-256: `3bd477ccddbe9a50aa07db1b7408d901188a2d90391b3cde135f1ab0084ba524`.

This is a **native x86 build of unchanged Microsoft C++**, not a downloaded
release executable. The mesh, compressed texture and HLSL are the original
pinned assets. Compatibility headers adapt missing WRL helpers, header casing,
MSVC naming macros, `min`/`max`, and disabled SDK PIX profiling. Upstream scalar
DirectXMath is selected. C++ runtime libraries are statically linked; Windows
CRT remains native Wine UCRT. No application Wasm, alternate scene or replacement
shader is included. WineBrowser compiles the x86 blocks and translates DXBC to
WGSL locally in the browser.

`npm run build:dx12-city` hash-checks all upstream inputs, builds PE32, and
compiles original HLSL to SM5 DXBC with the shipped browser compiler.
`source.zip` contains the generated shaders and an ordinary native `build.sh`.
Extracting it and running `sh build.sh` reproduces the EXE hash above with the
recorded MinGW GCC 16.1.0 toolchain. Microsoft and DirectXMath licenses accompany
both downloads. `build.json` records the exact build command.

## Complete target dependency closure

The EXE has 138 imports across 15 DLL/contract names. Acceptance audits every
provider plus all five native DLLs' transitive dependencies and binary hashes.
Those native libraries have 1,509 imported symbols in total.

| DLL or contract                          | Provider exercised                                      |
| ---------------------------------------- | ------------------------------------------------------- |
| `kernel32.dll`                           | Native source-built Wine PE                             |
| Ten `api-ms-win-crt-*` contracts         | Native Wine `ucrtbase.dll`                              |
| `shell32.dll`                            | Native source-built Wine `CommandLineToArgvW` component |
| `user32.dll`                             | Browser Win32 window/message/input provider             |
| `d3d12.dll`, `dxgi.dll`                  | Shared graphics provider backed by WebGPU               |
| Transitive `kernelbase.dll`, `ntdll.dll` | Native Wine PE with the shared NT boundary              |

Actual startup, file reads, graphics, input and teardown run with over 4,800
browser-compiled x86 blocks. This verifies this application's exercised dependency
paths; it does not establish every library export, arbitrary third-party DLLs or
general DX12 games. PE32+ x64, compute dispatch, DXIL/SM6 and many advanced DX12
features remain unsupported.

## Runtime and verification

Bundles inherit the direct caller's attachments, viewport and scissor, read
current buffer contents, and propagate modified graphics state back to the caller.
A matching root signature preserves inherited bindings. Open/nested bundles,
incompatible descriptor heaps and unsupported bundle methods fail explicitly.
Supported bundle root setters require a declared signature in the bundle.

BC1/2/3 UNORM/sRGB footprints count 4×4 block rows with native texel extents.
Repeated geometry shares immutable submission snapshots, preserving the 8 MiB
unique-geometry budget. The sample exposed and fixed x86 stack sizes for 64-bit
root handles, APPEND descriptor offsets, dynamic sampler validation, sampler
filter bits, and shader-optimized unused input elements.

`npm run test:dx12-city -- --local --ordinary` passes in ordinary Chrome
154.0.8037.97: all three loading paths, coherent 1280×720 scenes with about 12,000
colors, 30 draws/frame, movement, turning, exact image restoration on reset,
dependency closure and clean exit. Static Pages and live evidence are recorded
separately after deployment. CI runs the same acceptance on the built static site.

Production static acceptance passed on 2026-10-02T22:22:32.078Z in ordinary Chrome 154.0.8037.97. All three loading paths passed after a build with `/winebrowser/` as the base path, on a server without isolation headers. Evidence: `evidence/microsoft-dx12-city-static-results.json`.
