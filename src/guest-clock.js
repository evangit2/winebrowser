// The guest performance domain is a process-local, monotonic nanosecond clock.
// It is also used for RDTSC: those values are virtual ticks, never host CPU cycles.
export const GUEST_PERFORMANCE_FREQUENCY = 1_000_000_000n;

export class GuestPerformanceClock {
  constructor(now = () => performance.now()) {
    if (typeof now !== 'function') throw new TypeError('Guest clock source must be a function');
    this.now = now;
    this.last = 0n;
  }

  read() {
    const sample = this.now();
    let ticks;
    if (typeof sample === 'bigint') ticks = sample;
    else {
      if (!Number.isFinite(sample) || sample < 0) throw Error('Invalid guest clock sample');
      ticks = BigInt(Math.floor(sample * 1_000_000));
    }
    if (ticks < 0n) throw Error('Invalid guest clock sample');
    if (ticks < this.last) ticks = this.last;
    else this.last = ticks;
    return ticks;
  }
}

export function splitGuestCounter(value) {
  const ticks = BigInt.asUintN(64, BigInt(value));
  return {
    low: Number(ticks & 0xffffffffn) >>> 0,
    high: Number(ticks >> 32n) >>> 0,
  };
}
