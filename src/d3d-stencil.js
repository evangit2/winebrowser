// Stencil and alpha-test render state. D3D's stencil operations and comparison
// functions map one-to-one onto WebGPU's, so the pipeline can carry them
// directly; the mask and reference values are plain integers on both sides.
export const INVALID_STENCIL_CALL = 0x8876086c;
// D3DSTENCILOP -> WebGPU stencil operation.
export const STENCIL_OP = Object.freeze([
  null,
  'keep',
  'zero',
  'replace',
  'increment-clamp',
  'decrement-clamp',
  'invert',
  'increment-wrap',
  'decrement-wrap',
]);
// D3DCMPFUNC -> WebGPU compare function. Identical ordering to the depth
// comparison table, repeated here so this module owns its own validation.
export const STENCIL_COMPARE = Object.freeze([
  null,
  'never',
  'less',
  'equal',
  'less-equal',
  'greater',
  'not-equal',
  'greater-equal',
  'always',
]);
export const defaultStencil = () => ({
  52: 0, // STENCILENABLE
  53: 1, // STENCILFAIL: KEEP
  54: 1, // STENCILZFAIL: KEEP
  55: 1, // STENCILPASS: KEEP
  56: 8, // STENCILFUNC: ALWAYS
  57: 0, // STENCILREF
  58: 0xffffffff, // STENCILMASK
  59: 0xffffffff, // STENCILWRITEMASK
});
export const defaultAlphaTest = () => ({
  15: 0, // ALPHATESTENABLE
  24: 0, // ALPHAREF (0-255)
  25: 8, // ALPHAFUNC: ALWAYS
});
export function validStencilValue(key, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  if ([53, 54, 55].includes(key)) return value >= 1 && value <= 8;
  if (key === 52) return value <= 1;
  if (key === 56) return value >= 1 && value <= 8;
  return true; // 57 reference, 58/59 masks.
}
export function setStencilState(state, key, value) {
  if (!validStencilValue(key, value)) return INVALID_STENCIL_CALL;
  state.stencil[key] = value;
  return 0;
}
export function validAlphaTestValue(key, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  if (key === 15) return value <= 1;
  if (key === 24) return value <= 0xff;
  return key === 25 && value >= 1 && value <= 8;
}
export function setAlphaTestState(state, key, value) {
  if (!validAlphaTestValue(key, value)) return INVALID_STENCIL_CALL;
  state.alphaTest[key] = value;
  return 0;
}
export const stencilState = (command) => ({ ...defaultStencil(), ...command.stencil });
export const alphaTestState = (command) => ({ ...defaultAlphaTest(), ...command.alphaTest });
export function validStencil(command) {
  const s = stencilState(command);
  return (
    (s[52] === 0 || s[52] === 1) &&
    [53, 54, 55].every((k) => STENCIL_OP[s[k]] !== null) &&
    STENCIL_COMPARE[s[56]] !== null &&
    [57, 58, 59].every((k) => Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= 0xffffffff)
  );
}
export function validAlphaTest(command) {
  const a = alphaTestState(command);
  return a[15] <= 1 && a[24] <= 0xff && STENCIL_COMPARE[a[25]] !== null;
}
// WebGPU stencil-face descriptor for the current state. Both faces share the
// same D3D state because separate two-sided stencil is not advertised.
export function stencilFace(command) {
  const s = stencilState(command);
  return {
    compare: STENCIL_COMPARE[s[56]],
    failOp: STENCIL_OP[s[53]],
    depthFailOp: STENCIL_OP[s[54]],
    passOp: STENCIL_OP[s[55]],
  };
}
// A per-fragment alpha test is a compare-and-discard inserted ahead of the
// guest's own output. The reference is the 0-255 ALPHAREF byte as UNORM.
export function alphaTestCode(alpha, command) {
  const a = alphaTestState(command);
  if (!a[15]) return '';
  const reference = (a[24] / 255).toFixed(8),
    operator = wgslCompare(STENCIL_COMPARE[a[25]]);
  // `always` and `never` are constants, not operators; only `never` discards.
  if (operator === 'true') return '';
  if (operator === 'false') return 'discard;';
  return `if (!(${alpha} ${operator} ${reference})) { discard; }`;
}
// The alpha comparison uses the interpolated diffuse alpha, which the fixed
// pipeline carries in the vertex color; the caller supplies the WGSL expression.
const WGSL_COMPARE = Object.freeze({
  never: 'false',
  less: '<',
  equal: '==',
  'less-equal': '<=',
  greater: '>',
  'not-equal': '!=',
  'greater-equal': '>=',
  always: 'true',
});
function wgslCompare(compare) {
  return WGSL_COMPARE[compare];
}
