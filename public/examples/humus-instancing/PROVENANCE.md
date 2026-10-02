# Humus Instancing (Direct3D 9)

Emil Persson (Humus) made this demo. Its included readme permits free use and
redistribution by any method, provided the readme is included. The unchanged
ZIP retains the readme, executable, shaders, source and particle/font texture assets.

- Author/demo listing: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/Instancing.zip>
- Archive SHA-256: `9c74c3a787a1320e9cd7e7f708ff923f4a83be5a6e1dc93b80763c3c398e61f7`.
- Original `Instancing/Instancing.exe` SHA-256: `37df64605e11c7a23df2d5befeb0bf38d2b9b6d2bf1322ffb1d0a437030b2903`.
- Archive size: 432,605 bytes.
- F1 opens the upstream settings menu. Close the guest window to exit.

The executable renders animated additive particle clouds using its original
shader-constant batching path. WineBrowser translates its x86 blocks to Wasm
and its native D3D9 shaders to WebGPU during execution. The program chooses
this fallback itself from the advertised shader versions. Hardware stream
frequency instancing remains unsupported.

Keys 2, 3 and 4 select shader-constant batching, vertex-buffer upload and
user-pointer arrays. These three paths are covered by the browser regression.
Load the ZIP to include the assets.
