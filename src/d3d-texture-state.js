// D3D8 folds sampler states into texture-stage state. Keep raw DWORDs so
// Get*State round-trips float bit patterns and queued draws own their state.
export const INVALID_TEXTURE_CALL = 0x8876086c;
export const SAMPLER8 = { 13: 1, 14: 2, 25: 3, 15: 4, 16: 5, 17: 6, 18: 7, 19: 8, 20: 9, 21: 10 };
export const floatState = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];
export const defaultSampler = () => ({
  1: 1,
  2: 1,
  3: 1,
  4: 0,
  5: 1,
  6: 1,
  7: 0,
  8: 0,
  9: 0,
  10: 1,
  11: 0,
});
export const defaultStage = (i = 0) => ({
  1: i ? 1 : 4,
  2: 2,
  3: 1,
  4: i ? 1 : 2,
  5: 2,
  6: 1,
  11: i,
  24: 0,
  28: 1,
});
export function validSamplerValue(type, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  if ([1, 2, 3].includes(type)) return [1, 2, 3].includes(value); // wrap, mirror, clamp
  if (type === 4) return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  if ([5, 6].includes(type)) return [1, 2].includes(value);
  if (type === 7) return [0, 1, 2].includes(value);
  if (type === 8) return Number.isFinite(floatState(value)) && Math.abs(floatState(value)) <= 16;
  if (type === 9) return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  if (type === 10) return value === 1;
  if (type === 11) return value === 0;
  return false;
}
export function validStageValue(type, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return false;
  if ([1, 4].includes(type)) return [1, 2, 3, 4, 7].includes(value); // disable/select/modulate/add
  if ([2, 3, 5, 6].includes(type)) return !(value & ~0x3f) && (value & 15) <= 2;
  if (type === 11) return Number.isInteger(value) && value >= 0 && value < 8;
  if (type === 24) return value === 0; // texture transforms not yet supported
  if (type === 28) return value === 1; // CURRENT
  return false;
}
export function textureStateMethod({ sampler = false, get = false, version = 9 } = {}) {
  return {
    argc: 4,
    invoke(r, a, o) {
      const index = a(1) >>> 0,
        type = a(2) >>> 0;
      const translated = !sampler && version === 8 ? SAMPLER8[type] : undefined;
      const isSampler = sampler || translated !== undefined;
      const key = translated ?? type;
      const states = isSampler ? o.state.samplers : o.state.textureStages;
      if (index >= states.length || !(key in states[index])) return INVALID_TEXTURE_CALL;
      if (get) {
        r.check(a(3), 4, true);
        r.write32(a(3), states[index][key]);
      } else {
        const value = a(3) >>> 0;
        if (!(isSampler ? validSamplerValue : validStageValue)(key, value))
          throw Error(
            `Unsupported D3D${version} ${isSampler ? 'sampler' : 'texture-stage'} state ${type}=${value}`,
          );
        states[index][key] = value;
      }
      return 0;
    },
  };
}
