# Direct3D 9 cube

This is a freestanding, native Windows PE32 demo. It opens a 640×480 window
and draws a rotating, depth-tested cube through the ordinary Direct3D 9 COM
interface. It uses fixed-function XYZ/diffuse vertices and `DrawPrimitiveUP`;
it has no C runtime, pretranslated WebAssembly, or application-specific browser
calls. Close the window to exit.

Rebuild with `scripts/build-d3d9-demo.sh`. The package's `SHA256SUMS` pins the
exact EXE bytes produced by the local build. Source and binaries use the MIT
license in `LICENSE`.

This demo is a compatibility target. Its presence in the package does not by
itself establish that WineBrowser implements Direct3D 9 rendering yet.
