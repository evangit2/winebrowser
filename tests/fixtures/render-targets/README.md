# Native D3D8/9 render-target regression

These project-owned MIT-licensed PE32 fixtures are compiled from `main.c` with
`scripts/build-render-targets-fixture.sh`. They are independent of Hamsterball.

Each client renders six cubemap faces using a shared D16 depth surface, checks
center/border pixels with native LockRect after GetRenderTargetData (D3D9) or
CopyRects (D3D8), samples the cube across six window strips, animates and closes
through its normal window handler. A standalone R5G6B5 target also validates
full/partial clears and exact 16-bit readback. Browser verification checks every
window pixel and requires exit zero for bare EXE and ZIP uploads.
