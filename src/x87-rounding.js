// For inexact integer-operand arithmetic, compare the rounded ext80 magnitude
// with the exact binary rational. No intermediate JavaScript float loses bits.
export function roundedMagnitudeUp(left, right, result, operation) {
  const decode = (bytes) => {
    const v = new DataView(bytes.buffer, bytes.byteOffset, 10),
      se = v.getUint16(8, true);
    return {
      n: v.getBigUint64(0, true) * (se & 0x8000 ? -1n : 1n),
      e: (se & 0x7fff || 1) - 16446,
      special: (se & 0x7fff) === 0x7fff,
    };
  };
  const a = decode(left),
    b = decode(right),
    out = decode(result);
  if (a.special || b.special) return false;
  let numerator,
    denominator = 1n,
    exponent;
  if (operation < 2) {
    exponent = Math.min(a.e, b.e);
    const x = a.n << BigInt(a.e - exponent),
      y = b.n << BigInt(b.e - exponent);
    numerator = operation === 0 ? x + y : x - y;
  } else if (operation === 2) {
    numerator = a.n * b.n;
    exponent = a.e + b.e;
  } else {
    numerator = a.n;
    denominator = b.n;
    exponent = a.e - b.e;
  }
  if (!denominator) return false;
  if (out.special) return true; // Finite exact arithmetic rounded to infinity.
  const abs = (n) => (n < 0n ? -n : n);
  const common = Math.min(exponent, out.e);
  return (
    (abs(out.n) * abs(denominator)) << BigInt(out.e - common) >
    abs(numerator) << BigInt(exponent - common)
  );
}
