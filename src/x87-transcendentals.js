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
  const ln2 = ln2Interval(precision);
  return [exponent * scale + (lo * scale) / ln2[1], exponent * scale + ceil(hi * scale, ln2[0])];
}

// 2*atanh(1/3) = ln 2, as an outward-rounded fixed-point interval scaled by
// 2^precision. Shared by the base-two logarithm and exponential paths.
function ln2Interval(precision) {
  let ln2 = ln2Cache.get(precision);
  if (!ln2) {
    ln2 = logarithm(1n, 3n, precision);
    ln2Cache.set(precision, ln2);
  }
  return ln2;
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

// Ordering used when two quiet NaNs meet: the larger exponent wins, then the
// larger significand; exact ties keep the second operand, as SoftFloat does.
const isLargerNaN = (a, b) => a.exponent > b.exponent || (a.exponent === b.exponent && a.sig > b.sig);

// Signed interval helpers for outward-rounded rational evaluation.
const min2 = (a, b) => (a < b ? a : b);
const max2 = (a, b) => (a > b ? a : b);
const intervalMul = (a, b) => [
  min2(min2(a[0] * b[0], a[0] * b[1]), min2(a[1] * b[0], a[1] * b[1])),
  max2(max2(a[0] * b[0], a[0] * b[1]), max2(a[1] * b[0], a[1] * b[1])),
];
const floorDiv = (n, d) => (n >= 0n ? n / d : -((-n + d - 1n) / d));

// F2XM1: 2^x - 1 for the documented domain -1 <= x <= 1. 2^x = e^(x ln 2), so
// the result is the signed expm1 series over a bounded interval for z = x ln 2.
// Arguments outside the domain, infinities, invalid encodings and NaNs produce
// the x87 #IA result.
export function f2xm1(xBytes, rounding) {
  const x = unpack(xBytes),
    nan = specialNaN(x);
  if (nan) return nan;
  if (x.invalid || x.infinity) return invalid();
  const denormal = x.denormal ? 0x2 : 0;
  // 2^0 - 1 is exactly zero, positive regardless of the sign of the zero input.
  if (x.zero) return answer(pack(0n, 0, false), denormal, false);
  if (x.exponent > 16383 || (x.exponent === 16383 && x.sig > J)) return invalid();
  // The two endpoints are the exact rationals 2^(+/-1) - 1.
  if (x.exponent === 16383 && x.sig === J)
    return x.negative ? answer(pack(J, 16382, true), denormal, false) : answer(pack(J, 16383, false), denormal, false);

  for (let precision = 192; precision <= 12288; precision *= 2) {
    const P = BigInt(precision);
    const ln2 = ln2Interval(precision); // ln 2 scaled by 2^precision.
    const znLo = x.sig * ln2[0],
      znHi = x.sig * ln2[1];
    // z = x ln 2 as a signed interval scaled by 2^L.
    const z = x.negative ? [-znHi, -znLo] : [znLo, znHi];
    const scale = 1n << (P - BigInt(x.shift));
    // expm1 series: term_k = z^k / k!, summed outward over the interval.
    let termLo = z[0],
      termHi = z[1],
      sumLo = z[0],
      sumHi = z[1];
    for (let k = 2n; ; k += 1n) {
      const [mL, mH] = intervalMul([termLo, termHi], z);
      const den = scale * k;
      termLo = floorDiv(mL, den);
      termHi = ceilDiv(mH, den);
      sumLo += termLo;
      sumHi += termHi;
      // |z| <= ln 2, so the remaining tail is bounded by the term just added;
      // widen by that magnitude in both directions before stopping.
      const bound = max2(termLo < 0n ? -termLo : termLo, termHi < 0n ? -termHi : termHi);
      if (bound <= 1n) {
        sumLo -= bound;
        sumHi += bound;
        break;
      }
      if (k > P + 256n) throw Error('x87 exponential series bound exceeded');
    }
    // The interval is expressed in units of 2^-L, and L is a power-of-two
    // exponent, so the existing dyadic rounding (with its subnormal and
    // overflow handling) applies directly.
    const L = Number(P - BigInt(x.shift));
    const lower = roundDyadic(sumLo, -L, rounding),
      upper = roundDyadic(sumHi, -L, rounding);
    lower.flags |= 0x20 | denormal;
    upper.flags |= 0x20 | denormal;
    if (sameResult(lower, upper)) return lower;
  }
  throw Error('x87 exponential rounding could not be resolved within the precision bound');
}

// ---------------------------------------------------------------------------
// FPTAN: tan(ST(0)), then push 1.0 so the tangent lands in ST(0) and one in
// ST(1). The sine and cosine are bounded independently by the trigonometric
// interval reduction above; the tangent is the quotient of that interval pair,
// bounded by its monotone corner values. Like FSIN/FCOS this targets
// mathematical tangent, not a physical processor's finite-pi reduction.

// Exact min and max of a/b over a in [a0,a1] and b in [b0,b1], where b never
// straddles zero. Denominators are normalized positive before comparison.
function quotientCorners(a, b) {
  const corners = [];
  for (const [n, d] of [
    [a[0], b[0]],
    [a[0], b[1]],
    [a[1], b[0]],
    [a[1], b[1]],
  ]) {
    const sign = d < 0n ? -1n : 1n;
    corners.push([n * sign, d * sign]);
  }
  let min = corners[0],
    max = corners[0];
  for (const corner of corners) {
    if (corner[0] * min[1] < min[0] * corner[1]) min = corner;
    if (corner[0] * max[1] > max[0] * corner[1]) max = corner;
  }
  return [min, max];
}

function tanInterval(x, precision) {
  const bounds = trigInterval(x, precision);
  if (!bounds) return null;
  const { sine, cosine } = bounds;
  // A cosine interval that spans zero makes the quotient unbounded; a higher
  // precision tightens it around the true cos(x) instead.
  if (cosine[0] <= 0n && cosine[1] >= 0n) return null;
  const scale = 1n << BigInt(precision);
  const [min, max] = quotientCorners(sine, cosine);
  return [floorDiv(min[0] * scale, min[1]), ceilDiv(max[0] * scale, max[1])];
}

// For |x| < 2^-64 the cubic term of tan(x) = x + x^3/3 is far below the
// extended-format ulp. The tangent magnitude grows with |x|, so truncation and
// round-to-nearest keep |x| exactly while a directed mode that rounds away from
// zero adds a single ulp.
function tinyTan(x, rounding) {
  const away = (rounding === 1 && x.negative) || (rounding === 2 && !x.negative);
  // The magnitude sits on the subnormal grid, so the one-ulp increment carries
  // exactly like a binary counter. A significand that reaches the integer bit
  // becomes the smallest normal (exponent field 1), never a pseudo-denormal.
  let exponent = x.exponent || 1,
    sig = x.sig;
  if (away) {
    sig++;
    if (sig >= 2n * J) {
      sig >>= 1n;
      exponent++;
    }
  }
  const field = sig >= J ? exponent : 0;
  return answer(
    pack(sig, field, x.negative),
    0x20 | (x.denormal ? 0x2 : 0) | (!field ? 0x10 : 0),
    away,
  );
}

export function fptan(xBytes, rounding) {
  const x = unpack(xBytes),
    nan = specialNaN(x);
  if (nan) return { ...nan, nan: true };
  if (x.infinity) return { ...invalid(), nan: true };
  const denormal = x.denormal ? 0x2 : 0;
  // tan(+/-0) is the same signed zero and raises nothing.
  if (x.zero) return answer(pack(0n, 0, x.negative), denormal);
  // |x| >= 2^63 exceeds the reduction range: C2 is set and the stack is left
  // exactly as it was.
  if (x.exponent >= 16383 + 63) return { outOfRange: true };
  if (x.exponent < 16383 - 64) return tinyTan(x, rounding);
  for (let precision = 192; precision <= 6144; precision *= 2) {
    const bounds = tanInterval(x, precision);
    if (!bounds) continue;
    const lower = roundDyadic(bounds[0], -precision, rounding),
      upper = roundDyadic(bounds[1], -precision, rounding);
    lower.flags |= 0x20 | denormal;
    upper.flags |= 0x20 | denormal;
    if (sameResult(lower, upper)) return lower;
  }
  throw Error('x87 tangent rounding could not be resolved within the precision bound');
}

// FSCALE: ST(0) * 2^trunc(ST(1)). Truncation toward zero, plain exponent
// addition, precision control ignored (QEMU raises floatx80_precision_x here).
// The scale is saturated at +-2^15 because any larger count already overflows
// or underflows the extended range, which keeps the exponent arithmetic inside
// a bounded window and reproduces the indefinite result for |scale| >= 2^16.
export function fscale(aBytes, bBytes, rounding) {
  const a = unpack(aBytes),
    b = unpack(bBytes);
  if (a.invalid || b.invalid) return invalid();
  const denormal = a.denormal || b.denormal ? 0x2 : 0;
  // FSCALE combines NaNs the way SoftFloat's propagateNaNExtF80UI does: a
  // signaling NaN always raises #IA, a signaling operand yields the other NaN
  // when it exists, and two quiet NaNs keep the larger magnitude.
  if (a.nan || b.nan) {
    const signaling = a.signaling || b.signaling;
    let chosen;
    if (signaling) chosen = a.signaling ? (b.nan ? b : a) : a.nan ? a : b;
    else chosen = isLargerNaN(a, b) ? a : b;
    return answer(pack(chosen.sig | Q, 0x7fff, chosen.negative), (signaling ? 1 : 0) | denormal);
  }
  // An infinity in ST(0) survives a positive infinite scale; a negative infinite
  // scale (equivalently an infinite ST(1) below one) is an invalid operation.
  if (a.infinity) return b.infinity && b.negative ? invalid() : answer(aBytes, denormal);
  if (b.infinity) {
    if (a.zero) return b.negative ? answer(aBytes, denormal) : invalid();
    return b.negative
      ? answer(pack(0n, 0, a.negative), denormal)
      : infinity(a.negative, denormal);
  }
  if (a.zero) return answer(aBytes, denormal);
  // |ST(1)| < 1 truncates to a zero scale, and a subnormal ST(1) normalizes to
  // a value far below one, so both leave ST(0) untouched.
  let scale = 0;
  if (b.exponent >= 0x3fff) {
    // Above 0x400e the truncated scale already exceeds 2^15 in magnitude, which
    // overflows or underflows every possible ST(0); saturate past the shift
    // range so the shared rounding still reports the correct infinity or zero.
    scale =
      b.exponent > 0x400e
        ? (b.negative ? -0x10000 : 0x10000)
        : Number(b.sig >> BigInt(0x403e - b.exponent)) * (b.negative ? -1 : 1);
  }
  // The exact product is the unbounded significand shifted by this exponent;
  // feeding it through the standard dyadic rounding handles normal, subnormal,
  // directed and half-even results with the shared C1/#O/#U/#P accounting.
  const shift = (a.exponent || 1) - 16383 - 63 + scale,
    result = roundDyadic(a.negative ? -a.sig : a.sig, shift, rounding);
  result.flags |= denormal;
  return result;
}
