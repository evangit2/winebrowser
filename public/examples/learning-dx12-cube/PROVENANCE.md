# LearningDirectX12 rotating cube

Jeremiah van Oosten's free MIT-licensed [Tutorial 2](https://www.3dgep.com/learning-directx-12-2/)
rotates a native indexed, depth-tested 3D cube. The [upstream Windows release](https://github.com/jpvanoosten/LearningDirectX12/releases/download/v0.0.2/Tutorial2.zip)
is 64-bit. WineBrowser's package is a native 32-bit Windows build of the unchanged
upstream C++ at `25b21e05f9a60a72f64c4c11cca824331ec39354`, with the unchanged release shaders.
It is a source-built counterpart, not the original x64 release executable.

`Tutorial2-x86.zip` includes the executable, both required `.cso` shader files,
MIT notices, build metadata and `source.zip`. Upload that ZIP or select the EXE
and both shader files together. Close the guest window to exit.

CPU instructions compile from the supplied Windows PE to Wasm in the browser.
Shader bytecode compiles through vkd3d-shader and Naga to WebGPU in the browser.
No application Wasm or substituted shader is supplied.
Browser acceptance passes for ordinary ZIP upload, EXE plus both shaders, and
the hosted example button: 1280×720 animated colored cube, native indexed draws,
D32 depth, periodic FPS output and window-close exit code 0. The native DXGI
teardown reports zero live guest graphics objects. See
[recorded browser evidence](../../../evidence/learning-dx12-cube-browser-results.json).
This establishes this source-built sample, not general D3D12 game compatibility.

- PE32 SHA-256: `e84a537aae6f7564f42533fcf69a09a861732605469a41998f623e02f419fc80`.
- App ZIP SHA-256: `df1687db6d8d916097efe535c30c14b81c138bca77a536d0ef0bf726f83fce99`.
- Original x64 EXE SHA-256: `9cb3c02f71a5f6cdfa8f2e9f3e68e7d48b450f86df82359d79ee5c43f5f6a941`.
- Original release ZIP SHA-256: `513fc9681c6c20fafc659ec500e7a4784f19093d279c0fd0205527e43004d46f`.
- DirectXMath revision: `abced86db5d790d3463b118f2f716db30374a1f7` (MIT).

Rebuild with `python3 scripts/build-learning-dx12-cube.py` in WineBrowser.
Alternatively extract `source.zip` and run `sh build.sh` with a 32-bit MinGW-w64
C++ compiler. The complete pinned sources and shader bytes are included.
The build selects upstream scalar DirectXMath and supplies only MinGW header
compatibility; application sources and shaders are unchanged. Compiler versions
can produce different executable hashes.
