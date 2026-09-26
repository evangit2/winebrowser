# Real upstream DirectX 12 acceptance target

`python3 scripts/build-microsoft-d3d12.py` retrieves hash-pinned Microsoft
HelloTriangle sources at `be8195fc324c97c6550b710ace15e18b560c07c8` and builds
`.cache/dx12-microsoft/HelloTriangle.exe` with MinGW i686 C++.
`build.json` in that directory records compiler, command and binary/source hashes.
This is the older SM5 sample that calls D3DCompileFromFile at runtime, not the
current x64/SM6/Agility SDK variant. Source and MIT license hashes are checked
before the compiler runs. Source files are unchanged.

The build preincludes `mingw-wrl-compat.h` to supply the FileHandle RAII type
missing from MinGW's WRL headers and the `_uuidof` spelling. FileHandle appears
only in an unused upstream helper. `-fpermissive` accepts MSVC's address-of-
temporary expressions. No window, rendering or shader code is rewritten.

Native C++ compilation happens on the host. The browser receives a normal
Windows program plus original `shaders.hlsl`; x86-to-Wasm and HLSL-to-DXBC-to-
SPIR-V-to-WGSL are browser runtime compilation. C++ source compilation in the
browser is a separate unimplemented capability.

The full executable does not render yet. Its native Wine diagnostic currently
stops at the source loader's static-TLS restriction. UCRT API-set mapping,
DXGI factory2/4 enumeration and swapchains, null-output device probing,
and float3 vertex layouts/default pipeline state remain required next steps.
The HLSL compiler is verified separately without claiming upstream EXE success.
Run the diagnostic with `scripts/probe-wine-target.mjs`, this cache directory,
the pinned Wine i386 DLL directory, NLS directory, and `--browser`.
