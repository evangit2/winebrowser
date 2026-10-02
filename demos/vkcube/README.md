# Khronos Vulkan Cube for Windows x86

The free Apache-2.0 `vkcube` tech demo from the current Khronos Vulkan-Tools
project renders an animated, textured 3D cube with native Vulkan commands.
The upstream C source, SPIR-V shaders and embedded LunarG texture are preserved
byte for byte at the revision in `manifest.json`. The Windows PE32 build adds
only `startup.c` entry/CRT glue and release/compiler flags; no scene logic is
ported, patched or replaced. A stock x64 executable cannot run in the current
PE32 runtime.

- Upstream: <https://github.com/KhronosGroup/Vulkan-Tools/tree/f13d435dd50dc616db0c10e7bac87cd3aa7c82e3/cube>
- License: Apache-2.0, retained in `LICENSE` and upstream source headers.
- Build: `sh scripts/build-vkcube.sh` (MinGW-w64 x86, Python 3, curl and tar).
- Controls: Space pauses; arrows change rotation; Escape or window close exits.
- Shader compilation and x86 translation occur in the browser at launch.

Browser compatibility must be established by the executable upload regression;
merely building or inspecting this binary does not establish rendering.
