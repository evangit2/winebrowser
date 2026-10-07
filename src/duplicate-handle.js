import { guestHandleRecord } from './wine-object.js';
import { closeFileHandle } from './wine-file.js';
import { SYNC, syncAccess, syncObjects } from './sync-objects.js';

function processAccess(raw) {
  let access = raw & 0x0fffffff;
  if (raw & 0x10000000 || raw & 0x02000000) access |= 0x1fffff;
  access &= ~0x02000000;
  if (raw & 0x80000000) access |= 0x20410;
  if (raw & 0x40000000) access |= 0x203eb;
  if (raw & 0x20000000) access |= 0x120000;
  if (access & 0x400) access |= 0x1000;
  if (access & 0x200) access |= 0x2000;
  return access & ~0x1fffff ? null : access;
}
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

// Same-process synchronization objects and standard output pipes. File handles
// need shared position and lock ownership before they can be duplicated.
export function duplicateHandle(r, a) {
  if (a(0) !== 0xffffffff) return SYNC.HANDLE;
  const source = a(1),
    options = a(6),
    pseudo = source === 0xfffffffe;
  const opened = pseudo
    ? { kind: 'sync-thread', access: 0x1fffff, inherit: false }
    : guestHandleRecord(r, source);
  if (!opened) return SYNC.HANDLE;
  if (
    ![
      'sync-process',
      'sync-thread',
      'sync-event',
      'sync-semaphore',
      'sync-directory',
      'standard-output',
    ].includes(opened.kind)
  )
    return SYNC.UNSUPPORTED;
  const objects = syncObjects(r);
  const output = opened.kind === 'standard-output';
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
    if (output) {
      const access = options & 2 ? opened.access : a(4) >>> 0;
      // Preserve the byte-output right; duplication may also create an
      // alias without write access. Other rights need separate pipe services.
      if ((access & opened.access) !== access) return SYNC.ACCESS;
      if (r.handles.size >= 4096) return SYNC.MEMORY;
      const handle = r.nextHandle++;
      r.handles.set(handle, {
        kind: 'standard-output',
        stream: opened.stream,
        access,
        inherit: options & 4 ? !!opened.inherit : !!(a(5) & 2),
      });
      r.write32(a(3), handle);
      return 0;
    }
    const accessFor = opened.kind === 'sync-process' ? processAccess : threadAccess;
    const available = ['sync-process', 'sync-thread'].includes(opened.kind)
      ? accessFor(opened.access)
      : opened.access;
    const access =
      options & 2
        ? available
        : ['sync-process', 'sync-thread'].includes(opened.kind)
          ? accessFor(a(4))
          : syncAccess(a(4), opened.kind === 'sync-directory');
    if (access === null || available === null || (access & available) !== access)
      return SYNC.ACCESS;
    const inherit = options & 4 ? opened.inherit : !!(a(5) & 2);
    const object = pseudo ? r.threads.objectFor(r.threads.current) : opened.object;
    const result = objects.openHandle(object, access, inherit);
    if (!result.status) r.write32(a(3), result.handle);
    return result.status;
  } finally {
    if (options & 1 && !pseudo) {
      if (output) closeFileHandle(r, source);
      else objects.close(source);
    }
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
