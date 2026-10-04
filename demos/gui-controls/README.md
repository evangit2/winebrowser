# Native GUI controls showcase

A small, freestanding Windows x86 program using real USER32 and COMCTL32 calls.
Tree categories, sorted list selection, editable combo text, checkbox and radio
state, and a menu/reset button are handled by the program's own native callbacks.
A registered custom child paints its own GDI color swatches and text. Its nested
Change button switches the palette through a native WM_COMMAND callback, and
clicking the canvas reaches the application's own window procedure.
Drag the priorities list to change its order through native COMCTL32 callbacks.
Escape cancels an active drag; Reset restores the original priorities.
Native Priorities/Notes tabs switch pages while preserving the list order and
edited notes. The application controls page visibility through WM_NOTIFY.
The Notes menu uses native MENUITEMINFO queries/updates and radio choices to
switch notes between editable and read-only. The caption and selection follow
the current mode; editing locks preserve text, and Reset restores editable mode.
The bottom status bar is a native COMCTL32 control. Each callback updates its
text through SB_SETTEXTA, and its minimum height and docking use native messages.
Appearance → Font opens the common font picker. Accept applies the selected
font to controls and the GDI child canvas; Cancel preserves the current font.
Effects change the canvas text color, underline and strikeout.
Notes → Find/Replace opens native modeless dialogs while notes remain editable.
Find selects matching text; Replace changes that selection, Replace All updates
every match, and Undo restores the last change. Match case, whole word and
Up/Down control the sample's ASCII search; search wraps at the end. Notes are
limited to 4095 characters, and the sample refuses replacements while locked.
It needs no app-specific Wasm build: WineBrowser translates the executable's x86
blocks to WebAssembly in the browser.

Build and package with `npm run build:gui-controls` using MinGW i686. The public
package includes the executable, MIT license, provenance and reproducible source.
This demonstrates supported controls; it does not establish universal Windows
GUI or DLL compatibility.
