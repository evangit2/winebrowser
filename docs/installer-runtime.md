# Legacy installer services

The ATI Radeon 8500 Treasure Chest installer reported missing User32, GDI,
Shell32, LZ32 and common-controls imports. These services now resolve through
the shared Windows API provider, including the fallback for exports absent from
the source-built guest Shell32 component. No ATI executable or assets are shipped.

Implemented behavior:

- ANSI/UTF-16 character advancement, sibling/owner/child traversal, dialog tab
  navigation and parent changes. Control reparenting moves its browser element.
- Standard and extended in-memory dialog templates, modeless creation,
  owned top-level dialogs, standard button/edit/static class ordinals and guest
  dialog callbacks; modal owner disabling and event-loop wakeup. Unsupported control classes remain explicit failures.
- `CreateDIBitmap`: palette-indexed 1/4/8-bit RGB DIBs, 16/24/32-bit RGB,
  RGB bitfields, bottom-up and top-down rows. RLE and palette-index usage are
  not implemented. Font enumeration returns the virtual display's logical
  browser-backed device fonts and honors the callback's stop request.
- A user-selectable Shell32 folder dialog over the isolated package filesystem,
  copied PIDL round trips, callback initialization/selection notifications and
  an allocator with IMalloc lifetime/allocation methods. This namespace does
  not expose host filesystem folders or arbitrary native shell PIDLs.
- LZ32 open/init/read/seek/copy/close and expanded names. The SZDD LZSS decoder
  handles overlapping backreferences, the 4 KB space-filled dictionary and
  compressed-name fallback. File writes use the ordinary virtual filesystem.
- Published `comctl32.dll` ordinal 17 resolves to `InitCommonControls`.
- CBW/CWD compile to Wasm with correct partial-register and flag behavior.

`tests/installer-apis.test.js` checks service behavior. The unchanged authored
PE32 client in `tests/fixtures/installer-apis` executes the actual imports and
COM methods, opens dialogs, compares bitmap pixels, enumerates fonts,
expands a compressed file and asks the user to select a folder in the browser.

```sh
sh scripts/build-installer-apis.sh
node --test tests/installer-apis.test.js
node scripts/test-installer-apis-browser.mjs
```

The browser acceptance result is recorded in
`evidence/installer-apis-browser-results.json`. This proves the listed service
path; it does not establish that the proprietary ATI installer completes or
that its extracted Direct3D demo renders. Full Wine-level compatibility and
startup in a few seconds remain active work.
