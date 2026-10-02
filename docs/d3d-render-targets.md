# D3D8/9 offscreen rendering

A selected surface now receives its own queued clears and draws. Switching color
or depth attachments flushes the preceding batch in guest call order, without
presenting a window frame. The implicit backbuffer retains its pixels while
separate offscreen targets render. Present displays that backbuffer even when an
offscreen surface remains selected.

Supported color storage is A8R8G8B8, X8R8G8B8 and R5G6B5. Default-pool 2D and cube
textures accept D3DUSAGE_RENDERTARGET; each mip/face has independent target storage.
Texture-level surfaces and standalone CreateRenderTarget surfaces use the same
selection path. Render-target textures reject CPU locks and sampling while they
are selected for rendering. Target selection resets the viewport; subsequent
viewport validation uses the selected level's dimensions. D3D9 slot zero requires
a non-NULL color surface, and NULL depth detaches the attachment. D3D8's combined
selection adapts its different ABI and restores the backbuffer for NULL color.

D16, D24X8 and D24S8 depth surfaces retain their GPU contents across target
switches. The Discard hint accepts either boolean value. Color and depth
attachments currently require equal dimensions. Multisampling, multiple color
attachments and lockable render targets remain unsupported.

This first implementation reads offscreen color pixels back at batch boundaries
and writes the native level's BGRA/RGB565 bytes before a later texture snapshot.
That makes ordinary fixed/programmatic texture sampling observe preceding writes,
including separate cubemap faces, without a game-specific path. It adds CPU/GPU
transfers and is a correctness baseline. GPU-only render-to-texture sampling is a
future optimization. Standalone targets, texture levels and depth surfaces release
their backend storage when their owners no longer retain them.

D3D9 GetRenderTargetData reads matching SYSTEMMEM surfaces; D3D8 CopyRects can
read rendered color surfaces. CPU copies **into** render targets are rejected
until an upload synchronization path exists. Texture snapshots remain immutable
for earlier draws. Backend pipelines, partial clears and RGB565 feedback use the
actual color attachment format, including RGBA offscreen targets alongside BGRA
canvas buffers.

`npm run build:render-targets` rebuilds the native PE32 fixtures with MinGW.
`npm run test:render-targets` uploads both EXE and ZIP forms of the D3D8 and D3D9
clients. They draw all six cube faces with a shared D16 attachment, check center
and border pixels through native surface reads, sample the cube into all 12,288
window pixels, animate the colors and exit zero. A standalone RGB565 target also
checks full and partial clears through native 16-bit readback. See
[the browser report](../evidence/render-targets-browser-results.json).
