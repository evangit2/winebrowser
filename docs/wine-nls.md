# Wine NLS data boundary

`src/wine-nls.js` implements a bounded Wine 11 i386 mapping boundary for
NtInitializeNlsFiles, NtGetNlsSectionPtr and NtQueryDefaultLocale. Locale and
code-page algorithms remain guest Wine code. No NLS data is shipped here.

Runtime consumers can supply `nlsFiles: Map<basename, Uint8Array>`. An uploaded
package can instead put system data in `nls/` beside its selected executable.
The runtime snapshots those bytes (at most 256 resources / 16 MiB). This is an
explicit package convention, not a claim to implement Windows system-file
search or a complete Wine prefix. The bootstrap system/user LCID is en-US
`0x409`, consistent with the existing host ANSI code page 1252.

`src/section-views.js` maps copied data as read-only, non-executable page regions
in the shared 14 MiB VM arena. Each mapping has an independent lifetime; a
section cannot be freed as an ordinary virtual allocation. NtUnmapViewOfSection
supports the current-process pseudo-handle and removes the complete view
containing the supplied address. Shared/process-external sections, section
handles, general NtCreateSection/NtMapViewOfSection, and writable mappings are
not implemented. Process allocations and section effects are retained across
failed DLL loads, like existing guest virtual-allocation effects.

The Wine-specific contracts include:

- NtInitializeNlsFiles maps locale.nls, sets the LCID, and leaves its third
  LARGE_INTEGER output untouched, matching Wine 11.
- NtGetNlsSectionPtr selects sortdefault, l_intl, numbered code-page and
  normalization tables by type/id. It returns the page-rounded mapping extent.
- Missing data returns an NT failure; invalid pointers do not create a mapping.
- Callers must explicitly unmap temporary views or retain them for process life.

The optional CRT probe accepts an installed NLS directory as its second
argument. It checks each file against
[runtime/wine/nls-probe-manifest.json](../runtime/wine/nls-probe-manifest.json)
and records hashes and the subsequent startup failure. It now executes through
the NLS mapping calls, but **the full Wine CRT closure still does not initialize**.
No application compatibility is inferred from this probe.

Data redistribution requires a separate review: Wine's NLS generators consume
multiple upstream datasets with their own notices, not solely Wine's LGPL code.
See the pinned [Wine NLS mapping implementation](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/ntdll/unix/env.c)
and [data generator](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/tools/make_unicode).
