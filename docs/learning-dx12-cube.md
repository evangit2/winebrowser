# Free native DirectX 12 cube in WineBrowser

[Live harness](https://evangit2.github.io/winebrowser/) ·
[Windows package](https://evangit2.github.io/winebrowser/examples/learning-dx12-cube/Tutorial2-x86.zip) ·
[Upstream tutorial](https://www.3dgep.com/learning-directx-12-2/)

Choose **Load learning-dx12-cube**, then **Run executable**. Alternatively upload
`Tutorial2-x86.zip`, or select `Tutorial2.exe`, `VertexShader.cso` and
`PixelShader.cso` together. Close the guest window to exit. Chrome or Edge with
WebGPU is required. The hosted package includes sources, licenses and build metadata.

Jeremiah van Oosten's MIT LearningDirectX12 Tutorial 2 renders a rotating colored
cube using indexed triangles, native DirectXMath transforms, root constants and
a D32 depth buffer. Its original release executable is x64. WineBrowser runs a
native **32-bit counterpart of the unchanged C++**, pinned to
`25b21e05f9a60a72f64c4c11cca824331ec39354`. Both shader files retain the exact
original release bytes. The native build selects upstream scalar DirectXMath
and supplies MinGW header compatibility without editing application sources.

The browser loads the Windows PE, compiles its x86 CPU blocks to Wasm, and
compiles the supplied DXBC shaders with vkd3d-shader and Naga to WebGPU. No
server compiler, application Wasm, substituted scene or rewritten shader is
required. This acceptance covers this sample; WineBrowser's broader x64,
D3D12 game and compute compatibility remains incomplete.

[Browser evidence](../evidence/learning-dx12-cube-browser-results.json) checks
ZIP upload, EXE plus shaders and the hosted button. Each path produces a
1280×720 cube with many interpolated colors and a changing pixel digest, runs
its native FPS output, compiles over 5,000 CPU blocks, and exits with code 0.
The sample's native DXGI atexit report finds zero live guest graphics objects.
The CI workflow runs the same test against the static Pages build.
[Live Pages verification](../evidence/learning-dx12-cube-live-results.json)
records all three paths against the published site and its deployment commit.

![Native LearningDirectX12 cube](../evidence/learning-dx12-cube-browser.png)

Rebuild with `npm run build:learning-dx12` using Python 3 and an i686 MinGW-w64
C++ compiler, or extract the supplied `source.zip` and run `sh build.sh`.
The builder verifies hashes for all application, DirectXMath and release shader
inputs. Compiler versions may change executable bytes. Compatibility headers
also handle case-sensitive native toolchains. Provenance and hashes are in
[the package notes](../public/examples/learning-dx12-cube/PROVENANCE.md).

Run `npm run test:learning-dx12 -- --local` for a browser development-server
check. Set `WINEBROWSER_TEST_URL` to a deployed harness to test its downloads and
runtime directly; the default test target is the local static Pages server.
