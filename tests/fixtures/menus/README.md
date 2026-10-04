# Native menus fixture

Independent Win32 C test of dynamic menu bars and user-selected context menus.
It checks disabled and checked items, original `TrackPopupMenu` return-command
behavior, `TrackPopupMenuEx` cancellation, queued `WM_COMMAND`, and clean close.
The browser must actually receive a selection; choosing the first enabled item
in a shim cannot pass this test.

The startup checks GetUserNameA's required-size retry, BOOL return and LastError.
A read-only WS_EX_STATICEDGE edit verifies the one-pixel frame and native client
dimensions before the popup sequence runs.
It toggles EM_SETREADONLY, checks ES_READONLY and allows programmatic WM_SETTEXT.
Native MENUITEMINFO tests cover 44/48-byte layouts, ANSI/Unicode text, size probes,
short buffers, application data, default/radio state, nested insertion/query and
selection by command/position. Invalid masks, sizes, owner-drawn types and submenu
cycles fail without changing existing items.

Copyright (c) 2026 WineBrowser contributors. Permission is hereby granted, free
of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so, subject to
the following conditions: The above copyright notice and this permission
notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

An SS_OWNERDRAW static control uses the parent EXE's real WM_DRAWITEM handler
to paint a child HDC. The browser checks exact RGBA pixels, then triggers text,
resize and disable changes and verifies the native callback's new framebuffer.
