// PE32 CHOOSECOLORA/W share a 36-byte layout. Browser colors are solid RGB;
// native COLORREF byte order and the caller-owned custom palette are preserved.
const SUPPORTED = 1 | 2 | 4 | 0x80 | 0x100;
const ok = (result) => ({ result, argc: 1 });
function error(r, code, win32 = 87) {
  r.commonDialogError = code;
  r.lastError = win32;
  return ok(0);
}
const paletteColor = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const color = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff;
export async function chooseBrowserColor(r, a) {
  r.commonDialogError = 0;
  const pointer = a(0) >>> 0;
  if (!pointer) return error(r, 1);
  r.check(pointer, 4);
  if (r.read32(pointer) !== 36) return error(r, 1);
  r.check(pointer, 36, true);
  const owner = r.read32(pointer + 4),
    custom = r.read32(pointer + 16),
    flags = r.read32(pointer + 20),
    original = r.read32(pointer + 12);
  if (owner && !r.windows.windows.has(owner)) return error(r, 2, 1400);
  if (!custom) return error(r, 2);
  r.check(custom, 64, true);
  // Native hooks/templates/help need a native common-dialog HWND.
  if (flags & ~SUPPORTED) return error(r, 2, 120);
  const window = r.windows.windows.get(owner),
    enabled = window?.enabled;
  let initial = flags & 1 ? original & 0xffffff : 0,
    nextCustomSlot = 0;
  try {
    if (enabled) {
      window.enabled = false;
      r.windows.emit(window);
      await r.windows.send(owner, 0xa, 0, 0);
    }
    while (true) {
      const selected = await r.request('choose-color', {
        owner,
        initial,
        nextCustomSlot,
        customColors: Array.from({ length: 16 }, (_, i) => r.read32(custom + i * 4)),
        fullOpen: !!(flags & 2) && !(flags & 4),
        preventFullOpen: !!(flags & 4),
      });
      if (selected === null) {
        r.write32(pointer + 12, original);
        return ok(0);
      }
      if (
        !selected ||
        typeof selected.accepted !== 'boolean' ||
        !color(selected.color) ||
        !Array.isArray(selected.customColors) ||
        selected.customColors.length !== 16 ||
        !selected.customColors.every(paletteColor) ||
        (selected.nextCustomSlot !== undefined &&
          (!Number.isInteger(selected.nextCustomSlot) ||
            selected.nextCustomSlot < 0 ||
            selected.nextCustomSlot > 15))
      )
        return error(r, 2);
      nextCustomSlot = selected.nextCustomSlot ?? nextCustomSlot;
      // Wine updates caller-owned custom colors when Add is used, even on Cancel.
      selected.customColors.forEach((value, i) => r.write32(custom + i * 4, value));
      if (!selected.accepted) {
        r.write32(pointer + 12, original);
        return ok(0);
      }
      r.write32(pointer + 12, selected.color);
      if (owner) {
        const veto = await r.windows.send(
          owner,
          r.windows.registerWindowMessage('commdlg_ColorOK'),
          0,
          pointer,
        );
        if (!r.windows.windows.has(owner)) return error(r, 2, 1400);
        if (veto) {
          initial = r.read32(pointer + 12) & 0xffffff;
          continue;
        }
      }
      return ok(1);
    }
  } finally {
    const live = owner && r.windows.windows.get(owner);
    if (enabled && live) {
      live.enabled = true;
      r.windows.emit(live);
      await r.windows.send(owner, 0xa, 1, 0);
    }
  }
}
