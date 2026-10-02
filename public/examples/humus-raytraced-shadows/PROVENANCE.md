# Humus Raytraced Shadows (OpenGL)

Original freeware tech demo by Emil Persson (Humus), republished unchanged under
its included readme.txt. The upstream archive, executable, shader calculations,
DDS/PNG textures and font assets retain their original bytes.

This is a substantial older desktop OpenGL/GLSL compatibility demo: seven
bouncing spheres, a moving light, a textured and bump-mapped room, three lighting/
shadow passes and a settings UI. WineBrowser compiles its original x86 and shader
code in the browser. No scene-specific shader or image is substituted.

Upload RaytracedShadows.zip or choose humus-raytraced-shadows in the catalog.
W/S or up/down move the camera; F1 opens settings. Close the window to exit.
The original executable depends on Windows system DLLs; it statically includes
its CRT, image decoder and graphics framework. The ZIP needs all relative assets.
WineBrowser supplies the imported system services and the exercised OpenGL APIs.
This does not imply complete support for every export of every Windows DLL.

Upstream: <https://humus.name/3D/RaytracedShadows.zip>
