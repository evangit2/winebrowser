# D3D12 cube shaders

These original MIT-licensed HLSL shaders pass `POSITION` and `COLOR` float4
vertex inputs through a shader-model 5 vertex shader and return interpolated
color from the pixel shader. The checked-in DXBC files are ordinary compiled
shader assets; WineBrowser does not substitute shaders by application or hash.
The VS also declares the standard `SV_VertexID` system input so its generated
SPIR-V retains the generic base-vertex draw contract; it does not change the
passed-through position or color. Color precedes position in the output struct
so the independently compiled VS and PS both assign `COLOR` to location 0.

Run `./build.sh` to rebuild them. The build uses the open-source MinGW-w64
compiler for the small helper and Wine 11.0's LGPL `d3dcompiler_47.dll` through
`D3DCompile`, with entry point `main`, targets `vs_5_0` and `ps_5_0`, strict
validation, and optimization level 3. The fixture was built with
`x86_64-w64-mingw32-gcc 16.1.0`; its Wine compiler DLL SHA-256 was
`954fbced88b9dd526be604bcd73d7985b854bc327e8727e01c698d4d463289ff`.
`manifest.json` records source, helper, documentation, license and output
hashes. Build intermediates remain under `.cache/d3d12-cube-shaders`.
