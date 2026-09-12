// The bootstrap process uses Windows-1252 as CP_ACP. Explicit UTF-8 conversion
// is handled by the Windows API provider; guest byte strings remain bytes.
const ansiDecoder = new TextDecoder('windows-1252');
const ansiEncoding = new Map();
for (let byte = 0; byte < 256; byte++)
  ansiEncoding.set(ansiDecoder.decode(Uint8Array.of(byte)), byte);
export const decodeAnsi = (bytes) => ansiDecoder.decode(bytes);
export function encodeAnsi(value, replacement = 63) {
  let usedDefault = false;
  const bytes = Uint8Array.from(
    [...value].map((character) => {
      const byte = ansiEncoding.get(character);
      if (byte !== undefined) return byte;
      usedDefault = true;
      return replacement;
    }),
  );
  return { bytes, usedDefault };
}
