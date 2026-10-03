import { encodeAnsi } from './encoding.js';

// PE32 TVITEM is 40 bytes; NMTREEVIEW is 104. Item handles are opaque,
// scoped to their control and never recycled while that HWND is alive.
const ROOT = 0xffff0000,
  FIRST = 0xffff0001,
  LAST = 0xffff0002,
  SORT = 0xffff0003;
const INPUT_SELECT = 0x7ff0,
  INPUT_EXPAND = 0x7ff1;
function tree(w) {
  return (w.tree ??= {
    items: new Map(),
    roots: [],
    next: 1,
    selected: 0,
    indent: 16,
    itemHeight: 20,
    unicode: !!w.cls.wide,
    background: 0xffffff,
    color: 0,
  });
}
function siblings(t, item) {
  return item?.parent ? (t.items.get(item.parent)?.children ?? []) : t.roots;
}
function visible(t) {
  const rows = [];
  const visit = (ids, depth) => {
    for (const id of ids) {
      const item = t.items.get(id);
      if (!item) continue;
      rows.push({ id, depth });
      if (item.state & 0x20) visit(item.children, depth + 1);
    }
  };
  visit(t.roots, 0);
  return rows;
}
export function describeTree(w) {
  if (w.controlType !== 'treeview') return undefined;
  const t = tree(w);
  return {
    rows: visible(t).map(({ id, depth }) => {
      const i = t.items.get(id);
      return {
        id,
        depth,
        text: i.text,
        selected: id === t.selected,
        expanded: !!(i.state & 0x20),
        hasChildren: !!(i.children.length || i.childHint),
        bold: !!(i.state & 0x10),
      };
    }),
    selected: t.selected,
    indent: t.indent,
    itemHeight: t.itemHeight,
    background: t.background,
    color: t.color,
  };
}
function readItem(r, p, wide, previous = {}) {
  r.check(p, 40);
  const mask = r.read32(p),
    item = { ...previous };
  if (mask & ~0x7f) throw Error('Unsupported TreeView item fields');
  if (mask & 1) {
    const ptr = r.read32(p + 16);
    if (ptr === 0xffffffff) throw Error('TreeView callback text is not implemented');
    item.text = ptr ? (wide ? r.wideString(ptr) : r.string(ptr)) : '';
    if (item.text.length > 32767) throw Error('TreeView item text limit exceeded');
  }
  if (mask & 2) item.image = r.read32(p + 24);
  if (mask & 4) item.param = r.read32(p + 36);
  if (mask & 8) {
    const stateMask = r.read32(p + 12);
    item.state = ((item.state ?? 0) & ~stateMask) | (r.read32(p + 8) & stateMask);
  }
  if (mask & 0x20) item.selectedImage = r.read32(p + 28);
  if (mask & 0x40) item.childHint = r.read32(p + 32);
  return item;
}
function writeItem(r, p, item, mask = r.read32(p)) {
  r.check(p, 40, true);
  r.write32(p + 4, item?.id ?? 0);
  if (mask & 8) r.write32(p + 8, (item?.state ?? 0) & r.read32(p + 12));
  if (mask & 2) r.write32(p + 24, item?.image ?? 0);
  if (mask & 0x20) r.write32(p + 28, item?.selectedImage ?? 0);
  if (mask & 0x40) r.write32(p + 32, item ? item.children.length || item.childHint : 0);
  if (mask & 4) r.write32(p + 36, item?.param ?? 0);
}
async function notification(r, w, code, action, oldItem, newItem) {
  const t = tree(w),
    p = r.allocate(104);
  try {
    r.data.fill(0, p, p + 104);
    [w.id, w.controlId, -(400 + code + (t.unicode ? 49 : 0)), action].forEach((v, i) =>
      r.write32(p + i * 4, v),
    );
    for (const [offset, item] of [
      [16, oldItem],
      [56, newItem],
    ]) {
      r.write32(p + offset, 0x1c);
      r.write32(p + offset + 12, 0xffffffff);
      writeItem(r, p + offset, item, 0x1c);
    }
    return await r.windows.send(w.parentId, 0x4e, w.controlId, p);
  } finally {
    r.free(p);
  }
}
async function select(r, w, id, action = 0) {
  const t = tree(w);
  if (id && !t.items.has(id)) return 0;
  if (id === t.selected) return 1;
  const oldItem = t.items.get(t.selected),
    next = t.items.get(id);
  if (await notification(r, w, 1, action, oldItem, next)) return 0;
  if (!r.windows.windows.has(w.id) || (id && !t.items.has(id))) return 0;
  if (oldItem) oldItem.state &= ~2;
  if (next) next.state |= 2;
  t.selected = id;
  r.windows.emit(w);
  await notification(r, w, 2, action, oldItem, next);
  return 1;
}
async function expand(r, w, id, action) {
  const t = tree(w),
    item = t.items.get(id);
  if (!item) return 0;
  if (action & ~3) throw Error('Unsupported TreeView expansion mode');
  const expanded = action === 3 ? !(item.state & 0x20) : action === 2;
  if (!item.children.length && !item.childHint) return 0;
  if (!!(item.state & 0x20) === expanded) return 1;
  action = expanded ? 2 : 1;
  if (await notification(r, w, 5, action, null, item)) return 0;
  if (!t.items.has(id) || !r.windows.windows.has(w.id)) return 0;
  item.state = expanded ? item.state | 0x60 : item.state & ~0x20;
  r.windows.emit(w);
  await notification(r, w, 6, action, null, item);
  return 1;
}
async function remove(r, w, id) {
  const t = tree(w),
    item = t.items.get(id);
  if (!item) return 0;
  for (const child of [...item.children]) await remove(r, w, child);
  if (t.selected === id) await select(r, w, 0);
  const list = siblings(t, item),
    index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
  t.items.delete(id);
  await notification(r, w, 9, 0, item, null);
  return 1;
}
export function treeInput(r, w, event) {
  if (!['tree-select', 'tree-expand'].includes(event.type)) return false;
  if (tree(w).items.has(event.item >>> 0))
    r.windows.post(
      w.id,
      event.type === 'tree-select' ? INPUT_SELECT : INPUT_EXPAND,
      2,
      event.item >>> 0,
    );
  return true;
}
export async function treeMessage(r, w, message, wp, lp, fallback) {
  const t = tree(w);
  if (message === INPUT_SELECT) return select(r, w, lp, 2);
  if (message === INPUT_EXPAND) return expand(r, w, lp, 3);
  if (message === 0x100) {
    const rows = visible(t),
      at = rows.findIndex((i) => i.id === t.selected),
      item = t.items.get(t.selected);
    if ([35, 36, 38, 40].includes(wp)) {
      const index =
        wp === 36
          ? 0
          : wp === 35
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, at + (wp === 38 ? -1 : 1)));
      return rows[index] ? select(r, w, rows[index].id, 1) : 0;
    }
    if (wp === 39 && item)
      return item.state & 0x20
        ? select(r, w, item.children[0] ?? item.id, 1)
        : expand(r, w, item.id, 2);
    if (wp === 37 && item)
      return item.state & 0x20 ? expand(r, w, item.id, 1) : select(r, w, item.parent || item.id, 1);
  }
  if (message === 0x2005) {
    const old = t.unicode;
    t.unicode = !!wp;
    return old ? 1 : 0;
  }
  if (message === 0x2006) return t.unicode ? 1 : 0;
  if ([0x1100, 0x1132].includes(message)) {
    r.check(lp, 48);
    let parent = r.read32(lp),
      after = r.read32(lp + 4);
    if (parent === ROOT) parent = 0;
    if (parent && !t.items.has(parent)) return 0;
    const list = parent ? t.items.get(parent).children : t.roots;
    if (![0, FIRST, LAST, SORT].includes(after) && !list.includes(after)) return 0;
    if (t.items.size >= 2048) {
      r.lastError = 8;
      return 0;
    }
    const item = readItem(r, lp + 8, message === 0x1132, {
      id: t.next++,
      parent,
      children: [],
      text: '',
      state: 0,
      param: 0,
      childHint: 0,
    });
    t.items.set(item.id, item);
    const index =
      after === FIRST
        ? 0
        : after === SORT
          ? list.findIndex((id) => t.items.get(id).text.localeCompare(item.text) > 0)
          : after && after !== LAST
            ? list.indexOf(after) + 1
            : list.length;
    list.splice(index < 0 ? list.length : index, 0, item.id);
    r.windows.emit(w);
    return item.id;
  }
  if (message === 0x1101) {
    const all = lp === ROOT || !lp;
    if (!all && !t.items.has(lp)) return 0;
    for (const id of all ? [...t.roots] : [lp]) await remove(r, w, id);
    r.windows.emit(w);
    return 1;
  }
  if (message === 0x1102) return expand(r, w, lp, wp);
  if (message === 0x1105) return t.items.size;
  if (message === 0x1106) return t.indent;
  if (message === 0x1107) {
    t.indent = Math.max(8, Math.min(256, wp));
    r.windows.emit(w);
    return 0;
  }
  if (message === 0x110a) {
    if ([1, 2, 3, 4, 6, 7].includes(wp) && !t.items.has(lp)) return 0;
    const item = t.items.get(lp),
      list = siblings(t, item),
      index = list.indexOf(lp),
      rows = visible(t).map((i) => i.id),
      at = rows.indexOf(lp);
    return (
      {
        0: t.roots[0],
        1: list[index + 1],
        2: list[index - 1],
        3: item?.parent,
        4: item?.children[0],
        5: rows[0],
        6: rows[at + 1],
        7: rows[at - 1],
        9: t.selected,
        10: rows.at(-1),
      }[wp] ?? 0
    );
  }
  if (message === 0x110b) {
    if (wp !== 9) throw Error('Unsupported TreeView selection relation');
    return select(r, w, lp);
  }
  if ([0x110c, 0x113e, 0x110d, 0x113f].includes(message)) {
    r.check(lp, 40);
    const item = t.items.get(r.read32(lp + 4));
    if (!item) return 0;
    const wide = message === 0x113e || message === 0x113f;
    if (message === 0x110d || message === 0x113f) {
      const replacement = readItem(r, lp, wide, item);
      // Selection belongs to the control; state changes requesting it use the
      // same cancellable notification contract as TVM_SELECTITEM.
      if (
        (replacement.state & 2) !== (item.state & 2) &&
        !(await select(r, w, replacement.state & 2 ? item.id : 0))
      )
        return 0;
      Object.assign(item, replacement);
      r.windows.emit(w);
    } else {
      const mask = r.read32(lp);
      writeItem(r, lp, item, mask);
      if (mask & 1) {
        const ptr = r.read32(lp + 16),
          count = r.read32(lp + 20);
        if (ptr && count) {
          if (wide) {
            const text = item.text.slice(0, count - 1);
            r.check(ptr, (text.length + 1) * 2, true);
            for (let i = 0; i <= text.length; i++)
              r.view.setUint16(ptr + 2 * i, text.charCodeAt(i) || 0, true);
          } else {
            const bytes = encodeAnsi(item.text).bytes.subarray(0, count - 1);
            r.check(ptr, bytes.length + 1, true);
            r.data.set(bytes, ptr);
            r.data[ptr + bytes.length] = 0;
          }
        }
      }
    }
    return 1;
  }
  if (message === 0x1127) return (t.items.get(wp)?.state ?? 0) & lp;
  if (message === 0x1110) return Math.min(visible(t).length, Math.floor(w.height / t.itemHeight));
  if (message === 0x1114) {
    const item = t.items.get(lp);
    if (!item) return 0;
    let parent = item.parent;
    while (parent) {
      await expand(r, w, parent, 2);
      parent = t.items.get(parent)?.parent ?? 0;
    }
    return 1;
  }
  if (message === 0x111b) {
    const old = t.itemHeight;
    t.itemHeight = wp === 0xffffffff ? 20 : Math.max(1, Math.min(256, wp));
    r.windows.emit(w);
    return old;
  }
  if (message === 0x111c) return t.itemHeight;
  if ([0x111d, 0x111e].includes(message)) {
    const field = message === 0x111d ? 'background' : 'color',
      old = t[field];
    t[field] = lp === 0xffffffff ? (field === 'color' ? 0 : 0xffffff) : lp;
    r.windows.emit(w);
    return old;
  }
  if (message === 0x111f) return t.background;
  if (message === 0x1120) return t.color;
  if (message >= 0x1100 && message <= 0x1148)
    throw Error(`Unsupported TreeView message 0x${message.toString(16)}`);
  return fallback();
}
