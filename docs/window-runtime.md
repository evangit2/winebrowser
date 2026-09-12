# Virtual window runtime

The browser desktop displays windows owned by a running PE32 program. The EXE's WndProc runs through the same x86-to-Wasm dispatcher as its main code. Browser input only queues messages; it never enters guest code concurrently with an executing callback.

`src/win32-windows.js` owns classes, HWNDs, creation/destruction, a single GUI-thread queue, invalidation, and timers. `src/win32-gdi.js` gives each HWND a separate client framebuffer and DCs. `src/desktop.js` displays these frames inside draggable/resizable windows and forwards input through `src/worker.js`. The existing desktop DC remains a separate 640×480 surface for programs that draw directly to the desktop.

Window messages include creation, nonclient size calculation, show/size, paint/erase, keyboard/character, mouse, focus, timer, close, destroy, and quit. GetMessage waits without spinning. PeekMessage supports filtering and PM_REMOVE/PM_NOREMOVE. Only the guest's response to WM_CLOSE removes a window; closing browser chrome does not silently terminate its process. Stop terminates the worker. Returning from a process releases its browser windows and timers.

The current virtual desktop uses a fixed 1-pixel border and a 28-pixel title bar. CreateWindowEx and AdjustWindowRect agree about outer versus client dimensions. The browser positions use outer coordinates; mouse coordinates and GDI drawing use client coordinates. Window surfaces resize independently, preserving existing pixels before repaint.

## Tested program

The original MIT-licensed [native Breakout demo](../demos/breakout/main.c) creates two top-level windows, draws its board with FillRect, animates through SetTimer/WM_TIMER, responds to keyboard and mouse input, and exits through GetMessage/WM_QUIT after both windows close. Its logic is integer-only freestanding C compiled to a Windows PE32 executable. The browser executes that binary; it does not compile the C source to Wasm.

Build with `npm run build:windows` or `npm run build:demos`. The interactive demo lives in the public manifest's `interactive` list so the terminating fixture suite remains usable. `npm run test:windows` verifies animation, keyboard pause, independent windows, drag, resize/repaint, guest-mediated closing and exit code zero against a server selected by `WINEBROWSER_TEST_URL`. The CI workflow runs it against the Pages build. `tests/win32-windows.test.js` separately exercises guest callbacks, rejected creation, paint/DC isolation, queue filtering/quit, and timer lifetime.

## Current boundaries

This is the bootstrap host provider, not a port of Wine's complete USER32/GDI stack. One process and one GUI thread run at a time. Limits are eight top-level windows, 1024×768 client pixels per window, 128 classes, 4096 queued messages and 64 timers. Child controls, menus, fonts/text, compatible bitmaps/BitBlt, custom nonclient geometry, minimize/maximize behavior, full input-method handling, and graphics APIs beyond the existing raster subset still need implementation. Resize repaints the client surface; the application remains responsible for adapting its layout and game logic.

[Tetris and Minesweeper release binaries](../tests/targets.json) provide independent follow-on targets for controls, GDI, registry and shell services. Their PE images parse and their missing imports are recorded; they are not currently passing games. The Wine CRT/NLS startup investigation also remains active for programs with broader library dependencies.

API contracts were checked against Microsoft's [CreateWindowEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexa), [GetMessage](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmessage), and [BeginPaint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-beginpaint) documentation. Unsupported behavior must remain visible rather than returning success solely to advance a particular executable.
