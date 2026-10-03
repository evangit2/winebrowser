# Demo downloads

Every demo in the [live catalog](https://evangit2.github.io/winebrowser/) has a
compiled Windows PE32 x86 executable. **Use the complete ZIP to run a demo that
needs models, textures, shaders, data files or DLLs.** Upload the ZIP or select
its extracted folder in WineBrowser. Load buttons open the same full package.

The files are committed under `public/examples/` and `public/demos/`, using the
paths recorded in their `manifest.json` files. The root `demos/` directory holds
build sources, so some application EXEs are only in `public/examples/`.

For gltfskinning, the executable is
`public/examples/gltfskinning/bin/gltfskinning.exe`. Its ZIP includes the
CesiumMan model and SPIR-V shaders required to run it.

## Independent applications and demos

| Demo                      | Executable                                                                       | Complete package                                                                 |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| gnu-diff                  | [EXE](../public/examples/gnu-diff/diff.exe)                                      | [ZIP with companion DLLs](../public/examples/gnu-diff/gnu-diff.zip)              |
| optipng                   | [EXE](../public/examples/optipng/optipng.exe)                                    | [ZIP](../public/examples/optipng/optipng.zip)                                    |
| 7zip                      | [EXE](../public/examples/7zip/7zr.exe)                                           | [ZIP](../public/examples/7zip/7zip.zip)                                          |
| gltfskinning              | [EXE](../public/examples/gltfskinning/bin/gltfskinning.exe)                      | [ZIP](../public/examples/gltfskinning/gltfskinning.zip)                          |
| humus-dynamic-branching   | [EXE](../public/examples/humus-dynamic-branching/DynamicBranching.exe)           | [ZIP](../public/examples/humus-dynamic-branching/DynamicBranching.zip)           |
| humus-instancing          | [EXE](../public/examples/humus-instancing/Instancing.exe)                        | [ZIP](../public/examples/humus-instancing/Instancing.zip)                        |
| humus-raytraced-shadows   | [EXE](../public/examples/humus-raytraced-shadows/RaytracedShadows.exe)           | [ZIP](../public/examples/humus-raytraced-shadows/RaytracedShadows.zip)           |
| humus-rollercoaster       | [EXE](../public/examples/humus-rollercoaster/RollerCoaster.exe)                  | [ZIP](../public/examples/humus-rollercoaster/RollerCoaster.zip)                  |
| humus-transparent-shadows | [EXE](../public/examples/humus-transparent-shadows/TransparentShadowMapping.exe) | [ZIP](../public/examples/humus-transparent-shadows/TransparentShadowMapping.zip) |
| humus-water               | [EXE](../public/examples/humus-water/Water.exe)                                  | [ZIP](../public/examples/humus-water/Water.zip)                                  |
| learning-dx12-cube        | [EXE](../public/examples/learning-dx12-cube/Tutorial2.exe)                       | [ZIP](../public/examples/learning-dx12-cube/Tutorial2-x86.zip)                   |
| microsoft-dx12-city       | [EXE](../public/examples/microsoft-dx12-city/D3D12Bundles.exe)                   | [ZIP](../public/examples/microsoft-dx12-city/D3D12City-x86.zip)                  |
| sqlite                    | [EXE](../public/examples/sqlite/sqlite-client.exe)                               | [ZIP](../public/examples/sqlite/sqlite.zip)                                      |
| minesweeper               | [EXE](../public/examples/minesweeper/minesweeper.exe)                            | [ZIP](../public/examples/minesweeper/minesweeper.zip)                            |
| tetris                    | [EXE](../public/examples/tetris/tetris.exe)                                      | [ZIP](../public/examples/tetris/tetris.zip)                                      |
| vkcube                    | [EXE](../public/examples/vkcube/vkcube.exe)                                      | [ZIP](../public/examples/vkcube/vkcube.zip)                                      |
| lua                       | [EXE](../public/examples/lua/lua-client.exe)                                     | [ZIP](../public/examples/lua/lua.zip)                                            |

## Runtime fixtures

| Demo                | Executable                                                         | Complete package                               |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| beep                | [EXE](../public/demos/beep/beep.exe)                               | [ZIP](../public/demos/beep.zip)                |
| breakout            | [EXE](../public/demos/breakout/breakout.exe)                       | [ZIP](../public/demos/breakout.zip)            |
| console             | [EXE](../public/demos/console/console.exe)                         | [ZIP](../public/demos/console.zip)             |
| d3d10-cube          | [EXE](../public/demos/d3d10-cube/d3d10-cube.exe)                   | [ZIP](../public/demos/d3d10-cube.zip)          |
| d3d12-blend         | [EXE](../public/demos/d3d12-blend/d3d12-blend.exe)                 | [ZIP](../public/demos/d3d12-blend.zip)         |
| d3d12-constants     | [EXE](../public/demos/d3d12-constants/d3d12-constants.exe)         | [ZIP](../public/demos/d3d12-constants.zip)     |
| d3d12-constbuffer   | [EXE](../public/demos/d3d12-constbuffer/d3d12-constbuffer.exe)     | [ZIP](../public/demos/d3d12-constbuffer.zip)   |
| d3d12-cube          | [EXE](../public/demos/d3d12-cube/d3d12-cube.exe)                   | [ZIP](../public/demos/d3d12-cube.zip)          |
| d3d12-knot          | [EXE](../public/demos/d3d12-knot/d3d12-knot.exe)                   | [ZIP](../public/demos/d3d12-knot.zip)          |
| d3d12-parade        | [EXE](../public/demos/d3d12-parade/d3d12-parade.exe)               | [ZIP](../public/demos/d3d12-parade.zip)        |
| d3d12-rendertexture | [EXE](../public/demos/d3d12-rendertexture/d3d12-rendertexture.exe) | [ZIP](../public/demos/d3d12-rendertexture.zip) |
| d3d12-rootcbv       | [EXE](../public/demos/d3d12-rootcbv/d3d12-rootcbv.exe)             | [ZIP](../public/demos/d3d12-rootcbv.zip)       |
| d3d12-terrain       | [EXE](../public/demos/d3d12-terrain/d3d12-terrain.exe)             | [ZIP](../public/demos/d3d12-terrain.zip)       |
| d3d12-texture       | [EXE](../public/demos/d3d12-texture/d3d12-texture.exe)             | [ZIP](../public/demos/d3d12-texture.zip)       |
| d3d12-triangle      | [EXE](../public/demos/d3d12-triangle/d3d12-triangle.exe)           | [ZIP](../public/demos/d3d12-triangle.zip)      |
| d3d8-cube           | [EXE](../public/demos/d3d8-cube/d3d8-cube.exe)                     | [ZIP](../public/demos/d3d8-cube.zip)           |
| d3d9-cube           | [EXE](../public/demos/d3d9-cube/d3d9-cube.exe)                     | [ZIP](../public/demos/d3d9-cube.zip)           |
| d3d9-shader-cube    | [EXE](../public/demos/d3d9-shader-cube/d3d9-shader-cube.exe)       | [ZIP](../public/demos/d3d9-shader-cube.zip)    |
| files               | [EXE](../public/demos/files/files.exe)                             | [ZIP](../public/demos/files.zip)               |
| messagebox          | [EXE](../public/demos/messagebox/messagebox.exe)                   | [ZIP](../public/demos/messagebox.zip)          |
| opengl-raymarch     | [EXE](../public/demos/opengl-raymarch/opengl-raymarch.exe)         | [ZIP](../public/demos/opengl-raymarch.zip)     |
| tls                 | [EXE](../public/demos/tls/tls.exe)                                 | [ZIP](../public/demos/tls.zip)                 |
