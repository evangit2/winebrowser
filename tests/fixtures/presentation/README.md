# Native fullscreen presentation fixture

`fullscreen.c` compiles the shared native D3D8 cube with an 800×600 R5G6B5
fullscreen device, FLIP swap effect and interval ONE. It executes through the
normal upload runtime, with no pretranslated application Wasm. The source checks
virtual display metrics and mode, borderless window geometry, then restores and
verifies the prior mode, rectangle and style on device release. Escape exits.

Rebuild with `npm run build:presentation`. Run `npm run test:presentation` to
upload the actual EXE and a ZIP in Chromium. The test requires visible geometry,
animation across pixel hashes, RGB565 channel levels, increasing presented frames,
no page errors and exit zero after the native restoration assertions.
`evidence/presentation-browser-results.json` records the binary SHA and results.

`npm run test:webgpu` and `npm run test:webgpu -- --force-readback` independently
check exact clear/draw pixel values, two-buffer FLIP rotation, retained COPY
contents and interval ONE pacing in both presentation paths. These backend checks
do not substitute for the native EXE/ZIP tests.

Scope and remaining limits: [D3D display/presentation](../../../docs/d3d-display.md).
