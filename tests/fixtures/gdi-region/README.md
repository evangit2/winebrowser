# Native GDI region GUI

Original WineBrowser contributors, MIT. Ordinary Windows SDK PE32 code,
translated from unchanged x86 instructions to Wasm inside the browser.
Buttons select difference, union, XOR and intersection of overlapping regions.
Native FillRgn and FrameRgn paint the actual result; native GetPixel checks
the fill, frame and empty pixels before announcing each completed stage.

SDK checks also cover inverted rectangles, aliasing, canonical guarded RGNDATA,
round-trip construction, offsets, COPY ignoring source2, empty rectangles,
copied DC clips after deleting their source handles, saved clip restoration,
visibility and object types. This does not establish polygon/rounded regions,
nonidentity transforms, every region operation or arbitrary Windows support.

Rebuild using i686 MinGW with `sh scripts/build-gdi-region-fixture.sh`.
