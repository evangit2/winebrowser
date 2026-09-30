import { SYNC, syncObjects } from './sync-objects.js';
import { syncChecked, syncHandles } from './wine-sync.js';

const dosError = (status) =>
  ({
    [SYNC.HANDLE]: 6,
    [SYNC.LIMIT]: 298,
    [SYNC.TYPE]: 6,
    [SYNC.ACCESS]: 5,
    [SYNC.INVALID]: 87,
    [SYNC.NAME]: 123,
    [SYNC.NOT_FOUND]: 2,
    [SYNC.PATH]: 3,
    [SYNC.SYNTAX]: 161,
    [SYNC.MEMORY]: 8,
    [SYNC.UNSUPPORTED]: 50,
    [SYNC.FAULT]: 998,
    [SYNC.CANCELLED]: 995,
  })[status] ?? 87;
const result = (value, argc) => ({ result: value, argc });
function fail(r, status, argc, value = 0) {
  r.lastError = dosError(status);
  return result(value, argc);
}
function create(r, a, wide, extended = false, open = false, semaphore = false) {
  const argc = open ? 3 : extended && semaphore ? 6 : 4,
    objects = syncObjects(r);
  let inherit = open && !!a(1);
  if (!open && a(0)) {
    if (!syncChecked(r, a(0), 12)) return fail(r, SYNC.FAULT, argc);
    if (r.read32(a(0)) !== 12) return fail(r, SYNC.INVALID, argc);
    if (r.read32(a(0) + 4)) return fail(r, SYNC.UNSUPPORTED, argc);
    inherit = !!r.read32(a(0) + 8);
  }
  const p = a(open ? 2 : extended && !semaphore ? 1 : 3);
  let name = null;
  if (open && !p) return fail(r, SYNC.INVALID, argc);
  if (p) {
    const raw = wide ? r.wideString(p) : r.string(p);
    if (raw.length >= 260) return fail(r, SYNC.NAME, argc);
    const parsed = objects.path(objects.local + '\\' + raw);
    if (parsed.status) return fail(r, parsed.status, argc);
    if (parsed.directory) return fail(r, SYNC.TYPE, argc);
    name = parsed.name;
  }
  const flags = extended ? a(semaphore ? 4 : 2) : (!!a(1) ? 1 : 0) | (!!a(2) ? 2 : 0);
  if (!open && extended && flags & ~(semaphore ? 0 : 3)) return fail(r, SYNC.INVALID, argc);
  const response = objects[semaphore ? 'semaphore' : 'event']({
    name,
    inherit,
    open,
    access: open ? a(0) : extended ? a(semaphore ? 5 : 3) : SYNC.ALL,
    initial: a(1) | 0,
    maximum: a(2) | 0,
    manual: !!(flags & 1),
    signaled: !!(flags & 2),
  });
  if (!response.handle) return fail(r, response.status, argc);
  if (!open) r.lastError = response.status === SYNC.EXISTS ? 183 : 0;
  return result(response.handle, argc);
}
const timeout = (milliseconds) =>
  milliseconds === 0xffffffff ? null : -BigInt(milliseconds) * 10000n;
async function wait(r, a, multiple, extended) {
  const argc = multiple ? (extended ? 5 : 4) : extended ? 3 : 2;
  const list = multiple ? syncHandles(r, a(0), a(1)) : { handles: [a(0)] };
  if (list.status) return fail(r, list.status, argc, 0xffffffff);
  const status = await r.threads.block(
    syncObjects(r).wait(list.handles, multiple && !!a(2), timeout(a(multiple ? 3 : 1))),
  );
  return status >= 0x80000000 ? fail(r, status, argc, 0xffffffff) : result(status, argc);
}
export const syncApis = {};
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  syncApis[`kernel32.dll!CreateSemaphore${suffix}`] = (r, a) =>
    create(r, a, wide, false, false, true);
  syncApis[`kernel32.dll!CreateSemaphoreEx${suffix}`] = (r, a) =>
    create(r, a, wide, true, false, true);
  syncApis[`kernel32.dll!OpenSemaphore${suffix}`] = (r, a) => create(r, a, wide, false, true, true);
  syncApis[`kernel32.dll!CreateMutex${suffix}`] = (r, a) => createMutex(r, a, wide);
  syncApis[`kernel32.dll!CreateEvent${suffix}`] = (r, a) => create(r, a, wide);
  syncApis[`kernel32.dll!CreateEventEx${suffix}`] = (r, a) => create(r, a, wide, true);
  syncApis[`kernel32.dll!OpenEvent${suffix}`] = (r, a) => create(r, a, wide, false, true);
}
// CreateMutexA/W(LPSECURITY_ATTRIBUTES, BOOL initialOwner, LPCTSTR name). A
// mutex is a one-count semaphore, so the runtime models it with the same
// object; `initialOwner` decides whether the creating thread starts holding it.
function createMutex(r, a, wide) {
  const argc = 3;
  const objects = syncObjects(r);
  let inherit = false;
  if (a(0)) {
    if (!syncChecked(r, a(0), 12)) return fail(r, SYNC.FAULT, argc);
    if (r.read32(a(0)) !== 12) return fail(r, SYNC.INVALID, argc);
    if (r.read32(a(0) + 4)) return fail(r, SYNC.UNSUPPORTED, argc);
    inherit = !!r.read32(a(0) + 8);
  }
  let name = null;
  const pointer = a(2);
  if (pointer) {
    const raw = wide ? r.wideString(pointer) : r.string(pointer);
    if (raw.length >= 260) return fail(r, SYNC.NAME, argc);
    const parsed = objects.path(objects.local + '\\' + raw);
    if (parsed.status) return fail(r, parsed.status, argc);
    if (parsed.directory) return fail(r, SYNC.TYPE, argc);
    name = parsed.name;
  }
  const response = objects.semaphore({
    name,
    inherit,
    initial: a(1) ? 0 : 1,
    maximum: 1,
  });
  if (!response.handle) return fail(r, response.status, argc);
  r.lastError = response.status === SYNC.EXISTS ? 183 : 0;
  return result(response.handle, argc);
}
syncApis['kernel32.dll!ReleaseMutex'] = (r, a) => {
  const response = syncObjects(r).release(a(0), 1);
  if (response.status) return fail(r, response.status, 1);
  return result(1, 1);
};
syncApis['kernel32.dll!ReleaseSemaphore'] = (r, a) => {
  if (a(2) && !syncChecked(r, a(2), 4, true)) return fail(r, SYNC.FAULT, 3);
  const response = syncObjects(r).release(a(0), a(1) | 0);
  if (response.status) return fail(r, response.status, 3);
  if (a(2)) r.write32(a(2), response.previous);
  return result(1, 3);
};
for (const [name, operation] of [
  ['SetEvent', 'set'],
  ['ResetEvent', 'reset'],
  ['PulseEvent', 'pulse'],
])
  syncApis[`kernel32.dll!${name}`] = (r, a) => {
    const status = syncObjects(r).change(a(0), operation).status;
    return status ? fail(r, status, 1) : result(1, 1);
  };
for (const multiple of [false, true])
  for (const extended of [false, true]) {
    const name = `WaitFor${multiple ? 'MultipleObjects' : 'SingleObject'}${extended ? 'Ex' : ''}`;
    syncApis[`kernel32.dll!${name}`] = (r, a) => wait(r, a, multiple, extended);
  }
syncApis['kernel32.dll!SignalObjectAndWait'] = async (r, a) => {
  const objects = syncObjects(r),
    valid = objects.validateWait([a(1)], false);
  if (valid.status) return fail(r, valid.status, 4, 0xffffffff);
  const signal = objects.signal(a(0));
  if (signal.status) return fail(r, signal.status, 4, 0xffffffff);
  const status = await r.threads.block(objects.wait([a(1)], false, timeout(a(2))));
  return status >= 0x80000000 ? fail(r, status, 4, 0xffffffff) : result(status, 4);
};
