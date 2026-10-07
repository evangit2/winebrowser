// Direct binary32/binary64 operations in the pinned SoftFloat Wasm instance.
// MXCSR is independent of the x87 control/status words even when the module is shared.
const ROUNDING = [0, 2, 3, 1];
const EXCEPTIONS = [
  'invalid',
  'denormal operand',
  'divide by zero',
  'overflow',
  'underflow',
  'precision',
];
const classify = (words, double) => {
  const high = words[double ? 1 : 0] >>> 0;
  const exponent = (high >>> (double ? 20 : 23)) & (double ? 0x7ff : 0xff);
  const fraction = high & (double ? 0xfffff : 0x7fffff) || (double && words[0]);
  return {
    denormal: exponent === 0 && !!fraction,
    nan: exponent === (double ? 0x7ff : 0xff) && !!fraction,
  };
};

export class SIMDFloat {
  constructor(getModule) {
    this.getModule = getModule;
    this.mxcsr = 0x1f80;
    this.pointer = 0;
  }

  dispose() {
    if (this.pointer) this.getModule()._free(this.pointer);
    this.pointer = 0;
  }

  // Inputs and outputs are raw words. No JS floating-point intermediates.
  evaluate(operation, double, left, right, predicate = 0) {
    const sf = this.getModule();
    if (!sf) throw Error('SSE floating-point module must be initialized before execution');
    if (!this.pointer) {
      this.pointer = sf._malloc(28);
      if (!this.pointer) throw Error('SSE floating-point scratch allocation failed');
    }
    const state = this.pointer,
      a = state + 4,
      b = a + 8,
      out = b + 8;
    const inputDouble = operation === 8 ? !double : double;
    let flags = 0,
      nan = false;
    const input = (value) => {
      const words = new Uint32Array([value[0], value[1] ?? 0]);
      if (operation === 5) return words;
      const kind = classify(words, inputDouble);
      nan ||= kind.nan;
      if (kind.denormal) {
        if (this.mxcsr & 0x40) {
          const sign = words[inputDouble ? 1 : 0] & 0x80000000;
          words.fill(0);
          words[inputDouble ? 1 : 0] = sign;
        } else if (operation !== 6 && operation !== 7) flags |= 2;
      }
      return words;
    };
    const av = input(left);
    const bv = operation <= 3 || operation >= 9 ? input(right) : new Uint32Array(2);
    let status = sf._wb_sf_init(state, 4, ROUNDING[(this.mxcsr >>> 13) & 3], 64, 1);
    if (status) throw Error(`SoftFloat SSE state error ${status}`);
    const view = new DataView(sf.HEAPU8.buffer);
    for (let lane = 0; lane < 2; lane++) {
      view.setUint32(a + lane * 4, av[lane], true);
      view.setUint32(b + lane * 4, bv[lane], true);
    }
    const ieeeOperation =
      operation === 13
        ? [1, 2, 5, 6].includes(predicate & 7)
          ? 10
          : 9
        : operation >= 11
          ? 10
          : operation;
    status = sf._wb_sf_ieee(state, 4, double ? 1 : 0, ieeeOperation, out, 8, a, 8, b, 8);
    if (status) throw Error(`SoftFloat SSE operation error ${status}`);
    const bits = sf.HEAPU8[state + 3];
    let result = new Uint32Array([view.getUint32(out, true), view.getUint32(out + 4, true)]);
    if (operation === 11 || operation === 12) {
      // MIN/MAX return the second operand for equal values (including signed
      // zero) and unordered comparisons. Its NaN payload is not quieted.
      const comparison = result[0] | 0;
      result = operation === 11 ? (comparison === -1 ? av : bv) : comparison === 1 ? av : bv;
    }
    if (operation === 13) {
      const comparison = result[0] | 0;
      const matches = [
        comparison === 0,
        comparison === -1,
        comparison <= 0,
        comparison === 2,
        comparison !== 0,
        comparison !== -1,
        comparison > 0,
        comparison !== 2,
      ];
      const mask = matches[predicate & 7] ? 0xffffffff : 0;
      result = new Uint32Array([mask, double ? mask : 0]);
    }
    // Invalid, NaN and zero-divide responses suppress lower-priority conditions.
    // Ordered/unordered classification predicates still report a denormal
    // operand alongside a NaN. Relational/equality comparisons suppress it.
    const classification = operation === 13 && [3, 7].includes(predicate & 7);
    if (!classification && (nan || bits & 24)) flags = 0;
    flags |=
      ((bits & 16) >>> 4) |
      ((bits & 8) >>> 1) |
      ((bits & 4) << 1) |
      ((bits & 2) << 3) |
      ((bits & 1) << 5);
    const masks = (this.mxcsr >>> 7) & 0x3f;
    if (!(flags & 7 & ~masks) && operation !== 6 && operation !== 7 && operation < 9) {
      if (classify(result, double).denormal) {
        if (!(masks & 16))
          flags |= 16; // Exact tiny results trap when UM is clear.
        else if (this.mxcsr & 0x8000) {
          const sign = result[double ? 1 : 0] & 0x80000000;
          result.fill(0);
          result[double ? 1 : 0] = sign;
          flags |= 0x30;
        }
      }
    }
    return { result, flags };
  }

  commit(flags) {
    const masks = (this.mxcsr >>> 7) & 0x3f;
    // An unmasked pre-computation exception in any lane prevents all
    // post-computation flags and the entire destination write.
    if (flags & 7 & ~masks) flags &= 7;
    this.mxcsr |= flags;
    const unmasked = flags & ~masks;
    if (unmasked) {
      const names = EXCEPTIONS.filter((_, bit) => unmasked & (1 << bit));
      throw Error(
        `Unmasked SIMD floating-point exception: ${names.join(', ')}; guest #XM delivery is unsupported`,
      );
    }
  }

  execute(operation, double, left, right, predicate = 0) {
    const { result, flags } = this.evaluate(operation, double, left, right, predicate);
    this.commit(flags);
    return result;
  }

  packed(operation, double, left, right, predicate = 0) {
    const result = new Uint32Array(4);
    const count = double || operation === 8 ? 2 : 4;
    const inputStride = operation === 5 ? 1 : operation === 8 ? (double ? 1 : 2) : double ? 2 : 1;
    const outputStride = operation === 6 || operation === 7 ? 1 : double ? 2 : 1;
    const binary = operation <= 3 || operation >= 9;
    let flags = 0;
    for (let lane = 0; lane < count; lane++) {
      const offset = lane * inputStride;
      const evaluated = this.evaluate(
        operation,
        double,
        (binary ? left : right).subarray(offset, offset + inputStride),
        right.subarray(offset, offset + inputStride),
        predicate,
      );
      flags |= evaluated.flags;
      result.set(evaluated.result.subarray(0, outputStride), lane * outputStride);
    }
    this.commit(flags);
    return result;
  }
}
