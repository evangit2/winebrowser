# Browser HLSL compilation

`d3dcompiler_47.dll!D3DCompile` and `D3DCompileFromFile` compile guest-provided
HLSL source into real DXBC in the browser worker. The compiler is the pinned
LGPL libvkd3d-shader 2.1 Wasm library already used for bytecode translation.
D3D12 pipeline creation can subsequently translate these blobs through
SPIR-V and Naga to WGSL. No server or application-specific shader substitution
participates. Native application machine code still uses the x86-to-Wasm JIT.

The initial compiler API supports `vs_5_0` and `ps_5_0`, source up to 1 MiB,
flags zero, and no external macros/include handler. Flags2 describes effects
and is ignored for these shader profiles. Unsupported profiles/options return
E_NOTIMPL, syntax errors E_FAIL, and missing packaged files HRESULT 0x80070002.
Optional compiler messages are independent null-terminated ID3DBlob objects.
Both output pointers are validated before mutation, sources are copied before
asynchronous initialization, and a blob's bytes survive later compiler calls
until its final Release. Includes with no handler fail in the compiler. Files
resolve case-insensitively inside the guest package volume, relative to its
working directory or using an absolute C:\winebrowser path.

The existing vertex PointSize portability option now applies to DXBC as well as
legacy tokens. WebGPU does not expose PointSize; omitting the compiler's fixed
1.0 output allows ordinary POSITION/COLOR shaders without VertexID to translate.
Draw-parameter lowering remains in place for shaders that consume VertexID.
This does not implement programmable point size or geometry/tessellation shaders.

Validation:

- Unit tests cover API stack argument counts, output atomicity, source ownership,
  diagnostics, path resolution and independent blob references.
- A native EXE plus shader, and nested ZIP, exercise both APIs in the ordinary
  harness. See `evidence/hlsl-native-browser-results.json`.
- Original Microsoft HelloTriangle HLSL compiles entirely inside a worker and
  draws a color triangle with checked corner, interior and dominant vertex
  colors. Syntax, entry-point, include and SM6 errors fail, followed by successful
  compiler recovery. See `evidence/hlsl-browser-results.json`.

The real upstream C++ HelloTriangle application is a separate acceptance target;
compiling its shaders does not establish executable compatibility. Its current
MinGW build now passes static-TLS initialization and reaches its native EXE entry
point with real UCRT API-set imports resolved, then stops at `NtDuplicateObject`
when its native runtime duplicates the current thread.
DXGI factory/adapter coverage is also still incomplete. The build
uses a native cross-compiler; C++ source compilation in the browser is not yet
implemented. HLSL and x86 machine-code compilation do happen in the browser.

References: Microsoft's [D3DCompile](https://learn.microsoft.com/en-us/windows/win32/api/d3dcompiler/nf-d3dcompiler-d3dcompile)
and [D3DCompileFromFile](https://learn.microsoft.com/en-us/windows/win32/api/d3dcompiler/nf-d3dcompiler-d3dcompilefromfile),
and the [pinned sample](https://github.com/microsoft/DirectX-Graphics-Samples/tree/be8195fc324c97c6550b710ace15e18b560c07c8/Samples/Desktop/D3D12HelloWorld/src/HelloTriangle).
