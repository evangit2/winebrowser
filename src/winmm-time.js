const tick = (r) => Number((r.performanceClock.read() / 1_000_000n) & 0xffffffffn);
const ok = (result, argc) => ({ result, argc });
const periods = (r) => (r.multimediaPeriods ??= new Map());
export const multimediaTimeApis = {
  'winmm.dll!timeGetTime': (r) => ok(tick(r), 0),
  'winmm.dll!timeGetSystemTime': (r, a) => {
    if (!a(0) || a(1) < 12) return ok(97, 2); // TIMERR_NOCANDO
    try {
      r.check(a(0), 12, true);
    } catch {
      return ok(97, 2);
    }
    r.write32(a(0), 1); // TIME_MS
    r.write32(a(0) + 4, tick(r));
    r.write32(a(0) + 8, 0);
    return ok(0, 2);
  },
  'winmm.dll!timeGetDevCaps': (r, a) => {
    if (!a(0) || a(1) < 8) return ok(97, 2);
    try {
      r.check(a(0), 8, true);
    } catch {
      return ok(97, 2);
    }
    r.write32(a(0), 1);
    r.write32(a(0) + 4, 1000);
    return ok(0, 2);
  },
  'winmm.dll!timeBeginPeriod': (r, a) => {
    const period = a(0);
    if (period < 1 || period > 1000) return ok(97, 1);
    // The virtual clock already reads at millisecond resolution. Requests are
    // balanced per process; they never change the host OS timer resolution.
    const active = periods(r);
    active.set(period, (active.get(period) ?? 0) + 1);
    return ok(0, 1);
  },
  'winmm.dll!timeEndPeriod': (r, a) => {
    const active = periods(r),
      count = active.get(a(0));
    if (!count) return ok(97, 1);
    if (count === 1) active.delete(a(0));
    else active.set(a(0), count - 1);
    return ok(0, 1);
  },
};
