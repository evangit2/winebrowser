// PE32 D3DCAPS8 (53 DWORDs) and D3DCAPS9 (76 DWORDs), from the pinned
// Wine/MinGW headers. This bounded profile describes implemented paths only.
export function deviceCaps(version) {
  const caps = new Uint32Array(version === 8 ? 53 : 76);
  caps[0] = 1; // D3DDEVTYPE_HAL: browser GPU rasterization.
  caps[5] = 0x80000001; // Virtual ONE and IMMEDIATE presentation.
  caps[7] = 0x00080800; // HWRASTERIZATION | CANRENDERAFTERFLIP.
  caps[8] = 0x72; // MASKZ | CULLNONE | CULLCW | CULLCCW.
  caps[9] = 0x00400010; // COLORPERSPECTIVE | ZTEST.
  caps[10] = 0xff; // All eight D3DCMPFUNC depth comparisons.
  caps[14] = 0x8; // COLORGOURAUDRGB.
  new Float32Array(caps.buffer)[28] = 1e10; // Finite homogeneous W range.
  caps[45] = 21845; // Triangle-list primitive count (65,535 vertices).
  if (version === 9) {
    caps[58] = 1; // NumberOfAdaptersInGroup.
    caps[60] = 1; // One render target.
  }
  // Texture resources, lighting, stencil, indexed streams and general shader
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
