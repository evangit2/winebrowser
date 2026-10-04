import { compareWindowOrder } from './window-frame.js';
import { encodeAnsi } from './encoding.js';
const result = (value, argc) => ({ result: value >>> 0, argc });

// Compare UTF-16 code units without full Unicode expansions (e.g. ß -> SS).
// This uses the browser's simple BMP case mappings, not a Windows locale table.
function equalName(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] === right[i]) continue;
    const fold = (c) => {
      const upper = c.toUpperCase();
      return upper.length === 1 ? upper : c;
    };
    if (fold(left[i]) !== fold(right[i])) return false;
  }
  return true;
}

function find(r, a, wide, extended) {
  const m = r.windows,
    argc = extended ? 4 : 2;
  const parent = extended ? a(0) >>> 0 : 0,
    after = extended ? a(1) >>> 0 : 0;
  const classId = a(extended ? 2 : 0) >>> 0,
    titleId = a(extended ? 3 : 1) >>> 0;
  const read = (p) => (wide ? r.wideString(p) : r.string(p));
  const className = classId > 0xffff ? read(classId) : null;
  const title = titleId ? read(titleId) : null;
  // Message-only windows cannot yet be created, so their sibling list is empty.
  if (parent === 0xfffffffd && !after) return result(0, argc);
  if ((parent && !m.windows.has(parent)) || (after && !m.windows.has(after)))
    return m.fail(1400, argc);
  if (className === '') return result(0, argc);
  const candidates = [...m.windows.values()]
    .filter((w) => (w.parentId ?? 0) === parent)
    .sort(compareWindowOrder);
  const start = after ? candidates.findIndex((w) => w.id === after) : -1;
  if (after && start < 0) return result(0, argc);
  for (const w of candidates.slice(start + 1)) {
    if (
      classId &&
      (className === null ? w.cls.atom !== classId : !equalName(w.cls.name, className))
    )
      continue;
    // Native USER32 searches stored window text without sending WM_GETTEXT.
    if (title !== null && !equalName(w.title, title)) continue;
    return result(w.id, argc);
  }
  return result(0, argc);
}

export const windowFindApis = {};
for (const wide of [false, true])
  windowFindApis[`user32.dll!GetClassName${wide ? 'W' : 'A'}`] = (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 3);
    const count = a(2) | 0,
      out = a(1);
    if (count <= 0) return result(0, 3);
    if (!out) return r.windows.fail(87, 3);
    const text = w.cls.originalName ?? w.cls.name;
    if (wide) {
      const value = text.slice(0, count - 1);
      r.check(out, (value.length + 1) * 2, true);
      for (let i = 0; i <= value.length; i++)
        r.guestMemory.write(out + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
      return result(value.length, 3);
    }
    const bytes = encodeAnsi(text).bytes.subarray(0, count - 1);
    r.check(out, bytes.length + 1, true);
    r.data.set(bytes, out);
    r.guestMemory.write(out + bytes.length, 0, 1);
    return result(bytes.length, 3);
  };
for (const wide of [false, true])
  for (const extended of [false, true]) {
    windowFindApis[`user32.dll!FindWindow${extended ? 'Ex' : ''}${wide ? 'W' : 'A'}`] = (r, a) =>
      find(r, a, wide, extended);
  }
