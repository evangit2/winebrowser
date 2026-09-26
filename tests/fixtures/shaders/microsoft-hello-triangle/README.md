# Original Microsoft HelloTriangle shader

`shaders.hlsl` and `LICENSE` are unchanged upstream files from Microsoft's
DirectX-Graphics-Samples at `be8195fc324c97c6550b710ace15e18b560c07c8`:

- [Shader source](https://github.com/microsoft/DirectX-Graphics-Samples/blob/be8195fc324c97c6550b710ace15e18b560c07c8/Samples/Desktop/D3D12HelloWorld/src/HelloTriangle/shaders.hlsl)
- [MIT license](https://github.com/microsoft/DirectX-Graphics-Samples/blob/be8195fc324c97c6550b710ace15e18b560c07c8/LICENSE)

`node scripts/test-hlsl-browser.mjs` compiles these actual source bytes through
browser-worker libvkd3d-shader (HLSL → DXBC → SPIR-V), then Naga (SPIR-V → WGSL),
and verifies a WebGPU color triangle. Compiler work requires no network service.
This is a shader test, not evidence that the full upstream C++ EXE runs.
`node scripts/test-hlsl-native-browser.mjs` separately exercises the native
D3DCompile APIs via an EXE plus this shader and a nested ZIP.
