# Native cursor ownership evidence

Original WineBrowser contributors, MIT. `oracle.c` is an original SDK probe for
bitmap-created color/monochrome cursors and icons. It records 15 independently
reproduced desktop Wine results for creation, metadata, copies, shared handles,
cross-type destruction, active cursor destruction, double destruction and null
handles. Hotspots outside the bitmap are retained by the native API. The probe
contains no third-party assets.

Compile with MinGW i686 GCC and `-lgdi32`, and capture stdout on desktop Wine.
These are reference captures for upcoming GUI work. The browser runtime does
not yet implement these custom cursor ownership contracts or DestroyCursor.
