# Native topmost popup fixture

This original PE32 creates two topmost borderless popups and one ordinary window.
It verifies client/window rectangles, AdjustWindowRectEx, ClientToScreen, window
lookup and native activation order. Keyboard V checks the current native window
order from its WNDPROC; Escape exits the message loop and destroys all windows.

`npm run build:popup` rebuilds the fixture. `npm run test:popup` uploads it through
the ordinary browser UI, checks exact borderless geometry, clicks ordinary and
topmost windows, checks the element at the overlap and asks the native WNDPROC
to verify the corresponding lookup order. Evidence includes the EXE hash.

The runtime and browser desktop share frame geometry and sort windows in two
bands: topmost first, then ordinary, with activation order within each band.
Border and caption sizes are those of the browser desktop theme. SetWindowPos,
dynamic frame-style changes, owned windows, native theme metrics and maximize/
minimize behavior remain unfinished.

Reference: Microsoft's [extended window styles](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles).
