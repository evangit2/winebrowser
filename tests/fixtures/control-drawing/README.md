Project-authored MIT native PE32 fixture, reproducible with `npm run build:control-drawing`.

`npm run test:control-drawing` uploads the unchanged executable into ordinary Chromium. Native STATIC, EDIT, BUTTON and COMBOBOX subclasses forward default painting and draw real GDI rectangles/text through GetDC. The browser checks visible pixels, transparent text, client-edge dimensions, typing/clicks/combo selection through drawing, nested child input, partial/default repaint, a retained edit HDC across WM_CTLCOLOR, resizing and destruction/recreation. The native process asserts lifecycle behavior and exits zero.

Uncovered browser-painted pixels have no native readback; GetPixel/source-copy operations on them return explicit error120. Exact native control rasterization, scrolling and caret/IME remain incomplete. No proprietary application binary is included.
