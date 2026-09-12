# WineBrowser Breakout

This small native PE32 program opens a Breakout game window and a separate
status window. Use Left/Right or move the mouse to control the paddle. Space
pauses and resumes; R restarts after a loss or after clearing the bricks.
Close the game window to stop its timer. Close both windows to exit.

The game is freestanding C written for this repository, with no C runtime.
The ball and brick layout are deterministic. It uses only basic Win32 window,
timer, keyboard/mouse, and solid-fill drawing APIs.

Rebuild the executable and ZIP with `scripts/build-window-demo.sh`. The source
and generated package are licensed under MIT; see `LICENSE`.
