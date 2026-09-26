import { SYNC, syncObjects } from './sync-objects.js';

export function syncChecked(r, p, size, write = false) {
  try {
    r.check(p, size, write);
    return true;
  } catch {
    return false;
  }
}
function attributes(r, p, open = false) {
  if (!p) return open ? { status: SYNC.INVALID } : { status: 0 };
  if (!syncChecked(r, p, 24)) return { status: SYNC.FAULT };
  if (r.read32(p) !== 24) return { status: SYNC.INVALID };
  const root = r.read32(p + 4),
    ptr = r.read32(p + 8),
    flags = r.read32(p + 12);
  if (flags & ~0xc2 || r.read32(p + 16) || r.read32(p + 20)) return { status: SYNC.UNSUPPORTED };
  const result = {
    status: 0,
    root,
    inherit: !!(flags & 2),
    insensitive: !!(flags & 0x40),
    openIf: !!(flags & 0x80),
  };
  if (!ptr) return open || root ? { status: SYNC.INVALID } : result;
  if (!syncChecked(r, ptr, 8)) return { status: SYNC.FAULT };
  const length = r.view.getUint16(ptr, true),
    max = r.view.getUint16(ptr + 2, true),
    buffer = r.read32(ptr + 4);
  if (length & 1 || length > max || length > 32766) return { status: SYNC.INVALID };
  if (!length) return open || root ? { status: SYNC.NAME } : result;
  if (!syncChecked(r, buffer, length)) return { status: SYNC.FAULT };
  let name = '';
  for (let i = 0; i < length; i += 2)
    name += String.fromCharCode(r.view.getUint16(buffer + i, true));
  return { ...result, ...syncObjects(r).path(name, root, result.insensitive) };
}
function create(r, a, open = false, directory = false) {
  if (!syncChecked(r, a(0), 4, true)) return SYNC.FAULT;
  r.write32(a(0), 0);
  if (!open && a(3) > 1) return SYNC.INVALID;
  const attr = attributes(r, a(2), open);
  if (attr.status) return attr.status;
  if (!open && attr.root) {
    const root = syncObjects(r).lookup(attr.root, 'sync-directory', 4);
    if (root.status) return root.status;
  }
  if (directory !== !!attr.directory) return directory ? SYNC.NOT_FOUND : SYNC.TYPE;
  const objects = syncObjects(r),
    result = directory
      ? objects.directory(attr.name, a(1), attr.inherit)
      : objects.event({ ...attr, access: a(1), open, manual: !a(3), signaled: !!a(4) });
  if (result.handle) r.write32(a(0), result.handle);
  return result.status;
}
function change(r, a, operation) {
  if (a(1) && !syncChecked(r, a(1), 4, true)) return SYNC.FAULT;
  const result = syncObjects(r).change(a(0), operation);
  if (!result.status && a(1)) r.write32(a(1), result.previous);
  return result.status;
}
function timeout(r, p) {
  if (!p) return { value: null };
  return syncChecked(r, p, 8) ? { value: r.view.getBigInt64(p, true) } : { status: SYNC.FAULT };
}
export function syncHandles(r, count, pointer) {
  if (!count || count > 64) return { status: SYNC.INVALID };
  if (!syncChecked(r, pointer, count * 4)) return { status: SYNC.FAULT };
  return { handles: Array.from({ length: count }, (_, i) => r.read32(pointer + 4 * i)) };
}
export const syncNtServices = {
  NtCreateEvent: { argc: 5, call: (r, a) => create(r, a) },
  NtOpenEvent: { argc: 3, call: (r, a) => create(r, a, true) },
  NtOpenDirectoryObject: { argc: 3, call: (r, a) => create(r, a, true, true) },
  NtSetEvent: { argc: 2, call: (r, a) => change(r, a, 'set') },
  NtResetEvent: { argc: 2, call: (r, a) => change(r, a, 'reset') },
  NtPulseEvent: { argc: 2, call: (r, a) => change(r, a, 'pulse') },
  NtClearEvent: { argc: 1, call: (r, a) => syncObjects(r).change(a(0), 'reset').status },
  NtSetEventBoostPriority: { argc: 1, call: (r, a) => syncObjects(r).change(a(0), 'set').status },
  NtQueryEvent: {
    argc: 5,
    call(r, a) {
      if (a(1)) return 0xc0000003;
      if (a(3) !== 8) return 0xc0000004;
      if (!syncChecked(r, a(2), 8, true) || (a(4) && !syncChecked(r, a(4), 4, true)))
        return SYNC.FAULT;
      const result = syncObjects(r).lookup(a(0), 'sync-event', SYNC.QUERY);
      if (result.status) return result.status;
      r.write32(a(2), result.object.manual ? 0 : 1);
      r.write32(a(2) + 4, Number(result.object.signaled));
      if (a(4)) r.write32(a(4), 8);
      return 0;
    },
  },
  NtWaitForSingleObject: {
    argc: 3,
    call(r, a) {
      const t = timeout(r, a(2));
      return t.status ?? syncObjects(r).wait([a(0)], false, t.value);
    },
  },
  NtWaitForMultipleObjects: {
    argc: 5,
    call(r, a) {
      if (!a(0) || a(0) > 64) return 0xc00000ef;
      if (a(2) > 1) return SYNC.INVALID;
      const list = syncHandles(r, a(0), a(1)),
        t = timeout(r, a(4));
      return list.status ?? t.status ?? syncObjects(r).wait(list.handles, !a(2), t.value);
    },
  },
  NtSignalAndWaitForSingleObject: {
    argc: 4,
    call(r, a) {
      const t = timeout(r, a(3)),
        objects = syncObjects(r);
      if (t.status) return t.status;
      const valid = objects.validateWait([a(1)], false);
      if (valid.status) return valid.status;
      const signaled = objects.change(a(0), 'set');
      return signaled.status || objects.wait([a(1)], false, t.value);
    },
  },
};
