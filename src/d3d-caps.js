// PE32 D3DCAPS8 (53 DWORDs) and D3DCAPS9 (76 DWORDs), from the pinned
// Wine/MinGW headers. This bounded profile describes implemented paths only.
export function deviceCaps(version) {
  const caps = new Uint32Array(version === 8 ? 53 : 76);
  caps[0] = 1; // D3DDEVTYPE_HAL: browser GPU rasterization.
  caps[3] = 0x20000000; // DYNAMICTEXTURES.
  caps[5] = 0x80000001; // Virtual ONE and IMMEDIATE presentation.
  caps[7] = 0x00080800; // HWRASTERIZATION | CANRENDERAFTERFLIP.
  caps[8] = 0x72; // MASKZ | CULLNONE | CULLCW | CULLCCW.
  caps[9] = 0x00400011; // COLORPERSPECTIVE | ZTEST | DITHER.
  caps[10] = 0xff; // All eight D3DCMPFUNC depth comparisons.
  caps[14] = 0x208; // COLORGOURAUDRGB | SPECULARGOURAUDRGB.
  caps[15] = 0x4005; // PERSPECTIVE | ALPHA | MIPMAP; NPOT 2D supported.
  caps[16] = 0x03030300; // MIN/MAG/MIP POINT and LINEAR.
  caps[19] = 0x17; // WRAP | MIRROR | CLAMP | INDEPENDENTUV.
  caps[22] = caps[23] = 2048; // Maximum 2D texture dimensions.
  caps[25] = caps[26] = 2048; // Repeat and aspect ratio.
  caps[27] = 1; // No anisotropic filtering.
  caps[35] = 1; // One FVF texture coordinate set.
  caps[36] = 0x4f; // DISABLE | SELECTARG1/2 | MODULATE | ADD.
  caps[39] = 0x3a; // Material sources, directional/positional lights, local viewer.
  caps[40] = 8; // Active fixed-function lights.
  caps[37] = caps[38] = 1; // One blend stage and sampled texture.
  new Float32Array(caps.buffer)[28] = 1e10; // Finite homogeneous W range.
  caps[45] = 21845; // Triangle-list primitive count (65,535 vertices).
  if (version === 9) {
    caps[58] = 1; // NumberOfAdaptersInGroup.
    caps[60] = 1; // One render target.
  }
  // Cube/volume textures, stencil, indexed streams and general shader
  // models remain unadvertised until their corresponding paths are implemented.
  return caps;
}
export function writeDeviceCaps(runtime, pointer, version, adapter = 0, type = 1) {
  if (adapter !== 0 || !pointer) return 0x8876086c;
  if (type !== 1) return 0x8876086b; // D3DERR_INVALIDDEVICE.
  const caps = deviceCaps(version);
  try {
    runtime.check(pointer, caps.byteLength, true);
  } catch {
    return 0x8876086c;
  }
  for (let i = 0; i < caps.length; i++) runtime.write32(pointer + i * 4, caps[i]);
  return 0;
}
