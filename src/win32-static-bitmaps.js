import { gdiApis, describeGdiBitmap, flushGdi } from './win32-gdi.js';
import { resourceBitmapApis } from './win32-resource-bitmaps.js';

const call = (name, r, ...args) => gdiApis[name](r, (i) => args[i] ?? 0).result;
async function setBitmap(r, w, handle) {
  const image = handle ? describeGdiBitmap(r, handle) : null;
  if (handle && !image) {
    r.lastError = 6;
    return 0;
  }
  const old = w.staticBitmapHandle ?? 0;
  w.staticBitmapHandle = handle;
  if (image && !w.centerImage) {
    const border = w.controlBorder ?? 0;
    await r.apiProvider.get('user32.dll!SetWindowPos')(
      r,
      (i) => [w.id, 0, 0, 0, image.width + 2 * border, image.height + 2 * border, 0x16][i],
    );
  }
  r.windows.invalidate(w, null, true);
  return old;
}
export async function staticBitmapMessage(r, w, message, wp, lp, wide) {
  if (!w.staticBitmap) return null;
  if (message === 0x173) return wp === 0 ? (w.staticBitmapHandle ?? 0) : 0;
  if (message === 0x172) return wp === 0 ? setBitmap(r, w, lp) : 0;
  if (message === 1 || message === 0xc) {
    const name = message === 1 ? w.title : lp ? (wide ? r.wideString(lp) : r.string(lp)) : '';
    if (!name) {
      await setBitmap(r, w, 0);
      return message === 0xc ? 1 : 0;
    }
    const p = r.allocString(name, wide);
    try {
      const id = /^#[0-9]+$/.test(name) ? Number(name.slice(1)) : p;
      const handle = resourceBitmapApis['user32.dll!LoadBitmap' + (wide ? 'W' : 'A')](
        r,
        (i) => [w.instance, id][i],
      ).result;
      if (handle) {
        w.staticOwnedBitmaps ??= new Set();
        w.staticOwnedBitmaps.add(handle);
        await setBitmap(r, w, handle);
      }
      return message === 0xc ? 1 : 0;
    } finally {
      r.free(p);
    }
  }
  if (message === 2) {
    for (const handle of w.staticOwnedBitmaps ?? []) call('gdi32.dll!DeleteObject', r, handle);
    w.staticOwnedBitmaps?.clear();
    w.staticBitmapHandle = 0;
    return 0;
  }
  if (message !== 0xf) return null;
  const image = describeGdiBitmap(r, w.staticBitmapHandle ?? 0);
  const dc = call('user32.dll!GetDC', r, w.id);
  if (!dc) return 0;
  const rect = r.allocate(16),
    mem = call('gdi32.dll!CreateCompatibleDC', r, dc);
  try {
    [0, 0, w.width, w.height].forEach((v, i) => r.write32(rect + i * 4, v));
    call('user32.dll!FillRect', r, dc, rect, 16);
    if (image && mem) {
      const old = call('gdi32.dll!SelectObject', r, mem, w.staticBitmapHandle);
      const x = w.centerImage ? Math.trunc((w.width - image.width) / 2) : 0;
      const y = w.centerImage ? Math.trunc((w.height - image.height) / 2) : 0;
      call('gdi32.dll!BitBlt', r, dc, x, y, image.width, image.height, mem, 0, 0, 0x00cc0020);
      call('gdi32.dll!SelectObject', r, mem, old);
    }
    w.invalid = null;
    w.erase = false;
    return 0;
  } finally {
    if (mem) call('gdi32.dll!DeleteDC', r, mem);
    call('user32.dll!ReleaseDC', r, w.id, dc);
    r.free(rect);
    flushGdi(r);
  }
}
