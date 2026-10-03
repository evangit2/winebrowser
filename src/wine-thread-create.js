import { syncChecked } from './wine-sync.js';
const INVALID = 0xc000000d,
  FAULT = 0xc0000005,
  UNSUPPORTED = 0xc00000bb;
function create(r, a) {
  if (!syncChecked(r, a(0), 4, true)) return FAULT;
  if (a(3) !== 0xffffffff) return 0xc0000008;
  if (a(6) & ~1 || a(7)) return UNSUPPORTED;
  let inherit = false;
  if (a(2)) {
    if (!syncChecked(r, a(2), 24)) return FAULT;
    const values = Array.from({ length: 6 }, (_, i) => r.read32(a(2) + i * 4));
    if (values[0] !== 24) return INVALID;
    if (values[1] || values[2] || values[3] & ~2 || values[4] || values[5]) return UNSUPPORTED;
    inherit = !!(values[3] & 2);
  }
  const outputs = [],
    seen = new Set();
  if (a(10)) {
    const list = a(10);
    if (!syncChecked(r, list, 4)) return FAULT;
    const size = r.read32(list);
    if (size < 4 || size > 36 || (size - 4) % 16) return INVALID;
    if (!syncChecked(r, list, size)) return FAULT;
    for (let p = list + 4; p < list + size; p += 16) {
      const type = r.read32(p),
        length = r.read32(p + 4),
        value = r.read32(p + 8),
        returned = r.read32(p + 12);
      if (![0x10003, 0x10004].includes(type)) return UNSUPPORTED;
      if (seen.has(type) || length !== (type === 0x10003 ? 8 : 4)) return INVALID;
      if (!syncChecked(r, value, length, true) || (returned && !syncChecked(r, returned, 4, true)))
        return FAULT;
      seen.add(type);
      outputs.push({ type, length, value, returned });
    }
  }
  const created = r.threads.create({
    start: a(4),
    parameter: a(5),
    reserve: a(9),
    commit: a(8),
    access: a(1),
    suspended: !!(a(6) & 1),
    inherit,
  });
  if (created.status) return created.status;
  for (const output of outputs) {
    if (output.type === 0x10003) {
      r.write32(output.value, r.processId ?? 1);
      r.write32(output.value + 4, created.thread.id);
    } else r.write32(output.value, created.thread.teb);
    if (output.returned) r.write32(output.returned, output.length);
  }
  r.write32(a(0), created.handle);
  return 0;
}
export const threadCreationNtServices = {
  NtAlertThreadByThreadId: { argc: 1, call: (r, a) => r.threads.alert(a(0)) },
  NtWaitForAlertByThreadId: {
    argc: 2,
    call(r, a) {
      if (a(1) && !syncChecked(r, a(1), 8)) return FAULT;
      // The address is a diagnostic hint, not a guest buffer to dereference.
      return r.threads.waitAlert(a(1) ? r.view.getBigInt64(a(1), true) : null);
    },
  },
  NtCreateThreadEx: { argc: 11, call: create },
  NtResumeThread: {
    argc: 2,
    call(r, a) {
      if (a(1) && !syncChecked(r, a(1), 4, true)) return FAULT;
      const changed = r.threads.resume(a(0));
      if (!changed.status && a(1)) r.write32(a(1), changed.previous);
      return changed.status;
    },
  },
  NtSuspendThread: {
    argc: 2,
    async call(r, a) {
      if (a(1) && !syncChecked(r, a(1), 4, true)) return FAULT;
      const changed = r.threads.suspend(a(0));
      if (changed.status) return changed.status;
      if (a(1)) r.write32(a(1), changed.previous);
      await r.threads.yield();
      return 0;
    },
  },
  NtTerminateThread: {
    argc: 2,
    call(r, a) {
      return r.threads.terminate(a(0), a(1));
    },
  },
  NtQueryInformationThread: {
    argc: 5,
    call(r, a) {
      const found = r.threads.lookup(a(0), 0x40);
      if (found.status) return found.status;
      const size = a(1) === 0 ? 28 : [9, 12].includes(a(1)) ? 4 : 0;
      if (!size) throw Error(`Unsupported Wine thread query class ${a(1)}`);
      if (a(3) !== size) return 0xc0000004;
      if (!syncChecked(r, a(2), size, true) || (a(4) && !syncChecked(r, a(4), 4, true)))
        return FAULT;
      const t = found.thread,
        p = a(2);
      if (a(1) === 0) {
        [
          t.done ? t.code : 259,
          t.done ? 0 : t.teb,
          t.processId ?? r.processId ?? 1,
          t.id,
          1,
          r.threads.priority(t),
          t.relativePriority ?? 0,
        ].forEach((v, i) => r.write32(p + i * 4, v));
      } else
        r.write32(
          p,
          a(1) === 9
            ? (t.start ?? r.pe.entryPoint)
            : Number([...r.threads.records.values()].filter((t) => !t.done).length === 1),
        );
      if (a(4)) r.write32(a(4), size);
      return 0;
    },
  },
  NtDelayExecution: {
    argc: 2,
    async call(r, a) {
      if (!syncChecked(r, a(1), 8)) return FAULT;
      const time = r.view.getBigInt64(a(1), true);
      const delay =
        time <= 0n
          ? Number(-time) / 10000
          : Number(time - (BigInt(Math.trunc(r.systemNow())) * 10000n + 116444736000000000n)) /
            10000;
      if (!Number.isFinite(delay) || delay > 0x7fffffff) return UNSUPPORTED;
      await r.threads.delay(Math.max(0, delay));
      return 0;
    },
  },
};
