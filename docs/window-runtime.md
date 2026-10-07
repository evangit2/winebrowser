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

This host provider implements a bounded USER32/GDI subset. Native Wine child-process sessions can launch uploaded executables and exchange virtual package files; each process has its own GUI queue. Per-process limits include eight GDI-backed top-level windows, 2048×2048 client pixels per window, 128 classes, 4096 queued messages and 64 timers. Up to 256 child controls are supported. Basic controls are DOM-backed; registered custom child windows and SS_OWNERDRAW static controls have separate client framebuffers and HDCs within the shared 16-million-pixel GDI budget. Supported controls include STATIC text, push/check/radio buttons and group boxes, and EDIT controls with single-line, multiline, password and read-only styles. WS_EX_STATICEDGE and WS_EX_CLIENTEDGE preserve their one- and two-pixel client borders. Multiline ES_WANTRETURN edits accept newlines inside dialogs. Owner-drawn static controls send a PE32 DRAWITEMSTRUCT to the parent WNDPROC through WM_DRAWITEM. Native callbacks paint their child HDC; text, font, resize and enabled-state changes invalidate the control. SysTreeView32 text trees support nested opaque items, ANSI/Unicode text and LPARAM data, selection with cancellable native WM_NOTIFY, expansion, item deletion and keyboard/mouse navigation. The native TreeView fixture checks Win32 structure layouts and interactions in Chromium; image lists, callback text, label editing and drag/drop remain unsupported. STATIC SS_LEFTNOWORDWRAP and SS_CENTERIMAGE text preserve wrapping and vertical alignment. String LISTBOX controls support sorted insertion, deletion, selection, item data and ANSI/Unicode text queries. COMBOBOX simple, editable dropdown and dropdown-list types share the native item model and dispatch selection/edit notifications; SendDlgItemMessageA/W uses the correct five-argument ABI. Native fixtures verify these calls and browser interaction. Checkbox/radio indicators show their state, and automatic radio groups follow WS_GROUP in both directions. COMCTL32 MakeDragList registers real drag-list notifications; LBItemFromPt accepts a screen POINT by value, hit-tests uniform-height items and scrolls at bounded intervals. DrawInsert shows an insertion marker, and the native parent decides whether to accept, cancel or reorder strings and item data. Named exports and ordinals 13/14/15 share their callable implementations. IsDialogMessage honors WM_GETDLGCODE so Escape cancels an active drag without closing its dialog. The native drag-list fixture checks rejection, drop, cancellation, timed scrolling and cleanup in ordinary Chromium. See [the acceptance record](../evidence/draglist-browser-results.json). LBS_USETABSTOPS lists render aligned text columns from LB_SETTABSTOPS dialog units, retain original ANSI/Unicode tabbed strings and dispatch mouse/keyboard selection notifications. Fonts use browser matching, so column widths can differ from Windows. Label editing remains unsupported; multiple-selection lists and owner-drawn controls are described below. Registered custom child classes run their native EXE/DLL window procedures, GDI paint and nested controls. Matching ANSI/Unicode native procedures can be read and replaced per window and forwarded through CallWindowProc; cross-encoding procedure handles, rich text and full common-control coverage remain unsupported.

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
unsupported. Metapad now passes the bounded basic editor acceptance below;
advanced editor workflows remain incomplete.

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

Child HWNDs may now begin at 0x0 and retain their handles/text through layout.
Tiny framed controls suppress a frame that cannot fit, matching a native Wine
probe; resizing restores the client edge and exact outer/client rectangles.
Custom child GDI DCs can exist with empty client surfaces, and empty surfaces
produce no zero-size browser frames. `WS_EX_DLGMODALFRAME` is accepted for child
controls, and `SBARS_SIZEGRIP` renders a working grip that resizes the native
parent. `npm run test:zero-controls` verifies native geometry, editing and
resizing. Native toolbar bitmap strips pad short cells and keep extra complete
cells, following Wine's bitmap enlargement behavior. This supports Metapad's
15-pixel-high custom strip in its requested 16-pixel cells.

The unchanged official **Metapad 3.6 LE** now passes basic editing in Chromium:
its native window, toolbar and editor start without error notices; dropped text
is opened through native shell/file APIs, editing and Ctrl+S save real guest
file bytes, the exported file reopens after re-upload with the same EXE, and
both runs exit zero. [The acceptance record](../evidence/metapad-gui-browser-results.json)
includes the pinned EXE hash and actual browser compilation measurements.
Run `npm run fetch:metapad` then `npm run test:metapad-gui`; downloads stay under
`.cache/` and the executable is not published in the repo or on Pages.
Open/Save As common dialogs, native Find/Replace, options/property pages,
additional encodings and advanced commands remain incomplete or unverified.
Printing has no installed queues. This acceptance does not establish arbitrary
Windows software or full Metapad compatibility.

GDI drawing now enforces rectangular clip regions, including excluded holes,
across fills, lines, shapes, text, icons, pixel access and destination blits.
`SaveDC`/`RestoreDC` preserve complex clip pieces; `GetClipBox` reports their
bounds and complexity. `ExtTextOut` honors `ETO_CLIPPED`, and `DrawText` clips
to its rectangle unless `DT_NOCLIP` is set. Run `npm run test:gdi-clipping`
for an unchanged authored PE32 executable rendered through Chromium's in-browser
x86 compilation. General region handles and coordinate transforms remain
incomplete; this increment does not establish universal Windows compatibility.

Single-selection `LBS_OWNERDRAWFIXED` and `LBS_OWNERDRAWVARIABLE` listboxes now
execute native `WM_MEASUREITEM`, `WM_DRAWITEM`, `WM_COMPAREITEM` and
`WM_DELETEITEM` callbacks with PE32 structures, real child HWNDs and HDCs.
Lists without `LBS_HASSTRINGS` retain raw DWORD values; string-backed lists
retain ANSI/Unicode text separately from application item data. Fixed and
measured row heights govern item rectangles, paging, scrolling and mouse
selection. Rendering isolates each row's DC state and visible pixels, including
selection, focus and disabled flags. Deletion, reset and native HWND destruction
notify the parent once for each item. Run `npm run test:owner-lists` for the
unchanged authored native EXE and actual Chromium pixel/input acceptance.
Horizontal/multicolumn lists and full native mouse tracking remain incomplete.

`CBS_OWNERDRAWFIXED` and `CBS_OWNERDRAWVARIABLE` now support dropdown-list,
editable dropdown and simple combos. Text and popup rows use separate native
measurements; draw, compare and delete callbacks identify `ODT_COMBOBOX` and the
actual combo HWND. The selected display uses `ODS_COMBOBOXEDIT` (0x1000).
`GetComboBoxInfo` and `CB_GETCOMBOBOXINFO` expose real `ComboLBox` and, for editable
styles, EDIT child HWNDs. Public item messages forward through the actual list
procedure, including native subclasses. ANSI/Unicode strings and opaque item
DWORDs remain separate. Font changes propagate to the children.

`CB_SHOWDROPDOWN`, dropped state/width/rectangle, text and variable item heights,
F4, navigation, Enter/Escape, mouse selection and outside-click dismissal now
operate on the native popup. Dropdown notification ordering follows Wine:
`CBN_DROPDOWN` precedes opening, selection-end precedes hiding and `CBN_CLOSEUP`
follows hiding. Popup drawing floats outside the parent client rectangle while
retaining native child coordinates. Native text setters do not produce user
edit notifications. Reset and destruction delete each item once.

Run `npm run test:owner-combos` for the unchanged MIT PE32 fixture, real Chromium
pixels and native exit-zero assertions; rebuild with `npm run build:owner-combos`.
See [the acceptance record](../evidence/owner-combos-browser-results.json) and
[Wine's combo implementation](https://github.com/wine-mirror/wine/blob/master/dlls/user32/combo.c).
Native children/GetComboBoxInfo also cover ordinary string combos, as described
below. Exact native dropdown geometry,
monitor-edge placement, hover/held-button tracking and universal GUI/DLL
compatibility remain incomplete.

`LBS_MULTIPLESEL` and `LBS_EXTENDEDSEL` now support ordinary ANSI/Unicode
strings and fixed/variable owner-drawn listboxes. Each item retains selection
separately from the caret and range anchor, so insertion, sorting and deletion
preserve the selected objects. `LB_SETSEL`, `LB_GETSEL`, `LB_GETSELCOUNT` and
bounded `LB_GETSELITEMS` queries expose the native item state. Both packed
`LB_SELITEMRANGE` and directional `LB_SELITEMRANGEEX` operate on inclusive
ranges; caret/anchor messages and `LB_GETCURSEL` remain distinct from selected
item counts. `LB_SETCURSEL` returns `LB_ERR` for multi-selection controls.
Programmatic selection produces no user-selection notifications.

Browser clicks toggle independent multiple selections; extended lists support
Control-click toggling, Shift ranges, navigation, caret-only Control navigation
and Space toggling. Command-click maps to Control-click on macOS. Native
owner callbacks draw each item's selected state independently of its focused
caret, preserve disabled state and use fixed/variable scrolling coordinates.
`npm run test:multi-lists` uploads the unchanged MIT PE32 fixture and checks
native APIs, bounded buffers, mouse/keyboard behavior, selected/focus/disabled
pixels, selection retention, reset and destruction. See
[the acceptance record](../evidence/multi-lists-browser-results.json).
Ordinary single-string, owner-drawn, multiple, extended, tabbed and drag-list controls route
keyboard selection through the native control procedure. `LBS_WANTKEYBOARDINPUT`
is accepted on string and raw owner-drawn lists. Parent `WM_VKEYTOITEM` and
`WM_CHARTOITEM` callbacks receive the key/Unicode character, current caret and
actual list HWND: signed `-1` requests default behavior, `-2` handles the input,
and a valid nonnegative result chooses a target. Invalid targets leave the
control unchanged; callbacks may destroy the control safely.

Character search cycles matching prefixes from the next row and wraps,
using the list locale and Windows-1252 conversion for ANSI messages. Simple
multiple lists move their caret without changing selected flags; extended
lists retain their anchor and select its range to the matching caret. Raw
owner-drawn items use parent callbacks instead of reading item data as text.
Owner-drawn dropdown-list combos forward characters to their real ComboLBox,
update the selection and retain the popup until commitment or dismissal.
`npm run test:list-keyboard` verifies these paths in Chromium with an unchanged
MIT PE32 fixture, native queries and real owner-drawing pixels. See
[the acceptance record](../evidence/list-keyboard-browser-results.json) and
[Wine's listbox implementation](https://github.com/wine-mirror/wine/blob/master/dlls/user32/listbox.c).

LISTBOX controls now receive standard native pointer messages through their
actual control procedure, including application subclasses and callable originals.
Single-selection lists follow the held pointer; extended lists grow and shrink
the selected range, preserve Shift anchors and support Control toggling followed
by range dragging. Multiple-selection lists toggle the initial item and move
the caret over subsequent rows. Variable owner-drawn rows use their native
measured heights for hit testing and selected/focused painting.

The native list owns capture. Holding the pointer above or below its client
area scrolls vertically through a private `WM_SYSTIMER` at 100 ms intervals,
including when the pointer stops moving. That timer does not replace an
application's `WM_TIMER` with the same ID. Release clears capture before
`LBN_SELCHANGE`; native cancel mode, capture transfer, focus loss, disable,
reset, application blur and destruction stop tracking and clean up timers.
Combo list drags commit inside the popup and restore the original selection
when released outside. Programmatic popup closure releases the hidden list's
capture and cancels its private timer. Browser list scrolling aligns to whole
native rows and synchronizes before pointer input, including when Chromium
scrolls an offscreen row into a tiny popup before delivering its scroll event.
MakeDragList retains its separate parent-directed
drag/drop protocol. Adjacent mouse moves coalesce without crossing button,
keyboard or window-message boundaries.

`npm run test:list-pointer` uploads an unchanged MIT PE32 program into Chromium.
Its guest subclasses count the actual pointer and system timer messages; native
queries verify selection, caret, anchor, HWND capture, notifications, cancellation,
capture transfer and application timer separation. Browser acceptance also
checks real owner-drawn selection pixels and stationary autoscroll. See
[the acceptance record](../evidence/list-pointer-browser-results.json).

Simple, editable dropdown and dropdown-list string combos now use actual
ComboLBox/EDIT child HWNDs and the same native popup/selection path as owner-drawn
combos. `GetComboBoxInfo` and `CB_GETCOMBOBOXINFO` expose those handles, classes,
parent relationships and text/button rectangles. Applications can query and
subclass their real native EDIT child. `CB_LIMITTEXT`, `CB_SETEDITSEL` and
`CB_GETEDITSEL` forward to that edit; focus, fonts and enabled state propagate to
the actual children. ANSI edits convert text at their procedure boundary using
Windows-1252; Unicode edits preserve Unicode text. Programmatic combo selection
and text setters suppress user edit/selection notifications. Reset clears the
native list and edit, and combo destruction removes its children.

Ordinary combo font changes recalculate the text area from the same font metrics
as `GetTextMetrics`, resize the real EDIT child and update native list row heights.
Passing a null font restores the runtime's system font in the browser controls.
Font changes preserve owner-drawn measurements. Ordinary dropdown text heights
cannot clip the selected font; simple combos honor an explicitly smaller text
height. Ordinary combo list-item heights follow the font and reject
`CB_SETITEMHEIGHT` for list rows, as Wine does. Direct list font changes also
update ordinary row heights and preserve owner-drawn rows.

Browser EDIT controls suppress the delayed DOM selection events generated by
native range changes. This prevents an older rendered selection from feeding
back into a newer `EM_SETSEL` during operations such as Metapad's Replace All;
user selection changes still reach the native edit state.

Ordinary combos render their native children and string popups in the browser.
F4, Alt+Up/Down, character navigation, popup mouse selection, Enter/Escape and
outside dismissal use guest messages and native combo notifications. Simple
combos retain a visible list. `npm run test:native-combos` uploads an unchanged
MIT PE32 program that asserts child handles/queries and actually subclasses its
EDIT child; browser input enters that guest procedure and forwards through the
original callable procedure. Native font/height queries and actual browser
geometry verify larger and restored fonts without replacing children or losing
selection. See [the acceptance record](../evidence/native-combos-browser-results.json).

Keyboard/API dropdown opening captures the real ComboLBox. Hover selects its
native row without sending edit or selection notifications. An arrow press
captures the COMBOBOX and exposes `STATE_SYSTEM_PRESSED` in `GetComboBoxInfo`;
entering its popup transfers capture and client coordinates to the actual list
procedure. Releasing on the arrow leaves the list open for hover. Releasing a
row commits; an outside press restores the selection, including unmatched
Unicode text in editable combos, and closes the popup. Native cancel mode
closes the popup and clears capture. Browser pointer capture transports the
input across this HWND handoff; application window procedures own the behavior.
Simple combo lists retain ordinary list selection without dropdown hover.

`npm run test:combo-pointer` uploads a separate unchanged MIT PE32 program.
Actual guest COMBOBOX, ComboLBox and EDIT subclasses call their original
procedures and verify mouse/capture-change messages, pressed state, coordinates,
selection/caret queries and notification order while trusted Chromium input
exercises these cases. The final drag runs without intermediate state waits.
Every native stage and normal destruction must exit zero. See
[the acceptance record](../evidence/combo-pointer-browser-results.json).

Native child queries now support `ChildWindowFromPoint[Ex]`, `GetTopWindow` and
`IsChild`. The point queries use the SDK's POINT-by-value ABI, parent client
coordinates, immediate child z-order and nonclient borders, with independent
invisible, disabled and transparent skip flags. Hierarchy queries distinguish
descendants from owned top-level windows and the window itself. RECT copy,
intersection, union, subtraction, empty checks and clearing preserve aliased
destinations and SDK output bounds; subtraction returns the remaining bounding
rectangle.

`WS_EX_TRANSPARENT` child windows defer generated paint messages until pending
siblings below them have painted. This preserves the message loop's HWND and
message filters and posted-message priority. The style changes paint order;
control background brushes and pointer input retain their existing behavior.
`npm run test:window-query` uploads an unchanged MIT PE32 SDK client both loose
and zipped. Actual native window procedures verify opaque-back,
transparent-middle, transparent-front `WM_PAINT` callbacks through
`PeekMessage`, `DispatchMessage`, `BeginPaint` and `EndPaint`. See
[the acceptance record](../evidence/window-query-browser-results.json).
Top-level standard controls still require implementation; this test uses a
registered custom top-level class.

`BeginDeferWindowPos`, `DeferWindowPos` and `EndDeferWindowPos` now stage sibling
layout changes without modifying geometry or entering application procedures
until the batch ends. Repeated HWNDs retain their insertion order and merge
move, size, z-order and suppression flags following
[Wine's deferred-position implementation](https://github.com/wine-mirror/wine/blob/master/dlls/win32u/window.c).
Ending a batch consumes its handle before callbacks and routes each merged
request through the same `SetWindowPos` path, including mutable WINDOWPOS,
nonclient calculation, MOVE/SIZE, repaint and browser geometry updates.

The browser runtime bounds this support to 64 live batches, 512 distinct
positions per batch and windows with a common parent. The initial count is a
capacity hint, with zero supported; exceeding the supported bound reports
out-of-memory. Invalid requests return errors without modifying staged entries.
End failures consume the batch and return failure; earlier applied positions
remain applied. This is sequential guest message processing, without a promise
of atomic compositor presentation or rollback.

The public MIT **window-defer** example is a native two-pane GUI. Ordinary
buttons arrange independently painted custom children side by side or stacked
and resize the root window. Its guest checks unchanged staged geometry,
repeated-HWND merging, callback order, final SDK rectangles and handle
consumption. `npm run test:window-defer` verifies trusted button input, actual
geometry and GDI pixels through EXE upload, ZIP upload and hosted example runs.
See [the acceptance record](../evidence/window-defer-browser-results.json).
The published source ZIP independently rebuilds the exact EXE.

GDI regions now have owned handles and canonical disjoint horizontal bands.
Rectangle construction normalizes reversed coordinates; boolean combination
supports AND, OR, XOR, DIFF and COPY with aliased sources/destinations. Region
queries, offsets, object types and guarded RGNDATA serialization/reconstruction
answer from the actual shape. Selecting a region copies its geometry into the
DC; changing or deleting the original handle cannot alter current or saved
clips. Clip combination and rectangle visibility use actual complex regions.
`FillRgn` and `FrameRgn` use the shared brush and clipped pixel renderer. Frame
edges follow Wine's four axial-translation intersections, so internal rectangle
boundaries do not appear as seams.

The **gdi-region** MIT native GUI selects difference, union, XOR and intersection
using ordinary buttons. Guest SDK assertions verify ownership, guarded region
data and sampled fill/frame/empty pixels. `npm run test:gdi-region` checks
100,000 browser pixels per stage through EXE, ZIP and hosted-example loading.
See [the acceptance record](../evidence/gdi-region-browser-results.json).
The public source ZIP independently rebuilds the exact EXE.

Region coordinates use the SDK's signed 27-bit domain. Canonical output is
bounded to 256 rectangles, input RGNDATA to 1024 rectangles, and region handles
share the 4096-object GDI allocation budget. Complexity failures preserve
destination shapes and clips. `ExtCreateRegion` currently supports NULL or
identity XFORM; nonidentity transforms return error 120. Window-region ownership and broader GDI mapping remain unfinished.

Exact native control layout, monitor-edge placement, horizontal or multicolumn
lists and universal GUI/DLL compatibility remain incomplete.

Polygon constructors now scan directed integer edges with ALTERNATE/WINDING
fill rules, including self-intersections and multiple contours. As on Wine,
nonstandard fill-mode values use alternate coverage unless the value is WINDING. Elliptical and
rounded constructors use Wine's integer boundary rules, including the extra
right/bottom exclusion. Five GDI shape constructors feed the existing owned
regions, copied clips, boolean operations and fill/frame drawing. Their geometry
matches 289 desktop Wine 11 oracle cases; the captured SDK outputs and original
oracle source live in `tests/fixtures/gdi-shapes/`.

The MIT **gdi-shapes** native GUI displays alternate/winding pentagrams, a hole,
a rounded rectangle, an ellipse and a copied clip whose source was deleted.
`npm run test:gdi-shapes` compares 96,000 browser pixels per stage against
desktop Wine geometry in EXE/ZIP/hosted modes. Region output remains bounded to
256 canonical rectangles, polygon inputs to 4096 points/contours, each sloped
edge and each rounded ellipse dimension to 32,768 units, and accumulated
sloped-edge work to 4,194,304 rows. Vertical polygon spans skip scanlines and
can cover the full signed coordinate domain. Excess complexity returns an
allocation error without consuming a region handle. Temporary FrameRgn raster
geometry permits up to 4096 bands, independently of the owned-region budget. General window regions,
nonidentity XFORMs and full GDI mapping remain unfinished.

Pattern brushes now retain independent color or monochrome bitmap pixels,
including source DIB writes made before brush construction. Deleting or changing
the original bitmap cannot change the brush. `CreateBrushIndirect` supports
solid, null, hatch and bitmap-pattern LOGBRUSH styles; DIB-pattern styles remain
unsupported. GetObject exposes native BS_PATTERN metadata and its original
source HBITMAP value. Pattern storage counts against the shared 16-million-pixel
GDI surface budget and is released with the brush.

Get/SetBrushOrgEx use signed device origins and participate in SaveDC/RestoreDC.
The shared rasterizer tiles both color and monochrome sources with copied clip
geometry. Monochrome patterns draw the DC text/background colors even in
TRANSPARENT mode; one-bit DIB patterns preserve their actual color table.
Six native hatch phases now match desktop Wine SDK GetPixel outputs, with brush
origins applying consistently to hatch and bitmap patterns. Standard native
control color callbacks copy the pattern and origin into the browser's control
background before the borrowed HDC and brush are released.

CreateBitmap now reads top-down WORD-aligned DDB rows and reports their input
depth; DIB APIs retain their distinct DWORD-aligned rows and signed height.
The **gdi-pattern** MIT native GUI verifies copied source ownership, indirect
brushes, saved origins, native hatch phases, copied ellipse clips and a
patterned standard label. Six stages per run check 86,400 surface pixels and
256 label-tile pixels against actual desktop Wine 11 output in EXE/ZIP/catalog
modes. The original oracle source and captured tiles live in
`tests/fixtures/gdi-pattern/`; the public source ZIP independently rebuilds the
exact native EXE. DIB-pattern construction, generalized coordinate mapping,
indexed DDB color mapping and arbitrary raster operations remain unfinished.

`FrameRect` now paints a one-pixel border using the supplied solid/null/hatch/
pattern brush, copied DC clips and brush origin, without changing selections.
Empty and reversed frame bounds return zero. `DrawFocusRect` draws an alternating
XOR outline and preserves selections, colors, background mode and origins.
Drawing it twice restores RGB pixels. Dash phase follows the entire perimeter
through clipping, and narrow or reversed rectangles match actual desktop Wine.
Raster work is bounded by visible surface dimensions even for extreme signed
coordinates. Unreadable browser-painted control pixels return unsupported
instead of fabricating a native background for the XOR operation.

The original MIT **gdi-frames** Windows SDK GUI offers Frame/Focus/Erase/Hatch/
Pattern/Clip buttons. Browser acceptance checks all 86,400 drawing-area pixels
in seven stages for EXE, ZIP and catalog loading against six actual native Wine
snapshots. An independent 26-case Wine pixel oracle covers clipping, degenerate
bounds, double drawing, state independence and brush phases. This resolves two
native common-control drawing imports; native comctl32 execution and broader
Windows compatibility still require additional APIs.

Bitmap-backed icons now retain separate native AND-mask and XOR-color planes.
`CreateIconIndirect` copies monochrome masks and 24/32-bit color bitmaps, or
both stacked planes of a monochrome icon; the original HBITMAPs can be deleted.
`CopyIcon` and icon `CopyImage` independently own their pixels and mask planes.
`GetIconInfo` returns newly allocated, caller-owned mask/color DDB handles,
normalized icon hotspots and a guarded PE32 ICONINFO. Color planes retain
native alpha through GetDIBits and reconstruction. Bitmap `CopyImage` uses
native color interpolation when resizing, retains monochrome mask bits, keeps
same-size alpha, clears resized-color alpha and ignores bitmap COPYRETURNORG.

`DrawIconEx` now distinguishes no image channel, mask-only, image-only and
normal drawing. Legacy normal icons apply native AND/XOR destination operations;
32-bit alpha takes precedence over the legacy mask. Rendering uses the DC's
copied clips and bounded visible loops, including extreme coordinates. Pixels
requiring an unreadable control background fail explicitly. `DrawIcon` uses
the native default icon dimensions. Shared resource decoding retains native
mask planes, and copied handles cannot mutate the original through callbacks.

The original MIT **icon-bitmap** GUI checks seven stages in EXE/ZIP/catalog
modes, all 86,400 drawing-area pixels per stage, against 16 actual Wine SDK
pixel snapshots. A separate native bitmap oracle verifies color interpolation,
monochrome scaling and alpha retention. Bitmap-created cursors now retain
ownership, type and hotspots, with independent copies and native destruction
behavior. The **owned-cursors** GUI checks visibility, outside hotspots and
destination inversion in the browser. Arbitrary color-bit XOR presentation,
flicker-brush/animated drawing and additional CopyImage conversion/resource
flags remain unsupported. Indexed color source constructors and broader native
common-controls execution remain unfinished.

### Native alpha blending

`msimg32.dll!AlphaBlend` and `gdi32.dll!GdiAlphaBlend` draw bounded source-over
pixels into window, memory and readable control DCs. Constant alpha uses one
rounded weighted sum; premultiplied pixel alpha uses separate rounded source
and destination products. Both match actual desktop Wine RGB and raw 32-bit
DIB destination alpha at opacity 0, 1, 2, 64, 127, 128, 254 and 255. The raw
alpha channel remains distinct from the opaque display shadow and survives
same-size bitmap copies and later pixel-alpha blending.

Source scaling uses nearest sampling. Source clips are ignored; copied complex
destination regions apply. Overlap on the same surface, negative extents and
source bounds fail before drawing. Zero extents succeed without painting.
24-bit sources use opaque alpha for global blending and reject AC_SRC_ALPHA.
Bottom-up DIB orientation and retained 32-bit DDB alpha have explicit checks.
Nonstandard 32-bit masks, per-pixel display sources and unreadable control
backgrounds fail explicitly instead of painting invented pixels.

The original MIT **gdi-alpha** SDK GUI compares both DLL entry points across
seven interactive stages. Its unchanged native EXE is compiled into Wasm
inside the browser in EXE/ZIP/catalog modes; each stage checks all 86,400 pixels
of the drawing area against native Wine snapshots. The source archive includes
the deterministic build and both desktop Wine oracles. This adds another GUI
library path; universal compatibility and native comctl32 execution remain
unproven.

### Native polygon and line drawing

`SetPolyFillMode`/`GetPolyFillMode` store the DC's alternate or winding rule,
including nested SaveDC/RestoreDC snapshots. Polygon fills now use native
integral-row, ceil(x), half-open directed-edge coverage. `PolyPolygon` combines
all contour coverage before outlining, so nested and opposite directions
produce their actual native holes. Polygon counts below two fail without
changing LastError; two-point outlines retain both endpoints.

`PolyPolyline` draws each independent group without connecting adjacent groups
or changing the current position. Group validation finishes before painting,
so an invalid later count cannot leave an earlier group drawn. Empty group
arrays succeed without painting. Point arrays share a 1,024-point budget.

Thin solid line pixels use native directional tie-breaking and retain the
original endpoint phase when clipped, with work bounded by the visible major
axis. A 112-case actual Wine SDK oracle checks both fill rules, randomized
self-intersections, nested/opposite contours, outlined/degenerate shapes,
complex clips and forward/reverse lines in all eight directions.

`CreatePenIndirect` copies actual LOGPEN metadata into an owned pen object.
Solid widths zero/one and negative one normalize as on native Wine; null pens
normalize to width one/color zero. The unused width-y becomes zero and source
descriptor mutation cannot change the pen. PALETTEINDEX flags resolve at draw
time against the current logical palette (including first-entry fallback), while
GetObject retains the raw color flags. Eighteen native color snapshots compare
default and selected logical palettes across LineTo, Polygon and PolyPolyline.
Wider/dashed styles and direct DIBINDEX colors fail explicitly.

The original MIT **gdi-paths** native GUI exercises these APIs in seven stages
through EXE/ZIP/catalog modes. Its drawing area checks all 86,400 pixels/stage
against Wine. The complete source archive includes the deterministic native
build and geometry/metadata oracles. Ellipse/arc geometry, nondefault DC mapping
and native common-controls execution remain separate compatibility work.

`StretchDIBits` now decodes uncompressed 1/4/8-bit indexed, 16-bit 555/565, padded
24-bit and 32-bit RGB input and supported RGB bitfields, including swapped masks.
Native 5/6-bit channel expansion uses bit replication. RGB and selected logical
palette color tables are supported. Signed source/destination extents, cropped
and partially off-image source rectangles, copied complex region clips and
BLACKONWHITE, WHITEONBLACK, COLORONCOLOR and HALFTONE modes have native Wine pixel
snapshots. Smooth scaling rounds each horizontal interpolation before the
vertical blend and resizes the visible source to the clipped destination bounds.
It clears resized alpha; same-size copies preserve alpha.

`SetStretchBltMode` and `GetStretchBltMode` keep per-DC settings included in
SaveDC/RestoreDC. The new scaling modes currently apply to `StretchDIBits`; the
older `StretchBlt` path retains its limited nearest sampling implementation.
Eight raster operations (SRCCOPY, SRCPAINT, SRCAND, SRCINVERT, NOTSRCCOPY, BLACKNESS,
WHITENESS, DSTINVERT) act on raw alpha as well as RGB. Inputs are snapshotted for
aliasing, guest memory is checked before painting, and loops are bounded by the
visible destination and the supported 4096x4096 source limit. Compressed DIBs
and other raster operations remain unsupported. Raster capability flags have
not been broadened.

The original MIT **gdi-stretch** SDK GUI compares four drawing channels with
Zoom/Mirror/Clip/Crop/Ink/Save/Clear/Shrink controls. Browser acceptance checks
125,440 drawing-area pixels in nine stages for EXE upload, ZIP upload and the
public catalog, using 505 independent desktop Wine RGB/raw-byte snapshots.
Authored native demo acceptance does not establish arbitrary DLL execution.

`SetDIBitsToDevice` now implements uncompressed indexed/RGB/bitfield scanline
transfers with copied input rows, bottom-up/top-down layouts, source crops and
complex destination clips. It reads the supplied partial buffer rather than
requiring the entire described bitmap. Native scanline counts, start offsets,
excess top-down row counts, empty transfers and raw 32-bit alpha bytes are
covered by 83 independently captured desktop Wine snapshots. Aliased input and
a one-row buffer next to a guard page are checked. Loops visit the clipped
destination and validated source rows. Compressed DIBs remain unsupported, and
raster capability flags have not been broadened.

The original MIT **gdi-transfer** SDK GUI compares four bitmap formats through
Full/Partial/Start/Crop/Clip/Extra/Clear/Pixel controls. The unchanged native PE
client checks return counts and raw alpha, then cleans up its bitmap and DC.
Browser acceptance compares 125,440 drawing-area pixels in nine stages across
EXE upload, ZIP upload and the public catalog. This is additional GUI API
coverage; arbitrary Windows DLL execution remains unfinished.

`GetNearestColor` now resolves selected logical palette colors and direct DIB
palette indices, finds native nearest indexed colors and truncates/expands
555/565 channels. Display DC queries preserve their input COLORREF as desktop
Wine does. The read-only query leaves bitmap pixels and selected objects
unchanged. 352 independently captured native results cover eight surface types
and default/custom logical palettes. An unchanged SDK PE32 client repeats the
checks through actual Wine base DLLs and browser-local x86-to-Wasm execution.
This closes another native comctl32 import (25 unresolved remain); import
closure still does not establish native common-controls DLL execution.

Pixel writes now use native high-bit channel truncation for packed bitmap formats.
Memory DC SetPixel resolves logical-palette flags and direct DIB indices, including
out-of-range indices that become zero. Writes preserve adjacent packed pixels and
row padding, and clear the reserved 32-bit alpha byte even for unchanged RGB.
217 independently reproduced desktop Wine cases compare result, LastError,
GetPixel and every raw destination byte across seven bitmap formats.

The original MIT **gdi-pixel-colors** native SDK GUI compares RGB, palette colors,
direct indices, boundary values and clipping side by side. Startup repeats all
217 expectations through actual Wine base DLLs. Browser acceptance checks
156,160 drawing-area pixels per stage in EXE, ZIP and catalog modes. The unchanged
x86 EXE compiles into Wasm in the browser. This adds bitmap GUI compatibility;
universal EXE/DLL execution remains unproven.

The generic bitfield decoder also matches 93 independently reproduced desktop
Wine pixel writes with 444, 332 and 10-bit channels. Narrow channels append one
copy of their significant bits; wider channels expose their high eight bits.
This corrects normalized rounding and overexpansion for unusual bitmap masks.

Bitmap-created cursors now share real image ownership with icons. CreateIconIndirect
preserves cursor hotspots, GetIconInfo returns independent bitmap planes, and
CopyIcon/CopyImage retain type and metadata. Same-size icon/cursor RETURNORG
requests create independent handles, matching native Wine. Shared resource images
survive destruction; owned handles retire, including the selected cursor whose
visible image remains until selection changes. DestroyCursor and DestroyIcon
preserve native destruction results and LastError. Resource monochrome metadata
uses a double-height mask without a color bitmap.

The original MIT **owned-cursors** SDK GUI exercises creation, copy/scaling,
visibility, outside hotspots, active destruction and recreation. Native captures
cover 18 ownership observations, eight resource metadata cases and 768 drawing
reference pixels. Units compare the covered owned cases and resource metadata;
stock cursor/icon GetIconInfo queries remain unsupported. Browser acceptance
compares ten drawing stages and actual pointer images, including a screenshot
of destination inversion. Overlays support monochrome/channel inversion, large
cursors and outside hotspots on the device pixel grid; destroyed cursor caches
are released. Arbitrary color-bit XOR presentation remains unsupported. This
closes DestroyCursor in the native comctl32 import graph (24 unresolved remain);
actual native common-controls DLL execution and universal compatibility remain
unfinished.
