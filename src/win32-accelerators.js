// ACCEL tables belong to the process; their commands enter the guest WndProc
// synchronously, using the same callback dispatcher as SendMessage.
const result = (value, argc) => ({ result: value >>> 0, argc });
function fail(r, error, argc) {
  r.lastError = error;
  return result(0, argc);
}
function create(r, a) {
  const count = a(1) | 0;
  if (count <= 0) return fail(r, 87, 2);
  if (count > 4096 || r.windows.accelerators.size >= 256) return fail(r, 8, 2);
  r.check(a(0), count * 6);
  const entries = [];
  for (let n = 0; n < count; n++) {
    const p = a(0) + n * 6;
    const flags = r.guestMemory.read(p, 1);
    if (flags & ~0x1f) throw Error('Unsupported accelerator flags');
    entries.push({
      flags,
      key: r.guestMemory.read(p + 2, 2),
      command: r.guestMemory.read(p + 4, 2),
    });
  }
  const handle = r.windows.nextAccelerator++;
  r.windows.accelerators.set(handle, entries);
  return result(handle, 2);
}
async function translate(r, a) {
  const hwnd = a(0),
    table = r.windows.accelerators.get(a(1)),
    p = a(2);
  if (!r.windows.windows.has(hwnd)) return fail(r, 1400, 3);
  if (!table) return fail(r, 1403, 3);
  r.check(p, 28);
  const message = r.read32(p + 4),
    key = r.read32(p + 8);
  if (![0x100, 0x104, 0x102, 0x106].includes(message)) return result(0, 3);
  const down = (vk) => !!(r.windows.keyboardState.get(vk) & 0x8000);
  const modifiers = (down(16) ? 4 : 0) | (down(17) ? 8 : 0) | (down(18) ? 16 : 0);
  for (const entry of table) {
    if (entry.key !== key) continue;
    if (entry.flags & 1) {
      if (![0x100, 0x104].includes(message) || (entry.flags & 0x1c) !== modifiers) continue;
    } else if ([0x102, 0x106].includes(message)) {
      // Character messages already incorporate Ctrl/Shift translation. Wine's
      // character path compares only Alt, unlike virtual-key accelerators.
      if ((entry.flags & 16) !== (modifiers & 16)) continue;
    } else {
      const context = r.read32(p + 12);
      if (!(entry.flags & 16) || !(context & 0x20000000) || context & 0x01000000) continue;
    }
    await r.windows.send(hwnd, 0x111, 0x10000 | entry.command, 0);
    return result(1, 3);
  }
  return result(0, 3);
}
export const acceleratorApis = {
  'user32.dll!CreateAcceleratorTableA': create,
  'user32.dll!CreateAcceleratorTableW': create,
  'user32.dll!DestroyAcceleratorTable': (r, a) =>
    r.windows.accelerators.delete(a(0)) ? result(1, 1) : fail(r, 1403, 1),
  'user32.dll!TranslateAcceleratorA': translate,
  'user32.dll!TranslateAcceleratorW': translate,
  // USER32 also exports this legacy ANSI name; some PE files import it directly.
  'user32.dll!TranslateAccelerator': translate,
  'user32.dll!GetKeyState': (r, a) => {
    const state = r.windows.keyboardState.get(a(0)) ?? 0;
    return result((state << 16) >> 16, 1);
  },
};
