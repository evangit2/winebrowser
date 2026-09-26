import { SYNC, syncAccess, syncObjects } from './sync-objects.js';

function threadAccess(raw) {
  let access = raw & 0x0fffffff;
  if (raw & 0x10000000 || raw & 0x02000000) access |= 0x1fffff;
  access &= ~0x02000000;
  if (raw & 0x80000000) access |= 0x20048;
  if (raw & 0x40000000) access |= 0x20437;
  if (raw & 0x20000000) access |= 0x121800;
  if (access & 0x40) access |= 0x800;
  if (access & 0x20) access |= 0x400;
  return access & ~0x1fffff ? null : access;
}

// Same-process events, object directories and thread handles. Other families
// need their own shared object/position ownership before they can be duplicated.
export function duplicateHandle(r, a) {
  if (a(0) !== 0xffffffff) return SYNC.HANDLE;
  const source = a(1),
    options = a(6),
    pseudo = source === 0xfffffffe;
  const opened = pseudo
    ? { kind: 'sync-thread', access: 0x1fffff, inherit: false }
    : r.handles.get(source);
  if (!opened) return SYNC.HANDLE;
  if (!['sync-thread', 'sync-event', 'sync-directory'].includes(opened.kind))
    return SYNC.UNSUPPORTED;
  const objects = syncObjects(r);
  try {
    if (options & ~7) return SYNC.INVALID;
    // A null target closes only; output/access/attributes are ignored.
    if (!a(2)) return options & 1 ? 0 : SYNC.INVALID;
    if (a(2) !== 0xffffffff) return SYNC.HANDLE;
    if (!a(3)) return SYNC.UNSUPPORTED;
    try {
      r.check(a(3), 4, true);
    } catch {
      return SYNC.FAULT;
    }
    r.write32(a(3), 0);
    if (!(options & 4) && a(5) & ~2) return SYNC.UNSUPPORTED;
    const available = opened.kind === 'sync-thread' ? threadAccess(opened.access) : opened.access;
    const access =
      options & 2
        ? available
        : opened.kind === 'sync-thread'
          ? threadAccess(a(4))
          : syncAccess(a(4), opened.kind === 'sync-directory');
    if (access === null || available === null || (access & available) !== access)
      return SYNC.ACCESS;
    const inherit = options & 4 ? opened.inherit : !!(a(5) & 2);
    const object = pseudo ? r.threads.objectFor(r.threads.current) : opened.object;
    const result = objects.openHandle(object, access, inherit);
    if (!result.status) r.write32(a(3), result.handle);
    return result.status;
  } finally {
    if (options & 1 && !pseudo) objects.close(source);
  }
}

export const duplicateNtServices = {
  NtDuplicateObject: { argc: 7, call: duplicateHandle },
};
export const duplicateApis = {
  'kernel32.dll!DuplicateHandle': (r, a) => {
    // Win32 exposes CLOSE_SOURCE/SAME_ACCESS, not native SAME_ATTRIBUTES.
    const status = duplicateHandle(r, (i) =>
      i === 5 ? (a(i) ? 2 : 0) : i === 6 && a(i) & ~3 ? a(i) | 8 : a(i) >>> 0,
    );
    if (status)
      r.lastError =
        {
          [SYNC.FAULT]: 998,
          [SYNC.HANDLE]: 6,
          [SYNC.ACCESS]: 5,
          [SYNC.MEMORY]: 8,
          [SYNC.UNSUPPORTED]: 50,
        }[status] ?? 87;
    return { result: status ? 0 : 1, argc: 7 };
  },
};
