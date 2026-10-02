# Direct3D 9 cube

This is a freestanding, native Windows PE32 demo. It opens a 640×480 window
and draws a rotating, depth-tested cube through the ordinary Direct3D 9 COM
interface. It uses fixed-function XYZ/diffuse vertices;
it has no C runtime, pretranslated WebAssembly, or application-specific browser
calls. Close the window to exit.

Rebuild with `scripts/build-d3d9-demo.sh`. The package's `SHA256SUMS` pins the
exact EXE bytes produced by the local build. Source and binaries use the MIT
license in `LICENSE`.

This demo is a compatibility target. Its presence in the package does not by
itself establish general Direct3D 9 compatibility.

The rotating cube alternates ordinary user-memory draws with indexed draws from
dynamic managed and system-memory vertex/index buffers. The native program checks
the descriptors and lock results before rendering; EXE and ZIP browser runs must
exercise all three paths and exit cleanly.

Before creating the device, the native program verifies adapter display mode and
enumeration against USER32 screen dimensions, invalid adapter/index results,
D16/D24S8 depth and stencil capabilities and rejection of unsupported formats. The browser
regression requires these calls and subsequent real animated WebGPU frames.
