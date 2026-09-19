# Direct3D 9 programmable shader cube

This original MIT-licensed demo is an ordinary freestanding 32-bit Windows
program. It renders an animated, depth-tested cube with Direct3D 9. The native
x86 program calculates perspective vertices at runtime with x87 arithmetic,
then uses a vertex declaration, a VS 1.1 shader, a PS 2.0 shader, changing float
constants, and `DrawPrimitiveUP`. It creates no vertex buffer, index buffer, or
texture.

The original shader assembly is in `shaders/`. `assemble_shaders.py` turns that
small, auditable source into the D3D shader token arrays included in the PE.
Both shaders and all C source are covered by `LICENSE`.

Install the MinGW-w64 i686 compiler and run:

```sh
./build.sh
```

The result is `d3d9-shader-cube.exe`. Its only imported DLLs are `D3D9.dll`,
`KERNEL32.dll`, and `USER32.dll`; it has no C runtime dependency.
