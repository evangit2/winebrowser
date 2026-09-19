# Wine legacy shader fixtures

`wine-color.vs11.d3dbc` and `wine-color.ps20.d3dbc` are the little-endian
DWORD arrays retained in `wine-color-source.c`. They come from Wine 11 commit
`db11d0fe6a169c457e23d007e20404643d067aa8`,
`dlls/d3d9/tests/visual.c`, function `test_shademode`. The complete Wine LGPL
text is retained as `WINE-COPYING.LIB`. The shaders pass POSITION/COLOR through
VS 1.1 and return the interpolated color through PS 2.0.

`wine-color-constant.vs11.d3dbc` is Wine's `color_color_shader_code_1` from
`test_vs_input()`. It passes POSITION through and multiplies COLOR by external
float constant register c0, allowing the browser test to verify constant upload.

`wine-pixel-constant.ps20.d3dbc` is Wine's `shader_code_20` from
`constant_clamp_ps_test()`. It adds external pixel float constants c1 and c2 and
writes the sum to the render target. Paired with the constant-free color vertex
shader, it verifies the pixel-only constant bind-group path.
