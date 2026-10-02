# RGBA16 textures and shared depth extents

D3D8/9 format 36, `A16B16G16R16`, uses eight native bytes per pixel. Creation,
capability queries, mip pitches, 2D/cube/volume snapshots, offscreen storage and
readback retain those components. The worker requests WebGPU
`texture-formats-tier1` and `float32-filterable` when available. Without both,
the guest capability query rejects this format.

Render attachments use actual `rgba16unorm`. WebGPU specifies that normalized
16-bit textures are unfilterable, so sampled snapshots expand each component
to `rgba32float`, whose 23-bit significand preserves all UNORM16 values.
Linear filtering then works without reducing the data to eight bits or half
precision. The GPU upload budget accounts for this expansion. Readback copies
native 16-bit bytes and strips WebGPU's padded rows.

Direct3D allows a depth/stencil surface larger than its color target. WebGPU
requires matching attachment extents. The renderer therefore pads a temporary
color attachment to the depth extent, copies in/out the original color region,
and retains the original shared depth texture. Viewports and scissor regions
stay at the guest's color dimensions. Depth/stencil clears use a clipped draw
to preserve data outside that region. Color-only batches leave an unused depth
surface untouched. Smaller depth attachments still fail when used.

Disabled Z testing now also suppresses depth writes in draw snapshots, while
`GetRenderState(ZWRITEENABLE)` retains the stored guest state.

Verification includes:

- D3D8/9 COM capability checks, exact native mip/snapshot bytes and target
  readback with low 16-bit component values.
- Ordinary Chromium GPU checks for 16-bit clears, padded-row readback,
  fixed-function and browser-compiled legacy shader linear filtering.
- Exact shared-depth and stencil pixels inside/outside a smaller color target,
  allocation release and invalid smaller-depth rejection.
- Existing native six-face target/RGB565 upload and graphics regressions.
- Unchanged freely redistributable Humus Water ZIP and catalog paths: two
  128x128 RGBA16 targets, original shader physics, JPEG cubemap decoding,
  reflective scene/ripple animation excluding FPS text, 120 frames and clean
  exit in ordinary headed Chromium. Startup remains tens of seconds.

```sh
node scripts/test-rgba16-backend.mjs
node scripts/test-shared-depth-extent-backend.mjs
WINEBROWSER_NORMAL_CHROMIUM=1 node scripts/test-water-browser.mjs
```

Evidence is in `evidence/rgba16-backend-results.json`,
`evidence/shared-depth-extent-backend-results.json` and
`evidence/water-browser-results.json`. Texture feature/sample rules follow the
[WebGPU specification](https://gpuweb.github.io/gpuweb/#texture-formats).
