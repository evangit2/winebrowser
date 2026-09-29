// Native applications often configure an effect while leaving it disabled.
// Preserve that state for GetRenderState without claiming the rendering path.
// Enabling any of these effects is still an explicit unsupported operation.
// Alpha test and stencil are NOT here: src/d3d-stencil.js implements them.
export const INACTIVE_EFFECT_DEFAULTS = Object.freeze({
  28: 0,
  34: 0,
  35: 0,
  36: 0,
  37: 0x3f800000,
  38: 0x3f800000,
  48: 0,
  140: 0, // Fog.
});
export function setInactiveEffect(state, key, value, version) {
  if (key === 28 && value)
    throw Error(`Unsupported IDirect3DDevice${version}.SetRenderState ${key}=${value}`);
  if (([35, 140].includes(key) && value > 3) || (key === 48 && value > 1)) return 0x8876086c;
  // FLOAT states retain their raw DWORD bits, including nonfinite values. They
  // cannot reach a shader while the associated rendering effect is disabled.
  state.inactiveEffects[key] = value;
  return 0;
}
