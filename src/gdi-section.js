import { readDibPixel, writeDibPixel } from './gdi-dib.js';

// Private DIB storage is a committed, non-executable guest mapping, independent
// of the GDI color surface. The DIB keeps BGR/packed scanlines; the rasterizer
// keeps opaque RGBA. Checked guest stores invalidate only the affected rows.
export function allocateDibStorage(r, layout) {
  const bytes = layout.stride * layout.height;
  const allocation = r.virtualMemory.allocate(0, bytes, 0x3000, 4);
  if (allocation.status !== 0) return null;
  const dib = {
    layout,
    bits: allocation.base,
    allocationSize: allocation.size,
    dirtyRows: new Set(Array.from({ length: layout.height }, (_, i) => i)),
    damage: null,
    writing: false,
  };
  dib.stopObserving = r.guestMemory.observeWrites(dib.bits, bytes, (start, end) => {
    if (dib.writing) return;
    const first = Math.floor((start - dib.bits) / layout.stride);
    const last = Math.floor((end - 1 - dib.bits) / layout.stride);
    for (let row = first; row <= last; row++) dib.dirtyRows.add(row);
  });
  return dib;
}

export function releaseDibStorage(r, dib) {
  dib.stopObserving();
  r.virtualMemory.free(dib.bits, 0, 0x8000);
}

export function refreshDibPixels(r, bitmap) {
  const dib = bitmap.dib;
  if (!dib || !dib.dirtyRows.size) return;
  const { layout, bits } = dib;
  for (const row of dib.dirtyRows) {
    r.check(bits + row * layout.stride, layout.stride);
    const y = layout.signedHeight < 0 ? row : layout.height - 1 - row;
    for (let x = 0; x < layout.width; x++) {
      const rgb = readDibPixel(r, layout, bits + row * layout.stride, x);
      bitmap.pixels.set([...rgb, 255], (y * layout.width + x) * 4);
    }
  }
  dib.dirtyRows.clear();
}

// Preserve untouched pixels, unused high bits and row padding. GDI operations
// are complete at their API boundary, so their changed colors reach the actual
// guest mapping before the EXE can read or overwrite it again.
export function commitDibPixels(r, bitmap) {
  const dib = bitmap.dib;
  if (!dib || !bitmap.dirty) return;
  const { layout, bits } = dib;
  const [left, top, right, bottom] = dib.damage ?? [0, 0, bitmap.width, bitmap.height];
  dib.writing = true;
  try {
    for (let y = Math.max(0, top); y < Math.min(bitmap.height, bottom); y++) {
      const row = layout.signedHeight < 0 ? y : layout.height - 1 - y;
      const address = bits + row * layout.stride;
      r.check(address, layout.stride, true);
      for (let x = Math.max(0, left); x < Math.min(bitmap.width, right); x++) {
        const rgb = bitmap.pixels.subarray(
          (y * bitmap.width + x) * 4,
          (y * bitmap.width + x) * 4 + 3,
        );
        const previous = readDibPixel(r, layout, address, x);
        if (rgb.some((value, i) => value !== previous[i]))
          writeDibPixel(r, layout, address, x, rgb);
      }
      // Indexed/16-bit stores quantize colors; subsequent GDI reads observe
      // those actual stored values rather than an unquantized shadow color.
      dib.dirtyRows.add(row);
    }
  } finally {
    dib.writing = false;
  }
  bitmap.dirty = false;
  dib.damage = null;
}
