// Integer interval arithmetic for x87 extended-range logarithms. Bounds are
// refined until both endpoints round to the same ext80 result; inputs never
// pass through binary64. See docs/x87-transcendentals.md for scope and references.
const J = 1n << 63n;
const Q = 1n << 62n;
const ln2Cache = new Map();
const ceil = (n, d) => (n + d - 1n) / d; // nonnegative operands only

function unpack(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 10);
  const sig = view.getBigUint64(0, true),
    field = view.getUint16(8, true);
  const exponent = field & 0x7fff,
    negative = !!(field & 0x8000);
  const invalid = exponent !== 0 && !(sig & J);
  const nan = exponent === 0x7fff && !!(sig & (J - 1n));
  return {
    bytes,
    sig,
    exponent,
    negative,
    invalid,
    nan,
    signaling: nan && !(sig & Q),
    infinity: !invalid && exponent === 0x7fff && sig === J,
    zero: exponent === 0 && sig === 0n,
    denormal: exponent === 0 && sig !== 0n && !(sig & J),
    shift: (exponent || 1) - 16383 - 63,
  };
}

function pack(sig, exponent, negative) {
  const bytes = new Uint8Array(10),
    view = new DataView(bytes.buffer);
  view.setBigUint64(0, sig, true);
  view.setUint16(8, exponent | (negative ? 0x8000 : 0), true);
  return bytes;
}
const answer = (bytes, flags = 0, roundedUp = false) => ({ bytes, flags, roundedUp });
const invalid = () => answer(pack(J | Q, 0x7fff, true), 1);
const infinity = (negative, flags = 0) => answer(pack(J, 0x7fff, negative), flags);
const zero = (negative, flags = 0) => answer(pack(0n, 0, negative), flags);

function specialNaN(...operands) {
  if (operands.some((v) => v.invalid)) return invalid();
  const nan = operands.find((v) => v.signaling) ?? operands.find((v) => v.nan);
  return nan
    ? answer(pack(nan.sig | Q, 0x7fff, nan.negative), operands.some((v) => v.signaling) ? 1 : 0)
    : null;
}

// Round n * 2^shift to the 64-bit significand, with full extended exponent
// range. x87 transcendental instructions ignore precision-control bits.
function roundDyadic(n, shift, rounding) {
  const negative = n < 0n;
  let mag = negative ? -n : n;
  if (!mag) return zero(negative);
  let exponent = mag.toString(2).length - 1 + shift;
  const overflow = () => {
    const toInfinity =
      rounding === 0 || (rounding === 1 && negative) || (rounding === 2 && !negative);
    return answer(
      pack(toInfinity ? J : 2n * J - 1n, toInfinity ? 0x7fff : 0x7ffe, negative),
      0x28,
      toInfinity,
    );
  };
  if (exponent > 16383) return overflow();
  const discard = Math.max(exponent - 63, -16445) - shift;
  let inexact = false,
    up = false;
  if (discard > 0) {
    const unit = 1n << BigInt(discard),
      remainder = mag % unit;
    mag /= unit;
    inexact = remainder !== 0n;
    up =
      inexact &&
      (rounding === 0
        ? remainder * 2n > unit || (remainder * 2n === unit && !!(mag & 1n))
        : rounding === 1
          ? negative
          : rounding === 2
            ? !negative
            : false);
    if (up) mag++;
  } else mag <<= BigInt(-discard);
  if (mag >= 2n * J) {
    mag >>= 1n;
    exponent++;
  }
  if (exponent > 16383) return overflow();
  const field = exponent < -16382 ? (mag >= J ? 1 : 0) : exponent + 16383;
  return answer(
    pack(mag, field, negative),
    (inexact ? 0x20 : 0) | (inexact && field === 0 ? 0x10 : 0),
    up,
  );
}

// 2*atanh(n/d), where 0 <= n/d <= 1/3. Every multiplication and
// division rounds its lower/upper endpoint outward. The omitted positive
// tail is less than twice the next power because z^2 <= 1/9.
function logarithm(n, d, precision) {
  if (!n) return [0n, 0n];
  const scale = 1n << BigInt(precision);
  const lo = (n * scale) / d,
    hi = ceil(n * scale, d);
  const squareLo = (lo * lo) / scale,
    squareHi = ceil(hi * hi, scale);
  let powerLo = lo,
    powerHi = hi,
    sumLo = 0n,
    sumHi = 0n;
  for (let k = 1n; k < BigInt(precision * 2); k += 2n) {
    sumLo += powerLo / k;
    sumHi += ceil(powerHi, k);
    powerLo = (powerLo * squareLo) / scale;
    powerHi = ceil(powerHi * squareHi, scale);
    if (powerHi <= 2n) return [2n * sumLo, 2n * (sumHi + 2n * powerHi)];
  }
  throw Error('x87 logarithm series bound exceeded');
}

function log2Interval(x, precision) {
  const bits = x.sig.toString(2).length,
    unit = 1n << BigInt(bits - 1);
  const exponent = BigInt(x.shift + bits - 1),
    scale = 1n << BigInt(precision);
  const [lo, hi] = logarithm(x.sig - unit, x.sig + unit, precision);
  let ln2 = ln2Cache.get(precision);
  if (!ln2) {
    ln2 = logarithm(1n, 3n, precision);
    ln2Cache.set(precision, ln2);
  }
  return [exponent * scale + (lo * scale) / ln2[1], exponent * scale + ceil(hi * scale, ln2[0])];
}

function sameResult(a, b) {
  return (
    a.flags === b.flags && a.roundedUp === b.roundedUp && a.bytes.every((v, i) => v === b.bytes[i])
  );
}

export function fyl2x(xBytes, yBytes, rounding) {
  const x = unpack(xBytes),
    y = unpack(yBytes),
    nan = specialNaN(x, y);
  if (nan) return nan;
  if (x.negative && !x.zero) return invalid();
  const denormal = x.denormal || y.denormal ? 2 : 0;
  if (x.zero) return y.zero ? invalid() : infinity(!y.negative, denormal | (y.infinity ? 0 : 4));
  if (x.infinity) return y.zero ? invalid() : infinity(y.negative, denormal);
  const belowOne = x.exponent < 16383;
  const one = x.exponent === 16383 && x.sig === J;
  if (y.infinity) return one ? invalid() : infinity(y.negative !== belowOne, denormal);
  if (y.zero || one) return zero(y.negative !== belowOne, denormal);
  const multiplier = y.negative ? -y.sig : y.sig;
  // Powers of two have an exact integer logarithm, including subnormals.
  if (!(x.sig & (x.sig - 1n))) {
    const log = BigInt(x.sig.toString(2).length - 1 + x.shift);
    const result = roundDyadic(log * multiplier, y.shift, rounding);
    result.flags |= denormal;
    return result;
  }
  for (let precision = 192; precision <= 6144; precision *= 2) {
    let [lo, hi] = log2Interval(x, precision);
    [lo, hi] =
      multiplier < 0n ? [hi * multiplier, lo * multiplier] : [lo * multiplier, hi * multiplier];
    const lower = roundDyadic(lo, y.shift - precision, rounding);
    const upper = roundDyadic(hi, y.shift - precision, rounding);
    // A non-power-of-two binary rational has an irrational base-two log.
    lower.flags |= 0x20 | denormal;
    upper.flags |= 0x20 | denormal;
    if (sameResult(lower, upper)) return lower;
  }
  throw Error('x87 logarithm rounding could not be resolved within the precision bound');
}
