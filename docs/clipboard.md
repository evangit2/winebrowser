# Native clipboard and edit commands

WineBrowser preserves clipboard formats when applications close and reopen the
clipboard. Its previous implementation replaced the data with an empty map on
every OpenClipboard. Native programs can now copy, paste repeatedly, cut, undo
and save the result through ordinary edit-control messages.

The process-local clipboard tracks the opening guest thread separately from its
owner window. EmptyClipboard assigns ownership and sends WM_DESTROYCLIPBOARD to
the previous owner. Delayed data invokes the real WM_RENDERFORMAT callback;
native Kernel32 GlobalAlloc/GlobalLock/GlobalSize handle movable memory when
the Wine base is loaded. Unicode, Windows-1252 ANSI and CP437 OEM text convert
automatically, with CF_LOCALE and native format order added at close. Enumeration,
count, priority, owner, open-window and sequence queries share that state.

Native WM_COPY/WM_CUT/WM_PASTE/WM_CLEAR use the same data as application API
calls. Edit controls preserve Unicode internally even when created through ANSI
APIs. They retain readonly/password restrictions, text limits, filtering, undo
and native change notifications. Browser shortcuts queue native commands once;
context-menu plain-text paste imports its data before the native paste message.

## Independent acceptance

`tests/fixtures/clipboard/oracle.c` calls the actual clipboard APIs under desktop
Wine 11 and records their return values, LastError, format order and conversion
bytes. `wine-reference.json` pins its source, EXE and output. The authored MIT
Windows SDK client independently checks those expectations, real movable
memory, delayed callbacks and Unicode edit messages on desktop Wine and in the
browser. EXE upload, renamed ZIP upload and catalog loading all run the same PE.

The browser regression also uploads the unchanged official **Metapad 3.6 LE**
EXE, SHA-256 `dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b`,
then its renamed ZIP. Both run native Copy/Paste/Cut/Undo accelerators, paste
twice after reopening the clipboard, save actual file bytes and exit zero.
The original application stays cached; the public **Load clipboard-editor**
example contains the original MIT SDK client and complete source build.

```sh
npm run build:clipboard
npm run fetch:metapad
npm run test:clipboard
node --test tests/clipboard.test.js tests/win32-controls.test.js
```

`WINEBROWSER_TEST_URL` selects a static/live harness; `CLIPBOARD_EVIDENCE` selects
the report path. CI adds this acceptance to the dialogs group and retains all
prior invocations. The clipboard is isolated to one runtime session. OLE data
objects, clipboard viewers/listeners, shared clipboard between runtime processes,
GDI clipboard object formats and general Windows application compatibility
remain open. Text conversion currently follows the runtime's US locale/code
pages; custom LCID-driven clipboard conversion remains open.
