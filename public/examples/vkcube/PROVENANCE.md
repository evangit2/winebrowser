# Khronos Vulkan Cube

Free Apache-2.0 Vulkan tech demo from Khronos, Valve and LunarG.
Upstream revision: `f13d435dd50dc616db0c10e7bac87cd3aa7c82e3`.
Windows PE32 EXE SHA-256: `dec190257ab619a49a0c5d4c7454e04fd958d3d4596b3be185a868dd2220defa`.

The upstream C scene, original SPIR-V shaders and embedded LunarG texture are
unchanged. This build adds only Windows startup/CRT glue and release build
flags. The executable is built from upstream source, rather than copied from
an official Windows SDK installer. The current upstream Vulkan-Tools project
uses the Vulkan 1.0 API subset for this demo.

Source: <https://github.com/KhronosGroup/Vulkan-Tools/tree/f13d435dd50dc616db0c10e7bac87cd3aa7c82e3/cube>.
The ZIP retains the complete demo source, build recipe, pin manifest and license.

Upload the EXE directly or the ZIP into WineBrowser, select `vkcube.exe` and
click Run. WineBrowser translates its x86 blocks to WebAssembly and compiles
its SPIR-V to WGSL inside the browser. Space pauses/resumes, arrows change
rotation, and Escape/window close exits. No server compiler is required.

This demonstrates the documented Vulkan subset. It does not establish support
for arbitrary Vulkan programs, x64 executables or modern Vulkan extensions.
