# Native OpenGL 3.3 raymarch demo

A free MIT-licensed Windows PE32 tech demo, built from the source in this
directory. This is a WineBrowser fixture, not a downloaded third-party release.
It requests an OpenGL 3.3 core context and supplies its own GLSL 330 vertex and
fragment shaders, VAO and vertex buffer. The fragment shader renders a rotating
torus, bouncing sphere, rounded box, checker floor, soft shadows, ambient
occlusion and specular lighting at 800 × 600.

Upload `opengl-raymarch.exe` directly, or open the complete ZIP. Both the native
x86 instructions and the embedded GLSL shaders compile locally in the browser.
No application source, generated Wasm, scene image or server compiler is used
to run the EXE.

- Left/right arrows orbit the camera.
- Space pauses or resumes the animation.
- Escape or the window close button exits.

On Windows, run the EXE with a driver supporting OpenGL 3.3. Native Windows
execution has not been verified in this macOS development environment.

Rebuild with MinGW i686 GCC, binutils and Python 3:

```sh
sh build.sh opengl-raymarch.exe
```

From the WineBrowser checkout, `python3 scripts/build-opengl-demo.py` rebuilds
the EXE, ZIP, source delivery and hash-pinned hosted catalog entry.
