// Native applications often configure an effect while leaving it disabled.
// Preserve that state for GetRenderState without claiming the rendering path.
// Enabling any of these effects is still an explicit unsupported operation.
// Alpha test, stencil and fog are NOT here: src/d3d-stencil.js and
// src/d3d-fog.js implement them.
export const INACTIVE_EFFECT_DEFAULTS = Object.freeze({});
export function setInactiveEffect(state, key, value, version) {
  // FLOAT states retain their raw DWORD bits, including nonfinite values. They
  // cannot reach a shader while the associated rendering effect is disabled.
  state.inactiveEffects[key] = value;
  return 0;
}
