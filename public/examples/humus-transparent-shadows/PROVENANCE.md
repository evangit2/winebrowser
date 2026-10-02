# Humus TransparentShadowMapping (Direct3D 9)

Emil Persson (Humus) made this demo. Its included readme permits free use and
redistribution by any method, provided the readme is included. The unchanged
ZIP retains the readme, executable, shaders, source and room/font texture assets.

- Author/demo listing: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/TransparentShadowMapping.zip>
- Archive SHA-256: `da7446674a70947d4c5ec43d70bbd9ceb6e71468fc1830faaeb7def1f4d45cb5`.
- Original `TransparentShadowMapping/TransparentShadowMapping.exe` SHA-256: `7364e6f1ff3fe694dc0c939ded55eeee526f61bfae6073e3e4530dd549a926cf`.
- Archive size: 1,206,184 bytes.
- F1 opens the upstream settings menu. Close the guest window to exit.

The unchanged executable renders a room with stained glass and animated light.
Its original shader path renders six 512x512 cubemap faces with a shared D16
depth surface, then samples the shadow cube while drawing the room. WineBrowser
translates its native x86 blocks to Wasm during execution and compiles its
original D3D9 shader bytecode for WebGPU in the browser.

A sustained ordinary-upload probe passed more than 7,000 frames, animation of
the scene excluding the FPS text, and window-close exit zero. The ZIP-upload and
catalog regression checks scene pixels, animation and the original API path.
This establishes this demo's path, not general shadow/Direct3D compatibility.
The renderer currently reads offscreen targets back at each batch boundary;
GPU-only render-to-texture sampling remains a future optimization.
Load the ZIP to include the assets. F1 opens the upstream settings menu.
