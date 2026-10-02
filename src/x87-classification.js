// Classification flags used by the SoftFloat adapter, read directly from the
// unchanged ext80 bits. This does no arithmetic, rounding or NaN quieting.
export function classifyExtendedFloat(bytes) {
  const exponent = bytes[8] | ((bytes[9] & 0x7f) << 8);
  const sign = bytes[9] & 0x80 ? 64 : 0;
  if (exponent && exponent !== 0x7fff) return sign | 4;
  const low = bytes[0] | bytes[1] | bytes[2] | bytes[3] | bytes[4] | bytes[5] | bytes[6];
  if (!exponent) return sign | (low | bytes[7] ? 2 : 1);
  if (!low && bytes[7] === 0x80) return sign | 8;
  const signaling = !(bytes[7] & 0x40) && low | (bytes[7] & 0x3f);
  return sign | (signaling ? 32 : 16);
}
