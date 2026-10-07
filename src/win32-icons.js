import { readPEResource } from './pe-resources.js';
import { CURSOR_STYLES } from './cursors.js';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const ERROR_INVALID_DATA = 13;
const ERROR_INVALID_HANDLE = 6;
const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;
const MAX_ICONS = 256;
const iconStates = new WeakMap();
const ok = (result = 0, argc = 0) => ({ result: result >>> 0, argc });

function state(runtime) {
  let value = iconStates.get(runtime);
  if (!value) {
    value = {
      next: 0x62000000,
      nextCursor: 0x63000000,
      sharedCursorCount: 0,
      cursor: 32512,
      cache: new Map(),
      handles: new Map(),
    };
    iconStates.set(runtime, value);
  }
  return value;
}

function fail(runtime, error, argc = 2) {
  runtime.lastError = error;
  return ok(0, argc);
}

export function parseGroupIcon(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 6)
    throw Error('Invalid group icon resource');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  if (
    view.getUint16(0, true) !== 0 ||
    view.getUint16(2, true) !== 1 ||
    !count ||
    count > 256 ||
    bytes.length < 6 + count * 14
  )
    throw Error('Invalid group icon resource');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 14;
    entries.push({
      width: bytes[p] || 256,
      height: bytes[p + 1] || 256,
      planes: view.getUint16(p + 4, true),
      bitCount: view.getUint16(p + 6, true),
      bytes: view.getUint32(p + 8, true),
      id: view.getUint16(p + 12, true),
    });
  }
  return entries;
}

function rowStride(width, bits) {
  return Math.ceil((width * bits) / 32) * 4;
}

export function decodeIconDib(bytes, expected = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 40) throw Error('Invalid icon DIB');
  if (bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === 'PNG')
    throw Error('PNG icon resources are unsupported');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(0, true);
  const width = view.getInt32(4, true);
  const storedHeight = view.getInt32(8, true);
  const planes = view.getUint16(12, true);
  const bitCount = view.getUint16(14, true);
  const compression = view.getUint32(16, true);
  const colorsUsed = view.getUint32(32, true);
  if (
    headerSize !== 40 ||
    width < 1 ||
    width > 256 ||
    storedHeight < 2 ||
    storedHeight % 2 ||
    planes !== 1 ||
    compression !== 0
  )
    throw Error('Unsupported icon DIB header');
  const height = storedHeight / 2;
  if (
    height > 256 ||
    (expected.width && expected.width !== width) ||
    (expected.height && expected.height !== height)
  )
    throw Error('Icon DIB dimensions do not match group resource');
  if (![1, 4, 8, 24, 32].includes(bitCount))
    throw Error(`Unsupported icon DIB bit depth ${bitCount}`);
  if ((bitCount <= 8 && colorsUsed > 2 ** bitCount) || (bitCount >= 24 && colorsUsed))
    throw Error('Unsupported icon DIB palette size');
  if (expected.bitCount && expected.bitCount !== bitCount)
    throw Error('Icon DIB depth does not match group resource');
  const colors = bitCount <= 8 ? colorsUsed || 2 ** bitCount : 0;
  const xorOffset = headerSize + colors * 4;
  const xorStride = rowStride(width, bitCount);
  const maskStride = rowStride(width, 1);
  const maskOffset = xorOffset + xorStride * height;
  if (maskOffset + maskStride * height > bytes.length) throw Error('Truncated icon DIB');
  const pixels = new Uint8Array(width * height * 4);
  let hasAlpha = false;
  for (let y = 0; y < height; y++) {
    const sourceY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bitCount <= 8) {
        const bit = x * bitCount;
        const packed = bytes[xorOffset + sourceY * xorStride + (bit >> 3)];
        const index = (packed >>> (8 - bitCount - (bit & 7))) & ((1 << bitCount) - 1);
        if (index >= colors) throw Error('Invalid icon DIB palette index');
        const palette = headerSize + index * 4;
        pixels[out] = bytes[palette + 2];
        pixels[out + 1] = bytes[palette + 1];
        pixels[out + 2] = bytes[palette];
      } else {
        const source = xorOffset + sourceY * xorStride + x * (bitCount / 8);
        pixels[out] = bytes[source + 2];
        pixels[out + 1] = bytes[source + 1];
        pixels[out + 2] = bytes[source];
        if (bitCount === 32) {
          pixels[out + 3] = bytes[source + 3];
          hasAlpha ||= pixels[out + 3] !== 0;
        }
      }
    }
  }
  const xorPixels = pixels.slice(),
    maskPixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const sourceY = height - 1 - y;
      const transparent = !!(
        bytes[maskOffset + sourceY * maskStride + (x >> 3)] &
        (0x80 >> (x & 7))
      );
      maskPixels[y * width + x] = transparent ? 255 : 0;
      // For 32-bit icons with alpha, Windows uses the alpha channel and ignores
      // the legacy monochrome mask. Alpha-less and indexed icons use the mask.
      if (bitCount !== 32 || !hasAlpha) {
        if (
          expected.cursor &&
          transparent &&
          pixels.subarray(out, out + 3).some((channel) => channel !== 0 && channel !== 255)
        )
          throw Error('Arbitrary color XOR cursor presentation is unsupported');
        pixels[out + 3] = transparent ? 0 : 255;
      }
    }
  return Object.freeze({
    width,
    height,
    pixels,
    native: {
      mask: maskPixels,
      color: xorPixels,
      alpha: bitCount === 32 && hasAlpha,
      monochrome: bitCount === 1,
    },
  });
}

function moduleAt(runtime, base) {
  return [...runtime.graph.modules.values()].find((module) => !module.host && module.base === base);
}

function resourceName(runtime, pointer, wide) {
  if (pointer <= 0xffff) return pointer;
  return wide ? runtime.wideString(pointer) : runtime.string(pointer);
}

function loadIcon(runtime, argument, wide) {
  const module = moduleAt(runtime, argument(0));
  if (!module?.bytes) return fail(runtime, ERROR_INVALID_HANDLE);
  let name;
  try {
    name = resourceName(runtime, argument(1), wide);
  } catch {
    return fail(runtime, ERROR_RESOURCE_NAME_NOT_FOUND);
  }
  const icons = state(runtime);
  const key = `${module.base}:${typeof name}:${String(name).toLowerCase()}`;
  const cached = icons.cache.get(key);
  if (cached) return ok(cached, 2);
  try {
    const group = readPEResource(module.bytes, RT_GROUP_ICON, name);
    if (!group) return fail(runtime, ERROR_RESOURCE_NAME_NOT_FOUND);
    const candidates = parseGroupIcon(group).sort((left, right) => {
      const leftDistance = Math.abs(left.width - 32) + Math.abs(left.height - 32);
      const rightDistance = Math.abs(right.width - 32) + Math.abs(right.height - 32);
      return leftDistance - rightDistance || right.bitCount - left.bitCount;
    });
    const selected = candidates[0];
    const dib = readPEResource(module.bytes, RT_ICON, selected.id);
    if (!dib || (selected.bytes && selected.bytes !== dib.length))
      return fail(runtime, ERROR_RESOURCE_NAME_NOT_FOUND);
    const icon = decodeIconDib(dib, selected);
    if (icons.handles.size - icons.sharedCursorCount >= MAX_ICONS)
      throw Error('Icon handle limit exceeded');
    const handle = icons.next;
    icons.next += 4;
    icons.cache.set(key, handle);
    icons.handles.set(handle, { ...icon, shared: true });
    return ok(handle, 2);
  } catch (error) {
    if (/limit exceeded|unsupported/i.test(error.message)) throw error;
    return fail(runtime, ERROR_INVALID_DATA);
  }
}

// Builds (or reuses) an HICON from a module's RT_GROUP_ICON resource. Shared
// with LoadIcon and by ExtractIcon, which addresses the same resources by index.
export function iconHandleForGroup(runtime, module, name) {
  const icons = state(runtime);
  const key = `${module.base}:${typeof name}:${String(name).toLowerCase()}`;
  const cached = icons.cache.get(key);
  if (cached) return cached;
  const group = readPEResource(module.bytes, RT_GROUP_ICON, name);
  if (!group) return null;
  const candidates = parseGroupIcon(group).sort((left, right) => {
    const leftDistance = Math.abs(left.width - 32) + Math.abs(left.height - 32);
    const rightDistance = Math.abs(right.width - 32) + Math.abs(right.height - 32);
    return leftDistance - rightDistance || right.bitCount - left.bitCount;
  });
  const selected = candidates[0];
  const dib = readPEResource(module.bytes, RT_ICON, selected.id);
  if (!dib || (selected.bytes && selected.bytes !== dib.length)) return null;
  const icon = decodeIconDib(dib, selected);
  if (icons.handles.size - icons.sharedCursorCount >= MAX_ICONS)
    throw Error('Icon handle limit exceeded');
  const handle = icons.next;
  icons.next += 4;
  icons.cache.set(key, handle);
  icons.handles.set(handle, { ...icon, shared: true });
  return handle;
}

function cloneIcon(icon) {
  return {
    ...icon,
    pixels: icon.pixels.slice(),
    ...(icon.native
      ? {
          native: {
            ...icon.native,
            mask: icon.native.mask.slice(),
            color: icon.native.color.slice(),
          },
        }
      : {}),
  };
}
export function iconForHandle(runtime, handle) {
  const icon = state(runtime).handles.get(handle);
  return icon ? cloneIcon(icon) : null;
}

// Shell namespace icons are owned by their caller, unlike cached LoadIcon
// resources. Each result can be destroyed without invalidating another query.
export function createOwnedIcon(runtime, icon) {
  if (
    !Number.isInteger(icon.width) ||
    !Number.isInteger(icon.height) ||
    icon.width < 1 ||
    icon.height < 1 ||
    icon.width > 256 ||
    icon.height > 256 ||
    !(icon.pixels instanceof Uint8Array) ||
    icon.pixels.length !== icon.width * icon.height * 4
  )
    throw Error('Invalid owned icon');
  const icons = state(runtime);
  if (icons.handles.size - icons.sharedCursorCount >= MAX_ICONS)
    throw Error('Icon handle limit exceeded');
  const handle = icons.next;
  icons.next += 4;
  icons.handles.set(handle, Object.freeze({ ...cloneIcon(icon), shared: false }));
  return handle;
}

export function registerSharedCursor(runtime, image) {
  const images = state(runtime);
  if (images.sharedCursorCount >= 256) throw Error('Cursor handle limit exceeded');
  const handle = images.nextCursor;
  images.nextCursor += 4;
  images.sharedCursorCount++;
  images.handles.set(handle, Object.freeze({ ...cloneIcon(image), cursor: true, shared: true }));
  return handle;
}

export function rememberCursorSelection(runtime, handle) {
  state(runtime).cursor = handle >>> 0;
}

export function destroyImageHandle(runtime, handle) {
  handle >>>= 0;
  const images = state(runtime),
    image = images.handles.get(handle);
  if (image?.shared || CURSOR_STYLES.has(handle) || (handle >= 0x7f00 && handle <= 0x7fff))
    return 1;
  if (!images.handles.delete(handle)) return 0;
  runtime.emit?.({ type: 'cursor-release', handle });
  // The selected cursor keeps its visible image, but its public handle is retired.
  return images.cursor === handle ? 0 : 1;
}

export const iconApis = {
  'user32.dll!CopyIcon': (r, a) => {
    const icon = iconForHandle(r, a(0) >>> 0);
    if (!icon) {
      r.lastError = 1402;
      return ok(0, 1);
    }
    try {
      return ok(createOwnedIcon(r, icon), 1);
    } catch {
      r.lastError = 8;
      return ok(0, 1);
    }
  },
  'user32.dll!LoadIconA': (runtime, argument) => loadIcon(runtime, argument, false),
  'user32.dll!LoadIconW': (runtime, argument) => loadIcon(runtime, argument, true),
  'user32.dll!DestroyIcon': (r, a) => ok(destroyImageHandle(r, a(0)), 1),
};
