# PE runtime test targets

The local smoke fixtures are small 32-bit PE programs that exercise file I/O, standard output, a basic message box, and a system beep. Their expected behavior and SHA-256 digests are recorded in [`public/demos/manifest.json`](../public/demos/manifest.json). Rebuild them with `npm run build:demos`; the script requires `i686-w64-mingw32-gcc`, its matching `objdump`, and Python 3. The ZIPs contain a top-level fixture folder; run each executable with that folder as the working directory. In particular, `files/files.exe` expects `assets/message.txt` relative to its working directory and creates `output.txt` there. These fixtures are deliberately narrow and do not establish universal Windows application compatibility.

## Independent application result

The unchanged, MIT-licensed [wesmar/Tetris x86 release](../tests/targets.json) now passes browser gameplay through `npm run test:tetris`. The checked-in test records the exact interactions and exit result in [`evidence/tetris-browser.json`](../evidence/tetris-browser.json). This is evidence for that pinned 16 KB executable and tested path only.

The [wesmar Minesweeper x86 release](../tests/targets.json) remains blocked: static inspection finds 32 unresolved imports, including common-controls, DWM, registry, dialog/menu/control and drawing services. It has not been run as a game.

## Third-party candidates

The candidates below are not browser-tested here. The availability notes describe what the upstream page offers; they do not imply that a program works in this runtime. Prefer downloading from the linked upstream project at test time. Do not copy binaries or assets into this repository without checking and following the applicable license and redistribution terms.

| Target                                                                                    | Coverage value                                                                                                                                           | Upstream availability                                                                                                                                                                                               | Suggested setup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [PuTTY](https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html)                   | Non-DX Win32 GUI application, useful for window creation, GDI painting, menus, dialogs, and networking paths.                                            | Upstream publishes standalone executables as well as installer packages; the current release page lists a 32-bit x86 Windows build.                                                                                 | Download the x86 standalone `putty.exe`. First inspect whether startup imports and instructions fit the implemented subset; network interaction is optional and may require more Win32 services.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| [7-Zip](https://www.7-zip.org/download.html)                                              | Non-DX console and filesystem workload, with real argument parsing, file traversal, compression, and substantial runtime/library code.                   | The official download page offers `7zr.exe` (x86 console) and x86 Windows packages.                                                                                                                                 | Start with the standalone x86 `7zr.exe`; test `7zr.exe l archive.7z` on a small archive. The standalone executable is still a large, high-coverage stress target, not a minimal smoke test.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [SDL examples](https://github.com/libsdl-org/SDL/tree/main/examples)                      | Cross-platform windowing/rendering and audio paths; SDL supports OpenGL and audio, while the current examples tree includes audio and renderer examples. | The official repository supplies source examples, not a ready-to-run Windows PE test binary for each example. SDL releases provide libraries/development files.                                                     | Build a selected example for Windows from the official source with SDL and its required graphics/audio dependencies, then test the resulting PE. The OpenGL guide and audio examples document focused API paths: [OpenGL](https://www.libsdl.org/release/SDL-1.2.15/docs/html/guidevideoopengl.html), [audio](https://www.libsdl.org/release/SDL-1.2.15/docs/html/guideaudioexamples.html).                                                                                                                                                                                                                        |
| [Microsoft Windows classic samples](https://github.com/microsoft/Windows-classic-samples) | Native Windows API examples, including GDI printing, Direct2D drawing, and WASAPI capture.                                                               | Source, project files, assets, and metadata are downloadable from the official repository; the repository explains that samples are built with Visual Studio. These are not generally prebuilt standalone binaries. | Build individual samples on Windows with the required Visual Studio/Windows SDK. Useful starting points: [GDI printer](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/Win7Samples/multimedia/gdi/printer), [Simple Direct2D application](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/Win7Samples/multimedia/Direct2D/SimpleDirect2DApplication), and [WASAPI capture](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/Win7Samples/multimedia/audio/CaptureSharedEventDriven). Check each sample's README for OS and device requirements. |
| [Humus 3D demos](https://humus.name/index.php?page=3D)                                    | Historical Direct3D workloads across API generations, including DX8/9 and later DX10/11 examples; useful as a separate graphics compatibility series.    | The author's catalog marks many entries with both “Executable” and “Source code” and links downloadable ZIP archives. Entries state their Direct3D version and hardware requirements.                               | Select a historical DX8/DX9 entry from the catalog and use its upstream executable archive; record the specific demo and stated requirements with each test. Later demos are separate DX10/11 targets, not substitutes for DX8/9.                                                                                                                                                                                                                                                                                                                                                                                  |

Third-party targets can depend on OS APIs, DLLs, drivers, display/audio devices, network access, files, and CPU instructions that these sample fixtures do not cover. Record the exact binary version, architecture, input files, runtime environment, and observed outcome for each test. A pass or failure on one target should be treated as evidence about that target only.

### Standard file dialogs and unchanged Metapad

`npm run test:file-dialogs` executes an original PE32 fixture with native
OPENFILENAME v4 A cancellation, A selection and reads, Unicode Save As with
case-preserving output, Explorer W multiselect, insufficient buffer reporting,
folder/filter UI, stop and package replacement. The native caller creates the
saved file and its exported bytes are checked. `npm run test:metapad-gui` also
executes the pinned unchanged official Metapad 3.6 LE binary from a private
cache, using its real Open, Save As, overwrite, Ctrl+S and reopen workflows.
`npm run fetch:metapad` validates the upstream ZIP and EXE hash; the executable
is excluded from public output.

Standard A/W common dialogs select existing guest files or import browser File
snapshots into fresh `_opened/<batch>/` directories. Cancel does not mutate the
native structure, filename buffer, filesystem or current directory. Save As
returns a path; ordinary native file APIs perform the write. Filters, default
extensions, file titles, offsets, read-only selection, Explorer multi-select,
path/file existence and overwrite/create prompts are handled. ANSI is CP1252;
unrepresentable selections fail rather than producing an unusable substituted
filename. `OFN_NOCHANGEDIR` preserves the runtime cwd. Imports are inputs and
only appear in exported outputs after native code edits them.

This verifies standard dialogs and ANSI editor workflows. Native hooks/custom
templates/help, legacy 8.3 multi-select, shell namespace extensions, modern
IFileDialog COM and exact Windows MRU/cwd-on-cancel rules remain incomplete.
Metapad advanced editing and arbitrary other GUI frameworks remain
unproved. See `evidence/file-dialog-browser-results.json` and
`evidence/metapad-gui-browser-results.json` for bounded acceptance evidence.

`npm run test:metapad-find` also executes the unchanged editor's native custom
Find/Replace templates, subclass callbacks and editable ComboBoxes. Its real
`CB_LIMITTEXT` bounds browser typing to 100 characters; `CB_SETEDITSEL` and
`CB_GETEDITSEL` support signed ranges and native DWORD output pointers without
clipping programmatic text. Find Next selects two different matching ranges,
Replace All writes two replacements, the native notice reports the count, and
Ctrl+S exports the checked bytes. Modified browser shortcut keys no longer
also perform unintended browser edits, including macOS Chromium's Control+H
Backspace conflicting with the native Replace accelerator. Ordinary browser
selection/clipboard/undo shortcuts remain available. The common-control
selection bridge retains user ranges without echoing programmatic selection.

This covers bounded ANSI Find Next and Replace All. RichEdit, single Replace,
advanced matching and encodings remain unverified. Acceptance evidence
is in `evidence/metapad-find-browser-results.json`; no Metapad executable is
published.

Native resource dialogs now create and propagate real `HFONT` handles from
classic `FONT` and extended weight/italic/charset fields before
`WM_INITDIALOG`. Dialog and control dimensions use the selected font's measured
alphabet width and line height; `MapDialogRect` uses the same per-dialog base
units. Property-sheet tabs/buttons use sheet units and inherit its font.
Resource-owned fonts are released after dialog children, including failed
creation and runtime disposal. Native replacement fonts retain caller ownership.

`npm run test:dialog-fonts` executes an authored PE32 fixture that checks A/W
resource font attributes with `GetObjectW`, child `WM_GETFONT`, actual control
geometry, fontless units, destruction and modal callbacks. Browser assertions
also verify bold italic caption/edit rendering. This uses host Canvas metrics
and font substitution at 96dpi; exact Windows rasterization, per-monitor DPI
and mixed-font page sizing remain unproved. Evidence:
`evidence/dialog-fonts-browser-results.json`.

`npm run test:metapad-settings` uploads the unchanged privately cached Metapad
executable and a portable INI file. It opens all four native property pages,
checks the application's tab-size validation and Cancel rollback, then applies
a six-space indentation preference and checks actual editor/file output.
Exporting and re-uploading the application's `metapad.ini` restores the chosen
tab size, checkbox and UNIX format in a new native run. Tab captions now use
native escaped-ampersand rules (or literal text with `TCS_NOPREFIX`), retain raw
text for `TCM_GETITEMA/W`, and use actual font widths/line heights for geometry,
hit testing and page margins. Explicit tab dimensions still take precedence.

Evidence is in `evidence/metapad-settings-browser-results.json`. Font/color
pickers, language plugins, printing and arbitrary GUI frameworks remain
unproved; these bounded tests do not establish universal Windows compatibility.

`ChooseColorA/W` now use an actual browser color picker instead of forced
cancellation. The shared PE32 structure retains COLORREF byte order and the
caller's 16 custom colors, including palette additions on Cancel and the
column order used by Wine. `CC_RGBINIT`, full-open/prevent-full-open and solid
RGB choices work. The native owner receives the registered `commdlg_ColorOK`
message and can veto acceptance. Owner enable state and pending pickers survive
Cancel, Stop and package replacement. Native hooks/templates/help fail explicitly.
The palette behavior follows [Wine's color dialog](https://github.com/wine-mirror/wine/blob/master/dlls/comdlg32/colordlg.c).

Ordinary edit/static/button/list controls now run native `WM_CTLCOLOR` callbacks
with a borrowed child HDC during painting, and copy its text/background brush
colors into the browser control. Solid/null/hatch brushes retain their native
ownership; hatch tiles use the same rasterizer as GDI. Read-only and disabled
edits send `WM_CTLCOLORSTATIC`. Enable changes and closing an owned dialog
invalidate underlying control colors. Borrowed contexts are released; callback-only scratch surfaces are discarded.
Public control HDCs and their drawing persist across color callbacks. Group-box frames now let mouse clicks reach
sibling controls, while actual nested HWND controls remain interactive.

`npm run test:color-dialogs` runs authored native A/W buffers, custom colors,
ColorOK veto and lifecycle acceptance. `npm run test:metapad-appearance` runs the
unchanged Metapad View page: font and color pickers set the preview and actual
editor, native INI output records those choices, and uploading that output
restores them in a fresh run. Evidence is in
`evidence/color-dialogs-browser-results.json` and
`evidence/metapad-appearance-browser-results.json`. Native common-dialog HWNDs,
indexed palettes, printing, language plugins and arbitrary GUI frameworks remain
unproved.

Standard browser controls now display real guest `GetDC`/`BeginPaint` GDI
through an independent transparent canvas in the HWND client area. Native
input elements retain text, selection, keyboard and mouse input; the canvas
passes pointer events and stays below nested child HWNDs. Default control
painting clears the invalid portion of guest drawing, and `SetWindowPos`
resizes the backing bitmap. Destruction releases the bitmap and acquired DCs.
Transparent GDI text preserves antialias coverage instead of introducing black
fringes over browser content.

`npm run test:control-drawing` uploads the authored unchanged PE32 fixture and
checks pixels on STATIC, EDIT, BUTTON and COMBOBOX, edit/client-edge coordinates, native
text, combo selection, clicks through opaque drawing, nested input, partial repaint, retained
HDCs, resize and destruction/recreation. Evidence is in
`evidence/control-drawing-browser-results.json`. `GetPixel`, `BitBlt` and
`StretchBlt` can read/copy fully guest-painted pixels. Uncovered pixels belong
to browser-painted content that has no native readback yet; these reads fail
explicitly with error120. Exact native control rasterization, scrolling,
caret/IME and arbitrary GUI/DLL support remain incomplete.

`BS_OWNERDRAW` buttons now use a real native `WM_DRAWITEM` callback, with
`ODT_BUTTON`, the child client RECT/HWND, the assigned font selected in its HDC,
and `WM_CTLCOLORBTN` before drawing. The interactive browser button contains a
canvas showing the application's pixels. `BM_GETSTATE`/`BM_SETSTATE` retain
pressed/focused state; callbacks distinguish `ODA_DRAWENTIRE`, `ODA_SELECT` and
`ODA_FOCUS`, and report `ODS_SELECTED`, `ODS_DISABLED` and `ODS_FOCUS`. Mouse,
Space/Enter and `BM_CLICK` release the pressed state before native `BN_CLICKED`.
Dragging outside cancels activation. Capture transfers notify the old HWND
with `WM_CAPTURECHANGED` and translate incoming client coordinates to the
captured HWND. `EnableWindow` now sends `WM_ENABLE`, so native controls can
repaint or cancel their pending input, and its result correctly reports whether
the window was previously disabled.

`npm run test:owner-buttons` verifies unchanged ANSI/Unicode native buttons,
held-pointer pixels and drag-out cancellation, focus/disabled GDI, native
keyboard/programmatic activation, selected font/color state, resizing and
zero exit. The authored fixture is reproducible with
`npm run build:owner-buttons`; evidence is in
`evidence/owner-buttons-browser-results.json`. The behavior follows
[Wine's button procedure](https://github.com/wine-mirror/wine/blob/master/dlls/user32/button.c).
Owner-drawn menus, dynamic `BM_SETSTYLE`, exact native pointer/nonclient
behavior and arbitrary GUI/DLL compatibility remain incomplete.

`npm run test:owner-combos` uploads the authored unchanged ANSI/Unicode PE32
fixture and checks fixed/raw sorted dropdown lists, variable editable dropdowns
and simple combos. The native EXE asserts text/item measurements, callback
structures, raw item data, real child HWNDs, list subclass forwarding, fonts,
clipped HDCs, notification ordering and deletion. Chromium verifies popup clicks
outside the parent, selection/focus/disabled pixels, F4/Escape, Unicode input,
native text setters, resize, reset and destruction. Evidence is in
`evidence/owner-combos-browser-results.json`. Only project-authored MIT source
and its reproducible EXE are included; no Hamsterball assets are published.

`npm run test:multi-lists` verifies authored native multiple string,
extended raw owner-drawn and variable Unicode listboxes. Native code checks
selection queries, bounded selected-index arrays, reversed ranges, caret and
anchor contracts, item data/drawing and cleanup; browser input checks independent
and extended selection, Control/Shift keyboard/mouse operations, disabled
pixels and insertion/deletion retention. Rebuild with
`npm run build:multi-lists`; evidence is in
`evidence/multi-lists-browser-results.json`.
