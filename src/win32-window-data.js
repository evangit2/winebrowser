// GCL/GCW indices from WinUser.h (PE32 LONG and LONG_PTR are both 32 bits).
const classFields = new Map([
  [-8, 'menuNamePointer'],
  [-10, 'background'],
  [-12, 'cursor'],
  [-14, 'icon'],
  [-16, 'instance'],
  [-18, 'extra'],
  [-20, 'classExtra'],
  [-24, 'proc'],
  [-26, 'style'],
  [-32, 'atom'],
  [-34, 'smallIcon'],
]);
function classLong(r, a, wide, write, extended) {
  const argc = write ? 3 : 2;
  const hwnd = a(0) >>> 0;
  const w = r.windows.windows.get(hwnd);
  if (!w) return r.windows.fail(1400, argc);
  const cls = w.cls;
  const index = a(1) | 0;
  if (index >= 0) {
    // GetClassLong's positive offsets address the class's own cbClsExtra bytes.
    const block =
      cls.classExtraBytes ??
      (cls.classExtraBytes = new DataView(new ArrayBuffer(cls.classExtra ?? 0)));
    if (index > block.byteLength - (write ? 4 : 4)) return r.windows.fail(1413, argc);
    const previous = block.getUint32(index, true);
    if (write) block.setUint32(index, a(2) >>> 0, true);
    return result(previous, argc);
  }
  const field = classFields.get(index);
  if (!field) return r.windows.fail(1413, argc);
  if (write) {
    if (!['proc', 'style', 'background', 'cursor', 'icon', 'smallIcon'].includes(field))
      throw Error(`SetClassLong ${field} changes are unsupported`);
    const previous = cls[field] ?? 0;
    cls[field] = a(2) >>> 0;
    return result(previous, argc);
  }
  if (field === 'atom') return result(cls.atom, argc);
  return result(cls[field] ?? 0, argc);
}

const fields = new Map([
  [-6, 'instance'],
  [-8, 'parentId'],
  [-12, 'controlId'],
  [-16, 'style'],
  [-20, 'exStyle'],
  [-21, 'userData'],
]);
const writable = new Set([-6, -12, -21]);
const result = (value, argc) => ({ result: value >>> 0, argc });

function windowLong(r, a, wide, write) {
  const m = r.windows,
    argc = write ? 3 : 2,
    w = m.windows.get(a(0) >>> 0);
  if (!w) return m.fail(1400, argc);
  const index = a(1) | 0,
    value = write ? a(2) >>> 0 : 0;
  if (index >= 0) {
    if (index > w.extra.byteLength - 4) return m.fail(1413, argc);
    // Offsets are byte offsets, including unaligned ones; each window owns its
    // own zero-initialized cbWndExtra bytes for its entire native lifetime.
    const previous = w.extra.getUint32(index, true);
    if (write) {
      w.extra.setUint32(index, value, true);
      if (index === 4 && w.dialogProc !== undefined) w.dialogProc = value;
    }
    return result(previous, argc);
  }
  if (index === -4) {
    if (write || w.controlType || !!w.cls.wide !== wide)
      throw Error(
        'Window procedure replacement and ANSI/Unicode procedure handles are unsupported',
      );
    return result(w.proc, argc);
  }
  const field = fields.get(index);
  if (!field) return m.fail(1413, argc);
  if (!write && index === -16)
    return result(
      (w.style & ~0x18000000) |
        (w.visible ? 0x10000000 : 0) |
        (w.enabled === false ? 0x08000000 : 0),
      argc,
    );
  if (write && !writable.has(index))
    throw Error(`SetWindowLong ${field} changes require window style/owner services`);
  const previous = w[field] ?? 0;
  if (write) w[field] = value;
  return result(previous, argc);
}

export const windowDataApis = {};
for (const wide of [false, true])
  for (const write of [false, true]) {
    windowDataApis[`user32.dll!${write ? 'Set' : 'Get'}ClassLong${wide ? 'W' : 'A'}`] = (r, a) =>
      classLong(r, a, wide, write, false);
    windowDataApis[`user32.dll!${write ? 'Set' : 'Get'}ClassLongPtr${wide ? 'W' : 'A'}`] = (r, a) =>
      classLong(r, a, wide, write, true);
  }
for (const wide of [false, true])
  for (const write of [false, true]) {
    windowDataApis[`user32.dll!${write ? 'Set' : 'Get'}WindowLong${wide ? 'W' : 'A'}`] = (r, a) =>
      windowLong(r, a, wide, write);
  }
