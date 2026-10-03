# Native GUI controls showcase

A small, freestanding Windows x86 program using real USER32 and COMCTL32 calls.
Tree categories, sorted list selection, editable combo text, checkbox and radio
state, and a menu/reset button are handled by the program's own native callbacks.
It needs no app-specific Wasm build: WineBrowser translates the executable's x86
blocks to WebAssembly in the browser.

Build and package with `npm run build:gui-controls` using MinGW i686. The public
package includes the executable, MIT license, provenance and reproducible source.
This demonstrates supported controls; it does not establish universal Windows
GUI or DLL compatibility.
