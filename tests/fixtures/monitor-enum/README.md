Authored MIT native PE32 fixture; rebuild with `npm run build:monitor-enum`.

`npm run test:monitor-enum` uploads the unchanged executable into Chromium. Actual native stdcall callbacks query monitor information, reenter EnumDisplayMonitors and cancel enumeration. Input clipping rectangles must remain unchanged when the callback writes to its temporary output rectangle. Signed, outside and empty rectangles filter enumeration correctly.

A nested native BUTTON HWND supplies its actual GDI DC. Queries check client-relative monitor bounds, DC clipping, optional rectangle intersection and a partly offscreen parent. Native memory DCs use the selected bitmap bounds. Invalid and released DCs must fail without a callback. Native releases and normal window destruction must exit zero.

This covers one virtual monitor and the existing MM_TEXT GDI model. Multiple monitors, mapping transforms, full visible-region/occlusion behavior and top-level standard-control windows remain unfinished. No third-party binaries are included.
