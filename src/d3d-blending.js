// DWORD render states shared by the native D3D8/9 ABI and GPU command snapshots.
export const BLEND_DEFAULTS = Object.freeze({
  19: 2,
  20: 1,
  27: 0,
  168: 15,
  171: 1,
  193: 0xffffffff,
  206: 0,
  207: 2,
  208: 1,
  209: 1,
});
export function blendDefaults(version = 9) {
  return Object.fromEntries(
    Object.entries(BLEND_DEFAULTS).filter(([k]) => version === 9 || +k < 193),
  );
}
export function validBlendValue(state, value, version = 9) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  if (version === 8 && state >= 193) return false;
  if ([19, 20, 207, 208].includes(state))
    return (
      (value >= 1 && value <= 11) ||
      (state === 19 && [12, 13].includes(value)) ||
      (version === 9 && [14, 15].includes(value))
    );
  if ([27, 206].includes(state)) return value <= 1;
  if (state === 168) return value <= 15;
  if ([171, 209].includes(state)) return value >= 1 && value <= 5;
  return state === 193;
}
export function setBlendState(state, key, value, version) {
  if (!validBlendValue(key, value, version)) return 0x8876086c;
  state.blendState[key] = value;
  return 0;
}
export function validBlending(blend) {
  return (
    blend === undefined ||
    (blend !== null &&
      typeof blend === 'object' &&
      !Array.isArray(blend) &&
      Object.entries(blend).every(
        ([k, v]) => Object.hasOwn(BLEND_DEFAULTS, k) && validBlendValue(+k, v),
      ))
  );
}
export const blendState = (command) => ({ ...BLEND_DEFAULTS, ...command.blend });
export const blendConstant = (command) => {
  const c = blendState(command)[193];
  return [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, (c >>> 24) / 255];
};
export const needsBlendFeedback = (surface, command) =>
  surface.colorFormat === 23 && !!blendState(command)[27] && !!(blendState(command)[168] & 7);
export function blendKey(command) {
  // The constant is uploaded per draw, never baked into a pipeline.
  return Object.entries(blendState(command))
    .filter(([k]) => +k !== 193)
    .map(([, v]) => v)
    .join(',');
}
function factors(s, alpha = false) {
  if (alpha && s[206]) return [s[207], s[208], s[209]];
  return [
    s[19] === 12 ? 5 : s[19] === 13 ? 6 : s[19],
    s[19] === 12 ? 6 : s[19] === 13 ? 5 : s[20],
    s[171],
  ];
}
export function usesBlendConstant(command) {
  const [src, dst, op] = factors(blendState(command));
  return op < 4 && [src, dst].some((v) => v === 14 || v === 15);
}
const FACTORS = [
  null,
  'zero',
  'one',
  'src',
  'one-minus-src',
  'src-alpha',
  'one-minus-src-alpha',
  'dst-alpha',
  'one-minus-dst-alpha',
  'dst',
  'one-minus-dst',
  'src-alpha-saturated',
];
const OPS = [null, 'add', 'subtract', 'reverse-subtract', 'min', 'max'];
function hardwareFactor(value, alpha, opaque) {
  if (alpha) {
    if (value === 3) value = 5;
    if (value === 4) value = 6;
    if (value === 9) value = 7;
    if (value === 10) value = 8;
    if (value === 11) return 'one';
  }
  if (opaque && value === 7) return 'one';
  if (opaque && (value === 8 || value === 11)) return 'zero';
  return value === 14 ? 'constant' : value === 15 ? 'one-minus-constant' : FACTORS[value];
}
export function colorTarget(surface, command, format) {
  const s = blendState(command),
    target = { format, writeMask: s[168] };
  if (!s[27] || surface.colorFormat === 23) return target;
  const component = (alpha) => {
    const [src, dst, op] = factors(s, alpha);
    return {
      operation: OPS[op],
      srcFactor: op >= 4 ? 'one' : hardwareFactor(src, alpha, surface.colorFormat === 22),
      dstFactor: op >= 4 ? 'one' : hardwareFactor(dst, alpha, surface.colorFormat === 22),
    };
  };
  target.blend = { color: component(false), alpha: component(true) };
  return target;
}
// RGB565 has no destination alpha. Decode expanded UNORM8 storage back to
// its exact 5/6-bit value before arithmetic; quantize only AFTER blending.
export function feedbackShader(command, prefix) {
  const [src, dst, op] = factors(blendState(command));
  const factor = (value) =>
    ({
      1: 'vec3(0.0)',
      2: 'vec3(1.0)',
      3: 's.rgb',
      4: '(vec3(1.0)-s.rgb)',
      5: 'vec3(s.a)',
      6: 'vec3(1.0-s.a)',
      7: 'vec3(1.0)',
      8: 'vec3(0.0)',
      9: 'd',
      10: '(vec3(1.0)-d)',
      11: 'vec3(0.0)',
      14: `${prefix}constant.rgb`,
      15: `(vec3(1.0)-${prefix}constant.rgb)`,
    })[value];
  const a = `(s.rgb * ${factor(src)})`,
    b = `(d * ${factor(dst)})`;
  const expression =
    op === 4
      ? 'min(s.rgb,d)'
      : op === 5
        ? 'max(s.rgb,d)'
        : op === 1
          ? `${a}+${b}`
          : op === 2
            ? `${a}-${b}`
            : `${b}-${a}`;
  return `
@group(2) @binding(0) var ${prefix}destination: texture_2d<f32>;
@group(2) @binding(1) var<uniform> ${prefix}constant: vec4<f32>;
fn ${prefix}blend(color: vec4<f32>, position: vec2<f32>) -> vec4<f32> {
  let s = clamp(color, vec4(0.0), vec4(1.0));
  let levels = vec3(31.0,63.0,31.0);
  let stored = textureLoad(${prefix}destination, vec2<i32>(position), 0).rgb;
  let d = floor(stored * levels + vec3(0.5)) / levels;
  return vec4(${expression}, 1.0);
}
`;
}
