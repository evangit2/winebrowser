# File sections and mapped views

WineBrowser supports unnamed, file-backed `PAGE_READONLY` / `SEC_COMMIT` sections
through `NtCreateSection`, `NtMapViewOfSection`, `NtQuerySection` basic information,
`NtClose`, and `NtUnmapViewOfSection`. Ordinary uploads use the same objects through
`CreateFileMappingA/W`, `MapViewOfFile[Ex]`, `CloseHandle`, and `UnmapViewOfFile`.

A section records the exact requested maximum size (zero selects the current file
size). Mapping does not change a file handle's position. Base addresses and offsets
must be 64 KiB aligned, mapping sizes round to 4 KiB pages, and zero view size maps
from the offset to the section end. The final page includes backing file bytes
beyond a smaller requested extent; bytes beyond actual EOF are zero. An explicit
base cannot overlap an image, private reservation, NLS table, or another view.

File, section-handle, and view lifetimes are independent. A view survives closing
both handles. Unmapping any address inside the view, including its final page
padding, releases the entire view, removes its protection region, and zeroes the
released bytes. The object is collected after its last handle and view disappear.
These are guest data pages: writes and instruction execution are prohibited, and
`VirtualFree` cannot free them. General protection changes are not implemented.

The package file store remains authoritative. NT and Win32 writes refresh all
read-only aliases; growing a file preserves existing section maximum sizes.
Truncation/overwrite that would shrink a backing file returns
`STATUS_USER_MAPPED_FILE` / `ERROR_USER_MAPPED_FILE` until all its sections and views
are released. File-handle sharing is still governed by the existing file handles.
Closing a section never closes an unrelated file handle.

The implementation is bounded to 256 live section objects and the existing 256
view / 14 MiB shared virtual-memory arena limits (also used by NLS/private memory).
It does not implement named/opened/duplicated sections, another process's views,
pagefile mappings, writable shared aliases, copy-on-write, executable/image
sections, `SEC_RESERVE`, large pages, nondefault allocation/zero-bit flags, flush,
or section extension. These requests fail explicitly; they do not produce a
success stub or substitute a precompiled application.

## Validation

`npm run build:sections` reproducibly builds the freestanding fixtures.
`npm run test:sections` executes EXE, EXE plus sidecar, and nested ZIP uploads in
Chrome. The guest checks every byte of generated data and supplied sidecars,
offset views, closed-handle lifetimes, page tails, alignment/collision errors,
interior unmap and A/W APIs. `tests/file-sections.test.js` additionally covers
write rejection, NT access masks and output layouts, pointer validation before
mutation, read-only alias updates, truncation locks and resource exhaustion.

`npm run test:sections-native -- <wine-dll-dir> <nls-dir> [--browser]` executes a
separate fixture through real supplied Wine Kernel32/KernelBase/NTDLL, including
native create/map/query calls and partial section boundaries. Reports are in
`evidence/sections-{browser,native,native-browser}-results.json`. Installed Wine
DLLs and NLS data remain local diagnostic inputs, not redistributed runtime assets.

The implementation follows the [NT section contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntcreatesection),
[view contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwmapviewofsection),
and the pinned [Wine mapping conformance cases](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/kernel32/tests/virtual.c).
Fixture passage establishes this bounded path, not arbitrary Windows compatibility.
