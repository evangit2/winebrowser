# Native DirectDraw/Direct3D7 contracts

Project-owned MIT fixtures built from `main.c` with
`scripts/build-directdraw-fixtures.sh`, against actual MinGW DD1/DD7/D3D7 headers.
No game code or assets are included.

The DD1 and DD7 variants check enum callback ABI, legacy caps bounds, RGB565
Lock/Unlock, overlapping BltFast, busy locks and source keys. They display an
animated red/green framebuffer with a blue rectangle. The D3D7 variant converts
a 2×2 alpha texture, draws indexed geometry, checks D16 occlusion against a farther
nonindexed quad, validates sampler enum roundtrip, updates a bound texture without rebinding, and reads both frontbuffer and backbuffer through
DirectDraw Lock. All variants release their objects and print a PASS marker after
the guest handles WM_CLOSE. The browser checks every presented pixel for EXE and
ZIP uploads. See `docs/directdraw.md` for supported scope and remaining gaps.
