import { readGdiFontFace } from './gdi-text.js';
import { encodeAnsi } from './encoding.js';
const INIT = 0x40,
  EFFECTS = 0x100,
  LIMIT = 0x2000;
const NOFACE = 0x80000,
  NOSTYLE = 0x100000,
  NOSIZE = 0x200000;
const SUPPORTED = 1 | INIT | EFFECTS | LIMIT | NOFACE | NOSTYLE | NOSIZE;
const ok = (result) => ({ result, argc: 1 });
function error(r, code, win32 = 87) {
  r.commonDialogError = code;
  r.lastError = win32;
  return ok(0);
}
export async function chooseBrowserFont(r, a, wide) {
  r.commonDialogError = 0;
  const pointer = a(0) >>> 0,
    size = wide ? 92 : 60;
  if (!pointer) return error(r, 1);
  r.check(pointer, 4);
  if (r.read32(pointer) !== 60) return error(r, 1); // CDERR_STRUCTSIZE
  r.check(pointer, 60, true);
  const owner = r.read32(pointer + 4),
    font = r.read32(pointer + 12),
    flags = r.read32(pointer + 20);
  if (owner && !r.windows.windows.has(owner)) return error(r, 2, 1400);
  if (!font) return error(r, 1);
  r.check(font, size, true);
  // Hooks, templates, printer/font-inventory filters and Apply callbacks need
  // native dialog HWNDs. Reject them explicitly instead of reporting cancel.
  if (flags & ~SUPPORTED) return error(r, 2, 120);
  const bytes = flags & INIT ? r.data.slice(font, font + size) : new Uint8Array(size);
  if (!(flags & INIT)) bytes[23] = 1; // DEFAULT_CHARSET
  const view = new DataView(bytes.buffer);
  let face;
  try {
    face = flags & INIT ? readGdiFontFace(r, font + 28, wide) : 'Arial';
  } catch {
    return error(r, 1);
  }
  const initial = {
    face: face || 'Arial',
    points: Math.abs(view.getInt32(0, true) || -16) * 0.75,
    weight: view.getInt32(16, true) || 400,
    italic: !!bytes[20],
    underline: !!bytes[21],
    strikeout: !!bytes[22],
    color: r.read32(pointer + 24) & 0xffffff,
  };
  const min = flags & LIMIT ? r.read32(pointer + 52) | 0 : 1;
  const max = flags & LIMIT ? r.read32(pointer + 56) | 0 : 192;
  if (
    min < 1 ||
    max < min ||
    max > 192 ||
    initial.points > 192 ||
    initial.weight < 0 ||
    initial.weight > 1000
  )
    return error(r, 2);
  const selected = await r.request('choose-font', {
    owner,
    initial,
    min,
    max,
    effects: !!(flags & EFFECTS),
    noFace: !!(flags & NOFACE),
    noStyle: !!(flags & NOSTYLE),
    noSize: !!(flags & NOSIZE),
  });
  if (selected === null) return ok(0);
  if (!selected || typeof selected !== 'object') return error(r, 2);
  const value = { ...initial, ...selected };
  if (flags & NOFACE) value.face = initial.face;
  if (flags & NOSTYLE) {
    value.weight = initial.weight;
    value.italic = initial.italic;
  }
  if (flags & NOSIZE) value.points = initial.points;
  if (!(flags & EFFECTS)) {
    value.underline = initial.underline;
    value.strikeout = initial.strikeout;
    value.color = initial.color;
  }
  if (
    typeof value.face !== 'string' ||
    !value.face.length ||
    value.face.length > 31 ||
    value.face.includes('\0') ||
    !Number.isFinite(value.points) ||
    value.points < min ||
    value.points > max ||
    !Number.isInteger(value.weight) ||
    value.weight < 0 ||
    value.weight > 1000 ||
    !Number.isInteger(value.color) ||
    value.color < 0 ||
    value.color > 0xffffff ||
    [value.italic, value.underline, value.strikeout].some((flag) => typeof flag !== 'boolean')
  )
    return error(r, 2);
  const ansi = wide ? null : encodeAnsi(value.face);
  if (ansi?.usedDefault) return error(r, 2);
  // The picker produces upright logical fonts; physical matching is delegated
  // to the same browser font stack used by CreateFontIndirect and GDI drawing.
  view.setInt32(0, -Math.round((value.points * 96) / 72), true);
  view.setInt32(4, 0, true);
  view.setInt32(8, 0, true);
  view.setInt32(12, 0, true);
  view.setInt32(16, value.weight, true);
  bytes.set([+value.italic, +value.underline, +value.strikeout], 20);
  bytes.fill(0, 28);
  if (wide)
    for (let i = 0; i < value.face.length; i++)
      view.setUint16(28 + i * 2, value.face.charCodeAt(i), true);
  else bytes.set(ansi.bytes, 28);
  r.data.set(bytes, font);
  r.write32(pointer + 16, Math.round(value.points * 10));
  r.write32(pointer + 24, value.color);
  r.view.setUint16(
    pointer + 48,
    0x2000 |
      (value.weight >= 700 ? 0x100 : 0) |
      (value.italic ? 0x200 : 0) |
      (value.weight < 700 && !value.italic ? 0x400 : 0),
    true,
  ); // SCREEN_FONTTYPE + style
  return ok(1);
}
