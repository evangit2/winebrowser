# Humus Water (Direct3D 9)

Emil Persson (Humus) made this freeware demo. The included readme permits
free use and redistribution by any method when that readme is included.
The original archive retains its EXE, shaders, source, font and cubemap assets.

- Author: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/Water.zip>
- Archive SHA-256: `b932030521da28ab2c66e01e4d7914101540cd3f9cd9381586f12890f7d9fa70`.
- Original `Water/Water.exe` SHA-256: `435463c13f528a9012daa03004441e4187a7668ed0871f941633d8d53b6d4b0d`.
- Archive size: 714,714 bytes.

Load the ZIP to include all assets. The unchanged Windows EXE decodes its JPEG
cubemap, computes geometry and remainder functions in x86, and supplies its
own water, drop and physics shaders. WineBrowser compiles the machine code
and legacy shaders during browser execution. Two 128x128 RGBA16 UNORM targets
ping-pong the wave simulation, retaining every guest component's 16-bit precision.

F1 opens the original settings menu. Close the guest window to exit.
Verification covers ordinary ZIP upload and catalog/static-host paths,
animated scene pixels excluding the FPS overlay, and exit code zero.
This is one verified application; broader Windows compatibility remains work.
