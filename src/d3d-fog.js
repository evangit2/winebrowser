// D3D8/D3D9 fog. Both vertex fog (computed per vertex from the depth or radial
// distance) and table fog (the rasterizer's per-pixel depth lookup) reduce to
// the same blend, fogColor * factor + fragment * (1 - factor), so one WGSL
// helper covers the documented modes. The factor comes from the state the guest
// set: LINEAR over [start, end], EXP or EXP2 from the density.
export const FOG_MODE = Object.freeze([null, 'exp', 'exp2', 'linear']);
// D3DRS_* indices shared by the D3D8 and D3D9 ABI.
export const FOG_STATES = Object.freeze({
  28: 0, // FOGENABLE
  34: 0, // FOGCOLOR
  35: 0, // FOGTABLEMODE
  36: 0x3f800000, // FOGSTART (1.0f)
  37: 0x3f800000, // FOGEND (1.0f)
  38: 0x3f800000, // FOGDENSITY (1.0f)
  48: 0, // RANGEFOGENABLE
  140: 0, // FOGVERTEXMODE (D3DFOG_NONE)
});
export function validFogValue(key, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  if (key === 28 || key === 48) return value <= 1;
  if (key === 35 || key === 140) return value <= 3; // D3DFOG_NONE..LINEAR
  return true; // Colors and float bit patterns.
}
// Fog applies when either vertex or table fog is enabled. A table mode without
// a vertex mode is still fog; D3D selects the table path when the mode is not
// NONE, which is what a program asking for FOGTABLEMODE with FOGVERTEXMODE=NONE
// (Hamsterball's case) expects.
export function fogEnabled(state) {
  return !!state.fog[28] && !!(state.fog[35] || state.fog[140]);
}
export function fogSnapshot(state) {
  if (!fogEnabled(state)) return null;
  const asFloat = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
  return {
    mode: (state.fog[35] || state.fog[140]) >>> 0,
    color: state.fog[34] >>> 0,
    start: asFloat(state.fog[36]),
    end: asFloat(state.fog[37]),
    density: asFloat(state.fog[38]),
    range: !!state.fog[48],
  };
}
export function validFog(fog) {
  return (
    fog === undefined ||
    fog === null ||
    (
      typeof fog === 'object' &&
      FOG_MODE[fog.mode] !== null &&
      Number.isInteger(fog.color) &&
      fog.color >= 0 &&
      fog.color <= 0xffffffff &&
      Number.isFinite(fog.start) &&
      Number.isFinite(fog.end) &&
      Number.isFinite(fog.density) &&
      typeof fog.range === 'boolean')
  );
}
// Fog needs the camera-space depth. The vertex shader already computes the
// clip position, so fog uses that position's w component: it equals the
// distance along the view axis for a standard perspective transform, and the
// runtime's fog scope does not claim the radial variant for table fog.
export function fogCode(fog) {
  if (!fog) return '';
  const color = [
    ((fog.color >>> 16) & 255) / 255,
    ((fog.color >>> 8) & 255) / 255,
    (fog.color & 255) / 255,
  ];
  const literal = color.map((c) => c.toFixed(8)).join(', ');
  const mode = FOG_MODE[fog.mode];
  const body =
    mode === 'linear'
      ? `let range = max(${fog.end.toFixed(8)} - ${fog.start.toFixed(8)}, 1e-20);
  return clamp((${fog.end.toFixed(8)} - depth) / range, 0.0, 1.0);`
      : mode === 'exp'
        ? `return clamp(exp(-${fog.density.toFixed(8)} * depth), 0.0, 1.0);`
        : `let d = ${fog.density.toFixed(8)} * depth;
  return clamp(exp(-(d * d)), 0.0, 1.0);`;
  return {
    factor: `
fn winebrowser_fogFactor(depth: f32) -> f32 {
  ${body}
}`,
    color: `vec3<f32>(${literal})`,
  };
}
