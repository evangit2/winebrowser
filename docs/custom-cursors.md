# Packaged custom cursors

LoadCursorA/W now resolves named and numeric RT_GROUP_CURSOR/RT_CURSOR resources
from uploaded EXEs and loaded DLLs. The guest still executes its native PE32 code
through the browser JIT. There is no special case for Hamsterball's BLANKCURSOR.

The loader validates resource tables, payload lengths, bitmap dimensions and
hotspots, selects an image for the virtual 32×32 system cursor, and returns a shared
handle. A/W calls and case-insensitive names reuse that handle within a module;
a separate DLL has its own cache. Failed loads leave the selected cursor unchanged.
Shared resource cursors are bounded to 256 per runtime. Bitmap-created cursors
share the owned icon registry, with a separate 256-image budget. CreateCursor,
sized/file cursor LoadImage and cursor-file APIs remain separate work.

Supported bitmap formats are uncompressed BITMAPINFOHEADER DIBs with 1-, 4-, 8-,
24- or 32-bit pixels. Indexed palettes and DWORD-aligned bottom-up rows are decoded
with their AND masks. Nonzero 32-bit alpha takes precedence over the legacy mask.
The shared icon decoder also gains 1/8-bit palettes and bounded partial palettes.
The group height may describe either the visible image or the doubled DIB height;
actual bitmap headers determine dimensions and depth, including resource compilers
that write a monochrome group-depth hint for color images.

LoadCursor scales images and hotspots to the same 32-pixel dimensions reported by
GetSystemMetrics(SM_CXCURSOR/SM_CYCURSOR). The current scaler is nearest neighbor;
exact native downsampling behavior across all bitmap/mask combinations is not
established. Monochrome and binary-channel destination inversion retain their
native AND/XOR planes. PNG/animated cursors, compressed/bitfield/older DIB headers
and arbitrary color-bit XOR presentation still fail explicitly. A fully transparent
monochrome cursor is decoded normally and retains its native handle.

SetCursor, GetCursor, ShowCursor counts, WM_SETCURSOR overrides and window-class
selection share the existing cursor state. Selection sends copied RGBA and native
planes with a hotspot to the desktop. The main thread caches PNG-backed CSS cursors
for ordinary images. Inverting images, images larger than 128 pixels and outside
hotspots use positioned canvas layers; a difference-blended layer inverts binary
RGB channels. Positions align to device pixels.
Window frames keep their drag/resize styles. Hiding a cursor preserves its selected
handle, and resetting the desktop clears generated cursor images and overlays.

CreateIconIndirect with fIcon=FALSE copies its bitmap planes and preserves the
supplied hotspot. CopyIcon and cursor CopyImage create independent images;
GetIconInfo returns caller-owned bitmap handles and the actual cursor metadata.
DestroyCursor and DestroyIcon preserve shared resources. Destroying a selected
owned cursor retires its public handle while retaining the selected image until
selection changes. Stock cursor/icon GetIconInfo remains unsupported.

## Verification

`npm run build:custom-cursors` builds a native EXE and a resource-only DLL with
MinGW and windres. Resources are generated from repository-owned source.
`npm run test:custom-cursors` uploads the loose EXE/DLL files and a nested ZIP.
Each run switches nine cursor images and checks every RGBA pixel and hotspot
(9,216 pixels per run), then checks hiding/restoring/null selection, class cursor
restoration, and clean native exit. It covers five pixel depths, multiple resource
sizes, upscaling, shared A/W handles, DLL resource lookup and transparent cursors.
The browser also rejects malformed image messages and clears stale handles on
reset. [Evidence](../evidence/custom-cursors-browser-results.json).

Unit tests cover resource parsing/selection, masks/alpha, hotspot bounds, downscale
hotspots, malformed resources, binary-channel inversion, arbitrary color XOR
rejection and immutable cached pixels/planes. The original MIT **owned-cursors**
GUI covers ten stages in EXE/ZIP/catalog modes, including copies, resizing,
visibility, outside hotspots and active destruction. Native ownership, resource
metadata and drawing captures accompany the client. See
[owned cursor evidence](../evidence/owned-cursors-browser-results.json).

The resource DLL test exposed a separate PE mapper error. An empty relocation
table no longer prevents alternate-base mapping when IMAGE_FILE_RELOCS_STRIPPED
is clear. A stripped image still fails before any target memory is changed, even
if it contains relocation records. That fix is committed as `3aeb4d3` and follows
the pinned Wine loader and the [PE specification](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).

The earlier Hamsterball diagnostic passed LoadCursorA and reached texture
startup. The NT file adapter now accepts FILE_RANDOM_ACCESS (options 0x860),
opens and maps `shadow.png`, then stops at an unsupported `IDirect3DTexture8.GetSurfaceLevel` after 9,420,850 guest
instructions. No game frame has rendered yet.

References: Microsoft [LoadCursor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadcursorw),
[LOCALHEADER](https://learn.microsoft.com/en-us/windows/win32/menurc/localheader),
[CURSORDIR](https://learn.microsoft.com/en-us/windows/win32/menurc/cursordir)
and pinned Wine `dlls/user32/cursoricon.c`. No game cursor asset is redistributed.
