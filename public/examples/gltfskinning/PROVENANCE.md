# Sascha Willems glTF skinning demo

Current upstream revision: `41a4410243fca7640a2dd0115a5ff5cb9a29494b`. Native Windows x86 build.

Windows x86 source build of the current upstream glTF skinning demo; original application, animation, assets and SPIR-V are unchanged. A SIZE_MAX guard in the common helper avoids duplicate overload definitions on 32-bit Windows. GLM, tinyglTF/STB/nlohmann JSON, KTX, ImGui and the GNU C++ runtime are linked into the EXE. Wine source UCRT/kernel32/kernelbase/ntdll and host user32/gdi32/vulkan-1 supply Windows services in the browser.

The character is CesiumMan, copyright 2017 Cesium, licensed CC BY 4.0.
The Cesium logo retains its separate trademark notice in the model license.
Roboto Medium is copyright Google, Apache-2.0. TinyglTF, STB and JSON notices
are retained in the included pinned source; KTX and ImGui notices accompany
the package. The GNU runtime uses GPL-3.0 with the GCC runtime exception.

Upload this ZIP or open the complete extracted folder, select
`bin/gltfskinning.exe`, and Run. The EXE requires its adjacent assets/shaders
tree. P pauses/resumes skeletal animation; left mouse drag rotates the camera,
right drag or wheel zooms, F1 hides/shows the native ImGui overlay, Escape exits.
Wireframe requires an unavailable optional Vulkan feature; keep it unchecked.

WineBrowser compiles the Windows x86 executable and original SPIR-V in the
browser. No pretranslated application Wasm or replacement JavaScript scene is
included. `source.zip` contains hash-pinned source inputs and the build recipe.
