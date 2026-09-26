// Native applications often configure an effect while leaving it disabled.
// Preserve that state for GetRenderState without claiming the rendering path.
// Enabling any of these effects is still an explicit unsupported operation.
export const INACTIVE_EFFECT_DEFAULTS = Object.freeze({
  15: 0,
  24: 0,
  25: 8, // Alpha test enable, reference, comparison.
  28: 0,
  34: 0,
  35: 0,
  36: 0,
  37: 0x3f800000,
  38: 0x3f800000,
  48: 0,
  140: 0, // Fog.
  52: 0,
  53: 1,
  54: 1,
  55: 1,
  56: 8,
  57: 0,
  58: 0xffffffff,
  59: 0xffffffff, // Stencil.
});
export function setInactiveEffect(state, key, value, version) {
  if ([15, 28, 52].includes(key) && value)
    throw Error(`Unsupported IDirect3DDevice${version}.SetRenderState ${key}=${value}`);
  if (
    ([25, 53, 54, 55, 56].includes(key) && (value < 1 || value > 8)) ||
    ([35, 140].includes(key) && value > 3) ||
    (key === 48 && value > 1)
  )
    return 0x8876086c;
  // FLOAT states retain their raw DWORD bits, including nonfinite values. They
  // cannot reach a shader while the associated rendering effect is disabled.
  state.inactiveEffects[key] = value;
  return 0;
}
