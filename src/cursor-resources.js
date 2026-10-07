import { decodeIconDib } from './win32-icons.js';
import { CURSOR_SIZE } from './cursors.js';

export function parseGroupCursor(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 6) throw Error('Invalid cursor group');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    count = v.getUint16(4, true);
  if (
    v.getUint16(0, true) ||
    v.getUint16(2, true) !== 2 ||
    !count ||
    count > 256 ||
    bytes.length < 6 + count * 14
  )
    throw Error('Invalid cursor group');
  return Array.from({ length: count }, (_, i) => {
    const p = 6 + i * 14,
      width = v.getUint16(p, true) || 256,
      storedHeight = v.getUint16(p + 2, true) || 256;
    if (width > 256 || storedHeight > 512 || v.getUint16(p + 4, true) !== 1)
      throw Error('Invalid cursor group dimensions or planes');
    return {
      width,
      height: storedHeight,
      bitCount: v.getUint16(p + 6, true),
      bytes: v.getUint32(p + 8, true),
      id: v.getUint16(p + 12, true),
    };
  });
}
export function cursorCandidate(bytes, entry) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44 || bytes.length !== entry.bytes)
    throw Error('Invalid cursor resource size');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(4, true) !== 40) throw Error('Unsupported cursor DIB header');
  const width = v.getInt32(8, true),
    doubledHeight = v.getInt32(12, true),
    height = doubledHeight / 2;
  if (
    width !== entry.width ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > 256 ||
    (entry.height !== height && entry.height !== doubledHeight)
  )
    throw Error('Cursor dimensions do not match group resource');
  // Some resource compilers write a monochrome group hint for color CUR
  // images. The selected bitmap header determines its actual pixel format.
  return { ...entry, height, bitCount: v.getUint16(18, true), resource: bytes };
}
export function selectCursor(entries) {
  // Prefer the largest image no larger than the virtual system cursor. If
  // none fits, downsample the smallest available one. Equal sizes prefer color.
  let best;
  for (const entry of entries) {
    if (entry.width > CURSOR_SIZE || entry.height > CURSOR_SIZE) continue;
    if (best && (entry.width < best.width || entry.height < best.height)) continue;
    if (
      best &&
      entry.width === best.width &&
      entry.height === best.height &&
      entry.bitCount <= best.bitCount
    )
      continue;
    best = entry;
  }
  if (best) return best;
  for (const entry of entries) {
    if (best && (entry.width > best.width || entry.height > best.height)) continue;
    if (
      best &&
      entry.width === best.width &&
      entry.height === best.height &&
      entry.bitCount <= best.bitCount
    )
      continue;
    best = entry;
  }
  return best;
}
export function decodeCursorResource(bytes, expected = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) throw Error('Invalid cursor resource');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    hotX = v.getUint16(0, true),
    hotY = v.getUint16(2, true);
  const image = decodeIconDib(bytes.subarray(4), { ...expected, cursor: true });
  if (hotX >= image.width || hotY >= image.height) throw Error('Invalid cursor hotspot');
  // LoadCursor uses LR_DEFAULTSIZE. Scale both image and hotspot into the same
  // virtual 32-pixel system metric using bounded nearest-neighbor sampling.
  const pixels = new Uint8Array(CURSOR_SIZE * CURSOR_SIZE * 4),
    color = new Uint8Array(pixels.length),
    mask = new Uint8Array(CURSOR_SIZE * CURSOR_SIZE);
  for (let y = 0; y < CURSOR_SIZE; y++)
    for (let x = 0; x < CURSOR_SIZE; x++) {
      const i =
        (Math.floor((y * image.height) / CURSOR_SIZE) * image.width +
          Math.floor((x * image.width) / CURSOR_SIZE)) *
        4;
      const out = y * CURSOR_SIZE + x;
      pixels.set(image.pixels.subarray(i, i + 4), out * 4);
      color.set(image.native.color.subarray(i, i + 4), out * 4);
      mask[out] = image.native.mask[i / 4];
    }
  return {
    width: CURSOR_SIZE,
    height: CURSOR_SIZE,
    hotX: Math.floor((hotX * CURSOR_SIZE) / image.width),
    hotY: Math.floor((hotY * CURSOR_SIZE) / image.height),
    pixels,
    native: { ...image.native, color, mask },
  };
}
