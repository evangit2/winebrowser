# Common-control toolbar bitmaps

Unmodified Wine common-control bitmap sources at revision
`db11d0fe6a169c457e23d007e20404643d067aa8`. Resource declarations and copyright notice
are in `comctl32.rc`; LGPL-2.1-or-later text is in `COPYING.LIB`.
The manifest records each upstream URL and SHA-256.

WineBrowser decodes these standard strips through its shared GDI DIB converter;
`python3 scripts/generate-toolbar-assets.py` regenerates the byte bundle used
by the runtime. No Windows application binaries are included.
