# Native deferred-layout GUI

Original WineBrowser contributors, MIT. This unchanged PE32 Windows SDK program
is translated from x86 to Wasm inside the browser and uses real Wine base DLLs.
Its ordinary buttons arrange two independently painted native child windows
side by side or stacked and resize the root window.

The guest checks staged geometry stays unchanged, repeated-HWND move/size
requests merge, callbacks occur in insertion order, final SDK rectangles match
and completed batch handles cannot be reused. Browser acceptance clicks the
buttons, verifies actual geometry and GDI pixels and exits the normal message
loop. This establishes these GUI paths, not universal GUI compatibility.

Rebuild using i686 MinGW with `sh scripts/build-window-defer-fixture.sh`.
