# Wine D3D12 shader test pair

`fullscreen.vs.dxbc` and `green.ps.dxbc` are extracted byte-for-byte from the
first `vs_code` and `ps_code` arrays in Wine 11.0's
[`dlls/d3d12/tests/d3d12.c`](https://github.com/wine-mirror/wine/blob/db11d0fe6a169c457e23d007e20404643d067aa8/dlls/d3d12/tests/d3d12.c).
The complete source and `COPYING.LIB` are retained here under
LGPL-2.1-or-later. Run `python3 extract.py` to regenerate the DXBC files and
hash manifest from that pinned source. The vertex shader generates a full-screen
triangle from `SV_VertexID`; the pixel shader returns opaque green. The
planned browser proof uses an inset viewport to distinguish the green interior
from untouched background.

These are shader-compiler fixtures, not a D3D12 application or evidence that
WineBrowser implements the D3D12 device API.
