import { PROCESS_LAYOUT } from './process-layout.js';
import { systemFileTime } from './shared-user-data.js';

export const SYNC = {
  SUCCESS: 0,
  EXISTS: 0x40000000,
  TIMEOUT: 0x102,
  LIMIT: 0xc0000047,
  INVALID: 0xc000000d,
  HANDLE: 0xc0000008,
  ACCESS: 0xc0000022,
  TYPE: 0xc0000024,
  NAME: 0xc0000033,
  NOT_FOUND: 0xc0000034,
  COLLISION: 0xc0000035,
  PATH: 0xc000003a,
  SYNTAX: 0xc000003b,
  MEMORY: 0xc000009a,
  UNSUPPORTED: 0xc00000bb,
  CANCELLED: 0xc0000120,
  FAULT: 0xc0000005,
  ALL: 0x1f0003,
  MODIFY: 2,
  QUERY: 1,
  WAIT: 0x100000,
};
const HANDLE_BASE = 0x52000000,
  HANDLE_END = 0x53000000;

export function syncObjects(r) {
  return (r.syncObjects ??= new SyncObjects(r));
}
export function syncAccess(raw, directory = false) {
  const all = directory ? 0xf000f : SYNC.ALL;
  let access = raw & 0x0fffffff;
  if (raw & 0x10000000 || raw & 0x02000000) access |= all;
  access &= ~0x02000000;
  if (raw & 0x80000000) access |= 0x20000 | (directory ? 3 : 1);
  if (raw & 0x40000000) access |= 0x20000 | (directory ? 12 : 2);
  if (raw & 0x20000000) access |= 0x20000 | (directory ? 3 : SYNC.WAIT);
  return access & ~all ? null : access;
}

// Kernel objects belong to this guest process. Named aliases share an object,
// while each handle retains its own access mask and inheritance flag.
export class SyncObjects {
  constructor(runtime) {
    this.runtime = runtime;
    this.nextHandle = HANDLE_BASE;
    this.names = new Map();
    this.handles = new Set();
    this.waiters = new Set();
    this.disposed = false;
    this.local = `\\Sessions\\${runtime.read32(PROCESS_LAYOUT.peb + 0x1d4)}\\BaseNamedObjects`;
  }
  owns(handle) {
    return handle >= HANDLE_BASE && handle < this.nextHandle;
  }
  lookup(handle, type, access = 0) {
    const opened = this.runtime.handles.get(handle);
    if (!opened) return { status: SYNC.HANDLE };
    if (opened.kind !== type) return { status: SYNC.TYPE };
    if ((opened.access & access) !== access) return { status: SYNC.ACCESS };
    return { opened, object: opened.object, status: 0 };
  }
  path(name, root = 0, insensitive = false) {
    if (!name || name.includes('\0')) return { status: SYNC.NAME };
    if (root) {
      const directory = this.lookup(root, 'sync-directory', 2);
      if (directory.status) return directory;
      if (name.startsWith('\\')) return { status: SYNC.SYNTAX };
      name = directory.object.name + '\\' + name;
    }
    if (!name.startsWith('\\')) return { status: SYNC.SYNTAX };
    const equal = (a, b) => (insensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
    for (const prefix of ['\\BaseNamedObjects', this.local]) {
      if (equal(name, prefix)) return { name: prefix, directory: true, status: 0 };
      if (!equal(name.slice(0, prefix.length + 1), prefix + '\\')) continue;
      let leaf = name.slice(prefix.length + 1),
        base = prefix;
      if (leaf.startsWith('Global\\')) {
        base = '\\BaseNamedObjects';
        leaf = leaf.slice(7);
      } else if (leaf.startsWith('Local\\')) {
        base = this.local;
        leaf = leaf.slice(6);
      }
      if (!leaf || leaf.includes('\\')) return { status: SYNC.PATH };
      return { name: base + '\\' + leaf, directory: false, status: 0 };
    }
    return { status: SYNC.PATH };
  }
  openHandle(object, access, inherit) {
    if (this.disposed || this.handles.size >= 4096 || this.nextHandle >= HANDLE_END)
      return { status: SYNC.MEMORY };
    const handle = this.nextHandle;
    this.nextHandle += 4;
    object.refs++;
    this.handles.add(handle);
    this.runtime.handles.set(handle, { kind: object.kind, object, access, inherit });
    return { status: 0, handle };
  }
  find(name, insensitive) {
    if (!insensitive) return this.names.get(name);
    for (const [key, object] of this.names)
      if (key.toLowerCase() === name.toLowerCase()) return object;
  }
  event(options = {}) {
    const { manual = false, signaled = false } = options;
    return this.named('sync-event', { manual, signaled }, options);
  }
  semaphore(options = {}) {
    const { initial = 0, maximum = 1, open = false } = options;
    if (
      !open &&
      (!Number.isInteger(initial) ||
        !Number.isInteger(maximum) ||
        initial < 0 ||
        maximum <= 0 ||
        maximum > 0x7fffffff ||
        initial > maximum)
    )
      return { status: SYNC.INVALID };
    return this.named('sync-semaphore', { count: initial, maximum }, options);
  }
  named(
    kind,
    state,
    {
      name = null,
      access = SYNC.ALL,
      inherit = false,
      open = false,
      openIf = true,
      insensitive = false,
    } = {},
  ) {
    access = syncAccess(access);
    if (access === null) return { status: SYNC.ACCESS };
    let object = name ? this.find(name, insensitive) : null;
    const existed = !!object;
    if (object && object.kind !== kind) return { status: SYNC.TYPE };
    if (object && !open && !openIf) return { status: SYNC.COLLISION };
    if (!object && open) return { status: SYNC.NOT_FOUND };
    if (!object) object = { kind, name, ...state, refs: 0 };
    const result = this.openHandle(object, access, inherit);
    if (result.status) return result;
    if (name) this.names.set(object.name, object);
    return { ...result, status: existed && !open ? SYNC.EXISTS : 0 };
  }
  directory(name, access, inherit) {
    access = syncAccess(access, true);
    if (access === null) return { status: SYNC.ACCESS };
    return this.openHandle({ kind: 'sync-directory', name, refs: 0 }, access, inherit);
  }
  change(handle, operation) {
    const found = this.lookup(handle, 'sync-event', SYNC.MODIFY);
    if (found.status) return found;
    const { object } = found,
      previous = Number(object.signaled);
    object.signaled = operation !== 'reset';
    if (object.signaled) this.dispatch();
    if (operation === 'pulse') object.signaled = false;
    return { status: 0, previous };
  }
  release(handle, count) {
    if (!Number.isInteger(count) || count <= 0 || count > 0x7fffffff)
      return { status: SYNC.INVALID };
    const found = this.lookup(handle, 'sync-semaphore', SYNC.MODIFY);
    if (found.status) return found;
    const { object } = found,
      previous = object.count;
    if (count > object.maximum - previous) return { status: SYNC.LIMIT };
    object.count += count;
    this.dispatch();
    return { status: 0, previous };
  }
  signal(handle) {
    return this.runtime.handles.get(handle)?.kind === 'sync-semaphore'
      ? this.release(handle, 1)
      : this.change(handle, 'set');
  }
  validateWait(handles, all) {
    if (!handles.length || handles.length > 64) return { status: SYNC.INVALID };
    if (all && new Set(handles).size !== handles.length) return { status: SYNC.INVALID };
    const objects = [];
    for (const handle of handles) {
      const kind = this.runtime.handles.get(handle)?.kind;
      const found = this.lookup(
        handle,
        ['sync-thread', 'sync-semaphore'].includes(kind) ? kind : 'sync-event',
        SYNC.WAIT,
      );
      if (found.status) return found;
      // Multiple aliases of one semaphore in a wait-all are not supported.
      // Reject before consuming any count instead of allowing an underflow.
      if (all && kind === 'sync-semaphore' && objects.includes(found.object))
        return { status: SYNC.INVALID };
      objects.push(found.object);
    }
    return { status: 0, objects };
  }
  consume(objects, all) {
    const ready = (o) => (o.kind === 'sync-semaphore' ? o.count > 0 : o.signaled);
    const index = all ? (objects.every(ready) ? 0 : -1) : objects.findIndex(ready);
    if (index < 0) return null;
    for (const object of all ? objects : [objects[index]])
      if (object.kind === 'sync-semaphore') object.count--;
      else if (!object.manual) object.signaled = false;
    return index;
  }
  wait(handles, all, timeout = null) {
    const found = this.validateWait(handles, all);
    if (found.status) return found.status;
    if (this.disposed) return SYNC.CANCELLED;
    const result = this.consume(found.objects, all);
    if (result !== null) return result;
    // NT negative intervals are relative 100 ns ticks; positive values are
    // absolute FILETIME. Relative waits are unaffected by wall-clock changes.
    const deadline =
      timeout !== null && timeout < 0n
        ? this.runtime.performanceClock.read() - timeout * 100n
        : null;
    const remaining = () =>
      timeout === null
        ? Infinity
        : timeout <= 0n
          ? deadline === null
            ? 0
            : Number(deadline - this.runtime.performanceClock.read()) / 1e6
          : Number(timeout - systemFileTime(this.runtime.systemNow())) / 10000;
    if (remaining() <= 0) return SYNC.TIMEOUT;
    if (this.waiters.size >= 4096) return SYNC.MEMORY;
    return new Promise((resolve) => {
      const waiter = {
        handles: handles.slice(),
        objects: found.objects,
        all,
        remaining,
        timer: null,
        finish: (status) => {
          if (!this.waiters.delete(waiter)) return;
          clearTimeout(waiter.timer);
          resolve(status);
        },
      };
      const expire = () => {
        const delay = remaining();
        if (delay <= 0) waiter.finish(SYNC.TIMEOUT);
        else if (Number.isFinite(delay))
          waiter.timer = setTimeout(expire, Math.min(0x7fffffff, Math.ceil(delay)));
      };
      this.waiters.add(waiter);
      expire();
    });
  }
  dispatch() {
    for (const waiter of this.waiters) {
      if (waiter.remaining() <= 0) {
        waiter.finish(SYNC.TIMEOUT);
        continue;
      }
      const result = this.consume(waiter.objects, waiter.all);
      if (result !== null) waiter.finish(result);
    }
  }
  close(handle) {
    if (!this.owns(handle)) return null;
    const opened = this.runtime.handles.get(handle);
    if (!opened) return SYNC.HANDLE;
    for (const waiter of this.waiters)
      if (waiter.handles.includes(handle)) waiter.finish(SYNC.HANDLE);
    this.runtime.handles.delete(handle);
    this.handles.delete(handle);
    const object = opened.object;
    if (!--object.refs && object.name && this.names.get(object.name) === object)
      this.names.delete(object.name);
    return 0;
  }
  dispose() {
    this.disposed = true;
    for (const waiter of this.waiters) waiter.finish(SYNC.CANCELLED);
    for (const handle of this.handles) this.runtime.handles.delete(handle);
    this.handles.clear();
    this.names.clear();
  }
}
