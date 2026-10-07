# Native message-position reference

Original WineBrowser contributors, MIT. The source records Windows message
positions while changing the cursor before and after retrieval. It covers window
and thread posts, non-removing peeks, empty peeks, generated paint messages and
separate thread state. The native probe restores the host cursor on exit.

GetMessagePos support in WineBrowser is still unfinished. These are reference
captures for the next implementation, not evidence that the API already runs.

Build the reference with `i686-w64-mingw32-gcc -m32 oracle.c -o oracle.exe -luser32`,
then run it on native Wine. No reference executable is included in Pages.
