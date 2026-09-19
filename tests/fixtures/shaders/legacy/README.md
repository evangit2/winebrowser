# Wine legacy shader fixtures

`wine-color.vs11.d3dbc` and `wine-color.ps20.d3dbc` are the little-endian
DWORD arrays retained in `wine-color-source.c`. They come from Wine 11 commit
`db11d0fe6a169c457e23d007e20404643d067aa8`,
`dlls/d3d9/tests/visual.c`, function `test_shademode`. The complete Wine LGPL
text is retained as `WINE-COPYING.LIB`. The shaders pass POSITION/COLOR through
VS 1.1 and return the interpolated color through PS 2.0.
