# Native menus fixture

Independent Win32 C test of dynamic menu bars and user-selected context menus.
It checks disabled and checked items, original `TrackPopupMenu` return-command
behavior, `TrackPopupMenuEx` cancellation, queued `WM_COMMAND`, and clean close.
The browser must actually receive a selection; choosing the first enabled item
in a shim cannot pass this test.

The startup checks GetUserNameA's required-size retry, BOOL return and LastError.
A read-only WS_EX_STATICEDGE edit verifies the one-pixel frame and native client
dimensions before the popup sequence runs.

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
