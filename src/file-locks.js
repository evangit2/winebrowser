// Byte-range locks on the browser's shared guest volume. Offsets are 64-bit:
// databases use advisory regions far beyond the physical end of their files.
export const LOCK_NOT_GRANTED = 0xc0000055;
export const RANGE_NOT_LOCKED = 0xc000007e;
export const FILE_LOCK_CONFLICT = 0xc0000054;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
export function acquireFileLock(r, handle, start, length, exclusive, key = 0) {
  const opened = r.handles.get(handle),
    locks = (r.fileLocks ??= []);
  const range = { handle, path: opened.path, start, end: start + length, exclusive, key };
  if (
    locks.some(
      (lock) =>
        lock.path === range.path &&
        overlaps(lock, range) &&
        (exclusive || (lock.exclusive && lock.handle !== handle)),
    )
  )
    return LOCK_NOT_GRANTED;
  if (locks.length >= 4096) return 0xc000009a;
  locks.push(range);
  return 0;
}
export function releaseFileLock(r, handle, start, length, key = 0) {
  const locks = r.fileLocks ?? [];
  const matches = (lock) =>
    lock.handle === handle &&
    lock.start === start &&
    lock.end === start + length &&
    lock.key === key;
  // Windows releases an exclusive match before a shared match when both
  // were acquired on the same handle over exactly the same range.
  let index = locks.findIndex((lock) => matches(lock) && lock.exclusive);
  if (index < 0) index = locks.findIndex(matches);
  if (index < 0) return RANGE_NOT_LOCKED;
  locks.splice(index, 1);
  wakeFileLockWaiters(r);
  return 0;
}
export function releaseHandleLocks(r, handle) {
  if (r.fileLocks) r.fileLocks = r.fileLocks.filter((lock) => lock.handle !== handle);
  // A closing waiter fails with INVALID_HANDLE; remaining waiters may become
  // eligible after this handle's owned locks are released.
  for (const waiter of [...(r.fileLockWaiters ?? [])])
    if (waiter.handle === handle) {
      r.fileLockWaiters.delete(waiter);
      waiter.resolve(0xc0000008);
    }
  wakeFileLockWaiters(r);
}
export function fileLockConflict(r, handle, position, count, write = false, key = 0) {
  if (!count) return false;
  const opened = r.handles.get(handle),
    range = { start: BigInt(position), end: BigInt(position + count) };
  return (r.fileLocks ?? []).some(
    (lock) =>
      lock.path === opened?.path &&
      overlaps(lock, range) &&
      (write
        ? !lock.exclusive || lock.handle !== handle || lock.key !== key
        : lock.exclusive && (lock.handle !== handle || lock.key !== key)),
  );
}

function wakeFileLockWaiters(r) {
  for (const waiter of [...(r.fileLockWaiters ?? [])]) {
    const { handle, start, length, exclusive, key } = waiter;
    const status = waiter.thread?.stop
      ? 0xc0000120
      : r.handles.has(handle)
        ? acquireFileLock(r, handle, start, length, exclusive, key)
        : 0xc0000008;
    if (status === LOCK_NOT_GRANTED) continue;
    r.fileLockWaiters.delete(waiter);
    waiter.resolve(status);
  }
}
export async function waitFileLock(r, handle, start, length, exclusive, key = 0) {
  r.fileLockWaiters ??= new Set();
  if (r.fileLockWaiters.size >= 4096) return 0xc000009a;
  let waiter;
  const ready = new Promise((resolve) => {
    waiter = { handle, start, length, exclusive, key, resolve, thread: r.threads.current };
    r.fileLockWaiters.add(waiter);
  });
  try {
    return await r.threads.block(ready);
  } finally {
    // Guest thread termination cancels its blocked callback. Its request must
    // never acquire a later lock after that thread's stack has disappeared.
    r.fileLockWaiters.delete(waiter);
  }
}
