# Native owned cursor GUI

Original WineBrowser contributors, MIT. The unchanged Windows SDK EXE creates
alpha and monochrome cursors from real bitmap planes. **Alpha**, **Mono**,
**Copy**, **Grow** and **Offset** switch the mouse image. **Hide**/**Show**
control visibility. **Retire** destroys the selected grown cursor while its
image remains selected; **Reset** recreates it. Four panels paint the actual
native cursor images, including monochrome destination inversion.

Build: `sh scripts/build-owned-cursors-fixture.sh`.
The browser translates its x86 instructions to Wasm during execution.

Original native probes record 18 independently reproduced desktop Wine
ownership results, 256 DrawIconEx reference pixels and 512 GUI cursor pixels.
Eight resource metadata cases use the repo-authored custom-cursors DLL.
Compile the oracle sources with MinGW i686 GCC and `-lgdi32`, and capture stdout
on desktop Wine. `shapes.h` supplies the GUI's authored bitmap inputs.

Stock cursor/icon metadata queries, arbitrary color XOR cursor presentation
and complete Windows cursor conformance remain unfinished. These samples
contain no third-party game assets or precompiled application Wasm.
