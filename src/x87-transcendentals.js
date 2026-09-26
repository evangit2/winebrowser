// Integer interval arithmetic for x87 extended-range logarithms. Bounds are
// refined until both endpoints round to the same ext80 result; inputs never
// pass through binary64. See docs/x87-transcendentals.md for scope and references.
const J = 1n << 63n;
const Q = 1n << 62n;
const ln2Cache = new Map();
const piCache = new Map();
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

// Machin's identity: pi = 16 atan(1/5) - 4 atan(1/239). Exact rational
// denominators and the alternating-series remainder give outward bounds.
function atanReciprocal(q, precision) {
  const scale = 1n << BigInt(precision),
    square = q * q;
  let denominator = q,
    lo = 0n,
    hi = 0n;
  for (let k = 0n; k < BigInt(precision); k++) {
    const divisor = denominator * (2n * k + 1n);
    const lower = scale / divisor,
      upper = ceil(scale, divisor);
    if (k & 1n) {
      lo -= upper;
      hi -= lower;
    } else {
      lo += lower;
      hi += upper;
    }
    denominator *= square;
    const tail = ceil(scale, denominator * (2n * k + 3n));
    if (tail <= 1n) return [lo - tail, hi + tail];
  }
  throw Error('x87 pi series bound exceeded');
}

function piInterval(precision) {
  let pi = piCache.get(precision);
  if (!pi) {
    const a = atanReciprocal(5n, precision),
      b = atanReciprocal(239n, precision);
    pi = [16n * a[0] - 4n * b[1], 16n * a[1] - 4n * b[0]];
    piCache.set(precision, pi);
  }
  return pi;
}

const negateInterval = ([lo, hi]) => [-hi, -lo];

// Sine/cosine at an exact fixed-point argument of magnitude <= pi/4.
// Terms decrease; outward-rounded recurrence plus the next term bounds the
// alternating remainder. Return values are scaled by 2^precision.
function trigSeries(argument, precision, cosine) {
  const negative = argument < 0n,
    x = negative ? -argument : argument;
  const scale = 1n << BigInt(precision),
    square = x * x,
    scaleSquared = scale * scale;
  let powerLo = cosine ? scale : x,
    powerHi = powerLo;
  let lo = powerLo,
    hi = powerHi,
    index = cosine ? 0n : 1n;
  for (let k = 1; k < precision; k++) {
    const divisor = scaleSquared * (index + 1n) * (index + 2n);
    powerLo = (powerLo * square) / divisor;
    powerHi = ceil(powerHi * square, divisor);
    if (powerHi <= 1n) {
      const result = [lo - powerHi, hi + powerHi];
      return negative && !cosine ? negateInterval(result) : result;
    }
    if (k & 1) {
      lo -= powerHi;
      hi -= powerLo;
    } else {
      lo += powerLo;
      hi += powerHi;
    }
    index += 2n;
  }
  throw Error('x87 trigonometric series bound exceeded');
}

function trigInterval(x, precision) {
  const pi = piInterval(precision),
    halfLo = pi[0] / 2n,
    halfHi = ceil(pi[1], 2n);
  // The tiny-argument path handles exponents below -64, so this shift is exact.
  const input = x.sig << BigInt(x.shift + precision);
  const quadrant = (2n * input + halfHi) / (2n * halfHi);
  if (quadrant !== (2n * input + halfLo) / (2n * halfLo)) return null;
  const lo = input - quadrant * halfHi,
    hi = input - quadrant * halfLo;
  let sine = [trigSeries(lo, precision, false)[0], trigSeries(hi, precision, false)[1]];
  const absLo = lo < 0n ? -lo : lo,
    absHi = hi < 0n ? -hi : hi;
  const near = lo <= 0n && hi >= 0n ? 0n : absLo < absHi ? absLo : absHi;
  const far = absLo > absHi ? absLo : absHi;
  let cosine = [trigSeries(far, precision, true)[0], trigSeries(near, precision, true)[1]];
  switch (Number(quadrant & 3n)) {
    case 1:
      [sine, cosine] = [cosine, negateInterval(sine)];
      break;
    case 2:
      [sine, cosine] = [negateInterval(sine), negateInterval(cosine)];
      break;
    case 3:
      [sine, cosine] = [negateInterval(cosine), sine];
      break;
  }
  if (x.negative) sine = negateInterval(sine);
  return { sine, cosine };
}

function tinyTrig(x, rounding) {
  // For |x| < 2^-64, |sin(x)| is immediately below |x| and cos(x) is
  // immediately below 1, by less than half an ext80 ulp. Directed rounding
  // still matters, even for the smallest subnormal.
  let exponent = x.exponent || (x.sig & J ? 1 : 0),
    sig = x.sig;
  const away = rounding === 0 || (rounding === 1 && x.negative) || (rounding === 2 && !x.negative);
  if (!away) {
    if (sig === J && exponent > 1) {
      exponent--;
      sig = 2n * J - 1n;
    } else {
      sig--;
      if (sig < J) exponent = 0;
    }
  }
  const denormal = x.denormal ? 2 : 0;
  const sine = answer(
    pack(sig, exponent, x.negative),
    0x20 | denormal | (!exponent ? 0x10 : 0),
    away,
  );
  const cosUp = rounding === 0 || rounding === 2;
  const cosine = answer(
    pack(cosUp ? J : 2n * J - 1n, cosUp ? 16383 : 16382, false),
    0x20 | denormal,
    cosUp,
  );
  return { sine, cosine };
}

export function sincos(xBytes, rounding) {
  const x = unpack(xBytes),
    nan = specialNaN(x);
  if (nan || x.infinity) {
    const result = nan ?? invalid();
    return { sine: result, cosine: result };
  }
  if (x.exponent >= 16383 + 63) return { outOfRange: true };
  if (x.zero) return { sine: zero(x.negative), cosine: answer(pack(J, 16383, false)) };
  if (x.exponent < 16383 - 64) return tinyTrig(x, rounding);
  for (let precision = 192; precision <= 6144; precision *= 2) {
    const bounds = trigInterval(x, precision);
    if (!bounds) continue;
    const result = {};
    for (const name of ['sine', 'cosine']) {
      const lo = roundDyadic(bounds[name][0], -precision, rounding);
      const hi = roundDyadic(bounds[name][1], -precision, rounding);
      lo.flags |= 0x20;
      hi.flags |= 0x20;
      if (sameResult(lo, hi)) result[name] = lo;
    }
    if (result.sine && result.cosine) return result;
  }
  throw Error('x87 trigonometric rounding could not be resolved within the precision bound');
}

// ---------------------------------------------------------------------------
// FPATAN: arctan(ST(1)/ST(0)) with two-argument quadrant selection.
//
// Values are exact big integers scaled by 2^precision. atan is evaluated over
// an interval whose endpoints are rounded outward, and the caller's precision
// loop accepts a result only when both endpoints round to the same ext80 value.

function ceilDiv(n, d) {
  if (d <= 0n) throw Error('x87 arctangent: non-positive divisor');
  return n >= 0n ? (n + d - 1n) / d : -(-n / d);
}

// Floor integer square root.
function isqrt(n) {
  if (n < 0n) throw Error('x87 arctangent: negative square');
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

// atan(v) scaled by 2^precision over 0 <= v <= 1/16, rounded outward. The
// alternating series has decreasing terms, so a fixed-point partial sum plus a
// one-ulp tail padding bounds the true value in the requested direction.
function atanSmall(v, precision, upper) {
  if (v <= 0n) return 0n;
  const P = BigInt(precision),
    squareShift = 1n << (2n * P),
    square = v * v;
  let power = v,
    sum = v;
  // v <= 2^(P-4), so v^(2k+1) < 2^-P once k > P/8; P terms is ample. The
  // omitted alternating tail is smaller than the last included term.
  const terms = P + 2n;
  let tail = 0n;
  for (let k = 1n; k <= terms; k++) {
    const scaled = power * square;
    power = upper ? ceilDiv(scaled, squareShift) : scaled / squareShift;
    const divisor = 2n * k + 1n;
    if (k & 1n) sum = upper ? sum - ceilDiv(power, divisor) : sum - power / divisor;
    else sum = upper ? sum + ceilDiv(power, divisor) : sum + power / divisor;
    if (power === 0n) return upper ? sum + 1n : sum - 1n;
    tail = ceilDiv(power, divisor) + 1n;
  }
  return upper ? sum + tail : sum - tail;
}

// atan(r) scaled by 2^precision for an exact r >= 0, rounded outward. Large
// arguments use atan(r) = pi/2 - atan(1/r); the rest is halved by
// atan(r) = 2 atan(r / (1 + sqrt(1 + r^2))) until the series is accurate.
function atanScaled(r, precision, upper) {
  const P = BigInt(precision),
    one = 1n << P;
  if (r <= 0n) return 0n;
  if (r > one) {
    const inverseScaled = 1n << (2n * P);
    const inner = upper ? ceilDiv(inverseScaled, r) : inverseScaled / r;
    const [piLo, piHi] = piInterval(precision);
    const halfPi = upper ? piLo / 2n : ceilDiv(piHi, 2n);
    const innerAtan = atanScaled(inner, precision, !upper);
    return upper ? halfPi - innerAtan : halfPi - innerAtan;
  }
  const limit = one >> 4n;
  let value = r,
    halvings = 0n;
  while (value > limit) {
    const squared = value * value,
      inside = squared + (1n << (2n * P));
    const rootFloor = isqrt(inside);
    let rootHi = rootFloor;
    if (rootHi * rootHi < inside) rootHi += 1n;
    const denominator = upper ? one + rootFloor : one + rootHi;
    value = upper ? ceilDiv(value * one, denominator) : (value * one) / denominator;
    if (++halvings > 4096n) throw Error('x87 arctangent reduction exceeded');
  }
  return atanSmall(value, precision, upper) << halvings;
}

// Interval for atan of the nonnegative interval [rLo, rHi] scaled by 2^precision.
function atanInterval(rLo, rHi, precision) {
  return [atanScaled(rLo, precision, false), atanScaled(rHi, precision, true)];
}

export function fpatan(yBytes, xBytes, rounding) {
  const y = unpack(yBytes),
    x = unpack(xBytes),
    nan = specialNaN(x, y);
  if (nan) return nan;
  const denormal = x.denormal || y.denormal ? 2 : 0;

  const sameInterval = (lo, hi, precision) => {
    const lower = roundDyadic(lo, -precision, rounding),
      upper = roundDyadic(hi, -precision, rounding);
    lower.flags |= 0x20 | denormal;
    upper.flags |= 0x20 | denormal;
    return sameResult(lower, upper) ? lower : null;
  };

  // Constant multiples of pi, evaluated outward at each precision.
  const piMultiple = (num, den) => {
    for (let precision = 192; precision <= 6144; precision *= 2) {
      const [piLo, piHi] = piInterval(precision);
      const lo = (piLo * BigInt(num)) / BigInt(den),
        hi = ceilDiv(piHi * BigInt(num), BigInt(den));
      const result = sameInterval(lo, hi, precision);
      if (result) return result;
    }
    throw Error('x87 arctangent constant could not be resolved');
  };

  const yAbs = y.sig,
    xAbs = x.sig;

  // Zero/infinite divisors have exact results independent of the ratio.
  if (x.zero && !y.zero) return y.negative ? piMultiple(-1, 2) : piMultiple(1, 2);
  if (x.zero && y.zero) return zero(x.negative && y.negative);
  if (y.zero) {
    if (!x.negative) return zero(y.negative);
    return y.negative ? piMultiple(-1, 1) : piMultiple(1, 1);
  }
  if (y.infinity && x.infinity) {
    if (!x.negative) return y.negative ? piMultiple(-1, 4) : piMultiple(1, 4);
    return y.negative ? piMultiple(-3, 4) : piMultiple(3, 4);
  }
  if (y.infinity) return y.negative ? piMultiple(-1, 2) : piMultiple(1, 2);
  if (x.infinity) {
    if (!x.negative) return zero(y.negative);
    return y.negative ? piMultiple(-1, 1) : piMultiple(1, 1);
  }
  if (y.invalid || x.invalid) return invalid();

  for (let precision = 192; precision <= 6144; precision *= 2) {
    const shift = BigInt(y.shift - x.shift + precision);
    const numerator = shift >= 0n ? yAbs << shift : yAbs,
      denominator = shift >= 0n ? xAbs : xAbs << -shift;
    if (!denominator) throw Error('x87 arctangent: zero divisor');
    const rLo = numerator / denominator,
      rHi = ceilDiv(numerator, denominator);
    const [phiLo, phiHi] = atanInterval(rLo, rHi, precision);
    let lo, hi;
    if (!x.negative) {
      if (!y.negative) [lo, hi] = [phiLo, phiHi];
      else [lo, hi] = [-phiHi, -phiLo];
    } else {
      const [piLo, piHi] = piInterval(precision);
      if (!y.negative) [lo, hi] = [piLo - phiHi, piHi - phiLo];
      else [lo, hi] = [phiLo - piHi, phiHi - piLo];
    }
    const result = sameInterval(lo, hi, precision);
    if (result) return result;
  }
  throw Error('x87 arctangent rounding could not be resolved within the precision bound');
}
