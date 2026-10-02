import { compareWindowOrder } from './window-frame.js';
const ok = (result, argc) => ({ result: result >>> 0, argc });
const fail = (r, argc, error = 1400) => {
  r.lastError = error;
  return ok(0, argc);
};
function nextChar(r, a, wide) {
  const pointer = a(0) >>> 0;
  if (!pointer) return ok(0, 1);
  // The process ANSI code page is Windows-1252. Wide strings advance one
  // UTF-16 code unit, matching CharNextW rather than Unicode grapheme parsing.
  const width = wide ? 2 : 1;
  return ok(pointer + (r.guestMemory.read(pointer, width) ? width : 0), 1);
}
function relatedWindow(r, a) {
  const windows = r.windows.windows,
    window = windows.get(a(0)),
    command = a(1) >>> 0;
  if (!window) return fail(r, 2);
  if (command === 4) return ok(window.ownerId ?? 0, 2);
  if (command === 5)
    return ok(
      [...windows.values()].filter((w) => w.parentId === window.id).sort(compareWindowOrder)[0]
        ?.id ?? 0,
      2,
    );
  if (command === 6)
    return ok(
      [...windows.values()]
        .filter((w) => w.ownerId === window.id && w.enabled !== false)
        .sort(compareWindowOrder)[0]?.id ?? 0,
      2,
    );
  if (command > 3) return fail(r, 2, 87);
  const siblings = [...windows.values()]
    .filter((w) => (w.parentId ?? 0) === (window.parentId ?? 0))
    .sort(compareWindowOrder);
  const at = siblings.indexOf(window);
  const target =
    command === 0
      ? siblings[0]
      : command === 1
        ? siblings.at(-1)
        : siblings[at + (command === 2 ? 1 : -1)];
  return ok(target?.id ?? 0, 2);
}
function nextTab(r, a) {
  const m = r.windows,
    dialog = a(0),
    current = a(1),
    reverse = !!a(2);
  if (!m.windows.has(dialog) || (current && !m.windows.has(current))) return fail(r, 3);
  const controls = [];
  const visit = (parent) => {
    for (const w of [...m.windows.values()]
      .filter((w) => w.parentId === parent)
      .sort(compareWindowOrder)) {
      if (!m.isVisible(w.id) || w.enabled === false) continue;
      if (w.style & 0x00010000) controls.push(w);
      if (w.exStyle & 0x00010000) visit(w.id); // WS_EX_CONTROLPARENT
    }
  };
  visit(dialog);
  if (!controls.length) return ok(0, 3);
  const index = controls.findIndex((w) => w.id === current);
  if (!current || index < 0) return ok((reverse ? controls.at(-1) : controls[0]).id, 3);
  return ok(controls[(index + (reverse ? -1 : 1) + controls.length) % controls.length].id, 3);
}
function setParent(r, a) {
  const m = r.windows,
    w = m.windows.get(a(0)),
    parent = a(1) >>> 0;
  if (!w || (parent && !m.windows.has(parent))) return fail(r, 2);
  let ancestor = parent;
  while (ancestor) {
    if (ancestor === w.id) return fail(r, 2, 87);
    ancestor = m.windows.get(ancestor)?.parentId ?? 0;
  }
  const previous = w.parentId ?? 0;
  w.parentId = parent;
  w.ownerId = 0;
  // SetParent leaves WS_CHILD/WS_POPUP untouched; applications adjust their
  // styles with SetWindowLong when converting between top-level and child.
  w.zOrder = parent ? -m.nextZOrder++ : m.nextZOrder++;
  m.emit(w);
  return ok(previous, 2);
}
export const legacyUiApis = {
  'user32.dll!CharNextA': (r, a) => nextChar(r, a, false),
  'user32.dll!CharNextW': (r, a) => nextChar(r, a, true),
  'user32.dll!GetWindow': relatedWindow,
  'user32.dll!GetNextWindow': relatedWindow,
  'user32.dll!GetNextDlgTabItem': nextTab,
  'user32.dll!SetParent': setParent,
};
