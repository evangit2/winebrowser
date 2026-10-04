# Virtual window runtime

The browser desktop displays windows owned by a running PE32 program. The EXE's WndProc runs through the same x86-to-Wasm dispatcher as its main code. Browser input only queues messages; it never enters guest code concurrently with an executing callback.

`src/win32-windows.js` owns classes, HWNDs, creation/destruction, a GUI-thread queue per process session, invalidation, and timers. `src/win32-gdi.js` gives each HWND a separate client framebuffer and DCs. `src/desktop.js` displays these frames inside draggable/resizable windows and forwards input through `src/worker.js`. The existing desktop DC remains a separate 640×480 surface for programs that draw directly to the desktop.

Window messages include creation, nonclient size calculation, show/size, paint/erase, keyboard/character, mouse, focus, timer, close, destroy, and quit. GetMessage waits without spinning. PeekMessage supports filtering and PM_REMOVE/PM_NOREMOVE. Only the guest's response to WM_CLOSE removes a window; closing browser chrome does not silently terminate its process. Stop terminates the process session and its child workers. Returning from a process releases its browser windows and timers. Manual sessions run until guest exit or Stop and expose periodic execution counters; automated suites retain the one-million-dispatch limit.

The current virtual desktop uses a fixed 1-pixel border and a 28-pixel title bar, with a 20-pixel menu bar when attached. CreateWindowEx and AdjustWindowRect agree about outer versus client dimensions. The browser positions use outer coordinates; mouse coordinates and GDI drawing use client coordinates. Window surfaces resize independently, preserving existing pixels before repaint.

## Tested programs

The original MIT-licensed [native Breakout demo](../demos/breakout/main.c) creates two top-level windows, draws its board with FillRect, animates through SetTimer/WM_TIMER, responds to keyboard and mouse input, and exits through GetMessage/WM_QUIT after both windows close. Its logic is integer-only freestanding C compiled to a Windows PE32 executable. The browser executes that binary; it does not compile the C source to Wasm.

The unchanged, MIT-licensed [wesmar/Tetris PE32 release](../tests/targets.json) also passes the automated browser sequence in `npm run test:tetris`: piece movement and drop, pause/resume, name editing, the ghost-piece control, dismissal of the Clear Record confirmation, and clean process exit. See [`evidence/tetris-browser.json`](../evidence/tetris-browser.json) for the exact recorded run. This is a single independent application result, not a claim of general Windows game compatibility.

The unchanged MIT-licensed [wesmar Minesweeper release](../third_party/minesweeper/PROVENANCE.md) passes `npm run test:minesweeper` in ordinary Chromium. The sequence checks right-click flag/question cycling, safe reveal, F2 restart, all three board sizes, editable Custom Field with Tab/Enter and Escape, score reset/close, owned About and clean Exit. The hosted ZIP follows the same upload path. See [recorded acceptance](../evidence/minesweeper-browser-results.json). This is the independent MIT release, not Microsoft's proprietary winmine binary. Gameplay is tested, but complete game-rule correctness and pixel-exact Windows rendering are not claimed.

`npm run test:menus` runs an independent native Win32 fixture that requires selecting the second context-menu item, cancelling the next popup and dispatching a command by mnemonic. It checks real selection rather than accepting a fabricated first command; see [recorded acceptance](../evidence/menus-browser-results.json). `npm run test:controls` also checks group-box captions, updates and child lifecycle.

Build with `npm run build:windows` or `npm run build:demos`. The interactive demo lives in the public manifest's `interactive` list so the terminating fixture suite remains usable. `npm run test:windows` verifies animation, keyboard pause, independent windows, drag, resize/repaint, guest-mediated closing and exit code zero against a server selected by `WINEBROWSER_TEST_URL`. The CI workflow runs it against the Pages build. `tests/win32-windows.test.js` separately exercises guest callbacks, rejected creation, paint/DC isolation, queue filtering/quit, and timer lifetime.

## Current boundaries

This host provider implements a bounded USER32/GDI subset. Native Wine child-process sessions can launch uploaded executables and exchange virtual package files; each process has its own GUI queue. Per-process limits include eight GDI-backed top-level windows, 2048×2048 client pixels per window, 128 classes, 4096 queued messages and 64 timers. Up to 256 child controls are supported. Basic controls are DOM-backed; registered custom child windows and SS_OWNERDRAW static controls have separate client framebuffers and HDCs within the shared 16-million-pixel GDI budget. Supported controls include STATIC text, push/check/radio buttons and group boxes, and EDIT controls with single-line, multiline, password and read-only styles. WS_EX_STATICEDGE and WS_EX_CLIENTEDGE preserve their one- and two-pixel client borders. Multiline ES_WANTRETURN edits accept newlines inside dialogs. Owner-drawn static controls send a PE32 DRAWITEMSTRUCT to the parent WNDPROC through WM_DRAWITEM. Native callbacks paint their child HDC; text, font, resize and enabled-state changes invalidate the control. SysTreeView32 text trees support nested opaque items, ANSI/Unicode text and LPARAM data, selection with cancellable native WM_NOTIFY, expansion, item deletion and keyboard/mouse navigation. The native TreeView fixture checks Win32 structure layouts and interactions in Chromium; image lists, callback text, label editing and drag/drop remain unsupported. STATIC SS_LEFTNOWORDWRAP and SS_CENTERIMAGE text preserve wrapping and vertical alignment. String LISTBOX controls support sorted insertion, deletion, selection, item data and ANSI/Unicode text queries. COMBOBOX simple, editable dropdown and dropdown-list types share the native item model and dispatch selection/edit notifications; SendDlgItemMessageA/W uses the correct five-argument ABI. Native fixtures verify these calls and browser interaction. Checkbox/radio indicators show their state, and automatic radio groups follow WS_GROUP in both directions. COMCTL32 MakeDragList registers real drag-list notifications; LBItemFromPt accepts a screen POINT by value, hit-tests uniform-height items and scrolls at bounded intervals. DrawInsert shows an insertion marker, and the native parent decides whether to accept, cancel or reorder strings and item data. Named exports and ordinals 13/14/15 share their callable implementations. IsDialogMessage honors WM_GETDLGCODE so Escape cancels an active drag without closing its dialog. The native drag-list fixture checks rejection, drop, cancellation, timed scrolling and cleanup in ordinary Chromium. See [the acceptance record](../evidence/draglist-browser-results.json). LBS_USETABSTOPS lists render aligned text columns from LB_SETTABSTOPS dialog units, retain original ANSI/Unicode tabbed strings and dispatch mouse/keyboard selection notifications. Fonts use browser matching, so column widths can differ from Windows. Multi-selection, owner-drawn lists, label editing and native dropdown-opening messages remain unsupported. Registered custom child classes run their native EXE/DLL window procedures, GDI paint and nested controls. Matching ANSI/Unicode native procedures can be read and replaced per window and forwarded through CallWindowProc; cross-encoding procedure handles, rich text and full common-control coverage remain unsupported.

Horizontal single-row `SysTabControl32` text tabs now support PE32 TCITEMA/W insertion, update, queries and deletion with retained LPARAM data, selected/focused indices, fixed item dimensions, padding, minimum widths, highlighting, hit testing and reversible `TCM_ADJUSTRECT` conversion. Programmatic `TCM_SETCURSEL` changes do not generate notifications. Browser mouse and keyboard input queue real WM_NOTIFY callbacks; the native parent can veto selection, and packed NMTCKEYDOWN uses the PE32 layout. Native code owns page windows and their visibility. The fixture verifies edited page text survives switching tabs and destruction exits zero; see [the acceptance record](../evidence/tabs-browser-results.json). Variable text widths use estimates and browser horizontal scrolling is not the native up/down control. Images, callback labels, custom extra-data sizes, vertical/multiline/button/owner-drawn tabs and tooltip windows remain unsupported. Unsupported styles and messages remain visible.

Standard MENU resources and dynamic textual menus support bars, nested submenus, separators, disabled/checked state and command delivery. Resource submenus have queryable handles. Alt plus a menu mnemonic opens the menu; command mnemonics and vertical navigation select items. `TrackPopupMenu` and `TrackPopupMenuEx` wait for the user's actual selection or cancellation, then return a command ID or queue `WM_COMMAND` according to flags. MENUEX, bitmap/owner-drawn menus and popup alignment/exclusion rectangles remain unsupported. Menu item rectangle estimates are not pixel-exact browser layout measurements.

InsertMenuItem, SetMenuItemInfo and GetMenuItemInfo A/W now support the 44/48-byte
PE32 MENUITEMINFO layouts for textual/radio/separator items, enabled/checked/default
state, IDs, submenu handles and application data. Queries support size probes,
bounded NUL-terminated CP1252/UTF-16 output and nested command lookup; updates
reject submenu cycles and unsupported bitmap/owner-drawn types before changing
items. CheckMenuRadioItem selects within a single parent by command or position,
retaining radio types when selection changes. Default entries render bold and
radio selection renders a dot. Unsupported type/state flags and custom checkmark
bitmaps remain visible errors. The native menu fixture and unit tests cover
these contracts; implementation references include Wine's
[menu services](https://github.com/wine-mirror/wine/blob/master/dlls/win32u/menu.c)
and Microsoft's [MENUITEMINFO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-menuiteminfoa).
The public GUI showcase uses these APIs for Notes mode: native radio commands
call EM_SETREADONLY, update the menu caption and preserve note text. Programmatic
WM_SETTEXT remains available while user editing is locked; Reset restores editable
mode. Complete Edit control message coverage remains incomplete.

Horizontal `msctls_statusbar32` controls now support named CreateStatusWindow A/W
creation and the published COMCTL32 ordinal 6 for CreateStatusWindowA. Textual
parts retain their strings, types and right edges across multipart/simple mode
switches. SB_SETPARTS/GETPARTS, SB_GETRECT, ANSI/Unicode text and packed length/type
results, borders, minimum height, background color, Unicode format and bounded
tooltip text queries share the native control model. Browser rendering supports
sunken/raised/borderless parts and left/center/right tabbed labels. Native
SBN_SIMPLEMODECHANGE and PE32 NMMOUSE callbacks run on the guest dispatcher;
WM_SIZE docks the control to its parent's client bottom unless CCS_NORESIZE is
set. The [native acceptance](../evidence/statusbar-browser-results.json) checks
named/ordinal creation, rejected layouts, text, callbacks, mode persistence and
parent resize in ordinary Chromium. The public GUI showcase now displays callback
messages through this control. Icons, owner-drawn parts, native resize grips,
tooltip HWNDs, exact font/theme metrics and complete control coverage remain
incomplete. Run `npm run test:statusbar`. Contracts were checked against Wine's
[status implementation](https://github.com/wine-mirror/wine/blob/master/dlls/comctl32/status.c)
and [COMCTL32 exports](https://github.com/wine-mirror/wine/blob/master/dlls/comctl32/comctl32.spec).
Ordinal 8 is CreateMappedBitmap, covered by the resource bitmap services below.

LoadBitmap A/W and CreateMappedBitmap now read RT_BITMAP resources from the
calling EXE or a loaded native DLL, using ordinal or named resource IDs.
CreateMappedBitmap's named export and COMCTL32 ordinal 8 share a procedure.
Explicit COLORMAP arrays use the first matching entry; null arrays select system
button colors. Mapping copies the palette and leaves module resource bytes intact.
The shared GDI converter creates independent bitmap storage that survives DLL
unload. Indexed 1/4/8-bit, CORE, RGB24/32 and uncompressed RGB16/32 bitfield layouts
are bounded by the existing GDI dimensions and pixel budget. PE32 GetObject now
returns a 24-byte BITMAP with bmType, dimensions, word-aligned row bytes, planes,
depth and a null device-bitmap bits pointer. Size probes and output-buffer tails
are checked. The [EXE/DLL acceptance](../evidence/resource-bitmaps-browser-results.json)
executes the DLL entry point and export in Chromium, validates native GetPixel
results and checks real SRCCOPY framebuffer pixels after unload. CMB_MASKED,
predefined OEM system bitmaps and compressed/embedded-image DIBs remain
incomplete. Run `npm run test:resource-bitmaps`.
API behavior was checked against Wine's
[CreateMappedBitmap](https://github.com/wine-mirror/wine/blob/master/dlls/comctl32/commctrl.c)
and Microsoft's [BITMAP structure](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmap).

CreateFontIndirectA/W reads the PE32 LOGFONT byte fields and uses its one-argument
stdcall ABI, including calls made inside uploaded native DLLs. GetObjectA/W
reports 60-byte LOGFONTA, 92-byte LOGFONTW, 16-byte LOGPEN and 12-byte LOGBRUSH
structures. Logical height/weight, requested face, charset, precision and style
hints survive font queries separately from browser rendering substitutions.
Fonts and brushes permit short queries; pens require a complete structure.
Size probes, CP1252/Unicode face names and untouched buffer tails are checked by
the [native EXE/DLL acceptance](../evidence/gdi-objects-browser-results.json).
The EXE renders antialiased text with native bold/italic/underline/strikeout fonts
after unloading the library. Run `npm run test:gdi-objects`. Explicit widths,
rotated text, complete Windows font mapping and extended pen queries remain
incomplete.

GetCharWidth/GetCharWidth32 A/W measure each selected-font character separately;
GetCharWidthFloat A/W preserves the browser's fractional advances. GetCharABCWidths
and GetCharABCWidthsFloat A/W report three bearing/ink/spacing fields per
character, using Canvas ink bounds. These APIs use four stdcall arguments and
decode ANSI ranges using CP1252. TEXTMETRIC A/W reports selected-font styles at
the correct byte offsets. Native EXE/DLL checks cover proportional widths, ABC
layout, Euro decoding and untouched tails. Font coverage ranges and some vertical
metrics remain browser approximations; shaping, hinting and exact Windows font
metrics remain incomplete.

ChooseFontA/W opens a browser font picker with a live preview, face, point size,
weight/italic, underline/strikeout and color. It supports initial LOGFONT
selection, screen fonts, CF_EFFECTS, CF_LIMITSIZE and disabled face/style/size
selectors. Accept writes the native LOGFONT, tenths-of-a-point iPointSize,
COLORREF and nFontType; Escape/Cancel leaves guest structures unchanged and
CommDlgExtendedError zero. Requests are serialized and Stop dismisses the
picker. Hooks/templates, printer and installed-font filters, Apply callbacks
and exact Windows font matching remain unsupported and produce a common-dialog
error. The [native acceptance](../evidence/font-dialog-browser-results.json)
checks A/W selections and actual GDI text from the chosen font. Run
`npm run test:font-dialog`.

FindTextA/W and ReplaceTextA/W create real owned modeless windows with standard
Find/Replace controls. FINDREPLACE buffers and capacities, case/whole-word/
direction flags, Find Next/Replace/Replace All, Help and FR_DIALOGTERM owner
notifications use native memory and registered messages. The native EXE/DLL
[acceptance](../evidence/find-dialogs-browser-results.json) checks an ordinal
DLL RT_DIALOG template, a DLL hook veto and EXE subclass forwarding through
CallWindowProc. FR_ENABLETEMPLATEHANDLE accepts caller-owned GlobalAlloc memory
through the same bounded template parser. Complete custom controls and exact
Windows dialog layout remain incomplete. Run `npm run test:find-dialogs`.

Standard edit controls now support EM_GETSEL/EM_SETSEL, A/W EM_REPLACESEL,
EM_SETLIMITTEXT/EM_GETLIMITTEXT and basic one-level undo/toggle. Native replacements
update browser text/caret and send EN_UPDATE/EN_CHANGE; excess text sends
EN_MAXTEXT. Input/replacement limits retain the runtime's 32767-character bound,
while WM_SETTEXT bypasses the chosen input limit and clears undo. Read-only
controls block user edits but permit native programmatic replacement. Browser
selection changes synchronize with native selection queries. Rich Edit, large
documents, multi-level undo, CRLF index mapping and complete keyboard/IME parity
remain incomplete.

Resource dialogs use client dimensions, render their controls, and support Tab/Shift+Tab, default-button Enter and cancel Escape. Modal dialogs disable their owner and restore focus on exit; modeless visibility follows the template style. Caption ampersands are interpreted unless SS_NOPREFIX is set. `DrawEdge` uses the caller's HDC for raised/sunken edges, optional middle fill and rectangle adjustment; `SaveDC`/`RestoreDC` preserve implemented drawing state and object ownership. These remain bounded raster implementations, without full native clipping or all DrawEdge style combinations.

CreateDialog/DialogBox W APIs now preserve Unicode for frames and controls,
from either DLL resources or in-memory templates. Native acceptance checks
all four creation paths and EndDialog results. FindResourceW decodes Unicode
resource names, and SizeofResource/LoadResource use the HRSRC argument with
their two-argument ABI. Win32 FreeResource returns FALSE while resource data
remains valid. Full resource language selection/fallback and unload lifetime
parity remain incomplete.

Custom nonclient geometry, minimize/maximize behavior, full input-method handling and graphics APIs beyond the documented raster subset still need implementation. Resize repaints the client surface; the application remains responsible for adapting its layout and game logic. The virtual registry is process-local and is not persisted between runs. Fonts use browser matching and may differ from Windows. Shell icon extraction is not implemented. Offscreen compatible bitmaps, SRCCOPY BitBlt, accelerator tables, Unicode registry storage and Wine guest formatting are covered in [desktop compatibility](desktop-compatibility.md). Wine CRT/NLS support remains under development for broader library dependencies.

API contracts were checked against Microsoft's [CreateWindowEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowexa), [GetMessage](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getmessage), and [BeginPaint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-beginpaint) documentation. Unsupported behavior must remain visible rather than returning success solely to advance a particular executable.

Shared legacy text services now preserve raw CP1252 bytes and UTF-16 units for
lstrcpy/lstrcpyn/lstrcat A/W. Character predicates and CT_CTYPE1 classification
share browser Unicode categories, with separate alphabetic and digit flags.
GetStringTypeA uses its five-argument locale ABI while GetStringTypeW uses four
arguments; count -1 includes the terminating NUL. CP1252/CP437 CharToOem and
OemToChar conversions support counted buffers, embedded NULs and in-place copies.
The native [acceptance fixture](../tests/fixtures/legacy-text/README.md) verifies
these contracts through real PE32 calls compiled into Wasm in Chromium; see
[its recorded result](../evidence/legacy-text-browser-results.json).
GetDialogBaseUnits matches the default virtual dialog mapping. Other code pages,
CT_CTYPE2/3 and exact Windows locale/NLS parity remain incomplete. Run
`npm run test:legacy-text`.

A broader PuTTY 0.85 GUI probe exposed and corrected custom-dialog context, class metadata, list-control ABI and radio-state issues. The unchanged release now passes a bounded Configuration acceptance: Session category, edited hostname, registry-backed session Save, navigation to Terminal and Connection/Data, adding/removing tabbed environment variables, return with the hostname and username preserved, and Cancel exiting zero. `winspool.drv` provides local/connected queue enumeration for the browser's empty printer installation, with correct A/W exports, output counts and errors; printing jobs and remote spoolers remain unsupported. An exploratory SSH/Kex visit exposed missing dynamically loaded COMCTL32 drag-list exports. Kex, Host keys and Cipher preference panels now pass native drag/drop, Escape cancellation, Up/Down button reordering and preference persistence across panel reconstruction. Networking and terminal rendering remain unverified. Run `npm run fetch:targets -- putty-0.85-x86` then `npm run test:putty-gui` for the private cached executable. The executable is not published with this acceptance. See [the probe record](../evidence/putty-gui-progress.json).

The public `gui-controls` showcase is an original MIT Windows x86 program using
these controls and native callbacks. Its executable and ZIP are available in the
Pages example picker, with source, license and a standalone MinGW build script.
The source archive reproduces the published PE32 executable byte for byte. Its
browser acceptance covers tree/list/combo interaction, check/radio state, a
registered GDI child canvas with nested-button repaint and mouse input, draggable
priority reordering and Escape cancellation, native Priorities/Notes tabs with
retained edit text and list order, Appearance → Font acceptance/cancellation,
selected control fonts and GDI text color, menu Reset, close and ZIP/Stop cleanup.
Notes → Find/Replace demonstrates actual native search selection, single/all
replacement and Undo while the owner remains editable. This sample's search is
ASCII and its notes capacity is 4095 characters.

Horizontal ToolbarWindow32 controls and CreateToolbarEx now support standard
Wine icon strips, EXE/DLL RT_BITMAP strips and caller-owned HBITMAP strips.
The shared runtime decodes bitmaps through GDI and copies toolbar images/text;
native data remains usable after a resource DLL unload. TBBUTTON and A/W
TBBUTTONINFO calls preserve PE32 structures, data, strings and output tails.
State, checked groups, insert/delete, text, rectangle queries, resize/autosize
and basic horizontal wrapping update browser controls. Button activation sends
actual native WM_COMMAND callbacks. The public toolbar drives Find/Replace,
Undo and Lock notes through the same native handlers as its menus.
See [the EXE/DLL acceptance](../evidence/toolbar-browser-results.json) and run
`npm run test:toolbar`. Pinned Wine bitmap source and LGPL notices are in
`public/runtime/toolbar/`; its byte bundle is reproducibly generated.
Image-list APIs, dropdown/customization notifications, native tooltip callbacks,
full mouse/keyboard behavior, exact Windows layout and arbitrary editor execution
remain incomplete. Unsupported toolbar messages produce explicit errors.
See [the acceptance record](../evidence/gui-controls-browser-results.json).

`node scripts/test-custom-child-browser.mjs` uploads a native EXE and companion DLL whose registered child-window procedure paints independent surfaces and receives nested button, resize, mouse/double-click, context-menu, wheel and keyboard messages. The EXE subclasses one child while its sibling retains the original DLL procedure. The test verifies visibility, enabled state, native destruction and invalid HWND/DC cleanup; see [the acceptance record](../evidence/custom-child-browser-results.json). Wheel messages use screen coordinates and default handling forwards them to the parent; captured pointer messages convert coordinates between client areas. These are bounded native contracts, not general GUI framework acceptance.

Per-window host-control subclassing now provides real callable original WNDPROC addresses through GetWindowLong, GetClassLong and standard-control GetClassInfo. Native EXE/DLL callbacks can replace and restore matching-encoding procedures and forward through CallWindowProc or direct stdcall calls. The shared dispatcher handles supported control behavior when the original procedure is invoked; siblings retain their procedures. Class procedure handles remain callable across module-graph rollback. The native EXE/DLL fixture checks ANSI/Unicode Edit, Button and ListBox forwarding, a second EXE hook layer, text and click vetoes, WM_GETDLGCODE Tab ownership, restoration, destruction and invalid HWND errors; see [its acceptance record](../evidence/host-subclass-browser-results.json). Browser text commits use queued WM_SETTEXT and semantic button clicks use BM_CLICK for subclassed controls. Full per-keystroke/mouse/IME behavior, superclass registration, host class-procedure replacement and cross-encoding procedure handles remain incomplete. Run `npm run test:host-subclass`.

Classic tabbed property sheets implement `PropertySheetA/W`,
`CreatePropertySheetPageA/W` and `DestroyPropertySheetPage` for PE32 native
page descriptors, EXE/DLL dialog resources and memory templates. Page descriptor
strings and template contents are copied; page window procedures and callbacks
remain native guest code. Modal sheets disable/restore their owner, while modeless
sheets expose completion through `PSM_GETCURRENTPAGEHWND`/`PSM_GETRESULT` until the
application destroys them. Page windows instantiate lazily (or with
`PSP_PREMATURE`), keep editing state across tabs, and receive initialization,
activation, validation, Apply/Reset and lifetime notifications. Tab navigation
recurses through visible `WS_EX_CONTROLPARENT` pages. Dirty pages enable Apply.
The public GUI showcase exposes these through Demo → Settings.

The authored property sheet EXE/DLL acceptance covers real native vetoes and
callbacks. Wizard flows, dynamic page insertion/removal, page icons/help/RTL,
activation contexts and remaining property sheet messages are explicitly
unsupported. Metapad now resolves its static imports but remains blocked during
startup; this does not claim a usable editor.

Profile APIs (`Get/WritePrivateProfileStringA/W`, section/name enumeration,
integer reads and win.ini aliases) read and write real shared guest files.
Names match without case; value queries strip matching quotes, and list queries
use bounded double-NUL buffers. Existing ANSI, UTF8-BOM and UTF16 LE/BE files
retain their encoding, and modifications preserve unrelated lines/comments.
Reads and writes respect normal file sharing and mapped-file resize rules.
Bare profile names resolve under the virtual `C:\Windows` directory, matching
Wine; relative names with a separator and package DOS paths use the package cwd.
The `C:\Windows` namespace maps to the isolated `windows/` guest tree, shared by
file APIs, with system32/temp directories; it exposes no host files.
Writes update exported package outputs, not browser storage across reloads.
The public GUI settings workflow can export/re-upload `gui-settings.ini`.
Registry IniFileMapping and complete locale-dependent profile parsing remain
unimplemented. Native EXE/DLL settings acceptance tests UTF16 persistence,
ReadFile coherence, repeated dialog creation, and exported content.

Browser file drops now route to the nearest visible/enabled native window that
has `WS_EX_ACCEPTFILES`, including acceptance toggled through `DragAcceptFiles`.
The runtime imports each batch under a fresh `_dropped/` guest directory and
queues a real `WM_DROPFILES` with a Unicode `HGLOBAL`/`DROPFILES` block. Native
`DragQueryFileA/W` returns filename counts, lengths and clipped copies;
`DragQueryPoint` exposes client coordinates, and `DragFinish` frees the block.
ANSI blocks allocated by applications work too. Native `CreateFileW`/`ReadFile`
reads the imported bytes through the same shared filesystem. Duplicate names
cannot replace uploaded EXEs/DLLs; imported inputs become output downloads only
if the application modifies them. Dropped batches use the existing package
limits of 2,048 files and 128 MiB. Directory dragging and OLE `IDataObject`
drag/drop remain unsupported. `npm run test:drop-files` exercises browser
`File`/`DataTransfer`, the worker and native message callbacks; see the
[acceptance record](../evidence/drop-files-browser-results.json).

`IsTextUnicode`/`RtlIsTextUnicode` implements Wine's bounded text heuristic for
BOMs, statistics, control characters, odd lengths and zero bytes, including
requested/output flags. This detects text encoding; it does not transcode file
contents or implement all of Windows' undocumented heuristics. The translated
Wine function retains its LGPL-2.1-or-later notice in `src/win32-text-unicode.js`
and uses the license distributed as `public/runtime/COPYING.LIB`.

The browser has zero installed Windows printer queues. `PrintDlgA/W` validates
the packed PE32 structures: default-printer queries fail with
`PDERR_NODEFAULTPRN`, and invalid preallocated default-query buffers fail with
`PDERR_RETDEFFAILURE`. Interactive queries show a real no-printer warning and
return FALSE, following Wine's empty-installation path. `PageSetupDlgA/W`
validates size/page-paint hooks and reports an unavailable default printer,
with the normal warning unless `PSD_NOWARNING` is requested. Native apps receive
these results and can continue their other workflows. The owner restores after
the modal notice.

Existing display/bitmap DCs support `SetAbortProc` callback storage; `StartDoc`
invokes it but returns zero because the device cannot start a print job.
`StartPage`, `EndPage`, `EndDoc` and `AbortDoc` follow Wine's null-device results;
invalid DCs fail. These contracts do not provide printer DCs, spool jobs, driver
loading, browser printing or exported PDF output. Run `npm run test:printerless`
for native EXE callback and modal-warning acceptance.

`LoadAcceleratorsA/W` reads every compiler-generated PE shortcut record,
including initial entries with zero flags, and strips the final-entry marker
from the runtime table. The old parser wrongly required that marker on each
entry and rejected Metapad's 96-shortcut resource immediately. Native browser
acceptance now exercises a character shortcut, a Ctrl virtual-key shortcut and
the final Alt+Shift virtual-key shortcut. Run
`npm run test:accelerator-resources`; resource tables use 8-byte PE records,
while `CreateAcceleratorTable` retains the 6-byte runtime ACCEL layout.
